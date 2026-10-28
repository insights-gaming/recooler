import { children, unwrap } from "./analysis.js";
import type { Analysis, Node } from "./analysis.js";
import type { ActionMethod, Candidate, Diagnostic, FunctionNode, TransformOptions } from "./types.js";

export function attrName(node: Node, computed = false): string | undefined {
  if (computed && node.type === "Identifier") return;
  if (node.type === "Identifier" || node.type === "JSXIdentifier") return node.name;
  if (node.type === "JSXNamespacedName") return `${node.namespace.name}:${node.name.name}`;
  if (node.type === "TemplateLiteral" && !node.expressions.length) return node.quasis[0]?.value.cooked ?? undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
}

export function attrKind(name: string | undefined): ActionMethod | "handler" | undefined {
  name = name?.replace(/^data-/, "");
  if (name?.startsWith("hx-on:") || name?.startsWith("hx-on-")) return "handler";
  const method = name?.match(/^hx-(get|post|put|patch|delete)$/)?.[1];
  return method as ActionMethod | undefined;
}

export function isFunction(node: Node): node is FunctionNode {
  return ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type);
}

export function collect(analysis: Analysis, options: TransformOptions, diagnostics: Diagnostic[]): Candidate[] {
  const candidates: Candidate[] = [];
  let actions = 0, handlers = 0;
  const error = (node: Node, code: string, message: string) => diagnostics.push({
    severity: "error", code, message: `${options.relativePath}: ${message}`, start: node.start, end: node.end,
  });
  interface State { parent?: Candidate; component?: FunctionNode; inHandler?: boolean }
  function candidate(expression: Node, kind: ActionMethod | "handler", state: State, context?: Node): void {
    const fn = unwrap(expression);
    if (!isFunction(fn)) { visit(expression, state); return; }
    if (state.inHandler) {
      if (kind !== "handler") error(expression, "action-in-handler", "form actions inside event handlers cannot run on the client");
      for (const child of children(fn)) visit(child, state);
      return;
    }
    const index = kind === "handler" ? handlers++ : actions++;
    const item: Candidate = {
      kind: kind === "handler" ? "handler" : "action", method: kind === "handler" ? undefined : kind,
      id: `${options.relativePath}@${index.toString(36)}`,
      exportName: kind === "handler" ? `_handler$${index}` : `_action$${kind}$${index}`,
      expression, fn, start: expression.start, end: expression.end,
      parent: state.parent, component: state.component, explicitContext: context,
      captures: [], variables: [], aliases: new Map(),
    };
    candidates.push(item);
    if (fn.type === "ArrowFunctionExpression") {
      const used = lexicalBindings(fn, analysis);
      for (const binding of used) error(fn, `lexical-${item.kind}-binding`,
        `${item.kind === "handler" ? "event handler" : "form action"} ${item.id} is an arrow function that uses \`${binding}\`, which arrow functions don't bind; ${binding === "this"
          ? item.kind === "handler" ? "use a `function` expression to get the element as `this`, or `event.currentTarget`" : "use an explicit parameter instead"
          : "use a rest parameter, e.g. `(...args) => ...`"}`);
    }
    for (const child of children(fn)) visit(child, { ...state, parent: item, inHandler: item.kind === "handler" });
    item.variables = analysis.captures(fn);
    for (const variable of item.variables) {
      const kind = analysis.kind(variable);
      if (kind !== "value") error(fn, "unserializable-capture",
        `${item.kind === "action" ? "form action" : "event handler"} ${item.id} references the local ${kind} \`${variable.name}\`, which cannot be serialized; move it to the module scope`);
    }
    item.captures = item.variables.map(v => v.name);
  }
  function visit(node: Node, state: State): void {
    if (node.type === "JSXOpeningElement") {
      const ctx = node.attributes.find(a => a.type === "JSXAttribute" && attrName(a.name) === "ctx");
      const context = ctx?.type === "JSXAttribute" && ctx.value?.type === "JSXExpressionContainer" ? ctx.value.expression : undefined;
      for (const attr of node.attributes) {
        if (attr.type === "JSXAttribute" && attr.value?.type === "JSXExpressionContainer") {
          const kind = attrKind(attrName(attr.name));
          if (kind && isFunction(unwrap(attr.value.expression))) {
            candidate(attr.value.expression, kind, state, context); continue;
          }
        }
        visit(attr, state);
      }
      return;
    }
    if (node.type === "ObjectExpression") {
      const ctx = node.properties.find(p => p.type === "Property" && attrName(p.key, p.computed) === "ctx");
      const context = ctx?.type === "Property" ? ctx.value : undefined;
      const parent = analysis.parents.get(node);
      const htmxPosition = parent?.type === "JSXSpreadAttribute" || (parent?.type === "JSXExpressionContainer" && analysis.parents.get(parent)?.type === "JSXAttribute")
        || node.properties.some(p => p.type === "Property" && attrName(p.key, p.computed)?.replace(/^data-/, "").startsWith("hx-"));
      for (const prop of node.properties) {
        if (prop.type === "Property" && prop.kind === "init" && !prop.method) {
          if (htmxPosition && prop.computed && prop.key.type !== "Literal" && attrName(prop.key, true) === undefined && isFunction(unwrap(prop.value))) {
            error(prop.key, "computed-handler-key", "computed function property keys must be string literals so htmx attributes can be identified");
          }
          const kind = attrKind(attrName(prop.key, prop.computed));
          if (kind && isFunction(unwrap(prop.value))) { candidate(prop.value, kind, state, context); continue; }
        }
        visit(prop, state);
      }
      return;
    }
    if (isFunction(node) && !state.component && !state.parent) state = { ...state, component: node };
    for (const child of children(node)) visit(child, state);
  }
  visit(analysis.program, {});
  return candidates;
}

function lexicalBindings(fn: FunctionNode, analysis: Analysis): ("this" | "arguments")[] {
  let thisUsed = false, argumentsUsed = false;
  function visit(node: Node): void {
    if (isFunction(node) && node !== fn && node.type !== "ArrowFunctionExpression") return;
    if (node.type === "ClassExpression" || node.type === "ClassDeclaration") {
      if (node.superClass) visit(node.superClass);
      for (const member of node.body.body) if ("computed" in member && member.computed) visit(member.key);
      return;
    }
    if (node.type === "ThisExpression") thisUsed = true;
    if (node.type === "Identifier" && node.name === "arguments") {
      const ref = analysis.referenceAt.get(node.start);
      if (ref && analysis.isValueReference(ref)) argumentsUsed = true;
    }
    for (const child of children(node)) visit(child);
  }
  visit(fn);
  return [...(thisUsed ? ["this" as const] : []), ...(argumentsUsed ? ["arguments" as const] : [])];
}

