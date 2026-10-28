export default async function (c: any, next: any) { (globalThis.__t ??= []).push("secure-dir"); return c.text("BLOCKED by secure-dir", 401); }
