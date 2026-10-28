import type { RouteHeadFn } from '../../../../src/jsx/index.js';
export const head: RouteHeadFn = (_ctx, prev) => ({ ...prev, title: `${prev.title}/function` });
