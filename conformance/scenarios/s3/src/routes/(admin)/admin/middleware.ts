export default async function (c: any, next: any) { (globalThis.__t ??= []).push("admin-dir"); return c.text("BLOCKED by admin-dir", 401); }
