import { expect, test, type Frame, type Page } from '@playwright/test';
import { buildEpubFixture } from '../support/fixtures';
import { importBook, position } from './support';

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
});
test.afterEach(() => expect(errors).toEqual([]));

async function assetFrame(page: Page, chapter: number): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(async () => {
      for (const frame of page.frames().filter((frame) => frame.url().startsWith('blob:'))) {
        const caption = await frame
          .locator('#asset-caption')
          .textContent()
          .catch(() => '');
        if (caption === `Asset fixture chapter ${chapter}`) {
          found = frame;
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  return found!;
}

async function verifyAssets(frame: Frame): Promise<void> {
  await expect(frame.locator('#asset-caption')).toHaveCSS('border-top-width', '3px');
  await expect(frame.locator('#asset-caption')).toHaveCSS(
    'font-family',
    /^["']?Fixture Serif["']?$/,
  );
  const font = await frame.evaluate(async () => {
    await document.fonts.load('18px "Fixture Serif"', 'Asset fixture');
    await document.fonts.ready;
    return Array.from(document.fonts)
      .filter((font) => font.family.replaceAll('"', '') === 'Fixture Serif')
      .map((font) => font.status);
  });
  expect(font).toEqual(['loaded']);
  await expect
    .poll(() =>
      frame
        .locator('#asset-image')
        .evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBe(64);
  expect(
    await frame.locator('#asset-image').evaluate((element) => {
      const image = element as HTMLImageElement;
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 32;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    }),
  ).toEqual([35, 100, 220, 255]);
  expect(await frame.evaluate(() => 'bookScriptExecuted' in globalThis)).toBe(false);
}

for (const version of ['2.0', '3.0'] as const) {
  test(`EPUB ${version} embeds PNG, CSS and generated font under CSP and reloads offline`, async ({
    page,
    context,
  }) => {
    await importBook(
      page,
      buildEpubFixture({
        title: `Assets ${version}`,
        epubVersion: version,
        assets: 'valid',
        hostileScript: true,
      }),
      'assets.epub',
      `Assets ${version}`,
    );
    await verifyAssets(await assetFrame(page, 1));
    await page.getByText('Reader settings', { exact: true }).click();
    await page.getByLabel('Font size / PDF zoom', { exact: true }).evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = '24';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect((await assetFrame(page, 1)).locator('body')).toHaveCSS('font-size', '24px');
    await page.getByLabel('Theme', { exact: true }).selectOption('dark');
    await expect((await assetFrame(page, 1)).locator('html')).toHaveCSS(
      'background-color',
      'rgb(25, 25, 25)',
    );
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    await verifyAssets(await assetFrame(page, 1));
  });
}

test('fixed-layout EPUB preserves page geometry, navigates, blocks scripts and resumes offline', async ({
  page,
  context,
}) => {
  await importBook(
    page,
    buildEpubFixture({
      title: 'Fixed pages',
      assets: 'valid',
      fixedLayout: true,
      chapters: 3,
      hostileScript: true,
    }),
    'fixed.epub',
    'Fixed pages',
  );
  const first = await assetFrame(page, 1);
  await verifyAssets(first);
  await expect(page.locator('.reader-shell').getByRole('status')).toContainText(
    'Fixed-layout EPUB preserves publisher typography',
  );
  await page.getByText('Reader settings', { exact: true }).click();
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  await expect(page.locator('foliate-view')).toHaveCSS('background-color', 'rgb(25, 25, 25)');
  expect(
    await first.locator('body').evaluate((body) => ({
      width: body.getBoundingClientRect().width,
      height: body.getBoundingClientRect().height,
    })),
  ).toEqual({ width: 600, height: 800 });
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await verifyAssets(await assetFrame(page, 2));
  await expect.poll(async () => (await position(page)).fraction).toBeGreaterThan(0.2);
  const saved = await position(page);
  expect(saved.locatorValue).toMatch(/^epubcfi\(/);
  await page.getByRole('link', { name: '← Close reader' }).click();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await page.reload();
  await verifyAssets(await assetFrame(page, 2));
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await verifyAssets(await assetFrame(page, 1));
});

for (const assets of ['missing', 'malformed'] as const) {
  test(`EPUB ${assets} image/font resources leave text and navigation usable`, async ({ page }) => {
    await importBook(
      page,
      buildEpubFixture({ title: `Broken ${assets}`, assets, chapters: 2 }),
      'broken.epub',
      `Broken ${assets}`,
    );
    const frame = await assetFrame(page, 1);
    await expect(frame.locator('body')).toContainText('Content.');
    await expect(frame.locator('#asset-caption')).toHaveCSS('border-top-width', '3px');
    expect(
      await frame
        .locator('#asset-image')
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    ).toBe(0);
    await page.getByText('Table of contents', { exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Book contents' })
      .getByRole('button', { name: 'Chapter 2', exact: true })
      .click();
    await expect((await assetFrame(page, 2)).locator('body')).toContainText('Content.');
  });
}

test('late font-ready callbacks cannot render replaced or closed chapter frames', async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window === parent) return;
    Object.defineProperty(document.fonts, 'ready', {
      get: () =>
        new Promise<FontFaceSet>((resolve) => {
          const host = parent as Window & { fontReadyReleases?: (() => void)[] };
          (host.fontReadyReleases ??= []).push(() => resolve(document.fonts));
        }),
    });
  });
  await importBook(
    page,
    buildEpubFixture({ title: 'Late fonts', assets: 'valid', chapters: 2 }),
    'late.epub',
    'Late fonts',
  );
  await assetFrame(page, 1);
  await page.getByText('Table of contents', { exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Book contents' })
    .getByRole('button', { name: 'Chapter 2', exact: true })
    .click();
  await assetFrame(page, 2);
  await page.getByRole('link', { name: '← Close reader' }).click();
  await page.evaluate(async () => {
    const host = window as Window & { fontReadyReleases?: (() => void)[] };
    for (const release of host.fontReadyReleases ?? []) release();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
