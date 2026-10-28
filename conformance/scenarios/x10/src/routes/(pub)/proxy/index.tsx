// nested dispatch inside a handler: app.request with the caller's headers
export const onGet = async (c: any) => { (globalThis.__t ??= []).push("proxy"); const r = await globalThis.__app.request("/admin", { headers: c.req.raw.headers }); return new Response(await r.text(), { status: r.status }); };
