import { HTTPException } from "hono/http-exception";
import app from "recooler::app";
export { Counter } from "./lib/counter";
export default { ...app };
app.onError((error, ctx) => error instanceof HTTPException ? error.getResponse() : ctx.text(error.message, 500));
