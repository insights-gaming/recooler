export default function Page(props: any) {
 const value = props.ctx.req.param("rest");
 return <button ctx={props.ctx} hx-post={(c: any) => <p>{c.req.param("rest")}</p>}>{value}</button>;
}
