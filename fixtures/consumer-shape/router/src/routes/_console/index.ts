export const onRequest = (ctx: any) => ctx.env.SERVICE.fetch(ctx.req.raw);
