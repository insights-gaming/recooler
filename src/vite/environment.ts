interface Environment {
  name: string;
  config: { consumer: 'server' | 'client' };
}

/** Server consumers may import the app unless an explicit environment restricts it. */
export function serverEnvironment(environment: Environment, explicit?: string): string {
  if (environment.config.consumer === 'client') throw new Error('recooler: virtual:recooler/app is server-only');
  if (explicit !== undefined && environment.name !== explicit) {
    throw new Error(`recooler: virtual:recooler/app is restricted to serverEnvironment ${JSON.stringify(explicit)}; cannot load it in ${JSON.stringify(environment.name)}`);
  }
  return environment.name;
}
