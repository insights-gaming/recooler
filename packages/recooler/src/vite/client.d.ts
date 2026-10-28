/** Add `/// <reference types="recooler/vite/client" />` to your env.d.ts.
 * Augment RouteEnv in recooler/jsx to type the app's Bindings and Variables. */
declare module 'virtual:recooler/app' {
  const app: import('hono').Hono<import('recooler/jsx').RouteEnv>;
  export default app;
}
declare module 'virtual:recooler/htmx' {
  export const table: import('recooler/htmx').ActionTable;
  export const clients: import('recooler/htmx').ActionTable;
  export const clientModules: Readonly<Record<string, string>>;
  export const clientEntry: string;
  export const clientPreloads: Readonly<Record<string, readonly string[]>>;
  export const namespace: string;
  export const enabled: boolean;
}
