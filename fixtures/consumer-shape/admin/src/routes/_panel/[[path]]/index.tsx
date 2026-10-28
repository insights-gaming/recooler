export const head = (_ctx: any, previous: any) => ({ ...previous, title: `Missing - ${previous.title}` });
export default function ({ ctx }: any) { ctx.status(404); return <h1>missing:{ctx.req.param("path")}</h1>; }
