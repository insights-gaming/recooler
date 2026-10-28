export default function Admin(_props: RouteProps) {
  return <><h1>admin</h1><button id="admin-handler" hx-on:click={function (this: HTMLButtonElement) { this.textContent = 'admin clicked'; }}>admin action</button></>;
}
