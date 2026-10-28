/** Add `/// <reference types="recooler/vite/client" />` to your env.d.ts.
 * Augment RouteEnv in recooler/jsx to type the app's Bindings and Variables. */
declare module 'virtual:recooler/app' {
  const app: import('hono').Hono<import('recooler/jsx').RouteEnv>;
  export default app;
}
