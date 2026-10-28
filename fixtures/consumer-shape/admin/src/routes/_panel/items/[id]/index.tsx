import Items from "../index";
import Tools from "../../tools/list";
import { SharedAction } from "../../../../components";
export function head(_ctx: any, previous: any) { return { ...previous, title: `Item - ${previous.title}` }; }
export const onLoad = () => { document.documentElement.dataset.routeLoaded = "yes"; };
export default function ({ ctx }: any) { return <><h1>item:{ctx.req.param("id")}</h1><SharedAction ctx={ctx} value={ctx.req.param("id")} /><Items ctx={ctx} /><Tools ctx={ctx} /></>; }
