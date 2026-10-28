import Button from "./Button";
import { SERVER_MARKER } from "../lib/server-only";
export function SharedAction(props: { ctx: any; value: string }) {
  // Only the serializable value is captured, never the request context.
  const { ctx, ...values } = props;
  return <Button ctx={ctx} id="shared" data-marker={SERVER_MARKER}
    hx-post={() => <p>shared:{values.value}</p>} hx-on-click={function (this: HTMLButtonElement) { this.dataset.clicked = "yes"; }}>shared</Button>;
}
