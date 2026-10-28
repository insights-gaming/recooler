export function serializeScope(scope: Record<string, unknown>): string {
  for (const [name, value] of Object.entries(scope)) {
    assertSerializable(value, name, new Set());
  }

  return JSON.stringify(scope);
}

function assertSerializable(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): void {
  switch (typeof value) {
    case "string":
    case "boolean":
    case "undefined":
      return;
    case "number":
      if (Number.isFinite(value)) {
        return;
      }
      break;
    case "object": {
      if (value === null) {
        return;
      }

      if (ancestors.has(value)) {
        throw new TypeError(`cannot capture \`${path}\`: circular reference`);
      }

      const proto = Object.getPrototypeOf(value);
      if (
        !Array.isArray(value) &&
        proto !== Object.prototype &&
        proto !== null
      ) {
        break;
      }

      ancestors.add(value);
      for (const [key, child] of Object.entries(value)) {
        assertSerializable(
          child,
          Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`,
          ancestors,
        );
      }
      ancestors.delete(value);
      return;
    }
  }

  const kind =
    typeof value === "object"
      ? (Object.getPrototypeOf(value)?.constructor?.name ?? "object")
      : typeof value === "number"
        ? String(value)
        : typeof value;
  throw new TypeError(
    `cannot capture \`${path}\` (${kind}): only json compatible values may be captured by form actions and event handlers`,
  );
}

