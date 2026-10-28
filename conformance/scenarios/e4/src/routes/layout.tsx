export default function Layout(Page: any) { return (props: any) => <div><Page {...props} /><form hx-post={async () => <p>layout action</p>}><button>l</button></form></div>; }
