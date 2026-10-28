import { base64url, hmacSha256 } from './crypto.js';
import { serializeScope } from './scope.js';

export interface ActionAddress {
  routeId: string;
  /** Exact incoming URL pathname, including encoded slashes and any mount prefix visible to Hono. */
  pathname: string;
  method: string;
  actionId: string;
  scope?: Record<string, unknown>;
}

export function actionSignature(address: Omit<ActionAddress, 'scope'>, json: string, secret: string): string {
  // A versioned tuple avoids delimiter ambiguity in user-controlled strings.
  const message = JSON.stringify(['recooler.action.v1', address.routeId, address.pathname,
    address.method.toUpperCase(), address.actionId, json]);
  const encode = new TextEncoder();
  return base64url(hmacSha256(encode.encode(secret), encode.encode(message)));
}

export function actionPath(pathname: string, base = ''): string {
  if (!pathname.startsWith('/')) throw new TypeError('Action pathname must start with /');
  const path = base + pathname;
  // A catch-all may match //host; /. keeps resolution on the current origin.
  return /^\/[\\/]/.test(path) ? '/.' + path : path;
}

export function signedUrl(address: ActionAddress, secret: string | false, base = ''): string {
  const json = serializeScope(address.scope ?? {});
  return `${actionPath(address.pathname, base)}?action=${encodeURIComponent(address.actionId)}`
    + `&scope=${encodeURIComponent(json)}`
    + (secret === false ? '' : `&sig=${actionSignature(address, json, secret)}`);
}
