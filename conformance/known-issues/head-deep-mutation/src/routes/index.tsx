export const head = (_c: any, prev: any) => { prev.metas[0].content += "x"; return prev; };
export default function Page() { return <p>page</p>; }
