export const head = { title: 'Welcome & hello', base: '/base/', metas: [{ name: 'description', content: 'a < b & c' }], links: [{ rel: 'stylesheet', href: '/style.css' }], scripts: [{ src: '/head.js', defer: true }] };
export default function Page() {
  return <p id="greeting">Hello {'<world>'} &amp; friends</p>;
}
