import type { RouteHead } from '../../../../../../src/jsx/index.js';
export function head(_ctx: unknown, prev: RouteHead) { return { ...prev, title: `${prev.title} / custom` }; }
export default function Page() { return <h1>Custom root</h1>; }
export function onLoad() { document.title = 'loaded'; }
