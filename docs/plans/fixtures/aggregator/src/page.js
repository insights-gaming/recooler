import { Button } from "./components/Button.js";
import * as __dep0 from "./components/Button.js";
import * as __dep1 from "./components/Cycle.js";
import * as __dep2 from "./plain.js";
export default () => Button();
export const _action$post$0 = () => "page-action";
export function __recooler() {
  return { name: "page", actions: { "page@0": _action$post$0 }, deps: [() => __dep0.__recooler, () => __dep1.__recooler, () => __dep2.__recooler] };
}
