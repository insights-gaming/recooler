export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env = { FIXTURE_MARKER: "node-stub" };', shortCircuit: true };
  return next(specifier, context);
}
