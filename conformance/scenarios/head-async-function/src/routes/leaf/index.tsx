export async function head(_c: any, prev: any) { return { ...prev, title: prev.title + "|Async" }; }
export default function Page() { return <p>leaf</p>; }
