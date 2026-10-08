import { Show } from 'solid-js';
import {
  BOOK_FORMAT_LABELS,
  renderSupport,
  type BookFormat,
  type ReadingStatus,
} from '~/domain/enums';
import { statusLabel } from '~/domain/progress';

export function BookFormatBadge(props: { format: BookFormat }) {
  const support = () => renderSupport(props.format);
  return (
    <span class={`badge badge-format badge-${support()}`} title={supportTitle(props.format)}>
      {BOOK_FORMAT_LABELS[props.format]}
    </span>
  );
}

export function StatusBadge(props: { status: ReadingStatus }) {
  return (
    <span class={`badge badge-status badge-status-${props.status}`}>
      {statusLabel(props.status)}
    </span>
  );
}

export function SupportNote(props: { format: BookFormat }) {
  // Wrapped in Show so the note reacts if the same view switches books.
  return (
    <Show when={renderSupport(props.format) !== 'supported'}>
      <p class="note note-warning">
        {renderSupport(props.format) === 'experimental'
          ? props.format === 'epub' || props.format === 'pdf'
            ? `${BOOK_FORMAT_LABELS[props.format]} basic reading is verified with generated fixtures and selected upstream samples. Broader file/device validation is pending; support remains experimental.`
            : `${BOOK_FORMAT_LABELS[props.format]} reading is experimental and has no registered adapter yet.`
          : `Reading ${BOOK_FORMAT_LABELS[props.format]} files is not implemented yet. The book is imported and tracked correctly, and will become readable in a later milestone.`}
      </p>
    </Show>
  );
}

function supportTitle(format: BookFormat): string {
  const support = renderSupport(format);
  if (support === 'supported') return `${BOOK_FORMAT_LABELS[format]} reading is implemented`;
  if (support === 'experimental') return `${BOOK_FORMAT_LABELS[format]} reading is experimental`;
  return `${BOOK_FORMAT_LABELS[format]} reading is not implemented yet`;
}
