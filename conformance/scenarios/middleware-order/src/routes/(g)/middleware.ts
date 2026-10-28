export default async (c: any, next: any) => { (globalThis.__t ??= []).push("group-base"); await next(); };
