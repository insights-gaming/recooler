/** @jsxImportSource @insights-gaming/recooler/jsx */
import type { Context } from 'hono';
export function SpreadWrapper(props: { ctx: Context; title: string }) {
  return <button {...props}>spread</button>;
}
export function NestedSpreadWrapper(props: { ctx: Context; title: string }) {
  return <button {...{ ...props, title: 'nested' }}>nested</button>;
}
