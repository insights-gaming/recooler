import * as __dep0 from "./Cycle.js";
import { clientOnly } from "./client-only.js";
export const Button = () => "button";
export const _action$post$0 = () => "button-action";
export const _handler$0 = () => clientOnly();
export function __recooler() {
  return { name: "button", actions: { "button@0": _action$post$0 }, deps: [() => __dep0.__recooler] };
}
