import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import type { Plugin } from 'vite';
import { generateServiceWorker } from './service-worker.ts';

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
      server.middlewares.use((request, response, next) => {
        let pathname: string;
        try {
          pathname = decodeURIComponent((request.url ?? '').split('?')[0]!);
        } catch {
          next();
          return;
        }
        if (pathname !== '/manifest.webmanifest' && !/^\/icons\/[a-z0-9.-]+$/.test(pathname)) {
          next();
          return;
        }
        void readFile(resolve('public', `.${pathname}`))
          .then((bytes) => {
            response.setHeader(
              'Content-Type',
              pathname.endsWith('.webmanifest')
                ? 'application/manifest+json'
                : pathname.endsWith('.svg')
                  ? 'image/svg+xml'
                  : 'image/png',
            );
            response.end(bytes);
          })
          .catch(() => next());
      });
      server.middlewares.use('/pdf-assets', (request, response, next) => {
        let path: string;
        try {
          path = decodeURIComponent((request.url ?? '').split('?')[0]!);
        } catch {
          next();
          return;
        }
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
      for (const file of await filesIn(resolve('public'))) {
        this.emitFile({
          type: 'asset',
          fileName: relative(resolve('public'), file),
          source: await readFile(file),
        });
      }
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
      // Worker behavior is part of the cache identity, even if assets are unchanged.
      hash.update(generateServiceWorker('version', []));
      const assets = [];
      for (const file of files.sort()) {
        hash.update(relative(output, file));
        const bytes = await readFile(file);
        hash.update(bytes);
        assets.push({
          url: `./${relative(output, file)}`,
          integrity: `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
        });
      }
      const cache = `reader-shell-${hash.digest('hex').slice(0, 16)}`;
      await writeFile(resolve(output, 'sw.js'), generateServiceWorker(cache, assets));
    },
  };
}
