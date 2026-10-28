import { isRuntimeVariable } from "./analysis.js";
import type { Analysis, Node } from "./analysis.js";
import { attrName } from "./collect.js";

/** Runtime onLoad declarations and export specifiers, independent of mode. */
export function onLoadExports(analysis: Analysis): Set<Node> {
  const exports = new Set<Node>();
  for (const item of analysis.program.body) {
    if (item.type === "ExportAllDeclaration" && item.exportKind !== "type" && item.exported && attrName(item.exported) === "onLoad") {
      exports.add(item);
    }
    if (item.type !== "ExportNamedDeclaration" || item.exportKind === "type") continue;
    const decl = item.declaration;
    if (decl && !("declare" in decl && decl.declare)) {
      if (decl.type === "FunctionDeclaration" && decl.id?.name === "onLoad") exports.add(decl);
      if (decl.type === "VariableDeclaration") for (const part of decl.declarations) {
        if (part.id.type === "Identifier" && part.id.name === "onLoad") exports.add(part);
      }
    }
    for (const spec of item.specifiers) {
      if (attrName(spec.exported) === "onLoad" && !(spec.type === "ExportSpecifier" && spec.exportKind === "type")
        && (item.source || analysis.refs(spec).some(r => r.resolved && isRuntimeVariable(r.resolved)))) exports.add(spec);
    }
  }
  return exports;
}
