// Preserve Hono's return propagation when a later handler returns undefined.
export default async function (_ctx: any, next: any) {
  return await next();
}
