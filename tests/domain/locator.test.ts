import { describe, expect, it } from 'vitest';
import {
  assertLocator,
  clampFraction,
  createCfiLocator,
  createPdfHighlightLocator,
  createPdfLocator,
  describeLocator,
  formatPercent,
  isLocator,
  parsePdfHighlight,
  parsePdfLocator,
} from '~/domain/locator';
import { titleFromFilename } from '~/domain/book';
import { bytesToHex, hexToBytes, isSha256Hex } from '~/domain/ids';

describe('locators', () => {
  it('clamps fractions into range', () => {
    expect(clampFraction(-1)).toBe(0);
    expect(clampFraction(0.5)).toBe(0.5);
    expect(clampFraction(2)).toBe(1);
    expect(clampFraction(Number.NaN)).toBe(0);
    expect(clampFraction(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('round-trips a PDF position', () => {
    const locator = createPdfLocator(12, 345.6, 0.4);
    expect(locator.value).toBe('12:346');
    expect(parsePdfLocator(locator.value)).toEqual({ page: 12, yOffset: 346 });
  });

  it('rejects invalid PDF positions', () => {
    expect(parsePdfLocator('nonsense')).toBeNull();
    expect(parsePdfLocator('12')).toBeNull();
    expect(parsePdfLocator('-1:0')).toBeNull();
    expect(parsePdfLocator('1:-5')).toBeNull();
    expect(() => createPdfLocator(-1, 0, 0)).toThrow(/non-negative/i);
    expect(() => createPdfLocator(1.5, 0, 0)).toThrow(/integer/i);
  });

  it('encodes and parses a PDF highlight range while staying navigable', () => {
    const locator = createPdfHighlightLocator(4, 120, 10, 42, 0.3);
    expect(locator.value).toBe('4:120:10:42');
    expect(parsePdfLocator(locator.value)).toEqual({ page: 4, yOffset: 120 });
    expect(parsePdfHighlight(locator.value)).toEqual({ page: 4, yOffset: 120, start: 10, end: 42 });
  });

  it('rejects malformed PDF highlight anchors and ranges', () => {
    expect(parsePdfHighlight('4:120')).toBeNull();
    expect(parsePdfHighlight('4:120:42:10')).toBeNull();
    expect(parsePdfHighlight('4:120:10:10')).toBeNull();
    expect(() => createPdfHighlightLocator(1, 0, 5, 5, 0)).toThrow(/start < end/i);
    expect(() => createPdfHighlightLocator(-1, 0, 0, 1, 0)).toThrow(/non-negative/i);
  });

  it('accepts a well-formed locator and rejects malformed ones', () => {
    expect(isLocator(createCfiLocator('epubcfi(/6/4!/4/2)', 0.25))).toBe(true);
    for (const candidate of [
      null,
      'string',
      { kind: 'cfi', value: '', fraction: 0 },
      { kind: 'unknown', value: 'x', fraction: 0 },
      { kind: 'cfi', value: 'x', fraction: 1.5 },
      { kind: 'cfi', value: 'x', fraction: Number.NaN },
      { kind: 'cfi', value: 'x'.repeat(513), fraction: 0 },
    ]) {
      expect(isLocator(candidate), `expected ${JSON.stringify(candidate)} to be invalid`).toBe(
        false,
      );
    }
    expect(() => assertLocator({ kind: 'pdf', value: '1:0', fraction: -1 })).toThrow();
  });

  it('describes positions for display', () => {
    expect(describeLocator(null)).toBe('Not started');
    expect(describeLocator(createPdfLocator(0, 0, 0.125))).toBe('Page 1 · 13%');
    expect(describeLocator(createCfiLocator('cfi', 0.5))).toBe('50%');
    expect(formatPercent(0.994)).toBe('99%');
  });
});

describe('content identity helpers', () => {
  it('validates SHA-256 text', () => {
    expect(isSha256Hex('a'.repeat(64))).toBe(true);
    expect(isSha256Hex('A'.repeat(64))).toBe(false);
    expect(isSha256Hex('a'.repeat(63))).toBe(false);
    expect(isSha256Hex('g'.repeat(64))).toBe(false);
    expect(isSha256Hex(42)).toBe(false);
  });

  it('round-trips bytes through hex', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 254, 255]);
    expect(bytesToHex(bytes)).toBe('00010f10feff');
    expect([...hexToBytes('00010f10feff')]).toEqual([...bytes]);
    expect(() => hexToBytes('abc')).toThrow(/even/i);
    expect(() => hexToBytes('zz')).toThrow(/non-hexadecimal/i);
  });
});

describe('titleFromFilename', () => {
  it('derives a readable title from typical filenames', () => {
    expect(titleFromFilename('The_Hobbit.epub')).toBe('The Hobbit');
    expect(titleFromFilename('/home/user/books/deep+work.pdf')).toBe('deep work');
    expect(titleFromFilename('Dune.azw3')).toBe('Dune');
    expect(titleFromFilename('no-extension')).toBe('no-extension');
  });

  it('falls back to a placeholder rather than an empty title', () => {
    expect(titleFromFilename('.epub')).toBe('Untitled');
    expect(titleFromFilename('')).toBe('Untitled');
    expect(titleFromFilename('___')).toBe('Untitled');
  });

  it('bounds very long titles', () => {
    expect(titleFromFilename(`${'a'.repeat(900)}.epub`).length).toBe(512);
  });
});
