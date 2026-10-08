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

export default function ReaderContents(props: {
  items: readonly TocItem[];
  loading: boolean;
  error: string;
  onSelect: (locator: Locator) => void;
}) {
  let panel!: HTMLDetailsElement;
  const select = (locator: Locator) => {
    props.onSelect(locator);
    panel.open = false;
    panel.querySelector('summary')?.focus();
  };
  return (
    <details
      class="reader-contents"
      ref={(element) => {
        panel = element;
      }}
    >
      <summary>Table of contents</summary>
      <Show when={!props.loading} fallback={<p role="status">Loading contents…</p>}>
        <Show when={!props.error} fallback={<p role="status">{props.error}</p>}>
          <Show when={props.items.length} fallback={<p>No table of contents available.</p>}>
            <nav aria-label="Book contents">
              <ContentsList items={props.items} onSelect={select} />
            </nav>
          </Show>
        </Show>
      </Show>
    </details>
  );
}
