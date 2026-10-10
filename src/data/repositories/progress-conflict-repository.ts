import { compareHlc, parseHlc } from '~/domain/hlc';
import type { LibraryDatabase, ProgressConflictRow } from '../db';
import type { ProgressRepository } from './progress-repository';

export type ProgressConflictChoice = 'local' | 'remote';

/** True when `candidate` is strictly newer than `existing` (or there is none). */
function isNewer(candidate: string | undefined, existing: string | undefined): boolean {
  if (candidate === undefined) return false;
  if (existing === undefined) return true;
  const a = parseHlc(candidate);
  const b = parseHlc(existing);
  if (a === null) return false;
  if (b === null) return true;
  return compareHlc(a, b) > 0;
}

/**
 * Reads and resolves pending progress-divergence prompts (docs/SYNC.md §6).
 *
 * These rows are recorded by the sync apply path when a remote reading position
 * diverges from the local one beyond the threshold; the local position is left
 * untouched until the user chooses. Resolution is explicit:
 *
 * - `remote`: accept the remote position (applied as pulled data — no outbox
 *   echo), provided it is still newer than whatever the local row now holds.
 * - `local`: keep the local position and re-assert it as a fresh mutation so it
 *   dominates the remote candidate and the choice propagates to other devices.
 *
 * A later local read also dismisses the prompt (see ProgressRepository.save).
 */
export class ProgressConflictRepository {
  constructor(
    private readonly db: LibraryDatabase,
    private readonly progress: ProgressRepository,
  ) {}

  async list(): Promise<ProgressConflictRow[]> {
    return this.db.progressConflicts.toArray();
  }

  async get(bookId: string): Promise<ProgressConflictRow | undefined> {
    return this.db.progressConflicts.get(bookId);
  }

  async count(): Promise<number> {
    return this.db.progressConflicts.count();
  }

  async resolve(bookId: string, choice: ProgressConflictChoice): Promise<void> {
    const conflict = await this.db.progressConflicts.get(bookId);
    if (conflict === undefined) return;

    if (choice === 'remote') {
      await this.db.transaction('rw', this.db.progress, this.db.progressConflicts, async () => {
        const local = await this.db.progress.get(bookId);
        // Accept the remote candidate as pulled data (no outbox): it already
        // exists on the server and will propagate to other devices by LWW.
        if (isNewer(conflict.remote.updatedHlc, local?.updatedHlc)) {
          await this.db.progress.put(conflict.remote);
        }
        await this.db.progressConflicts.delete(bookId);
      });
      return;
    }

    // Keep local: re-assert the local position with a fresh HLC + outbox row so
    // it beats the remote candidate everywhere. save() also clears the prompt.
    const local = await this.db.progress.get(bookId);
    if (local?.locatorKind !== undefined && local.locatorValue !== undefined) {
      await this.progress.save({
        bookId,
        locator: { kind: local.locatorKind, value: local.locatorValue, fraction: local.fraction },
        status: local.status,
      });
    }
    await this.db.progressConflicts.delete(bookId);
  }
}
