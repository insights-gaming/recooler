export const onRequest = async (c: any, next: any) => { (globalThis.__t ??= []).push("onRequest hookonly user=" + c.get("user")); await next(); };
