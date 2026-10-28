interface Environment {
  name: string;
  config: { consumer: 'server' | 'client' };
}

/** Selection happens on import, so idle SSR/Worker/test environments are harmless. */
export function serverEnvironment(environment: Environment, selected?: string, explicit?: string): string {
  if (environment.config.consumer === 'client') throw new Error('recooler: virtual:recooler/app is server-only');
  const name = explicit ?? selected ?? environment.name;
  return name;
}
