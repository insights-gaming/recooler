// nested dispatch of the very same Request object, from a public route
export const onGet = async (c: any) => { (globalThis.__t ??= []).push("inner"); const r = await globalThis.__app.fetch(new Request(new URL("/admin", c.req.url), c.req.raw)); return new Response(await r.text(), { status: r.status }); };
