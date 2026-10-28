export const getDataPage = () => "data-page";
export const onGet = (_ctx: any, next: any) => next();
export const onRequest = (_ctx: any, next: any) => next();
export function onLoad() { document.documentElement.dataset.toolLoaded = "yes"; }
export default function ({ ctx }: any) {
  return <>{["alpha", "beta"].map(label => <button id={`choice-${label}`} ctx={ctx} hx-post={() => <p>selected:{label}</p>}>{label}</button>)}</>;
}
