import { expect, test, type Page } from '@playwright/test';
import { PDF_CORPUS } from '../../tooling/corpus-manifest';
import { readCorpusSample } from '../../tooling/corpus-files';
import { importBook, importStoredBook, position } from '../browser/support';

async function readyPage(page: Page, number: number, total: number): Promise<void> {
  const canvas = page.locator('.pdf-scroll canvas[data-render-state="ready"]');
  await expect(canvas).toHaveAttribute('aria-label', `Page ${number} of ${total}`);
  await expect(canvas).toHaveCount(1);
  expect(
    await canvas.evaluate(
      (element) => (element as HTMLCanvasElement).width * (element as HTMLCanvasElement).height,
    ),
  ).toBeLessThanOrEqual(4_000_000);
}

async function painted(page: Page, expected = true): Promise<void> {
  expect(
    await page.locator('.pdf-scroll canvas[data-render-state="ready"]').evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, index) => index % 4 !== 3 && value < 180);
    }),
  ).toBe(expected);
}

for (const sample of PDF_CORPUS) {
  test(`PDF corpus ${sample.id}: real rendering or explicit limit, original preservation and cleanup`, async ({
    page,
    context,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const bytes = await readCorpusSample(sample);
    if (sample.kind === 'invalid') {
      await importStoredBook(page, bytes, sample.filename, sample.title);
      await page.getByRole('button', { name: 'Read', exact: true }).click();
      await expect(page.locator('.reader-shell').getByRole('status')).toContainText(
        'Could not open book',
      );
      await expect(page.locator('.pdf-scroll canvas')).toHaveCount(0);
      expect((await position(page)).locatorValue).toBeUndefined();
      await page.getByRole('link', { name: '← Close reader' }).click();
      await page.getByText('Local file', { exact: true }).click();
      await page.getByRole('button', { name: 'Check local file', exact: true }).click();
      await expect(page.locator('.details').getByRole('status')).toContainText(
        'original file is present',
      );
      expect(errors).toEqual([]);
      await info.attach('pdf-corpus-evidence', {
        body: JSON.stringify(
          {
            id: sample.id,
            sha256: sample.sha256,
            observations: [
              {
                result: 'invalid structure rejected; original retained; no locator/canvas created',
              },
            ],
          },
          null,
          2,
        ),
        contentType: 'application/json',
      });
      return;
    }
    await importBook(page, bytes, sample.filename, sample.title);
    await readyPage(page, 1, sample.pages);
    await painted(page);
    await expect.poll(async () => (await position(page)).locatorValue).toMatch(/^0:/);
    const observations: { page: number; pixels?: number; aspectRatio?: number; result: string }[] =
      [];
    const visited = Math.min(sample.pages, 12);
    let lastGood = 1;
    for (let number = 1; number <= visited; number++) {
      if (number > 1) await page.getByRole('button', { name: 'Next', exact: true }).click();
      if ((sample.limitedPages as readonly number[]).includes(number)) {
        const savedBeforeFailure = await position(page);
        await expect(page.locator('.reader-shell').getByRole('status')).toContainText(
          'Image exceeded maximum allowed size',
        );
        await expect(page.locator('.pdf-scroll canvas[data-render-state="ready"]')).toHaveCount(0);
        await page.waitForTimeout(450);
        expect((await position(page)).locatorValue).toBe(savedBeforeFailure.locatorValue);
        observations.push({
          page: number,
          result: 'explicit image decode limit; not claimed readable',
        });
        continue;
      }
      await readyPage(page, number, sample.pages);
      const blank = (sample.blankPages as readonly number[]).includes(number);
      await painted(page, !blank);
      await expect
        .poll(async () => (await position(page)).locatorValue)
        .toMatch(new RegExp(`^${number - 1}:`));
      const raster = await page.locator('.pdf-scroll canvas').evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        return { pixels: canvas.width * canvas.height, aspectRatio: canvas.width / canvas.height };
      });
      const expectedAspect = (sample.aspectRatios as readonly number[])[number - 1];
      if (expectedAspect) expect(Math.abs(raster.aspectRatio - expectedAspect)).toBeLessThan(0.03);
      observations.push({
        page: number,
        ...raster,
        result: blank ? 'intentional blank page; render completed' : 'painted',
      });
      if (!blank) lastGood = number;
    }
    // If the final tested page is blank or decode-limited, return to a painted page.
    for (let number = visited; number > lastGood; number--)
      await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await readyPage(page, lastGood, sample.pages);
    await expect
      .poll(async () => (await position(page)).locatorValue)
      .toMatch(new RegExp(`^${lastGood - 1}:`));
    const saved = await position(page);
    await page.getByRole('link', { name: '← Close reader' }).click();
    await expect(page.locator('.pdf-scroll canvas')).toHaveCount(0);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await readyPage(page, lastGood, sample.pages);
    await page.reload();
    await readyPage(page, lastGood, sample.pages);
    await expect.poll(async () => (await position(page)).locatorValue).toBe(saved.locatorValue);
    await painted(page);
    expect(errors).toEqual([]);
    await info.attach('pdf-corpus-evidence', {
      body: JSON.stringify(
        {
          id: sample.id,
          sha256: sample.sha256,
          actualPages: sample.pages,
          observations,
          scope: `first ${visited} pages checked; remaining pages not claimed; limits retained`,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  });
}
