import css from "../index.css";
import { env } from "cloudflare:workers";
export const onGet = (ctx: any) => new Response(css, { headers: { "content-type": "text/css", "x-fixture-env": env.FIXTURE_MARKER || "absent" } });
