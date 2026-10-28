// Intentionally unreachable: a source action site is not necessarily registered.
export default function UnusedAction() {
  return <button hx-post={() => <p>unused</p>}>unused</button>;
}
