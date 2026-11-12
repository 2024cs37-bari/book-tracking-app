import { expect, test, type Page } from '@playwright/test';
import { buildEpubFixture } from '../support/fixtures';

async function rows<T>(page: Page, table: string): Promise<T[]> {
  return page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('book-reader');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<T[]>((resolve, reject) => {
        const request = db.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }, table);
}
async function importHere(page: Page, bytes: Uint8Array<ArrayBuffer>) {
  await page.locator('#library-import').setInputFiles({
    name: 'shared.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(bytes),
  });
  await page.getByRole('link', { name: /Shared offline book/ }).click();
  await expect(page.getByRole('button', { name: 'Read', exact: true })).toBeVisible();
}
const pending = (page: Page) =>
  rows<{ pushedAt: number }>(page, 'changes').then(
    (items) => items.filter((item) => item.pushedAt === 0).length,
  );
async function syncNow(page: Page) {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect.poll(() => pending(page)).toBe(0);
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeEnabled();
}
async function stayHereIfConflicted(page: Page) {
  if ((await rows(page, 'progressConflicts')).length === 0) return;
  const existing = page.getByRole('alertdialog', { name: 'Reading position differs' });
  await expect(existing).toBeVisible();
  await existing.getByRole('button', { name: 'Stay here', exact: true }).click();
  await expect(existing).toHaveCount(0);
}

test('offline independent imports converge through real Worker/D1/R2, including notes, collections, progress and on-demand originals', async ({
  browser,
  baseURL,
  request,
}) => {
  const contexts = await Promise.all([
    browser.newContext({ baseURL }),
    browser.newContext({ baseURL }),
    browser.newContext({ baseURL }),
  ]);
  const [a, b, c] = await Promise.all(contexts.map((context) => context.newPage()));
  const errors: string[] = [];
  const apiRequests: string[] = [];
  for (const page of [a!, b!, c!]) {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (req) => {
      if (req.url().includes(`:${process.env.SYNC_TEST_API_PORT ?? 8793}/api/`))
        apiRequests.push(`${req.method()} ${req.url()}`);
    });
  }
  try {
    await Promise.all([a!.goto('/'), b!.goto('/')]);
    await Promise.all([a!.locator('.app-nav').waitFor(), b!.locator('.app-nav').waitFor()]);
    await Promise.all([contexts[0]!.setOffline(true), contexts[1]!.setOffline(true)]);
    const bytes = buildEpubFixture({ title: 'Shared offline book', chapters: 3, paragraphs: 30 });
    await importHere(a!, bytes);
    await importHere(b!, bytes);
    const [abook] = await rows<{ id: string; sha256: string }>(a!, 'books');
    const [bbook] = await rows<{ id: string; sha256: string }>(b!, 'books');
    expect(abook!.id).not.toBe(bbook!.id);
    expect(abook!.sha256).toBe(bbook!.sha256);
    expect(await pending(a!)).toBeGreaterThan(0);
    expect(await pending(b!)).toBeGreaterThan(0);
    await a!.getByLabel('New shelf name').fill('From device A');
    await a!.getByRole('button', { name: 'Add shelf', exact: true }).click();
    await b!.getByLabel('New shelf name').fill('From device B');
    await b!.getByRole('button', { name: 'Add shelf', exact: true }).click();
    await b!.getByLabel('New tag', { exact: true }).fill('Synced tag');
    await b!.getByRole('button', { name: 'Add tag', exact: true }).click();
    await Promise.all([contexts[0]!.setOffline(false), contexts[1]!.setOffline(false)]);
    // Automatic online/mutation events push offline work, without Sync now.
    await expect.poll(() => pending(a!)).toBe(0);
    await expect.poll(() => pending(b!)).toBe(0);
    // Foreground/manual pull catches work that arrived after a device's cycle.
    await syncNow(a!);
    await syncNow(b!);
    const canonical = [abook!.id, bbook!.id].sort()[0]!;
    for (const page of [a!, b!]) {
      expect((await rows<{ id: string }>(page, 'books')).map((book) => book.id)).toEqual([
        canonical,
      ]);
      expect(await rows(page, 'shelfBooks')).toHaveLength(2);
      expect(await rows(page, 'bookTags')).toHaveLength(1);
      await page.goto(`/book/${canonical}`);
      await expect(page.getByLabel('From device A', { exact: true })).toBeChecked();
      await expect(page.getByLabel('From device B', { exact: true })).toBeChecked();
    }
    await expect
      .poll(async () =>
        (await rows<{ direction: string; state: string }>(a!, 'fileTransfers')).some(
          (job) => job.direction === 'upload' && job.state === 'complete',
        ),
      )
      .toBe(true);
    const remote = await request.head(
      `http://127.0.0.1:${process.env.SYNC_TEST_API_PORT ?? 8793}/api/v1/files/${abook!.sha256}`,
    );
    expect(remote.status()).toBe(200);
    expect(Number(remote.headers()['content-length'])).toBe(bytes.length);

    // A third isolated installation obtains metadata only, then requests bytes.
    await c!.goto('/');
    await c!.getByRole('link', { name: /Shared offline book/ }).click();
    await expect(
      c!.getByRole('button', { name: 'Download to this device', exact: true }),
    ).toBeVisible();
    expect(
      (await rows<{ direction: string }>(c!, 'fileTransfers')).filter(
        (job) => job.direction === 'download',
      ),
    ).toHaveLength(0);
    await c!.getByRole('button', { name: 'Download to this device', exact: true }).click();
    await expect
      .poll(async () =>
        (await rows<{ direction: string; state: string }>(c!, 'fileTransfers')).some(
          (job) => job.direction === 'download' && job.state === 'complete',
        ),
      )
      .toBe(true);
    await c!.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(c!.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    await c!.getByRole('tab', { name: 'Notes', exact: true }).click();
    await c!.getByRole('button', { name: 'Bookmark this position', exact: true }).click();
    await expect(c!.locator('.reader-annotation-list li')).toHaveCount(1);
    await c!.getByRole('link', { name: '← Close reader' }).click();
    await syncNow(c!);
    await syncNow(a!);
    await a!.goto(`/book/${canonical}`);
    await expect(a!.locator('.annotation-review-row')).toHaveCount(1);

    // Establish a genuinely local position on B while sync is paused. Merely
    // importing the book leaves B following remote progress; A's initial
    // near-equal position and later movement then correctly continue without
    // a conflict, depending on which intermediate saves reached the server.
    await syncNow(b!);
    await b!.getByRole('button', { name: 'Pause automatic sync', exact: true }).click();
    await b!.goto(`/book/${canonical}`);
    await b!.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(b!.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    await stayHereIfConflicted(b!);
    await b!.getByRole('tab', { name: 'Contents', exact: true }).click();
    await b!
      .getByRole('navigation', { name: 'Book contents' })
      .getByRole('button', { name: 'Chapter 2', exact: true })
      .click();
    await expect
      .poll(async () => (await rows<{ fraction: number }>(b!, 'progress'))[0]?.fraction ?? 0)
      .toBeGreaterThan(0.3);
    const [bLocal] = await rows<{ fraction: number; locatorValue: string }>(b!, 'progress');
    expect(bLocal!.fraction).toBeLessThan(0.6);
    await b!.getByRole('link', { name: '← Close reader' }).click();
    await b!.goto('/settings');

    // Move A to a different chapter after B's local position is durable.
    await a!.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(a!.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    // C's initial renderer location may already differ from A's imported 0%.
    // A must make the same explicit choice a reader would before new movement
    // can be saved; unresolved conflicts deliberately suspend automatic saves.
    await stayHereIfConflicted(a!);
    await a!.getByRole('tab', { name: 'Contents', exact: true }).click();
    await a!
      .getByRole('navigation', { name: 'Book contents' })
      .getByRole('button', { name: 'Chapter 3', exact: true })
      .click();
    await expect
      .poll(async () => (await rows<{ fraction: number }>(a!, 'progress'))[0]?.fraction ?? 0)
      .toBeGreaterThan(0.5);
    await a!.getByRole('link', { name: '← Close reader' }).click();
    await syncNow(a!);
    await b!.getByRole('button', { name: 'Resume automatic sync', exact: true }).click();
    await expect.poll(async () => (await rows(b!, 'progressConflicts')).length).toBe(1);
    const [candidate] = await rows<{ remote: { fraction: number } }>(b!, 'progressConflicts');
    expect(candidate!.remote.fraction).toBeGreaterThan(0.6);
    expect((await rows<{ locatorValue: string }>(b!, 'progress'))[0]?.locatorValue).toBe(
      bLocal!.locatorValue,
    );
    await b!.goto(`/book/${canonical}`);
    await b!.getByRole('button', { name: 'Read', exact: true }).click();
    const conflict = b!.getByRole('alertdialog', { name: 'Reading position differs' });
    await expect(conflict).toBeVisible();
    await conflict.getByRole('button', { name: /^Go to/ }).click();
    await expect(conflict).toHaveCount(0);
    expect(
      apiRequests.some((path) => path.startsWith('POST ') && path.includes('/sync/push')),
    ).toBe(true);
    expect(apiRequests.some((path) => path.startsWith('PUT ') && path.includes('/files/'))).toBe(
      true,
    );
    expect(
      apiRequests.some(
        (path) => path.startsWith('GET ') && path.includes(`/files/${abook!.sha256}`),
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
