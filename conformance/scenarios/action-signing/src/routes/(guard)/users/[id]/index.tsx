export default function Page(props: any) {
 const value = "original";
 return <div>
  <button hx-post={() => { (globalThis.__t ??= []).push("action plain"); return "plain action"; }}>plain</button>
  <button hx-post={() => { (globalThis.__t ??= []).push("action scoped"); return "scoped " + value; }}>scoped</button>
  <button hx-get={() => { (globalThis.__t ??= []).push("action get"); return "get action"; }}>get</button>
 </div>;
}
