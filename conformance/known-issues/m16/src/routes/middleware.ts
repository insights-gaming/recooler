const mw = async (c: any, next: any) => { await next(); };
export { mw as "default" };
