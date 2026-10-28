export default function Layout(Page: any) { return (props: any) => <div><Page {...props} /><form hx-post={async () => <p>layout-post-action</p>}><button>l</button></form></div>; }
