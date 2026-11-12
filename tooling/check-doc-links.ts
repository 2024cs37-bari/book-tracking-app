import { readFile, readdir, access } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

// Local link targets only: external network availability and generated heading
// anchors are intentionally not presented as verified by this deterministic check.
const root = resolve(import.meta.dirname, '..');
async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : [];
    }),
  );
  return groups.flat();
}
const files = [
  ...['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'server/README.md'].map((file) =>
    join(root, file),
  ),
  ...(await markdownFiles(join(root, 'docs'))),
];
let targets = 0;
const failures: string[] = [];
for (const file of files) {
  const source = (await readFile(file, 'utf8')).replace(/^(`{3,}|~{3,}).*\n[\s\S]*?^\1\s*$/gm, '');
  const links = [
    ...source.matchAll(/\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g),
    ...source.matchAll(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm),
  ];
  for (const match of links) {
    const target = match[1]!.replace(/^<|>$/g, '').split('#')[0]!.split('?')[0]!;
    if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(target)) continue;
    targets++;
    try {
      await access(resolve(dirname(file), decodeURIComponent(target)));
    } catch {
      failures.push(`${relative(root, file)}: missing local target ${target}`);
    }
  }
}
if (failures.length) {
  process.stderr.write(failures.join('\n') + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Documentation: ${targets} local targets checked across ${files.length} files.\n`,
  );
}
