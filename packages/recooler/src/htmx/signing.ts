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

export type ActionSigner = (address: Omit<ActionAddress, 'scope'>, json: string) => string | undefined;

export function createActionSigner(secret: string): ActionSigner {
  const encode = new TextEncoder();
  const key = encode.encode(secret);
  return (address, json) => {
    // A versioned tuple avoids delimiter ambiguity in user-controlled strings.
    const message = JSON.stringify(['recooler.action.v1', address.routeId, address.pathname,
      address.method.toUpperCase(), address.actionId, json]);
    return base64url(hmacSha256(key, encode.encode(message)));
  };
}

export function actionSignature(address: Omit<ActionAddress, 'scope'>, json: string, secret: string): string {
  return createActionSigner(secret)(address, json)!;
}

export function actionPath(pathname: string, base = ''): string {
  if (!pathname.startsWith('/')) throw new TypeError('Action pathname must start with /');
  const path = base + pathname;
  // A catch-all may match //host; /. keeps resolution on the current origin.
  return /^\/[\\/]/.test(path) ? '/.' + path : path;
}

export function signedUrl(address: ActionAddress, secret: string | false | ActionSigner, base = ''): string {
  const json = serializeScope(address.scope ?? {});
  const signature = typeof secret === 'function' ? secret(address, json)
    : secret === false ? undefined : actionSignature(address, json, secret);
  return `${actionPath(address.pathname, base)}?action=${encodeURIComponent(address.actionId)}`
    + `&scope=${encodeURIComponent(json)}`
    + (signature === undefined ? '' : `&sig=${signature}`);
}
