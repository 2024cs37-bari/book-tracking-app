import { fileURLToPath } from 'node:url';
import solid from 'vite-plugin-solid';
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { networkPolicy } from './tooling/network-policy.ts';
import { readerAssets } from './tooling/reader-assets.ts';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (
    env.VITE_DICTIONARY_ENABLED !== undefined &&
    !['true', 'false'].includes(env.VITE_DICTIONARY_ENABLED)
  ) {
    throw new Error('VITE_DICTIONARY_ENABLED must be true or false.');
  }
  return {
    publicDir: 'vendor',
    plugins: [
      solid(),
      readerAssets(),
      networkPolicy({
        syncUrl: env.VITE_SYNC_URL,
        dictionaryEnabled: env.VITE_DICTIONARY_ENABLED !== 'false',
        development: command === 'serve' || mode === 'test',
        desktop: mode === 'desktop',
      }),
    ],
    resolve: {
      alias: {
        '~': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    build: {
      target: 'es2022',
      sourcemap: true,
    },
    test: {
      environment: 'node',
      // Bound resource use on hosts exposing many cores to this shared workspace.
      maxWorkers: 4,
      include: ['tests/**/*.test.ts'],
      setupFiles: ['tests/setup.ts'],
      restoreMocks: true,
    },
  };
});
