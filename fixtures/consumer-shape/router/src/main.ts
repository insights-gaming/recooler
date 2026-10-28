import app from "recooler::app";
import { receive } from "./routes/providers";
receive();
export default app;
app.onError((error, ctx) => ctx.text(error.message, 500));
