import { expect, test, type Page } from '@playwright/test';
import type { AnnotationRow, ChangeRow } from '../../src/data/db';
import { buildEpubFixture, buildPdfFixture } from '../support/fixtures';
import { importBook } from './support';

async function annotationState(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('book-reader');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = <T>(store: string) =>
      new Promise<T[]>((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const rows = await read<AnnotationRow>('annotations');
    const changes = (await read<ChangeRow>('changes')).filter((row) => row.entity === 'annotation');
    db.close();
    return { rows, changes };
  });
}

for (const format of ['EPUB', 'PDF'] as const) {
  test(`${format} reports missing anchors without changing notes or diagnosing unloaded content`, async ({
    page,
  }) => {
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    const title = `Anchor Review ${format}`;
    await importBook(
      page,
      format === 'EPUB'
        ? buildEpubFixture({ title, chapters: 2, paragraphs: 12 })
        : buildPdfFixture({ title, pageCount: 3 }),
      `anchor-review.${format.toLowerCase()}`,
      title,
    );
    await page.getByRole('tab', { name: 'Notes' }).click();
    await page.getByRole('button', { name: 'Bookmark this position' }).click();
    await expect(page.locator('.reader-annotation')).toHaveCount(1);
    const bookmark = (await annotationState(page)).rows[0]!;

    // Model a restored/synced annotation whose native anchor no longer resolves.
    // The file and its saved notes stay intact while the renderer checks only
    // content it has actually loaded.
    const missing: AnnotationRow[] = [0, 1].map((index) => ({
      ...bookmark,
      id: `missing-anchor-${index}`,
      kind: 'highlight',
      locatorValue:
        format === 'EPUB'
          ? `epubcfi(/6/${2 + index * 2}!/4/2/1:999999)`
          : `${index}:0:99999:100000`,
      fraction: index / 2,
      color: 'yellow',
      textExcerpt: `Retained excerpt ${index}`,
      note: `Retained note ${index}`,
    }));
    await page.evaluate(async (rows) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('book-reader');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('annotations', 'readwrite');
        for (const row of rows) tx.objectStore('annotations').put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, missing);
    const before = await annotationState(page);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    await page.getByRole('tab', { name: 'Notes' }).click();
    const visibleMissing = page
      .locator('.reader-annotation')
      .filter({ hasText: 'Retained excerpt 0' });
    const unloaded = page.locator('.reader-annotation').filter({ hasText: 'Retained excerpt 1' });
    await expect(visibleMissing.locator('.reader-annotation-unresolved')).toContainText(
      'Anchor unavailable',
    );
    await expect(unloaded.locator('.reader-annotation-unresolved')).toHaveCount(0);
    await expect(page.locator('.reader-annotation-unresolved')).toHaveCount(1);
    expect(await annotationState(page)).toEqual(before);

    if (format === 'EPUB') {
      await page.getByRole('tab', { name: 'Contents' }).click();
      await page.getByRole('button', { name: 'Chapter 2', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Next', exact: true }).click();
    }
    await page.getByRole('tab', { name: 'Notes' }).click();
    await expect(unloaded.locator('.reader-annotation-unresolved')).toContainText(
      'Anchor unavailable',
    );
    await expect(page.locator('.reader-annotation-unresolved')).toHaveCount(2);
    expect(await annotationState(page)).toEqual(before);

    // The warning never disables note editing or portable Markdown export.
    const note = visibleMissing.getByRole('textbox', { name: 'Note', exact: true });
    await note.fill('Edited despite unavailable anchor');
    await note.blur();
    await expect
      .poll(
        async () =>
          (await annotationState(page)).rows.find((row) => row.id === missing[0]!.id)?.note,
      )
      .toBe('Edited despite unavailable anchor');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export notes', exact: true }).click(),
    ]);
    const chunks: Buffer[] = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
    const markdown = Buffer.concat(chunks).toString('utf8');
    expect(markdown).toContain('Edited despite unavailable anchor');
    expect(markdown).toContain('Retained excerpt 0');
    expect(markdown).toContain('Retained note 1');
    expect(markdown).not.toContain('Anchor unavailable');
    const after = await annotationState(page);
    expect(after.changes).toHaveLength(before.changes.length + 1);
    expect(after.rows.find((row) => row.id === missing[1]!.id)).toEqual(missing[1]);
    expect(browserErrors).toEqual([]);
  });
}
