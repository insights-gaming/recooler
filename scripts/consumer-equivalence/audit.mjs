// Replays the complete ordered history, then saves every changed HTML response.
// Private source, bodies, paths and reports are never written into this repository.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizeHtml, responseRecord } from './traces.mjs';
const [beforeFile, afterFile, output, rulesFile] = process.argv.slice(2);
if (!beforeFile || !afterFile || !output || !resolve(output).startsWith('/private/tmp/')) throw new Error('Usage: audit.mjs BEFORE.json AFTER.json /private/tmp/AUDIT');
await mkdir(output, { recursive: true });
const before = JSON.parse(await readFile(beforeFile, 'utf8')), after = JSON.parse(await readFile(afterFile, 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const pick = trace => Object.fromEntries(Object.entries(trace).filter(([key]) => ['status','headers','htmlDigest','bodyBase64','error','errorMessage','returnedType'].includes(key)));
// These substitutions are deliberately an audit layer, not equivalence allowances.
// The compared digest still includes every script and client wrapper change.
export function frameworkHtml(html, canonicalActionId) {
  return normalizeHtml(html, canonicalActionId)
    .replace(/\n    at [^\n<]*/g, '')
    .replace(/<script>\(\(\)=>\{(?:(?!<\/script>)[\s\S])*?window\.\$handlers=(?:(?!<\/script>)[\s\S])*?\}\)\(\)<\/script>/g, '')
    .replace(/<script>\(\(\)=>\{import\("[^" ]*\/assets\/recooler-client\.js\?v=<build>"\)\.then\(m=>m\.init\(\)\)\}\)\(\)<\/script>/g, '')
    .replace(/<script type="module"(?: async)? src="[^" ]*\/assets\/recooler-(?:client|route-[a-f0-9]+)\.js\?v=<build>"><\/script>/g, '')
    .replace(/<link rel="modulepreload" href="[^" ]*\/assets\/recooler-slice-<build>-\d+\.js"\/?>/g, '')
    .replace(/<template data-recooler-marker="true" data-recooler-version="<build>"><\/template>/g, '')
    .replace(/(hx-on[:-][^= ]+="|x-parent-on-click=")([^" ](?:[^" ]| )*)"/g, (whole, attr, code) => {
      const legacy = code.match(/^\$handlers\[&quot;([^&]+)&quot;\]\.call\(this, event\)$/);
      const current = code.startsWith('(self.$rc||') && code.match(/\(&quot;([^&]+)&quot;,null,this,event\)$/);
      if (legacy) return attr + 'HANDLER:' + legacy[1] + '"';
      if (current) return attr + 'HANDLER:src/' + current[1] + '"';
      return whole;
    })
    .replace(/(hx-(?:get|post|put|patch|delete)=")([^"]+)/g, (_, attr, url) => attr + url.replace(/%5F/gi, '_'))
    .replace(/&amp;scope=%7B%7D/g, '')
    .replace(/&amp;sig=<volatile>/g, '');
}
const rules = rulesFile ? JSON.parse(await readFile(rulesFile, 'utf8')) : [];
for (const rule of rules) {
  if (!['before','after'].includes(rule.side) || !rule.find || typeof rule.replace !== 'string' || !rule.reason?.trim()) throw new Error('Audit rules require side, exact literal find/replace and reason');
  rule.applied = 0;
}
const review = (html, side, canonical) => {
  for (const rule of rules.filter(rule => rule.side === side)) {
    const count = html.split(rule.find).length - 1;
    rule.applied += count;
    html = html.replaceAll(rule.find, rule.replace);
  }
  return frameworkHtml(html, canonical);
};
const records = [];
for (const name of ['router', 'admin']) {
  const load = async (snapshot, file) => {
    const run = dirname(resolve(file));
    const adapter = await import(`./adapters/${snapshot.target}.mjs`);
    const spec = JSON.parse(await readFile(join(run,name,'probe-options.json'),'utf8'));
    return adapter.load({packageRoot:join(run,'checkout/packages',name),packageOut:join(run,name),spec});
  };
  const b = await load(before,beforeFile), a = await load(after,afterFile);
  try {
    const bs=before.packages[name], as=after.packages[name];
    assert.equal(bs.traces.length,as.traces.length);
    for(let offset=0;offset<bs.traces.length;offset+=32) {
      const cases=bs.traces.slice(offset,offset+32).map(t=>t.request);
      const replay=async app=>app.dispatchBatch(await Promise.all(cases.map(async request=>({...request,caseKey:JSON.stringify(request),path:request.action?await app.actionUrl(request):request.path}))));
      const br=await replay(b), ar=await replay(a);
      for(let j=0;j<cases.length;j++) {
        const index=offset+j;
        assert.deepEqual(responseRecord(br[j],b.canonicalActionId),pick(bs.traces[index]),`${name} ${index} baseline replay`);
        assert.deepEqual(responseRecord(ar[j],a.canonicalActionId),pick(as.traces[index]),`${name} ${index} candidate replay`);
        const changed=!isDeepStrictEqual(pick(bs.traces[index]),pick(as.traces[index]));
        if(!changed || ![br[j],ar[j]].some(r=>/^\s*</.test(r.body))) continue;
        const prefix=`${name}-${index}`;
        await writeFile(join(output,prefix+'-before.html'),br[j].body);
        await writeFile(join(output,prefix+'-after.html'),ar[j].body);
        const reviewedBefore=review(br[j].body,'before',b.canonicalActionId),reviewedAfter=review(ar[j].body,'after',a.canonicalActionId);
        const same=reviewedBefore===reviewedAfter;
        if(!same){await writeFile(join(output,prefix+'-before-reviewed.html'),reviewedBefore);await writeFile(join(output,prefix+'-after-reviewed.html'),reviewedAfter);}
        records.push({name,index,statusBefore:br[j].status,statusAfter:ar[j].status,rawBefore:sha(br[j].body),rawAfter:sha(ar[j].body),reviewedBefore:sha(reviewedBefore),reviewedAfter:sha(reviewedAfter),same,replayMatches:true});
      }
    }
  }finally{await b.dispose();await a.dispose();}
}
const summary={checked:records.length,equivalentAfterFrameworkChanges:records.filter(r=>r.same).length,remaining:records.filter(r=>!r.same).map(({name,index,statusBefore,statusAfter})=>({name,index,statusBefore,statusAfter}))};
await writeFile(join(output,'audit.json'),JSON.stringify({summary,records,rules:rules.map(({find,replace,...rule})=>({...rule,findHash:sha(find),replaceHash:sha(replace)}))},null,2)+'\n');
console.log(JSON.stringify(summary));

assert(rules.every(rule => rule.applied > 0), 'Stale private audit rule');
