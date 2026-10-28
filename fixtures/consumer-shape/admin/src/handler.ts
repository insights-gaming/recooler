import { CreateResolvedTemplate } from "easy-jsx-html-engine";
import { CreateJSXRouteHandlerFactory } from "farm-plugin-recooler/helpers";
export default CreateJSXRouteHandlerFactory({
  ResolvedTemplate: CreateResolvedTemplate({ resolvedScriptMiddleware: script => `${script}.forEach(htmx.process)` }),
  suspenseCleanupScriptMiddleware: script => `${script};window.dispatchEvent(new CustomEvent('fixture-ready'))`,
});
