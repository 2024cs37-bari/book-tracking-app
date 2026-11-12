import { afterEach, expect, it, vi } from 'vitest';
import { PositionJournal, POSITION_JOURNAL_MAX_AGE_MS } from '~/services/position-journal';
import type { Locator } from '~/domain/locator';

function storage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => data.delete(key),
    setItem: (key, value) => data.set(key, value),
  };
}
afterEach(() => vi.restoreAllMocks());

const first: Locator = { kind: 'cfi', value: 'epubcfi(/6/2)', fraction: 0.2 };
const last: Locator = { kind: 'cfi', value: 'epubcfi(/6/8)', fraction: 0.8 };

it('persists unsaved positions across service instances and clears only an acknowledged token', () => {
  const store = storage();
  const journal = new PositionJournal('profile', () => store);
  const a = journal.write('book', first);
  const b = journal.write('book', last);
  journal.clear('book', a.token);
  expect(new PositionJournal('profile', () => store).read('book')).toEqual(b);
  journal.clear('book', b.token);
  expect(new PositionJournal('profile', () => store).read('book')).toBeUndefined();
});

it('keeps a newer other-tab journal when an earlier tab acknowledges its write', () => {
  const store = storage();
  const one = new PositionJournal('profile', () => store);
  const two = new PositionJournal('profile', () => store);
  const earlier = one.write('book', first);
  const newer = two.write('book', last);
  one.clear('book', earlier.token);
  expect(new PositionJournal('profile', () => store).read('book')).toEqual(newer);
});

it('uses the latest memory intent when storage fails instead of replaying stale storage', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const store = storage();
  const journal = new PositionJournal('profile', () => store);
  journal.write('book', first);
  vi.spyOn(store, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  const newest = journal.write('book', last);
  expect(journal.read('book')).toEqual(newest);
});

it('reads the latest other-tab intent even when an older memory intent has the same timestamp', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const store = storage();
  const one = new PositionJournal('profile', () => store);
  const two = new PositionJournal('profile', () => store);
  const earlier = one.write('book', first);
  const newest = two.write('book', last);
  expect(one.read('book')).toEqual(newest);
  one.clear('book', earlier.token);
  expect(one.read('book')).toEqual(newest);
});

it('migrates only matching original journals in the current namespace, keeping the latest intent', () => {
  const store = storage();
  const journal = new PositionJournal('profile', () => store);
  const hash = 'a'.repeat(64);
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  journal.write('older-uuid', first, hash);
  vi.spyOn(Date, 'now').mockReturnValue(2000);
  journal.write('newer-uuid', last, hash);
  journal.write('other-original', first, 'b'.repeat(64));
  new PositionJournal('other-profile', () => store).write('unrelated', first, hash);
  const restarted = new PositionJournal('profile', () => store);
  restarted.migrateOriginal(hash, `sha256:${hash}`);
  expect(restarted.read(`sha256:${hash}`)?.locator).toEqual(last);
  expect(restarted.read('older-uuid')).toBeUndefined();
  expect(restarted.read('newer-uuid')).toBeUndefined();
  expect(restarted.read('other-original')?.locator).toEqual(first);
  expect(new PositionJournal('other-profile', () => store).read('unrelated')?.locator).toEqual(
    first,
  );
});

it('retains the durable legacy intent if saving its new key fails during migration', () => {
  const store = storage();
  const journal = new PositionJournal('profile', () => store);
  const original = journal.write('retired-id', last, 'a'.repeat(64));
  const fail = vi.spyOn(store, 'setItem').mockImplementation(() => {
    throw new Error('quota exceeded');
  });
  journal.migrateOriginal('a'.repeat(64), 'stable-content-key');
  expect(journal.read('stable-content-key')?.locator).toEqual(last);
  expect(new PositionJournal('profile', () => store).read('retired-id')).toEqual(original);
  fail.mockRestore();
  const restarted = new PositionJournal('profile', () => store);
  restarted.migrateOriginal('a'.repeat(64), 'stable-content-key');
  expect(restarted.read('stable-content-key')?.locator).toEqual(last);
  expect(restarted.read('retired-id')).toBeUndefined();
});

it('isolates databases and ignores invalid locators in stored JSON', () => {
  const store = storage();
  new PositionJournal('one', () => store).write('book', first);
  expect(new PositionJournal('two', () => store).read('book')).toBeUndefined();
  const key = store.key(0)!;
  store.setItem(
    key,
    JSON.stringify({ token: 'unsafe', locator: { kind: 'cfi', value: '', fraction: 8 } }),
  );
  expect(new PositionJournal('one', () => store).read('book')).toBeUndefined();
});

it('expires stale intents and rejects malformed clock data', () => {
  const store = storage();
  const journal = new PositionJournal('profile', () => store);
  const intent = journal.write('book', first);
  vi.spyOn(Date, 'now').mockReturnValue(intent.recordedAt + POSITION_JOURNAL_MAX_AGE_MS + 1);
  expect(new PositionJournal('profile', () => store).read('book')).toBeUndefined();
  expect(journal.read('book')).toBeUndefined();
});
