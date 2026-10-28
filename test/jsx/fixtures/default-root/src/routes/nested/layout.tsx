import type { RouteHead } from '../../../../../../../src/jsx/index.js';
// A head-only layout must not wrap the route.
const x = (_ctx: unknown, prev: RouteHead) => ({ ...prev, title: `${prev.title} / head-only` });
export { x as head };
