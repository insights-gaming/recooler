export default function P(props: any) { return <div><p>rest</p><button hx-post={() => "action rest"}>x</button></div>; }
export const onPost = (c: any) => c.text("onPost rest");
