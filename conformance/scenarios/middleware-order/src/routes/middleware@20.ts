export default async (c: any, next: any) => { (globalThis.__t ??= []).push("plain-20"); await next(); };
