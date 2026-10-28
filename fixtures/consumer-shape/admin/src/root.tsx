import { dangerouslyPreventEscaping } from "easy-jsx-html-engine";
import { renderHeadElements } from "farm-plugin-recooler/helpers";
export default function (Content: any, clientScript?: string) {
  return async (props: any) => {
    const content = await <Content {...props} />;
    return <html><head><meta charset="utf-8" />{renderHeadElements(props.head)}</head>
      <body hx-boost="true">{content}{clientScript ? <script>{dangerouslyPreventEscaping(`(()=>{${clientScript}})()`)}</script> : null}</body></html>;
  };
}
