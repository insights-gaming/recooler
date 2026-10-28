import { createElement as h, Suspense } from 'easy-jsx-html-engine';
import { renderToStream } from 'easy-jsx-html-engine/stream-webapi';

// The gate is released by the caller only AFTER it receives the streaming Response.
export function createContextApp(Hono, contextStorage, getContext, routePath, timed = false) {
  const gates = new Map();
  const child = new Hono();
  child.get('/item/:id/:rest{.+}', (c) => {
    const id = c.req.param('id');
    c.set('requestId', id);
    let release;
    const gate = timed ? new Promise(r => { setTimeout(r, 100); release = () => {}; })
      : new Promise(r => { release = r; });
    gates.set(id, release);
    const matched = { routePath: routePath(c), params: { ...c.req.param() } };
    const snapshot = (where) => {
      const ambient = getContext();
      if (ambient !== c) throw new Error('context leaked: ' + id);
      return { where, id: ambient.get('requestId'), propertyRoutePath: ambient.req.routePath ?? null, routePath: routePath(ambient),
        params: ambient.req.param(), matched, url: new URL(ambient.req.url).pathname };
    };
    const initial = snapshot('initial');
    const pending = [];
    const stream = renderToStream(rid => h('main', {},
      h('pre', { 'data-record': true }, JSON.stringify(initial)),
      h(Suspense, { rid, fallback: h('i', {}, 'waiting') }, (async () => {
        await gate;
        const late = snapshot('after-response');
        await Promise.resolve();
        return h('pre', { 'data-record': true }, JSON.stringify(late));
      })()),
      // .toHTML runs in the renderer after the initial writable stream is consumed.
      { toHTML() { return '<b>' + JSON.stringify(snapshot('toHTML')) + '</b>'; } }
    ), { waitUntil: p => { pending.push(p); try { c.executionCtx.waitUntil(p); } catch {} } });
    return new Response(stream, { headers: { 'content-type': 'text/html' } });
  });
  const app = new Hono();
  app.use('*', contextStorage());
  app.get('/release/:id', c => {
    const release = gates.get(c.req.param('id'));
    gates.delete(c.req.param('id'));
    release?.();
    return c.json({ released: !!release });
  });
  app.route('/mount', child);
  app.route('/base', new Hono().basePath('/nested').route('/', child));
  return app;
}
