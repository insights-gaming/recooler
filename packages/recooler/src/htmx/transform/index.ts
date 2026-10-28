import MagicString from "magic-string";
import { contains, ParseError, parseAndAnalyze, unwrap, walk } from "./analysis.js";
import type { Analysis, Node, Span, Variable } from "./analysis.js";
import { SpanIndex } from "./spans.js";
import { attrKind, attrName, collect, isFunction } from "./collect.js";
import { emitActionUrl, emitRegistration } from "./codegen.js";
import { sliceModule, warnOnLoad } from "./slice.js";
import { handlerOnlyDeclarations } from "./server.js";
import type { Action, Candidate, Diagnostic, FunctionNode, TransformOptions, TransformResult } from "./types.js";

export type { Action, Handler, Diagnostic, TransformOptions, TransformResult, TransformMode,
  ActionUrlEmission, RegistrationEmission } from "./types.js";
export { emitActionUrl, emitRegistration } from "./codegen.js";
export { bannedClientModules, isBannedModule, moduleIdForms } from "./banned-imports.js";

/** Pure TSX → TSX transform. Diagnostics with severity `error` are build errors;
 * callers MUST reject them. On errors code/map are the unchanged source/map.
 * Parsing errors are also returned as diagnostics. No filesystem or bundler APIs.
 */
export function transform(code: string, options: TransformOptions): TransformResult {
  const ms = new MagicString(code, { filename: options.id });
  const diagnostics: Diagnostic[] = [];
  const result = (candidates: Candidate[] = []): TransformResult => ({
    code: ms.toString(), map: ms.generateMap({ hires: true, source: options.id, includeContent: true }),
    actions: candidates.filter(c => c.kind === "action").map(c => ({ ...metadata(c), method: c.method! })),
    handlers: candidates.filter(c => c.kind === "handler").map(metadata), diagnostics,
  });
  let analysis: Analysis;
  try { analysis = parseAndAnalyze(code, options.id, options.rawTransfer); }
  catch (error) {
    const errors = error instanceof ParseError ? error.diagnostics : [{ start: 0, end: 0,
      message: error instanceof Error ? error.message : String(error) }];
    diagnostics.push(...errors.map(e => ({ ...e, severity: "error" as const, code: "parse-error" })));
    return result();
  }
  const candidates = collect(analysis, options, diagnostics);
  warnOnLoad(analysis, options, diagnostics);
  const mode = options.mode ?? "full";
  // Also run the client reachability check in full/server mode when configured:
  // the caller should see a client leak before generating a handler variant.
  const slice = mode === "client-slice" || options.clientBannedImports?.length
    ? sliceModule(analysis, candidates, options, diagnostics) : undefined;
  if (diagnostics.some(d => d.severity === "error")) return result(candidates);

  const names = new Set<string>();
  for (const variable of analysis.variables) names.add(variable.name);
  // Include unresolved references too: an injected import must not shadow a global.
  for (const ref of analysis.references) names.add(ref.identifier.name);
  const counters = new Map<string, number>();
  const unique = (base: string) => {
    let name = base, i = counters.get(base) ?? 0;
    while (names.has(name)) name = `${base}$${++i}`;
    counters.set(base, i); names.add(name); return name;
  };
  // These are public generated export names. Silently renaming them would break
  // plugin metadata and client registration, so diagnose user collisions.
  const reserved = new Set([...analysis.variables.filter(v => ["module", "global"].includes(v.scope.type)).map(v => v.name),
    ...analysis.references.filter(r => !r.resolved).map(r => r.identifier.name)]);
  for (const candidate of candidates) if (reserved.has(candidate.exportName)) diagnostics.push({
    severity: "error", code: "reserved-export", start: candidate.start, end: candidate.end,
    message: `${options.relativePath}: ${candidate.exportName} is reserved for generated htmx exports`,
  });
  if (diagnostics.some(d => d.severity === "error")) return result(candidates);
  const helpers = new Map<string, string>();
  const helper = (name: string) => {
    let local = helpers.get(name);
    if (!local) { local = unique(`__recooler_${name}`); helpers.set(name, local); }
    return local;
  };
  for (const c of candidates) for (const variable of c.variables) c.aliases.set(variable, unique("__recooler_capture"));
  const moved = candidates.filter(c => mode === "client-slice" ? c.kind === "handler" : mode !== "server" || c.kind === "action");
  const movedSet = new Set(moved);
  const owners = new SpanIndex(moved);
  const candidateOwners = new SpanIndex(candidates);
  const dropped: Span[] = [];
  const drop = (start: number, end: number) => { if (start < end) dropped.push({ start, end }); };

  if (mode === "client-slice") {
    for (const item of analysis.program.body) {
      if (item.type === "ExportAllDeclaration" && slice!.onLoadItems.has(item)) continue;
      if (item.type === "ImportDeclaration") {
        const kept = item.specifiers.filter(s => slice!.kept.has(s));
        if (!kept.length) drop(item.start, item.end);
        else rewriteImport(ms, code, item, kept);
        continue;
      }
      if (item.type === "ExportNamedDeclaration" && !item.declaration) {
        const kept = item.specifiers.filter(s => slice!.onLoadSpecifiers.has(s));
        if (!kept.length) drop(item.start, item.end);
        else trimList(item.specifiers, s => slice!.onLoadSpecifiers.has(s), drop);
        continue;
      }
      const decl = item.type === "ExportNamedDeclaration" || item.type === "ExportDefaultDeclaration" ? item.declaration : item;
      if (!decl) { drop(item.start, item.end); continue; }
      if (decl.type === "VariableDeclaration") {
        if (!decl.declarations.some(d => slice!.kept.has(d))) { drop(item.start, item.end); continue; }
        trimList(decl.declarations, d => slice!.kept.has(d), drop);
      } else if (!slice!.kept.has(decl)) { drop(item.start, item.end); continue; }
      if (item !== decl && !slice!.onLoadItems.has(item)) drop(item.start, decl.start);
    }
  }
  if (mode === "server") {
    const clientOnly = handlerOnlyDeclarations(analysis, candidates);
    for (const item of analysis.program.body) {
      const decl = item.type === "ExportNamedDeclaration" || item.type === "ExportDefaultDeclaration" ? item.declaration : item;
      if (!decl) continue;
      if (clientOnly.has(decl)) drop(item.start, item.end);
      else if (decl.type === "VariableDeclaration" && decl.declarations.some(d => clientOnly.has(d))) {
        if (decl.declarations.every(d => clientOnly.has(d))) drop(item.start, item.end);
        else trimList(decl.declarations, d => !clientOnly.has(d), drop);
      }
    }
    const clientOwners = new SpanIndex([...clientOnly]);
    for (const item of analysis.program.body) if (item.type === "ImportDeclaration" && item.specifiers.length) {
      const kept = item.specifiers.filter(spec => {
        const variable = analysis.moduleVariables(spec)[0];
        const refs = variable?.references.filter(r => analysis.isValueReference(r)) ?? [];
        return !refs.length || refs.some(r => {
          const span = { start: r.identifier.range[0], end: r.identifier.range[1] };
          const owner = candidateOwners.owner(span);
          return owner?.kind === "action" || (owner?.kind !== "handler" && !clientOwners.owner(span));
        });
      });
      if (!kept.length) drop(item.start, item.end);
      else if (kept.length !== item.specifiers.length) rewriteImport(ms, code, item, kept);
    }
    for (const c of candidates.filter(c => c.kind === "handler")) drop(c.start, c.end);
  }

  // Remove only the gaps around moved subranges. Removing an entire component
  // would also erase the moved handler's original chunks and its mappings.
  const removed: Span[] = [];
  for (const range of dropped) removeExcept(ms, range, owners.within(range), removed);
  const removedIndex = new SpanIndex(removed);
  const alive = (span: Span) => !removedIndex.owner(span);
  const handlerSites = new Set(candidates.filter(c => c.kind === "handler").map(c => `${c.start}:${c.end}`));
  const droppedIndex = new SpanIndex(dropped.filter(d => mode !== "server" || !handlerSites.has(`${d.start}:${d.end}`)));
  const siteAlive = (c: Candidate) => {
    const d = droppedIndex.owner(c);
    if (!d) return true;
    const parent = owners.owner({ start: c.start, end: c.end });
    // The candidate's own hoisted body doesn't preserve its original site.
    if (parent === c) return !!c.parent && movedSet.has(c.parent) && contains(d, c.parent);
    return !!parent && contains(d, parent);
  };

  // Rename resolved captures, including shorthand object references, before
  // moving any text. The closest moved function owns a reference.
  for (const ref of analysis.references) {
    const span = { start: ref.identifier.range[0], end: ref.identifier.range[1] };
    if (!alive(span)) continue;
    const owner = owners.owner(span);
    const alias = ref.resolved && owner?.aliases.get(ref.resolved);
    if (!alias) continue;
    const node = ref.identifier as unknown as Node;
    const parent = analysis.parents.get(node);
    const grandparent = parent && analysis.parents.get(parent);
    const shorthand = (parent?.type === "Property" && parent.shorthand && parent.value === node)
      || (parent?.type === "AssignmentPattern" && parent.left === node && grandparent?.type === "Property" && grandparent.shorthand);
    ms.overwrite(span.start, span.end, shorthand ? `${ref.identifier.name}: ${alias}` : alias, { storeName: true });
  }
  const valueAtSite = (variable: Variable, c: Candidate) => {
    for (let parent = c.parent; parent; parent = parent.parent) {
      if (movedSet.has(parent) && parent.aliases.has(variable)) return parent.aliases.get(variable)!;
    }
    return variable.name;
  };
  const scopeAtSite = (c: Candidate) => `{ ${c.variables.map(v => `${JSON.stringify(v.name)}: ${valueAtSite(v, c)}`).join(", ")} }`;
  const components = new Map<FunctionNode, string>();
  const contextFor = (c: Candidate): string | undefined => {
    if (c.explicitContext) {
      // Shorthand props are expanded to `ctx: alias` by capture renaming. Only
      // the value is an expression when it is reused as the URL override.
      if (c.explicitContext.type === "Identifier") {
        const ref = analysis.referenceAt.get(c.explicitContext.start);
        const owner = owners.owner(c.explicitContext);
        return (ref?.resolved && owner?.aliases.get(ref.resolved)) || c.explicitContext.name;
      }
      return ms.slice(c.explicitContext.start, c.explicitContext.end);
    }
    if (c.parent?.kind === "action") {
      const parent = c.parent;
      const param = firstParam(parent.fn);
      if (param?.type === "Identifier") return param.name;
      if (!param) { parent.addContext ??= unique("__recooler_ctx"); return parent.addContext; }
      return;
    }
    if (options.componentContext !== false && c.component) {
      const param = firstParam(c.component);
      if (!param) return;
      const pat = param.type === "AssignmentPattern" ? param.left : param;
      if (pat.type === "Identifier") return `${pat.name}?.ctx`;
      if (pat.type === "RestElement" && pat.argument.type === "Identifier") return `${pat.argument.name}[0]?.ctx`;
      let props = components.get(c.component);
      if (!props) { props = unique("__recooler_props"); components.set(c.component, props); }
      return `${props}${pat.type === "RestElement" ? "[0]?" : ""}.ctx`;
    }
  };
  for (const c of candidates) if (c.kind === "action" && siteAlive(c)) c.context = contextFor(c);
  // Only a direct object spread into a component passes ctx through. Nested
  // object props with actions consume ctx here, before it can leak into props.
  walk(analysis.program, node => {
    if (node.type !== "ObjectExpression" || !alive(node)) return;
    if (!node.properties.some(p => p.type === "Property" && attrKind(attrName(p.key, p.computed))
      && attrKind(attrName(p.key, p.computed)) !== "handler" && isFunction(unwrap(p.value)))) return;
    const parent = analysis.parents.get(node);
    const opening = parent && analysis.parents.get(parent);
    if (parent?.type === "JSXSpreadAttribute" && opening?.type === "JSXOpeningElement"
      && !(opening.name.type === "JSXIdentifier" && /^[a-z]/.test(opening.name.name))) return;
    trimList(node.properties, p => !(p.type === "Property" && attrName(p.key, p.computed) === "ctx"),
      (start, end) => ms.remove(start, end));
  });
  for (const [fn, props] of components) rewriteProps(ms, fn, props);
  for (const c of moved) if (c.addContext) addFirstParam(ms, code, c.fn, c.addContext);

  // Inner first: a moved range must never be overwritten by an outer edit.
  // Insertion affinities here intentionally follow the magic-string spike.
  for (const c of [...candidates].sort((a, b) => contains(a, b) ? 1 : contains(b, a) ? -1 : a.start - b.start)) {
    if (siteAlive(c)) {
      let replacement: string;
      if (c.kind === "action") replacement = (options.codegen?.actionUrl ?? emitActionUrl)({
        id: c.id, scope: scopeAtSite(c), context: c.context, helper: helper("actionUrl"),
      });
      else {
        const ref = `$handlers[${JSON.stringify(c.id)}]`;
        replacement = c.variables.length
          ? `\`${escapeTemplate(ref)}(\${${helper("handlerScope")}(${scopeAtSite(c)})}).call(this, event)\``
          : JSON.stringify(`${ref}.call(this, event)`);
      }
      ms.appendLeft(c.start, replacement);
    }
    if (!movedSet.has(c)) continue;
    const factory = c.variables.length ? `({ ${c.variables.map(v => `${JSON.stringify(v.name)}: ${c.aliases.get(v)}`).join(", ")} }) => ` : "";
    let prefix = `\nexport const ${c.exportName} = `, suffix = ";\n";
    if (c.kind === "action") {
      prefix += `/*#__PURE__*/ ${helper(c.method === "get" ? "wrapAction" : "wrapActionWithPayload")}(${factory}(`;
      suffix = `)${c.variables.length ? `, ${JSON.stringify(c.id)}` : ""});\n`;
    } else { prefix += `${factory}(`; suffix = ");\n"; }
    ms.move(c.start, c.end, code.length);
    ms.prependRight(c.start, prefix);
    ms.appendLeft(c.end, suffix);
  }
  if (mode !== "client-slice") {
    const actions: Action[] = candidates.filter(c => c.kind === "action").map(c => ({ ...metadata(c), method: c.method! }));
    if (actions.length) ms.append(`\n${(options.codegen?.registerActions ?? emitRegistration)({
      moduleId: options.relativePath, actions, helper: helper("registerActions"),
    })}\n`);
  } else {
    const handlers = candidates.filter(c => c.kind === "handler");
    if (handlers.length) {
      const table = unique("__recooler_handlers");
      ms.append(`\nconst ${table} = globalThis.$handlers ??= {};\n${handlers.map(c => `${table}[${JSON.stringify(c.id)}] = ${c.exportName};`).join("\n")}\n`);
    }
  }
  if (helpers.size) ms.prepend(`import { ${[...helpers].map(([name, alias]) => `${name} as ${alias}`).join(", ")} } from "recooler/htmx/runtime";\n`);
  return result(candidates);
}

function metadata(c: Candidate) {
  return { id: c.id, exportName: c.exportName, captures: c.captures, start: c.start, end: c.end };
}

function escapeTemplate(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function firstParam(fn: FunctionNode): Node | undefined {
  return fn.params.find(p => !(p.type === "Identifier" && p.name === "this"));
}

function addFirstParam(ms: MagicString, code: string, fn: FunctionNode, name: string): void {
  const thisParam = fn.params.find(p => p.type === "Identifier" && p.name === "this");
  if (thisParam) { ms.appendLeft(thisParam.end, `, ${name}`); return; }
  let pos = fn.typeParameters?.end ?? fn.id?.end ?? fn.start;
  while (pos < fn.body!.start) {
    if (code.startsWith("/*", pos)) { pos = code.indexOf("*/", pos + 2) + 2; continue; }
    if (code.startsWith("//", pos)) { pos = code.indexOf("\n", pos + 2); continue; }
    if (code[pos] === "(") { ms.appendLeft(pos + 1, name); return; }
    pos++;
  }
  throw new Error("could not locate the parsed function's empty parameter list");
}

function rewriteProps(ms: MagicString, fn: FunctionNode, name: string): void {
  let param = firstParam(fn)!;
  if (param.type === "RestElement") param = param.argument;
  const pattern = param.type === "AssignmentPattern" ? param.left : param;
  const typeStart = "typeAnnotation" in pattern && pattern.typeAnnotation ? pattern.typeAnnotation.start : pattern.end;
  const block = fn.body!.type === "BlockStatement";
  // Leave the annotation/default in the parameter list and move the actual
  // binding pattern. This preserves mappings and can contain nested hoists.
  ms.move(pattern.start, typeStart, fn.body!.start + (block ? 1 : 0));
  ms.prependRight(pattern.start, block ? "let " : "{ let ");
  ms.appendLeft(typeStart, ` = ${name}; ${block ? "" : "return ("}`);
  ms.appendLeft(pattern.start, name);
  if (!block) ms.appendLeft(fn.body!.end, "); }");
}

function rewriteImport(ms: MagicString, code: string, item: Extract<Node, { type: "ImportDeclaration" }>, kept: typeof item.specifiers): void {
  const normal = kept.filter(s => s.type !== "ImportSpecifier").map(s => code.slice(s.start, s.end));
  const named = kept.filter(s => s.type === "ImportSpecifier").map(s => code.slice(s.start, s.end));
  if (named.length) normal.push(`{ ${named.join(", ")} }`);
  ms.overwrite(item.start, item.source.start, `import ${item.importKind === "type" ? "type " : ""}${normal.join(", ")} from `);
}

function trimList<T extends Span>(parts: readonly T[], keep: (part: T) => boolean, drop: (start: number, end: number) => void): void {
  for (let i = 0; i < parts.length;) {
    if (keep(parts[i]!)) { i++; continue; }
    const start = i;
    while (i < parts.length && !keep(parts[i]!)) i++;
    if (i < parts.length) drop(parts[start]!.start, parts[i]!.start);
    else drop(start > 0 ? parts[start - 1]!.end : parts[start]!.start, parts[i - 1]!.end);
  }
}

function removeExcept(ms: MagicString, range: Span, protectedRanges: Span[], removed: Span[]): void {
  const protectedParts = protectedRanges.filter(p => contains(range, p))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let cursor = range.start;
  for (const part of protectedParts) {
    if (part.start > cursor) { ms.remove(cursor, part.start); removed.push({ start: cursor, end: part.start }); }
    cursor = Math.max(cursor, part.end);
  }
  if (cursor < range.end) { ms.remove(cursor, range.end); removed.push({ start: cursor, end: range.end }); }
}
