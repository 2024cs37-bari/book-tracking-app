// Local browser-test Worker only. Never reads .dev.vars, .env, wrangler config,
// production credentials or persistent Cloudflare data.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.SYNC_TEST_API_PORT ?? 8793);
const clientPort = Number(process.env.SYNC_TEST_CLIENT_PORT ?? 4193);
const bundled = await build({
  entryPoints: [`${root}src/worker.ts`],
  bundle: true,
  write: false,
  format: 'esm',
  target: 'es2022',
});
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    r2Buckets: ['FILES'],
    port,
    host: '127.0.0.1',
    bindings: {
      DEV_USER: 'browser-test-owner',
      ACCESS_AUD: '',
      ACCESS_TEAM_DOMAIN: '',
      CLIENT_ORIGIN: `http://127.0.0.1:${clientPort}`,
    },
  }),
);
const db = await runtime.getD1Database('DB');
const migration = await readFile(`${root}migrations/0001_init.sql`, 'utf8');
await db.exec(migration.replace(/--[^\n]*/g, '').replace(/\n/g, ' '));
await runtime.ready;
console.log(`Local sync test Worker ready on 127.0.0.1:${port}`);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await runtime.dispose();
  process.exit(0);
};
process.on('SIGTERM', () => {
  void close();
});
process.on('SIGINT', () => {
  void close();
});
