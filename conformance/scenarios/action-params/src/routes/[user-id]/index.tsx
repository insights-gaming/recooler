export default function Page(props: any) {
 const value = props.ctx.req.param("user-id");
 return <button ctx={props.ctx} hx-post={(c: any) => <p>{c.req.param("user-id")}</p>}>{value}</button>;
}
