import type { ActionUrlEmission, RegistrationEmission } from "./types.js";

/** D3: the runtime reads ambient request context; a supplied ctx overrides it. */
export function emitActionUrl({ id, scope, context, helper }: ActionUrlEmission): string {
  return `${helper}(${JSON.stringify(id)}, ${scope}${context ? `, ${context}` : ""})`;
}

/** D5: one module-level registry side effect, grouped by HTTP method. */
export function emitRegistration({ moduleId, actions, helper, namespace, moduleHash }: RegistrationEmission): string {
  const groups = new Map<string, string[]>();
  for (const action of actions) {
    const entries = groups.get(action.method) ?? [];
    entries.push(`${JSON.stringify(action.id)}: ${action.exportName}`);
    groups.set(action.method, entries);
  }
  const metadata = namespace !== undefined || moduleHash !== undefined
    ? `, ${JSON.stringify(namespace ?? "")}, ${JSON.stringify(moduleHash ?? "")}` : "";
  return `${helper}(${JSON.stringify(moduleId)}, { ${[...groups].map(([method, entries]) =>
    `${method}: { ${entries.join(", ")} }`).join(", ")} }${metadata});`;
}
