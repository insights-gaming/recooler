export const head = (_c: any, prev: any) => { prev.title += "|page"; prev.metas.push({ name: "added", content: "once" }); return prev; };
export default function Page() { return <p>bare page</p>; }
