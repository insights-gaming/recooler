export default async function auth(c: any, next: any) { (globalThis.__t ??= []).push("auth"); await next(); }
