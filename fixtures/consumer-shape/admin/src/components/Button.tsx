export default function ({ children, ...props }: any) {
  return <button {...props}>{children}</button>;
}
