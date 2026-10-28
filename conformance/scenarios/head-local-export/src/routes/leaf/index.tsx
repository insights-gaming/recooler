const head = (_c: any, prev: any) => ({ ...prev, title: prev.title + "|Local" }); export { head };
export default function Page() { return <p>leaf</p>; }
