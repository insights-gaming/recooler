export default async function (c: any, next: any) { (globalThis.__t ??= []).push("admin"); return c.text("BLOCKED admin", 401); }
