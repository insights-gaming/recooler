// Generates a synthetic recooler app for build benchmarks.
// Usage: node gen-app.mjs <dir> <routes> [--no-handlers]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, routes, flag] = process.argv.slice(2);
const count = Number(routes);
const handlers = flag !== "--no-handlers";
const src = join(dir, "src");

const PAGE = `import { db } from "../../lib/db";
import { Card } from "../../components/card";
const LIMIT = 20;
export default async function Page0(props) {
  const { ctx, url } = props;
  const items = await db.list(LIMIT);
  const user = ctx.get("user");
  return (
    <Card title="page 0">
      <ul>
        {items.map((item, idx) => (
          <li key={item.id} class={idx % 2 ? "odd" : "even"}>
            <span>{item.title}</span>
            <button hx-post={async (ctx) => { await db.remove(item.id, user.id); return <></>; }} hx-swap="outerHTML">delete</button>
            <button hx-on:click={function (e) { this.classList.toggle("open"); console.log(item.id, idx); }}>toggle</button>
          </li>
        ))}
      </ul>
      <form hx-post={async (ctx, payload) => { await db.add(payload.title, user.id); return <p>added {payload.title}</p>; }}>
        <input name="title" />
        <button>add</button>
      </form>
      <div hx-get={() => <p>refreshed at {url.pathname}</p>}>refresh</div>
    </Card>
  );
}
function helper(a, b) { return a + b; }
export const metadata = { title: "page 0", tags: ["a", "b", "c"], weight: helper(1, 2) };
`;

function write(path, content) {
  mkdirSync(join(src, path, ".."), { recursive: true });
  writeFileSync(join(src, path), content);
}

rmSync(src, { recursive: true, force: true });
write("lib/db.ts", `export const db = {
  async list(n: number) { return Array.from({ length: n }, (_, i) => ({ id: i, title: "item " + i })); },
  async remove(id: number, user: string) { console.log("remove", id, user); },
  async add(title: string, user: string) { console.log("add", title, user); },
};
`);
write("components/card.tsx", `export function Card(props: { title: string; children?: any }) {
  return <section><h2>{props.title}</h2>{props.children}</section>;
}
`);
write("root.tsx", `import { DefaultRootHOC } from "farm-plugin-recooler/helpers";
export default DefaultRootHOC;
`);
write("routes/index.tsx", `export default function Home() { return <h1>home</h1>; }
`);

const page = handlers ? PAGE : PAGE.split("\n").filter((line) => !line.includes("hx-on:click")).join("\n");
for (let i = 0; i < count; i++) {
  write(`routes/p${i}/index.tsx`, page.replaceAll("Page0", `Page${i}`).replaceAll("page 0", `page ${i}`));
}

console.log(`generated ${count} routes (handlers: ${handlers}) in ${src}`);
