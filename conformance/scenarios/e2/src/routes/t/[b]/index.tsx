export default function P(props: any) { return <div><p>b page</p><form hx-post={() => <p>b action</p>}><button>x</button></form></div>; }
export const onPost = (c: any) => c.text("b onPost");
