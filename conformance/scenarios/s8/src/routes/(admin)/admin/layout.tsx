export default function Layout(Page: any) {
  return (props: any) => <div><Page {...props} /><button hx-post={(ctx: any) => "layout-action user=" + ctx.get("user")}>l</button></div>;
}
