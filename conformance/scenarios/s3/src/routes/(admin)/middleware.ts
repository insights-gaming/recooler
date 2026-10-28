export default async function (c: any, next: any) { (globalThis.__t ??= []).push("admin-group"); return c.text("BLOCKED by admin-group", 401); }
