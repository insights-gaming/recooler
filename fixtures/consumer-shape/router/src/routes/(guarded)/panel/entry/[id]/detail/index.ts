export const onGet = (ctx: any) => ctx.text(`detail:${ctx.req.param("id")}`);
