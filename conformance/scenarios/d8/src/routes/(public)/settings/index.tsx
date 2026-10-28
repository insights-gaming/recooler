export default function P(props: any) { return <div><p>public page</p><form hx-post={() => <p>public action</p>}><button>x</button></form></div>; }
