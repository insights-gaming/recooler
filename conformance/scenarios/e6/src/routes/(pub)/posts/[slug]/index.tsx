export default function P(props: any) { return <div><p>pub page</p><form hx-post={() => <p>pub action</p>}><button>x</button></form></div>; }
