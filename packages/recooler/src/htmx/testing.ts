/** Test-only capability minting for conformance/consumer adapters. Never expose this as an endpoint. */
import { signedUrl, type ActionAddress } from './signing.js';
export type { ActionAddress } from './signing.js';

/** Include the receiving namespace, normalized base and current defining-module hash.
 * Omitted identities are empty strings, matching manual default registrations. */
export function signActionUrl(address: ActionAddress, secret: string): string {
  if (!secret) throw new TypeError('Action signing requires a nonempty secret');
  return signedUrl(address, secret);
}
