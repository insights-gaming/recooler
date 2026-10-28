export default function Page() { return <button hx-on:click={function () { console.log("root-scripts-handler"); }}>click</button>; }
