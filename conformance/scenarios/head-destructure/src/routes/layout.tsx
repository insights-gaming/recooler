export const head = (_ctx: any, prev: any) => ({ ...prev, title: prev.title + "|Layout" });
export default function Layout(Page: any) { return (props: any) => <section data-layout="yes"><Page {...props} /></section>; }
