export default function Layout(Page: any) { return (props: any) => <div><Page {...props} /><form hx-get={async () => <p>layout-get-action</p>}><button>l</button></form></div>; }
