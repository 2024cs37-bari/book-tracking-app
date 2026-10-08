import { renderSupport, type BookFormat } from '~/domain/enums';
import { titleFromFilename } from '~/domain/book';
import { epubMetadataExtractor } from './epub';
import { pdfMetadataExtractor } from './pdf';
import type { ExtractedMetadata, MetadataExtractionInput, MetadataExtractor } from './types';

export function createMetadataExtractors(): MetadataExtractor[] {
  return [epubMetadataExtractor, pdfMetadataExtractor];
}

export interface MetadataExtractionResult {
  /** Always has a usable title: embedded metadata first, filename as fallback. */
  readonly metadata: ExtractedMetadata & { readonly title: string };
  /** True when the title came from the filename rather than the file itself. */
  readonly usedFilenameTitle: boolean;
  /** True when embedded metadata was missing or only partially read. */
  readonly incomplete: boolean;
  /** Which extractor ran, for diagnostics. */
  readonly source: string;
}

function findExtractor(
  format: BookFormat,
  extractors: readonly MetadataExtractor[],
): MetadataExtractor | undefined {
  return extractors.find((extractor) => extractor.formats.includes(format));
}

/**
 * Extracts metadata with an explicit fallback chain.
 *
 * A book is never rejected for having poor metadata: bad or unparseable files
 * are imported with a filename-derived title and flagged, which is far more
 * useful than refusing the import (see docs/IMPORT-AND-READER.md §2).
 */
export async function extractBookMetadata(
  input: MetadataExtractionInput,
  extractors: readonly MetadataExtractor[] = createMetadataExtractors(),
): Promise<MetadataExtractionResult> {
  const extractor = findExtractor(input.format, extractors);
  const warnings: string[] = [];

  let extracted: ExtractedMetadata = { warnings };
  let source = 'None';

  if (extractor === undefined) {
    warnings.push(`No metadata extractor is available for ${input.format.toUpperCase()} files.`);
  } else {
    source = extractor.source;
    try {
      extracted = await extractor.extract(input);
    } catch (error) {
      warnings.push(
        `Metadata extraction failed: ${error instanceof Error ? error.message : 'unknown error'}.`,
      );
      extracted = { warnings };
    }
  }

  const embeddedTitle = extracted.title?.trim();
  const usedFilenameTitle = embeddedTitle === undefined || embeddedTitle.length === 0;
  const title = usedFilenameTitle ? titleFromFilename(input.filename) : embeddedTitle;

  const support = renderSupport(input.format);
  if (support === 'deferred') {
    warnings.push(
      `${input.format.toUpperCase()} files can be imported and tracked, but reading them is not implemented yet.`,
    );
  } else if (support === 'experimental') {
    warnings.push(
      `${input.format.toUpperCase()} reading support is experimental and has not been validated against a test corpus.`,
    );
  }

  return {
    metadata: { ...extracted, title, warnings: [...warnings, ...extracted.warnings] },
    usedFilenameTitle,
    incomplete: usedFilenameTitle || extracted.warnings.length > 0,
    source,
  };
}

export { epubMetadataExtractor, pdfMetadataExtractor };
export type { ExtractedMetadata, MetadataExtractionInput, MetadataExtractor };
