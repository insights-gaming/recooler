import MagicString from "magic-string";
import { contains, parseAndAnalyze } from "./analysis.js";
import type { Analysis, Node, Span, Variable } from "./analysis.js";
import { collect, ownerAt } from "./collect.js";
import { emitActionUrl, emitRegistration } from "./codegen.js";
import { sliceModule, warnOnLoad } from "./slice.js";
import type { Action, Candidate, Diagnostic, FunctionNode, TransformOptions, TransformResult } from "./types.js";

export type { Action, Handler, Diagnostic, TransformOptions, TransformResult, TransformMode,
  ActionUrlEmission, RegistrationEmission } from "./types.js";
export { emitActionUrl, emitRegistration } from "./codegen.js";

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
    diagnostics.push({ severity: "error", code: "parse-error", start: 0, end: 0,
      message: error instanceof Error ? error.message : String(error) });
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
  const unique = (base: string) => {
    let name = base, i = 0;
    while (names.has(name)) name = `${base}$${++i}`;
    names.add(name); return name;
  };
  // These are public generated export names. Silently renaming them would break
  // plugin metadata and client registration, so diagnose user collisions.
  for (const candidate of candidates) if (names.has(candidate.exportName)) diagnostics.push({
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
  const dropped: Span[] = [];
  const drop = (start: number, end: number) => { if (start < end) dropped.push({ start, end }); };

  if (mode === "client-slice") {
    for (const item of analysis.program.body) {
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
    for (const item of analysis.program.body) if (item.type === "ImportDeclaration" && item.specifiers.length) {
      const kept = item.specifiers.filter(spec => {
        const variable = analysis.variables.find(v => v.identifiers.some(id => id.range[0] === spec.local.start));
        const refs = variable?.references.filter(r => r.isValueReference) ?? [];
        return refs.some(r => !candidates.some(c => c.kind === "handler"
          && contains(c.expression, { start: r.identifier.range[0], end: r.identifier.range[1] })));
      });
      if (!kept.length) drop(item.start, item.end);
      else if (kept.length !== item.specifiers.length) rewriteImport(ms, code, item, kept);
    }
    for (const c of candidates.filter(c => c.kind === "handler")) drop(c.start, c.end);
  }

  // Remove only the gaps around moved subranges. Removing an entire component
  // would also erase the moved handler's original chunks and its mappings.
  for (const range of dropped) removeExcept(ms, range, moved);
  const alive = (span: Span) => !dropped.some(d => contains(d, span)
    && !moved.some(c => contains(d, c) && contains(c, span)));
  const siteAlive = (c: Candidate) => (mode === "server" && c.kind === "handler") || !dropped.some(d => contains(d, c))
    || moved.some(p => p !== c && contains(p, c));

  // Rename resolved captures, including shorthand object references, before
  // moving any text. The closest moved function owns a reference.
  for (const ref of analysis.references) {
    const span = { start: ref.identifier.range[0], end: ref.identifier.range[1] };
    if (!alive(span)) continue;
    const owner = ownerAt(moved, span);
    const alias = ref.resolved && owner?.aliases.get(ref.resolved);
    if (!alias) continue;
    const node = ref.identifier as unknown as Node;
    const parent = analysis.parents.get(node);
    const shorthand = parent?.type === "Property" && parent.shorthand && parent.value === node;
    ms.overwrite(span.start, span.end, shorthand ? `${ref.identifier.name}: ${alias}` : alias, { storeName: true });
  }
  const valueAtSite = (variable: Variable, c: Candidate) => {
    for (let parent = c.parent; parent; parent = parent.parent) {
      if (moved.includes(parent) && parent.aliases.has(variable)) return parent.aliases.get(variable)!;
    }
    return variable.name;
  };
  const scopeAtSite = (c: Candidate) => `{ ${c.variables.map(v => `${JSON.stringify(v.name)}: ${valueAtSite(v, c)}`).join(", ")} }`;
  const components = new Map<FunctionNode, string>();
  const contextFor = (c: Candidate): string | undefined => {
    if (c.explicitContext) return ms.slice(c.explicitContext.start, c.explicitContext.end);
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
      if (pat.type === "Identifier") return `${pat.name}.ctx`;
      if (pat.type === "RestElement" && pat.argument.type === "Identifier") return `${pat.argument.name}[0]?.ctx`;
      let props = components.get(c.component);
      if (!props) { props = unique("__recooler_props"); components.set(c.component, props); }
      return `${props}${pat.type === "RestElement" ? "[0]?" : ""}.ctx`;
    }
  };
  for (const c of candidates) if (c.kind === "action" && siteAlive(c)) c.context = contextFor(c);
  for (const [fn, props] of components) rewriteProps(ms, code, fn, props);
  for (const c of moved) if (c.addContext) addFirstParam(ms, code, c.fn, c.addContext);

  // Inner first: a moved range must never be overwritten by an outer edit.
  // Insertion affinities here intentionally follow the magic-string spike.
  for (const c of [...candidates].sort((a, b) => (a.end - a.start) - (b.end - b.start))) {
    if (siteAlive(c)) {
      let replacement: string;
      if (c.kind === "action") replacement = (options.codegen?.actionUrl ?? emitActionUrl)({
        id: c.id, scope: scopeAtSite(c), context: c.context, helper: helper("actionUrl"),
      });
      else {
        const ref = `$handlers[${JSON.stringify(c.id)}]`;
        replacement = c.variables.length
          ? `\`${ref}(\${${helper("handlerScope")}(${scopeAtSite(c)})}).call(this, event)\``
          : JSON.stringify(`${ref}.call(this, event)`);
      }
      ms.appendLeft(c.start, replacement);
    }
    if (!moved.includes(c)) continue;
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

function firstParam(fn: FunctionNode): Node | undefined {
  return fn.params.find(p => !(p.type === "Identifier" && p.name === "this"));
}

function addFirstParam(ms: MagicString, code: string, fn: FunctionNode, name: string): void {
  const thisParam = fn.params.find(p => p.type === "Identifier" && p.name === "this");
  if (thisParam) { ms.appendLeft(thisParam.end, `, ${name}`); return; }
  const open = code.indexOf("(", fn.start);
  ms.appendLeft(open + 1, name);
}

function rewriteProps(ms: MagicString, code: string, fn: FunctionNode, name: string): void {
  let param = firstParam(fn)!;
  if (param.type === "RestElement") param = param.argument;
  const pattern = param.type === "AssignmentPattern" ? param.left : param;
  const typeStart = "typeAnnotation" in pattern && pattern.typeAnnotation ? pattern.typeAnnotation.start : pattern.end;
  const original = code.slice(pattern.start, typeStart);
  const annotation = code.slice(typeStart, pattern.end);
  ms.overwrite(pattern.start, pattern.end, name + annotation);
  const init = `let ${original} = ${name}; `;
  if (fn.body!.type === "BlockStatement") ms.prependRight(fn.body!.start + 1, init);
  else {
    ms.prependRight(fn.body!.start, `{ ${init}return (`);
    ms.appendLeft(fn.body!.end, "); }");
  }
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

function removeExcept(ms: MagicString, range: Span, protectedRanges: Span[]): void {
  const protectedParts = protectedRanges.filter(p => contains(range, p))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let cursor = range.start;
  for (const part of protectedParts) {
    if (part.start > cursor) ms.remove(cursor, Math.min(part.start, range.end));
    cursor = Math.max(cursor, part.end);
  }
  if (cursor < range.end) ms.remove(cursor, range.end);
}
