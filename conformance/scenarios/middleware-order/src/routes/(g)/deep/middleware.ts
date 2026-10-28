export default async (c: any, next: any) => { (globalThis.__t ??= []).push("deep"); await next(); };
