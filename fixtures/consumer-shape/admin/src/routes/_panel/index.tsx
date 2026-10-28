import Button from "../../components/Button";
import Dialog from "../../components/Dialog";
export const head = (_ctx: any, previous: any) => ({ ...previous, title: `Home - ${previous.title}` });
export default function ({ ctx }: any) {
  return <><h1>panel home</h1><button id="throw" hx-post={() => { throw new Error("synthetic failure"); }}>throw</button><form id="save" hx-on-submit={(event: Event) => { event.preventDefault(); }} hx-post={(_ctx: any, payload: { value: string; __formData: FormData }) => <p>saved:{payload.value}:{payload.__formData.get("value")}</p>}><input name="value" /></form>
    <Button id="quiet" ctx={ctx} hx-post={() => {}}>quiet</Button>
    <Button id="remove" ctx={ctx} hx-delete={(c: any) => c.text("removed", 202)}>remove</Button>
    <Dialog hx-on-click={function (this: HTMLButtonElement) { this.dataset.parent = "yes"; }}>dialog</Dialog>
    <input data-hx-on--before-swap="event.detail.shouldSwap = true" hx-on:change="this.dataset.changed = 'yes'" hx-on:input={function (this: HTMLInputElement) { this.dataset.edited = "yes"; }} />
    <select hx-get="/_panel" name="limit" hx-trigger="change"><option>10</option></select></>;
}
