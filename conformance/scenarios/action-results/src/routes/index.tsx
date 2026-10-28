import { html } from "hono/html";
export const onPost = (c: any) => c.text("ordinary POST");
export const onOptions = (c: any) => c.text("options", 200, { Allow: "GET, POST, OPTIONS" });
export default function Page(props: any) { return <div>
<button hx-post={() => "<b>&text</b>"}>string</button>
<button hx-post={() => new Response("passthrough", { status: 202, headers: { "x-result": "response" } })}>response</button>
<button hx-post={() => { throw new Response("thrown", { status: 409, headers: { "x-result": "thrown" } }); }}>throw</button>
<button hx-post={() => null}>null</button>
<button hx-post={() => undefined}>undefined</button>
<button hx-post={() => ["a&", <b>b</b>, Promise.resolve("c<")]}>array</button>
<button hx-post={() => html`<em>raw</em>`}>html</button>
<button hx-post={() => ({ toHTML: () => "<i>sync</i>" })}>sync</button>
<button hx-post={() => ({ toHTML: async () => "<i>async</i>" })}>async</button>
<button hx-get={() => <p>get action</p>}>get</button>
</div>; }
