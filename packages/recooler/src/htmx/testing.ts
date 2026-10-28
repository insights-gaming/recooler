/** Test-only capability minting for conformance/consumer adapters. Never expose this as an endpoint. */
import { signedUrl, type ActionAddress } from './signing.js';
export type { ActionAddress } from './signing.js';

export function signActionUrl(address: ActionAddress, secret: string): string {
  if (!secret) throw new TypeError('Action signing requires a nonempty secret');
  return signedUrl(address, secret);
}
