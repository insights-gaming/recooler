export const onGet = (ctx: any) => ctx.text(`result:${ctx.req.param("id")}`);
