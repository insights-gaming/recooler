export default async (c: any, next: any) => { (globalThis.__t ??= []).push("plain-base"); await next(); };
