import { describe, expect, it } from 'vitest';
import { DETECTION_SAMPLE_BYTES, detectFormat, formatFromExtension } from '~/reader/format-detect';
import {
  buildCbzFixture,
  buildEpubFixture,
  buildFb2Fixture,
  buildMobiFixture,
  buildPdfFixture,
  buildPlainTextFixture,
} from '../support/fixtures';

describe('formatFromExtension', () => {
  it('recognises supported extensions case-insensitively', () => {
    expect(formatFromExtension('book.EPUB')).toBe('epub');
    expect(formatFromExtension('book.azw3')).toBe('azw3');
    expect(formatFromExtension('book.mobi')).toBe('mobi');
    expect(formatFromExtension('book.pdf')).toBe('pdf');
    expect(formatFromExtension('/path/to/Some Book.fb2')).toBe('fb2');
  });

  it('returns null for unknown or absent extensions', () => {
    expect(formatFromExtension('book.xyz')).toBeNull();
    expect(formatFromExtension('book')).toBeNull();
    expect(formatFromExtension('book.')).toBeNull();
  });
});

describe('detectFormat', () => {
  it('detects a PDF from its header with high confidence', () => {
    const detection = detectFormat(buildPdfFixture(), 'book.pdf');
    expect(detection.format).toBe('pdf');
    expect(detection.confidence).toBe('high');
  });

  it('detects a PDF whose header is preceded by junk', () => {
    const junk = new Uint8Array([0xef, 0xbb, 0xbf]);
    const pdf = buildPdfFixture();
    const combined = new Uint8Array([...junk, ...pdf]);
    const detection = detectFormat(combined, 'book.pdf');
    expect(detection.format).toBe('pdf');
    expect(detection.confidence).toBe('medium');
  });

  it('detects an EPUB from its mimetype entry', () => {
    const detection = detectFormat(buildEpubFixture(), 'book.epub');
    expect(detection.format).toBe('epub');
    expect(detection.confidence).toBe('high');
  });

  it('falls back to the extension when an EPUB omits its mimetype entry', () => {
    const detection = detectFormat(buildEpubFixture({ omitMimetype: true }), 'book.epub');
    expect(detection.format).toBe('epub');
    expect(detection.confidence).toBe('medium');
  });

  it('detects MOBI and distinguishes KF8 as AZW3', () => {
    expect(detectFormat(buildMobiFixture({ fileVersion: 6 }), 'book.mobi')).toMatchObject({
      format: 'mobi',
      confidence: 'high',
    });
    expect(detectFormat(buildMobiFixture({ fileVersion: 8 }), 'book.azw3')).toMatchObject({
      format: 'azw3',
      confidence: 'high',
    });
  });

  it('detects FictionBook XML', () => {
    expect(detectFormat(buildFb2Fixture(), 'book.fb2')).toMatchObject({ format: 'fb2' });
  });

  it('treats a non-EPUB ZIP as a comic archive with low confidence', () => {
    expect(detectFormat(buildCbzFixture(), 'comic.cbz')).toMatchObject({
      format: 'cbz',
      confidence: 'low',
    });
  });

  it('trusts content over a misleading extension', () => {
    // A real EPUB named .pdf must still be read as an EPUB.
    expect(detectFormat(buildEpubFixture(), 'mislabelled.pdf')).toMatchObject({ format: 'epub' });
  });

  it('falls back to a low-confidence extension match for unrecognised content', () => {
    const detection = detectFormat(buildPlainTextFixture(), 'notes.epub');
    expect(detection.format).toBe('epub');
    expect(detection.confidence).toBe('low');
  });

  it('reports no format for unrecognised content without a usable extension', () => {
    const detection = detectFormat(buildPlainTextFixture(), 'notes.txt');
    expect(detection.format).toBeNull();
    expect(detection.reason).toMatch(/did not match/i);
  });

  it('handles empty and truncated input without throwing', () => {
    expect(detectFormat(new Uint8Array(0), 'empty.epub').format).toBe('epub');
    expect(detectFormat(new Uint8Array(0), '').format).toBeNull();
    expect(detectFormat(new Uint8Array([0x50, 0x4b]), 'broken.epub').format).toBe('epub');
  });

  it('detects a MOBI marker that lacks a readable header version', () => {
    const truncated = buildMobiFixture().slice(0, 80);
    expect(detectFormat(truncated, 'book.mobi')).toMatchObject({
      format: 'mobi',
      confidence: 'medium',
    });
  });

  it('samples enough bytes to cover large headers', () => {
    expect(DETECTION_SAMPLE_BYTES).toBeGreaterThanOrEqual(128 * 1024);
  });
});
