import { newId } from '~/domain/ids';
import { formatHlc, type Clock } from '~/domain/hlc';
import type { ChangeOp, ChangeRow, ReplicatedEntity } from './db';
import { parseReplicatedRow } from './replicated-validation';

/**
 * Shared context for every replicated mutation.
 *
 * Repositories never read wall-clock time directly: ordering must come from
 * the HLC so devices converge, and one place must own that to keep it honest.
 */
export interface MutationContext {
  readonly clock: Clock;
  readonly deviceId: string;
}

export function createMutationContext(clock: Clock): MutationContext {
  return { clock, deviceId: clock.deviceId };
}

export function makeChangeRow(
  context: MutationContext,
  entity: ReplicatedEntity,
  entityId: string,
  op: ChangeOp,
  payload: unknown,
): ChangeRow {
  // Reject invalid local input before its transaction can commit a row that
  // other devices or backup recovery would have to refuse.
  const validated = parseReplicatedRow(entity, payload);
  return {
    id: newId(),
    entity,
    entityId,
    op,
    payload: JSON.stringify(validated),
    hlc: formatHlc(context.clock.next()),
    deviceId: context.deviceId,
    createdAt: Date.now(),
    pushedAt: 0,
  };
}
