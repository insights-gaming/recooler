import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export function samplePath(path, second = false) {
  return path.replace(/:([^/{}]+)(?:\{([^}]+)\})?/g, (_, _name, regex) => regex ? (second ? 'other/leaf' : 'sample/child') : (second ? 'other-value' : '7'))
    .replace(/\/\*$/, second ? '/other/leaf' : '/sample/child');
}
function pathVariants(pattern) {
  const path = samplePath(pattern);
  const encoded = path.replace(/[^/]/, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  return [...new Set([path, samplePath(pattern, true), path === '/' ? path : path + '/', encoded])];
}
export function generateRequests(catalog, options = {}) {
  const requests = new Map();
  const profiles = [
    { name: 'htmx', headers: { 'hx-request': 'true', origin: 'http://localhost', 'sec-fetch-site': 'same-origin' } },
    { name: 'plain', headers: {} },
    ...(options.clientVariants || []),
  ];
  if (new Set(profiles.map(x => x.name)).size !== profiles.length) throw new Error('Client variant names must be unique');
  const add = (path, method, kind, action) => {
    for (const profile of profiles) {
      const key = JSON.stringify([method, path, profile.name]);
      if (!requests.has(key)) requests.set(key, { path, method, kind, variant: profile.name,
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...profile.headers },
        ...(!['GET', 'HEAD'].includes(method) ? { body: kind.includes('action') ? 'value=sample&item=7' : '' } : {}),
        ...(action ? { action } : {}) });
    }
  };
  for (const route of catalog.routes) {
    for (const path of pathVariants(route.path)) {
      for (const method of methods) add(path, method, 'route');
      for (const method of methods) add(`${path}?action=__unknown__`, method, 'unknown-action');
      for (const action of route.actions) add(`${path}?action=${encodeURIComponent(action.id)}`, action.method, 'known-action', {
        routeId: route.path, pathname: path, method: action.method, actionId: action.id,
      });
    }
    const segments = samplePath(route.path).split('/').filter(Boolean);
    for (let i = 0; i <= segments.length; i++) {
      const prefix = '/' + segments.slice(0, i).join('/');
      for (const method of methods) {
        add(prefix, method, 'parent');
        add(`${prefix === '/' ? '' : prefix}/__unmatched__`, method, 'unmatched-prefix');
      }
    }
  }
  return [...requests.values()];
}

// Deliberately narrow substitutions; never remove entire heads, scripts or layouts.
export function normalizeHtml(html, canonicalActionId = id => id) {
  return html
    .replace(/(recooler-(?:client\.js|route-[a-f0-9]+\.js)\?v=)[a-f0-9]{20}(?=["'&\s<])/g, '$1<build>')
    .replace(/(recooler-slice-)[a-f0-9]{20}(-\d+\.js)/g, '$1<build>$2')
    .replace(/(data-recooler-version=")[a-f0-9]{20}("?)/g, '$1<build>$2')
    .replace(/<meta\b(?=[^>]*\sname="recooler-route"(?=\s|\/?>))[^>]*\/?\s*>/gi, '')
    .replace(/\sdata-recooler-route(?=[\s/>=])(?:="[^"]*")?/g, '')
    .replace(/((?:\?|&amp;|&)(action|sig|signature)=)([^"'\s<>&]*)/g, (_, prefix, key, value) =>
      prefix + (key === 'action'
        // Invalid-action probes can echo their reserved literal in page URLs.
        // Keep that exact sentinel significant without mapping it as a real action.
        ? encodeURIComponent(decodeURIComponent(value) === '__unknown__' ? '__unknown__' : canonicalActionId(decodeURIComponent(value)))
        : '<volatile>'))
    .replace(/(\bid="s:[prs])\d+("|')/g, '$1<stream>$2')
    .replace(/(suspense\.tp\()\d+(\))/g, '$1<stream>$2');
}
export const comparedHeaders = ['location', 'content-type', 'content-disposition', 'cache-control', 'allow', 'vary',
  'hx-refresh', 'hx-push-url', 'hx-replace-url', 'hx-redirect', 'hx-location', 'hx-trigger', 'hx-trigger-after-settle', 'hx-trigger-after-swap'];
export function responseRecord(response, canonicalActionId) {
  const headers = Object.fromEntries(comparedHeaders.filter(key => Object.hasOwn(response.headers || {}, key)).map(key => [key, response.headers[key]]));
  const isHtml = /\btext\/html\b/i.test(headers['content-type'] || '');
  return { status: response.status, headers,
    ...(response.error ? { error: response.error, ...(Object.hasOwn(response, 'errorMessage') ? { errorMessage: response.errorMessage } : {}),
      ...(response.returnedType ? { returnedType: response.returnedType } : {}) } :
      isHtml ? { htmlDigest: createHash('sha256').update(normalizeHtml(response.body, canonicalActionId)).digest('hex') } :
        { bodyBase64: response.bodyBase64 ?? Buffer.from(response.body || '').toString('base64') }) };
}
async function resolvedCase(adapter, request) {
  if (request.action && typeof adapter.actionUrl !== 'function') throw new Error('Known actions require an adapter actionUrl(case) hook');
  return { ...request, caseKey: JSON.stringify(request), path: request.action ? await adapter.actionUrl(request) : request.path };
}
export async function dispatchCase(adapter, request) {
  return adapter.dispatch(await resolvedCase(adapter, request));
}
async function dispatchBatch(adapter, requests) {
  const resolved = [];
  for (const request of requests) resolved.push(await resolvedCase(adapter, request));
  if (adapter.dispatchBatch) return adapter.dispatchBatch(resolved);
  const responses = [];
  for (const request of resolved) responses.push(await adapter.dispatch(request));
  return responses;
}
export async function captureTraces(adapter, requests, baseline) {
  const traces = [];
  // Miniflare resets a host connection per dispatchFetch. Sequential batches keep
  // the expanded matrix from exhausting ephemeral ports without changing order.
  for (let offset = 0; offset < requests.length; offset += 32) {
    const cases = requests.slice(offset, offset + 32);
    const responses = await dispatchBatch(adapter, cases);
    const plain = baseline ? await dispatchBatch(baseline, cases) : null;
    if (responses.length !== cases.length || (plain && plain.length !== cases.length)) throw new Error('Incomplete dispatch batch');
    for (const [index, request] of cases.entries()) {
      const response = responses[index];
      const trace = { request, invoked: response.invoked, ...responseRecord(response, adapter.canonicalActionId),
        diagnostics: { console: response.errors || [], ...(response.returnedConstructor ? { returnedConstructor: response.returnedConstructor } : {}) } };
      if (plain) {
        trace.baselineStatus = plain[index].status;
        if (response.status !== plain[index].status || response.error !== plain[index].error || response.returnedType !== plain[index].returnedType) {
          throw new Error(`Instrumentation changed dispatch outcome: ${request.method} ${request.path}: ${JSON.stringify({ probe: responseRecord(response), baseline: responseRecord(plain[index]) })}`);
        }
      }
      traces.push(trace);
    }
  }
  return traces;
}
export function traceCounts(traces) {
  return { requests: traces.length, invocations: traces.reduce((n, x) => n + x.invoked.length, 0),
    uncaughtErrors: traces.filter(x => x.error).length,
    nonResponses: traces.filter(x => x.error === 'NonResponse').length,
    baselineStatusesChecked: traces.filter(x => Object.hasOwn(x, 'baselineStatus')).length,
    knownActions: traces.filter(x => x.request.kind === 'known-action').length,
    unknownActions: traces.filter(x => x.request.kind === 'unknown-action').length,
    actionInvocations: traces.reduce((n, x) => n + x.invoked.filter(y => y.kind === 'action').length, 0),
    renderInvocations: Object.fromEntries(['root', 'layout', 'head', 'render-page'].map(kind => [kind, traces.reduce((n, x) => n + x.invoked.filter(y => y.kind === kind).length, 0)])),
    htmlDigests: traces.filter(x => x.htmlDigest).length,
    statuses: Object.fromEntries([...new Set(traces.map(x => x.status))].sort().map(status => [status, traces.filter(x => x.status === status).length])) };
}
export function comparisonRecord(snapshot) {
  return snapshot.traces.map(({ baselineStatus: _, diagnostics: _diagnostics, ...trace }) => trace);
}

// Exact case + top-level field selectors. No wildcards or blanket acceptance.
export function compareTraces(expected, actual, entries = []) {
  const allowedFields = new Set(['invoked', 'status', 'headers', 'bodyBase64', 'htmlDigest', 'error', 'errorMessage', 'returnedType']);
  for (const entry of entries) {
    if (!entry.reason?.trim() || !entry.case || !Array.isArray(entry.fields) || !entry.fields.length ||
      entry.fields.some(field => !allowedFields.has(field) || !entry.values?.[field]?.before || !entry.values?.[field]?.after)) throw new Error('Expected differences require an exact case, supported value-pinned fields and a reason');
  }
  const used = new Set(), differences = [], accepted = [];
  for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
    const before = expected[index], after = actual[index];
    if (isDeepStrictEqual(before, after)) continue;
    const fields = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].filter(field => !isDeepStrictEqual(before?.[field], after?.[field]));
    const unresolved = fields.filter(field => {
      const match = entries.findIndex(entry => isDeepStrictEqual(entry.case, before?.request) && entry.fields.includes(field) && isDeepStrictEqual(entry.values[field].before, pinValue(before?.[field])) && isDeepStrictEqual(entry.values[field].after, pinValue(after?.[field])));
      if (match < 0) return true;
      used.add(`${match}:${field}`); accepted.push({ index, field, reason: entries[match].reason }); return false;
    });
    if (unresolved.length) differences.push({ index, fields: unresolved, expected: before, actual: after });
  }
  const unused = entries.flatMap((entry, index) => { const fields = entry.fields.filter(field => !used.has(`${index}:${field}`)); return fields.length ? [{ ...entry, fields }] : []; });
  return { equal: differences.length === 0 && unused.length === 0, differences, accepted, unused };
}

// Hash the complete JSON value, distinguishing absent fields from null.
export function pinValue(value) {
  return value === undefined ? { missing: true } : { sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}
export function canonicalCatalog(catalog) {
  const path = value => value === '/*' ? '*' : value;
  return {
    routes: catalog.routes.map(route => ({ path: route.path,
      methods: (route.methods.includes('ALL') ? ['ALL'] : [...new Set(route.methods)]).sort(),
      actions: [...new Map(route.actions.map(action => [JSON.stringify(action), action])).values()].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      page: route.page ? Object.fromEntries(['root', 'layouts', 'module', 'heads'].map(key => [key, route.page[key]])) : null,
    })).sort((a,b) => a.path.localeCompare(b.path)),
    middleware: catalog.middleware ? catalog.middleware.map(mw => ({ ...mw, path: path(mw.path) })) : catalog.middlewarePrefixes.map(path),
  };
}
