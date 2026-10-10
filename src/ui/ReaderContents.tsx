import { For, Show } from 'solid-js';
import type { Locator } from '~/domain/locator';
import type { TocItem } from '~/reader/renderer';

function ContentsList(props: { items: readonly TocItem[]; onSelect: (locator: Locator) => void }) {
  return (
    <ol>
      <For each={props.items}>
        {(item) => (
          <li>
            <button
              class="contents-entry"
              type="button"
              disabled={!item.locator}
              title={!item.locator ? 'This contents entry has no readable destination.' : undefined}
              onClick={() => {
                if (item.locator) props.onSelect(item.locator);
              }}
            >
              {item.label || 'Untitled section'}
            </button>
            <Show when={item.children?.length}>
              <ContentsList items={item.children ?? []} onSelect={props.onSelect} />
            </Show>
          </li>
        )}
      </For>
    </ol>
  );
}

/**
 * The Contents (table-of-contents) sidebar panel body. The surrounding panel
 * chrome (tab, scroll area) is provided by {@link ReaderSidebar}; this renders
 * only the loading/error/empty states and the recursive entry list.
 */
export default function ReaderContents(props: {
  items: readonly TocItem[];
  loading: boolean;
  error: string;
  onSelect: (locator: Locator) => void;
}) {
  return (
    <Show
      when={!props.loading}
      fallback={
        <p class="note" role="status">
          Loading contents…
        </p>
      }
    >
      <Show
        when={!props.error}
        fallback={
          <p class="note" role="status">
            {props.error}
          </p>
        }
      >
        <Show
          when={props.items.length}
          fallback={<p class="note">No table of contents available.</p>}
        >
          <nav class="reader-contents" aria-label="Book contents">
            <ContentsList items={props.items} onSelect={props.onSelect} />
          </nav>
        </Show>
      </Show>
    </Show>
  );
}
