export default function P(props: any) { return <div><p>page-with-action slug={props.ctx.req.param("slug")}</p><button hx-post={() => <p>page-action</p>}>a</button></div>; }
