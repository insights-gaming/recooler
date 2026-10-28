export function selectServer(environments) {
  const servers = Object.values(environments).filter(e => e.config.consumer === 'server');
  // CF v1 leaves Vite's unused `ssr` beside its Worker environment.
  return servers.find(e => e.config.build.rolldownOptions.input || typeof e.config.build.ssr === 'string') ?? servers[0];
}
