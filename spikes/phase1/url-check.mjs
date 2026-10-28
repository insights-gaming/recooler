import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Hono as Hono4 } from 'hono';
import { Hono as Hono5 } from 'hono5';
import { routePath as path4 } from 'hono/route';
import { routePath as path5 } from 'hono5/route';
const results = [];
for (const [version,Hono,routePath] of [['4',Hono4,path4],['5rc',Hono5,path5]]) {
  const app = new Hono();
  const child = new Hono().basePath('/nested');
  child.get('/item/:id/:rest{.+}', c => {
    const params = c.req.param();
    const pattern = routePath(c);
    const rebuilt = pattern.replace(':id',encodeURIComponent(params.id)).replace(':rest{.+}',params.rest.split('/').map(encodeURIComponent).join('/'));
    return c.json({pattern,params,rebuilt,original:new URL(c.req.url).pathname});
  });
  app.route('/mount',child);
  for (const rest of ['one/two%20three','one%2Ftwo/three']) {
    const result = await (await app.request('http://spike.test/mount/nested/item/a%2Fb/' + rest)).json();
    assert.equal(result.rebuilt === result.original, !rest.includes('%2F'));
    results.push({version,...result,exact:result.rebuilt===result.original});
  }
}
writeFileSync(new URL('results/urls.json',import.meta.url),JSON.stringify(results,null,2)+'\n');
console.log('URL reconstruction PASS: encoded scalar, catch-all segments, encoded-slash information loss');
