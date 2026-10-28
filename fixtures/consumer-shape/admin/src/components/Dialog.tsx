import Button from "./Button";
export default function ({ children, ...props }: any) {
  return <Button {...props} data-parent-click={props["hx-on-click"]}
    hx-on-click={function (this: HTMLButtonElement, event: Event) {
      event.preventDefault();
      const parent = this.getAttribute("data-parent-click");
      if (parent) eval(parent);
    }}>{children}</Button>;
}
