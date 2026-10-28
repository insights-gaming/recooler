import { relative, isAbsolute } from 'node:path';
import ts from 'typescript';

// Farm-only adapter. Parse import slots, never infer provenance from function identity.
export function instrumentApp(content, packageRoot) {
  const ast = ts.createSourceFile('app.js', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const roles = new Map();
  function identify(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'routeHandlerFactory') {
      const [root, component, head] = node.arguments;
      if (ts.isIdentifier(root)) roles.set(root.text, 'root');
      function peel(expr) {
        if (ts.isCallExpression(expr)) { roles.set(expr.expression.getText(ast), 'layout'); peel(expr.arguments[0]); }
        else if (ts.isIdentifier(expr)) roles.set(expr.text, 'render-page');
      }
      peel(component);
      function heads(expr) {
        if (ts.isIdentifier(expr)) roles.set(expr.text, 'head');
        ts.forEachChild(expr, heads);
      }
      heads(head);
    }
    ts.forEachChild(node, identify);
  }
  identify(ast);
  const imports = new Map();
  const edits = [];
  const wrappers = [];
  const sourceLabel = (file, name) => ({ file: (isAbsolute(file) ? relative(packageRoot, file) : file).replaceAll('\\', '/').replace(/^\.\//, ''), export: name });
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const source = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    const slots = [];
    if (clause?.name) slots.push([clause.name, 'default']);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const spec of clause.namedBindings.elements) slots.push([spec.name, spec.propertyName?.text || spec.name.text]);
    }
    for (const [node, exported] of slots) {
      const local = node.text;
      const label = sourceLabel(source, exported);
      imports.set(local, label);
      if (['actionsMiddleware', 'groupMiddleware', 'routeHandlerFactory'].includes(local)) {
        // Preserve the exported name when renaming shorthand named imports.
        const replacement = node.parent && ts.isImportSpecifier(node.parent) && !node.parent.propertyName
          ? `${exported} as __eqOriginal_${local}` : `__eqOriginal_${local}`;
        edits.push([node.getStart(ast), node.end, replacement]);
      } else if (roles.has(local) || /^on(Get|Post|Put|Patch|Delete|Head|Options|Request)$/.test(exported) || /(?:^|\/)middleware(?:@[^/]*)?\.[cm]?[jt]sx?$/.test(source)) {
        const original = `__eqImport_${local}`;
        edits.push([node.getStart(ast), node.end, node.parent && ts.isImportSpecifier(node.parent) && !node.parent.propertyName ? `${exported} as ${original}` : original]);
        const kind = roles.get(local) || (exported === 'default' ? 'middleware' : 'handler');
        wrappers.push(`const ${local} = ${['root', 'layout'].includes(kind) ? '__eqHOC' : '__eqWrap'}(${original}, ${JSON.stringify({ kind, ...label })});`);
      }
    }
  }
  const lookup = node => {
    if (!node || !ts.isIdentifier(node) || !imports.has(node.text)) throw new Error(`Unrecognised generated source: ${node?.getText(ast)}`);
    return imports.get(node.text);
  };
  const pageCalls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'routeHandlerFactory') {
      const [root, component, head] = node.arguments;
      const layouts = [];
      function peel(expr) {
        if (ts.isCallExpression(expr)) {
          layouts.push(lookup(expr.expression));
          return peel(expr.arguments[0]);
        }
        return lookup(expr);
      }
      const page = peel(component);
      const heads = [];
      function findHeads(expr) {
        if (ts.isIdentifier(expr) && imports.get(expr.text)?.export === 'head') heads.push(lookup(expr));
        ts.forEachChild(expr, findHeads);
      }
      findHeads(head);
      const description = { kind: 'page', root: lookup(root), layouts, module: page, heads };
      pageCalls.push(description);
      edits.push([node.expression.getStart(ast), node.expression.end, `__eqPage.bind(null, ${JSON.stringify(description)})`]);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) content = content.slice(0, start) + replacement + content.slice(end);
  const prelude = `
const __eqLabels = new WeakMap();
function __eqWrap(fn, label) {
  if (typeof fn !== "function") return fn;
  const wrapped = function(...args) {
    globalThis.__recoolerTrace?.push(label);
    return Reflect.apply(fn, this, args);
  };
  __eqLabels.set(wrapped, label);
  return wrapped;
}
function __eqHOC(factory, label) {
  return function(...args) {
    return __eqWrap(Reflect.apply(factory, this, args), label);
  };
}
${wrappers.join('\n')}
function actionsMiddleware(actions) {
  const traced = Object.fromEntries(Object.entries(actions).map(([id, fn]) => [id, __eqWrap(fn, { kind: 'action', id })]));
  const handler = __eqOriginal_actionsMiddleware(traced);
  __eqLabels.set(handler, { kind: 'actions', actionIds: Object.keys(actions).sort() });
  return handler;
}
function groupMiddleware(handler, moduleId) {
  const wrapped = __eqOriginal_groupMiddleware(handler, moduleId);
  __eqLabels.set(wrapped, { kind: 'group-middleware', moduleId, source: __eqLabels.get(handler) });
  return wrapped;
}
function __eqPage(description, ...args) {
  return __eqWrap(__eqOriginal_routeHandlerFactory(...args), description);
}
`;
  if (!content.includes('const app =') || !content.includes('return app;')) throw new Error('Unrecognised Farm virtual app');
  content = content.replace('const app =', prelude + '\nconst app =');
  content = content.replace('return app;', `
globalThis.__recoolerEquivalence = app.routes.map((entry, index) => ({
  index, method: entry.method, path: entry.path,
  handler: __eqLabels.get(entry.handler) || { kind: 'unknown', name: entry.handler.name }
}));
return app;`);
  return { content, pageCalls };
}

export function snapshotPlugin(packageRoot) {
  let instrumented = false;
  return {
    name: 'recooler-private-equivalence', priority: 100,
    get instrumented() { return instrumented; },
    transform: { filters: { resolvedPaths: ['recooler::app-impl$'] }, executor({ content }) {
      const result = instrumentApp(content, packageRoot);
      instrumented = true;
      return { content: result.content, sourceMap: null };
    } },
  };
}

// Registration diagnostics are private adapter evidence, never the comparison contract.
export function summariseEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('No registered Hono routes captured');
  if (entries.some(entry => entry.handler.kind === 'unknown')) throw new Error('An unlabelled handler would make the snapshot incomplete');
  const groups = new Map();
  for (const entry of entries) {
    const key = JSON.stringify([entry.method, entry.path]);
    if (!groups.has(key)) groups.set(key, { method: entry.method, path: entry.path, handlers: [], actionIds: [] });
    const group = groups.get(key);
    group.handlers.push(entry.handler);
    group.actionIds = [...new Set([...group.actionIds, ...(entry.handler.actionIds || [])])].sort();
  }
  const routes = [...groups.values()];
  return { entries, routes, summary: {
    registeredEntries: entries.length, methodPathPairs: routes.length,
    paths: new Set(routes.map(route => route.path)).size,
    actionIds: new Set(routes.flatMap(route => route.actionIds)).size,
    actionRoutePairs: routes.reduce((sum, route) => sum + route.actionIds.length, 0),
    pages: entries.filter(entry => entry.handler.kind === 'page').length,
  } };
}
