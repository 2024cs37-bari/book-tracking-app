import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import type { Plugin } from 'vite';

async function filesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? filesIn(resolve(directory, entry.name))
        : [resolve(directory, entry.name)],
    ),
  );
  return nested.flat();
}

/** Ship pdf.js auxiliary resources and precache only application assets, never books. */
export function readerAssets(): Plugin {
  let output = '';
  let building = false;
  const roots = ['cmaps', 'standard_fonts', 'wasm'];
  return {
    name: 'reader-local-assets',
    configResolved(config) {
      output = resolve(config.root, config.build.outDir);
      building = config.command === 'build';
    },
    configureServer(server) {
      server.middlewares.use('/pdf-assets', (request, response, next) => {
        const path = decodeURIComponent((request.url ?? '').split('?')[0]!);
        if (path.includes('..') || !roots.some((root) => path.startsWith(`/${root}/`))) {
          next();
          return;
        }
        void readFile(resolve('node_modules/pdfjs-dist', `.${path}`))
          .then((bytes) => {
            response.setHeader(
              'Content-Type',
              path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',
            );
            response.end(bytes);
          })
          .catch(() => next());
      });
    },
    async generateBundle() {
      for (const root of roots) {
        const directory = resolve('node_modules/pdfjs-dist', root);
        for (const file of await filesIn(directory)) {
          this.emitFile({
            type: 'asset',
            fileName: `pdf-assets/${root}/${relative(directory, file)}`,
            source: await readFile(file),
          });
        }
      }
    },
    async closeBundle() {
      if (!output || !building) return;
      const files = (await filesIn(output)).filter(
        (file) => !file.endsWith('.map') && !file.endsWith('/sw.js'),
      );
      const hash = createHash('sha256');
      for (const file of files.sort()) {
        hash.update(relative(output, file));
        hash.update(await readFile(file));
      }
      const cache = `reader-shell-${hash.digest('hex').slice(0, 16)}`;
      const paths = files.map((file) => `./${relative(output, file)}`);
      await writeFile(
        resolve(output, 'sw.js'),
        `const CACHE=${JSON.stringify(cache)};
const ASSETS=${JSON.stringify(paths)};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('reader-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    if (event.request.mode === 'navigate') return (await cache.match('./index.html')) || fetch(event.request);
    return (await cache.match(event.request, { ignoreVary: true })) || fetch(event.request);
  }));
});
`,
      );
    },
  };
}
