import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import vm from 'node:vm';

export async function evaluateClientPage(clientOut, html, beforeLoad) {
  const window = new Window({ url: 'http://client.test/', settings: { suppressInsecureJavaScriptEnvironmentWarning: true } });
  window.document.write(html.replace(/<script[^>]*type="module"[^>]*><\/script>/g, ''));
  const context = vm.createContext(window);
  const modules = new Map();
  const load = async file => {
    if (modules.has(file)) return modules.get(file);
    const module = new vm.SourceTextModule(await readFile(file, 'utf8'), {
      context, identifier: pathToFileURL(file).href,
      initializeImportMeta(meta) { meta.url = pathToFileURL(file).href; },
      importModuleDynamically: async (specifier, parent) => {
        const dependency = await load(fileURLToPath(new URL(specifier, parent.identifier)));
        if (dependency.status === 'linked') await dependency.evaluate();
        return dependency;
      },
    });
    modules.set(file, module);
    await module.link((specifier, parent) => load(fileURLToPath(new URL(specifier, parent.identifier))));
    return module;
  };
  beforeLoad?.(window, context);
  const module = await load(path.join(clientOut, 'assets/recooler-client.js'));
  await module.evaluate(); await vm.runInContext('globalThis.__recooler_ready', context);
  return window;
}
