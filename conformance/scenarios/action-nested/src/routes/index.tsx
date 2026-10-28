export default function Page({ ctx }: any) {
 const captured = "scope <&>";
 return <div>
 <button {...{ ctx, "hx-post": () => <p>{captured}</p> }}>shorthand</button>
 <button data-hx-post={() => <p>data action</p>}>data</button>
 <button ctx={ctx} hx-post={(c: any) => <button hx-post={(inner: any) => <p>nested {inner.req.path}</p>}>inner</button>}>outer</button>
 </div>;
}
