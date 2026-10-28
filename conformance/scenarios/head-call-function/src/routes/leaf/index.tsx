function make() { return (_c: any, prev: any) => ({ ...prev, title: prev.title + "|Call" }); } export const head = make();
export default function Page() { return <p>leaf</p>; }
