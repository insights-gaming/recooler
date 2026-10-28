import { ErrorBoundary as EngineBoundary } from "easy-jsx-html-engine";
import { ErrorBoundary, Suspense } from "farm-plugin-recooler/helpers";
async function Deferred() { return <small>resolved</small>; }
const errorHandler = (error: Error) => <small>boundary:{error.message}</small>;
export default function (Content: any) {
  return (props: any) => props.ctx.req.header("hx-request") === "true" ? <Content {...props} /> : <main data-layout="panel"><ErrorBoundary catch={errorHandler}><EngineBoundary catch={errorHandler}><Content {...props} /></EngineBoundary></ErrorBoundary>
    <Suspense catch={errorHandler} rid={props.rid} fallback={<small>pending</small>}><Deferred /></Suspense></main>;
}
export function head(_ctx: any, previous: any) { return { ...previous, title: "Panel" }; }
// 0.0.27 warns and deliberately excludes layout onLoad from the client script.
export const onLoad = () => { document.documentElement.dataset.layoutIgnored = "yes"; };
