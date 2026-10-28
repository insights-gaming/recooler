// Reclassify saved captures without changing/rebuilding the captured artifacts.
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { canonicalCatalog, comparisonRecord, compareTraces } from './traces.mjs';
const [beforeFile, afterFile, option, allowancesFile] = process.argv.slice(2);
if (!beforeFile || !afterFile || (option && (option !== '--expect-diff' || !allowancesFile))) throw new Error('Usage: compare.mjs BEFORE.json AFTER.json [--expect-diff PRIVATE.json]');
const before=JSON.parse(await readFile(beforeFile,'utf8')),after=JSON.parse(await readFile(afterFile,'utf8'));
if (before.schemaVersion !== 3 || after.schemaVersion !== 3) throw new Error('Comparison requires schemaVersion 3 captures');
const entries=allowancesFile ? JSON.parse(await readFile(allowancesFile,'utf8')) : [];
if (!Array.isArray(entries) || entries.some(entry => !['router','admin'].includes(entry.package))) throw new Error('Invalid expected-difference packages');
const packages={};
for (const name of ['router','admin']) {
  const b=before.packages[name],a=after.packages[name];
  const expected=comparisonRecord(b),actual=comparisonRecord(a);
  const result=compareTraces(expected,actual,entries.filter(entry => entry.package===name));
  const catalogEqual=isDeepStrictEqual(canonicalCatalog(b.catalog),canonicalCatalog(a.catalog));
  packages[name]={cases:b.traces.length,identical:expected.filter((trace,index)=>isDeepStrictEqual(trace,actual[index])).length,
    acceptedCases:new Set(result.accepted.map(field=>field.index)).size,acceptedFields:result.accepted.length,
    unexplained:result.differences.length,stale:result.unused.length,catalogEqual};
  if (!result.equal || !catalogEqual) process.exitCode=1;
}
console.log(JSON.stringify({packages},null,2));
