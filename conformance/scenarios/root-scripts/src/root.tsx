export default function Root(Content: any, clientScript?: string) {
  return (props: any) => {
    if (!Array.isArray(props.scripts)) throw new Error("props.scripts must be an array");
    return <html><head><title>Scripts root</title></head><body><Content {...props} />{props.scripts.map((src: string) => <script type="module" src={src}></script>)}</body></html>;
  };
}
