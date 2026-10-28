interface ServerConfig {
  consumer: 'server' | 'client';
  build: { ssr?: boolean | string; rolldownOptions: { input?: unknown } };
}

/** CF v1 leaves an idle server beside its configured Worker. Entry points, not
 * names or object iteration order, identify the server that owns the app. */
export function serverEnvironment(environments: Record<string, ServerConfig>, explicit?: string): string {
  const servers = Object.entries(environments).filter(([, config]) => config.consumer === 'server');
  if (explicit) {
    if (!servers.some(([name]) => name === explicit)) throw new Error(`recooler: serverEnvironment ${JSON.stringify(explicit)} is not a server environment`);
    return explicit;
  }
  const configured = servers.filter(([, config]) => config.build.rolldownOptions.input || typeof config.build.ssr === 'string');
  const candidates = configured.length ? configured : servers;
  if (candidates.length !== 1) throw new Error(`recooler: cannot select a server environment (${candidates.map(([name]) => name).join(', ') || 'none'}); set serverEnvironment`);
  return candidates[0]![0];
}
