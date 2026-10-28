/** Add `/// <reference types="recooler/vite/client" />` to your env.d.ts. */
declare module 'virtual:recooler/app' {
  const app: import('hono').Hono;
  export default app;
}
