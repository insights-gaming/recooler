import { getDataPage } from "../tools/list";
export const onGet = (ctx: any) => ctx.text(getDataPage());
