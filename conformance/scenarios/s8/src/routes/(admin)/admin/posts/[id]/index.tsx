export const onPost = (c: any) => { (globalThis.__t ??= []).push("onPost admin-posts-id"); return c.text("onPost admin-posts-id user=" + c.get("user") + " id=" + c.req.param("id")); };
