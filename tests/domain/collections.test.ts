import { describe, expect, it } from 'vitest';
import { assertCollectionName, isMembershipActive, normalizeTagName } from '~/domain/collections';

describe('isMembershipActive', () => {
  it('is active when there is no removal', () => {
    expect(isMembershipActive({ addedHlc: '100:0:a' })).toBe(true);
  });

  it('is inactive when the removal is newer than the add', () => {
    expect(isMembershipActive({ addedHlc: '100:0:a', removedHlc: '200:0:a' })).toBe(false);
  });

  it('is active when a re-add carries a newer HLC than a stale removal', () => {
    // The convergence rule: a re-add (newer addedHlc) wins over an older removal.
    expect(isMembershipActive({ addedHlc: '300:0:a', removedHlc: '200:0:a' })).toBe(true);
  });

  it('treats an equal add/remove HLC as removed', () => {
    expect(isMembershipActive({ addedHlc: '100:0:a', removedHlc: '100:0:a' })).toBe(false);
  });

  it('treats an unparseable HLC conservatively as removed', () => {
    expect(isMembershipActive({ addedHlc: 'nonsense', removedHlc: '200:0:a' })).toBe(false);
  });
});

describe('normalizeTagName', () => {
  it('case-folds and collapses whitespace', () => {
    expect(normalizeTagName('  Sci-Fi ')).toBe('sci-fi');
    expect(normalizeTagName('Science   Fiction')).toBe('science fiction');
  });
});

describe('assertCollectionName', () => {
  it('trims and returns a valid name', () => {
    expect(assertCollectionName('  Favorites ', 'Shelf')).toBe('Favorites');
  });

  it('rejects a blank name', () => {
    expect(() => assertCollectionName('   ', 'Shelf')).toThrow(/must not be empty/i);
  });
});
