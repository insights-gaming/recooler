// Source roots are package-relative, matching recooler's routes.srcDir.
export function sourceFile(file, sourceRoot = 'src') {
  const parts = `${sourceRoot}/${file}`.replaceAll('\\', '/').split('/');
  const normalized = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..' && normalized.length && normalized.at(-1) !== '..') normalized.pop();
    else normalized.push(part);
  }
  return normalized.join('/');
}
