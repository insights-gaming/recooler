export const onPost = async (ctx: any) => ctx.text(`posted:${await ctx.req.text()}`);
