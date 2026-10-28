export default function Admin() { return <button hx-post={() => { (globalThis.__t ??= []).push("action admin-barrel"); return "admin barrel action"; }}>admin</button>; }
