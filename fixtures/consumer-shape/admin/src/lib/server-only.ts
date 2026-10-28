import { env } from "cloudflare:workers";
export const SERVER_MARKER = [env.FIXTURE_MARKER, "synthetic-server-marker"].slice(-1)[0];
