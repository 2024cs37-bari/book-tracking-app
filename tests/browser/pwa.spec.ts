import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { generateServiceWorker } from '../../tooling/service-worker';

const integrity = (content: string) =>
  `sha256-${createHash('sha256').update(content).digest('base64')}`;

// Exercise generated production worker code in an actual browser, with a tiny
// controlled deployment so old/new asset transitions and failed installs are deterministic.
function deployment() {
  let version = 1;
  let broken = false;
  let activated = 0;
  const server = createServer((request, response) => {
    const path = request.url?.split('?')[0];
    const html = `<html><body><h1>Reader version ${version}</h1></body></html>`;
    const asset = `export const version = ${version};`;
    response.setHeader('Cache-Control', 'no-store');
    if (path?.startsWith('/activated/')) {
      activated = Number(path.split('/').at(-1));
      response.end('ok');
    } else if (path === '/sw.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(
        generateServiceWorker(`reader-shell-test-${version}`, [
          { url: './index.html', integrity: integrity(html) },
          { url: './engine.js', integrity: integrity(asset) },
        ]) +
          `\nself.addEventListener('activate', event => event.waitUntil(fetch('/activated/${version}')));`,
      );
    } else if (path === '/engine.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(broken ? 'corrupted deployment' : asset);
    } else if (path === '/api/private') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ private: true, version }));
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end(html);
    }
  });
  return {
    server,
    version: (next: number, corrupt = false) => {
      version = next;
      broken = corrupt;
    },
    activated: () => activated,
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server failed to listen');
  return `http://127.0.0.1:${address.port}`;
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test('production manifest and install icons are available', async ({ page, request }) => {
  await page.goto('/');
  const manifestLink = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestLink).toBeTruthy();
  const response = await request.get(manifestLink!);
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.scope).toBe('./');
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192', purpose: 'any maskable' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'any maskable' }),
    ]),
  );
  for (const size of [192, 512]) {
    expect(
      await page.evaluate(async (size) => {
        const image = new Image();
        image.src = `/icons/reader-${size}.png`;
        await image.decode();
        return [image.naturalWidth, image.naturalHeight];
      }, size),
    ).toEqual([size, size]);
  }
});

test('updates wait for readers to close; corrupt updates preserve the current offline engine', async ({
  page,
  context,
}) => {
  const deployed = deployment();
  const url = await listen(deployed.server);
  try {
    await page.goto(url);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await expect.poll(deployed.activated).toBe(1);
    deployed.version(2);
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())!.update();
    });
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state,
        ),
      )
      .toBe('installed');
    expect(deployed.activated()).toBe(1);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading')).toHaveText('Reader version 1');
    expect(await page.evaluate(async () => (await fetch('/engine.js')).text())).toContain(
      'version = 1',
    );
    await context.setOffline(false);
    await page.goto('about:blank');
    await expect.poll(deployed.activated).toBe(2);
    await page.goto(url);
    await expect(page.getByRole('heading')).toHaveText('Reader version 2');
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await caches.keys()).filter((key) => key.startsWith('reader-shell-')),
        ),
      )
      .toEqual(['reader-shell-test-2']);

    deployed.version(3, true);
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())!.update();
    });
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return !registration?.installing && !registration?.waiting;
        }),
      )
      .toBe(true);
    expect(deployed.activated()).toBe(2);
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await caches.keys()).filter((key) => key.startsWith('reader-shell-')),
        ),
      )
      .toEqual(['reader-shell-test-2']);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading')).toHaveText('Reader version 2');
    expect(await page.evaluate(async () => (await fetch('/engine.js')).text())).toContain(
      'version = 2',
    );
  } finally {
    await context.setOffline(false);
    await page.goto('about:blank');
    await stop(deployed.server);
  }
});

test('private API requests and navigations never enter the offline shell cache', async ({
  page,
  context,
}) => {
  const deployed = deployment();
  const url = await listen(deployed.server);
  try {
    await page.goto(url);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    expect(await page.evaluate(async () => (await fetch('/api/private')).json())).toEqual({
      private: true,
      version: 1,
    });
    expect(
      await page.evaluate(async () => {
        const cache = await caches.open('reader-shell-test-1');
        return (await cache.keys()).map((request) => new URL(request.url).pathname);
      }),
    ).toEqual(expect.not.arrayContaining(['/api/private']));
    await page.goto(`${url}/api/private`);
    await expect(page.locator('body')).toContainText('"private":true');
    await page.goto(url);
    await context.setOffline(true);
    expect(
      await page.evaluate(async () => {
        try {
          await fetch('/api/private');
          return 'unexpected success';
        } catch {
          return 'offline';
        }
      }),
    ).toBe('offline');
  } finally {
    await context.setOffline(false);
    await page.goto('about:blank');
    await stop(deployed.server);
  }
});
