import type { DirNode, Manifest, ModuleNs } from '../../src/router/index.js';
import { isGroupSegment, routePathWithoutGroups, routeSegment } from '../../src/router/index.js';

/** A hand-written source tree, with no generator involved. */
export function manifest(files: Record<string, ModuleNs>, root?: ModuleNs): Manifest {
  const tree: DirNode = { segment: '', path: '/', group: false, middleware: [], middlewareFiles: [], children: [] };
  for (const [file, module] of Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const segments = file.split('/');
    const name = segments.pop()!;
    let node = tree;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      let child = node.children.find(n => n.segment === segment);
      if (!child) {
        child = { segment, path: routePathWithoutGroups('/' + segments.slice(0, i + 1).map(routeSegment).join('/')), group: isGroupSegment(segment), middleware: [], middlewareFiles: [], children: [] };
        node.children.push(child);
      }
      node = child;
    }
    const source = 'routes/' + file;
    if (name.startsWith('index.')) node.route = { file: source, module };
    else if (name.startsWith('layout.')) { node.layout = module; node.layoutFile = source; }
    else { node.middleware.push(module); node.middlewareFiles!.push(source); }
  }
  return { version: 1, root, tree };
}
