export const onGet = (ctx: any) => ctx.text(`docs:${ctx.req.param("path") || "root"}`);
