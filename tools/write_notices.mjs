import { readFile, writeFile } from 'node:fs/promises';

const packages = {
  'opentype.js': 'LICENSE',
  svgpath: 'LICENSE',
  'svg-path-bbox': 'LICENSE',
  'tiny-inflate': 'LICENSE',
  'string.prototype.codepointat': 'LICENSE-MIT.txt',
};
const notices = [];
for (const [name, filename] of Object.entries(packages)) {
  const root = new URL(`../node_modules/${name}/`, import.meta.url);
  const metadata = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  notices.push(`${name} ${metadata.version} (${metadata.license})\n\n${await readFile(new URL(filename, root), 'utf8')}`);
}
await writeFile(new URL('../dist/THIRD-PARTY-NOTICES.txt', import.meta.url), notices.join('\n\n' + '='.repeat(72) + '\n\n'));
