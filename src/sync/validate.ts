import {
  parseReplicatedRow,
  validateReplicatedHlc,
  type ReplicatedRows,
} from '~/data/replicated-validation';
import type { ReplicatedEntity } from '~/data/db';
import { compareHlc, parseHlc } from '~/domain/hlc';
import type { PullChange } from './protocol';
import { SyncHttpError } from './http-transport';

/** Invalid remote rows stop the page; silently skipping would permanently lose data at its cursor. */
export function validatePullPayload(change: PullChange): ReplicatedRows[ReplicatedEntity] {
  try {
    const now = Date.now();
    validateReplicatedHlc(change.hlc, now);
    const row = parseReplicatedRow(change.entity, change.payload, now);
    const identity =
      'id' in row
        ? row.id
        : 'shelfId' in row
          ? `${row.shelfId}:${row.bookId}`
          : 'tagId' in row
            ? `${row.tagId}:${row.bookId}`
            : row.bookId;
    if (identity !== change.entity_id)
      throw new Error('Payload identity differs from its envelope.');
    // The event clock must cover every register it carries. Otherwise a forged
    // field/membership clock can override edits without being observed locally.
    const payloadClocks = [
      ...('updatedHlc' in row ? [row.updatedHlc] : []),
      ...('addedHlc' in row ? [row.addedHlc, row.removedHlc] : []),
      ...('metadataHlcs' in row ? Object.values(row.metadataHlcs ?? {}) : []),
    ];
    if (
      payloadClocks.some(
        (clock) => clock !== undefined && compareHlc(parseHlc(clock)!, parseHlc(change.hlc)!) > 0,
      )
    )
      throw new Error('Payload clock exceeds its event clock.');
    return row;
  } catch (error) {
    throw new SyncHttpError(
      `Invalid ${change.entity} change ${change.change_id}; its page was not applied. ${error instanceof Error ? error.message : 'Invalid payload.'}`,
      { retryable: false, code: 'invalid_payload' },
    );
  }
}
