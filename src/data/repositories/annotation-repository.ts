import { AppError } from '~/domain/errors';
import { formatHlc } from '~/domain/hlc';
import { newId } from '~/domain/ids';
import {
  assertNewAnnotation,
  MAX_ANNOTATION_NOTE_LENGTH,
  type Annotation,
  type NewAnnotation,
} from '~/domain/annotation';
import type { AnnotationRow, LibraryDatabase } from '../db';
import { makeChangeRow, type MutationContext } from '../mutations';

export interface AnnotationPatch {
  readonly note?: string;
  readonly color?: string;
}

/**
 * Reads and writes annotations (highlights, notes, bookmarks).
 *
 * Every mutation writes its outbox row in the same transaction, and deletion is
 * a tombstone (`deleted: true`) so the removal can replicate rather than
 * silently vanishing on other devices.
 */
export class AnnotationRepository {
  constructor(
    private readonly db: LibraryDatabase,
    private readonly context: MutationContext,
  ) {}

  async listByBook(bookId: string): Promise<Annotation[]> {
    const rows = await this.db.annotations.where('bookId').equals(bookId).toArray();
    return rows
      .filter((row) => !row.deleted)
      .sort((left, right) => left.fraction - right.fraction)
      .map(toAnnotation);
  }

  async getById(id: string): Promise<Annotation | undefined> {
    const row = await this.db.annotations.get(id);
    return row === undefined || row.deleted ? undefined : toAnnotation(row);
  }

  async create(input: NewAnnotation): Promise<Annotation> {
    assertNewAnnotation(input);
    const hlc = formatHlc(this.context.clock.next());
    const row: AnnotationRow = {
      id: newId(),
      bookId: input.bookId,
      kind: input.kind,
      locatorKind: input.locator.kind,
      locatorValue: input.locator.value,
      fraction: input.locator.fraction,
      textExcerpt: input.textExcerpt,
      note: input.note,
      color: input.color,
      createdHlc: hlc,
      updatedHlc: hlc,
      deleted: false,
    };
    await this.db.transaction('rw', this.db.annotations, this.db.changes, async () => {
      await this.db.annotations.add(row);
      await this.db.changes.add(makeChangeRow(this.context, 'annotation', row.id, 'upsert', row));
    });
    return toAnnotation(row);
  }

  async update(id: string, patch: AnnotationPatch): Promise<Annotation> {
    if (patch.note !== undefined && patch.note.length > MAX_ANNOTATION_NOTE_LENGTH) {
      throw new Error(`Annotation note must be ${MAX_ANNOTATION_NOTE_LENGTH} characters or fewer.`);
    }
    return this.db.transaction('rw', this.db.annotations, this.db.changes, async () => {
      const row = await this.db.annotations.get(id);
      if (row === undefined || row.deleted) {
        throw new AppError('not_found', `Annotation ${id} does not exist.`);
      }
      const next: AnnotationRow = {
        ...row,
        ...patch,
        updatedHlc: formatHlc(this.context.clock.next()),
      };
      await this.db.annotations.put(next);
      await this.db.changes.add(makeChangeRow(this.context, 'annotation', id, 'upsert', next));
      return toAnnotation(next);
    });
  }

  async remove(id: string): Promise<void> {
    await this.db.transaction('rw', this.db.annotations, this.db.changes, async () => {
      const row = await this.db.annotations.get(id);
      if (row === undefined || row.deleted) return;
      const next: AnnotationRow = {
        ...row,
        deleted: true,
        updatedHlc: formatHlc(this.context.clock.next()),
      };
      await this.db.annotations.put(next);
      await this.db.changes.add(makeChangeRow(this.context, 'annotation', id, 'delete', next));
    });
  }
}

function toAnnotation(row: AnnotationRow): Annotation {
  return {
    id: row.id,
    bookId: row.bookId,
    kind: row.kind,
    locator: { kind: row.locatorKind, value: row.locatorValue, fraction: row.fraction },
    textExcerpt: row.textExcerpt,
    note: row.note,
    color: row.color,
    createdHlc: row.createdHlc,
    updatedHlc: row.updatedHlc,
    deleted: row.deleted,
  };
}
