import { For, Show, type JSX } from 'solid-js';

export interface SidebarTab {
  readonly id: string;
  readonly label: string;
}

/**
 * The reader's collapsible navigation sidebar: a tab strip over a scrolling
 * panel body, a desktop drag-to-resize handle, and a mobile scrim. The panel
 * body is supplied by the caller as children (switched on the active tab). On
 * a wide screen the shell lays this out beside the reader (CSS); on a narrow
 * one it overlays with the scrim.
 */
export default function ReaderSidebar(props: {
  open: boolean;
  panel: string;
  tabs: readonly SidebarTab[];
  width: number;
  onPanel: (id: string) => void;
  onClose: () => void;
  onResize: (width: number) => void;
  children: JSX.Element;
}) {
  let aside: HTMLElement | undefined;

  function startResize(event: PointerEvent): void {
    event.preventDefault();
    const move = (moveEvent: PointerEvent): void => {
      if (aside === undefined) return;
      const left = aside.getBoundingClientRect().left;
      props.onResize(Math.max(220, Math.min(520, Math.round(moveEvent.clientX - left))));
    };
    const up = (): void => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  return (
    <Show when={props.open}>
      <div class="reader-scrim" role="presentation" onClick={() => props.onClose()} />
      <aside
        class="reader-sidebar"
        aria-label="Reader navigation"
        style={{ '--reader-sidebar-width': `${props.width}px` }}
        ref={(element) => {
          aside = element;
        }}
      >
        <div class="reader-sidebar-tabs" role="tablist" aria-label="Reader panels">
          <For each={props.tabs}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                class="reader-tab"
                classList={{ active: props.panel === tab.id }}
                aria-selected={props.panel === tab.id}
                onClick={() => props.onPanel(tab.id)}
              >
                {tab.label}
              </button>
            )}
          </For>
          <button
            type="button"
            class="reader-sidebar-close"
            aria-label="Close sidebar"
            onClick={() => props.onClose()}
          >
            ×
          </button>
        </div>
        <div class="reader-sidebar-body" role="tabpanel">
          {props.children}
        </div>
        <div
          class="reader-sidebar-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onPointerDown={startResize}
        />
      </aside>
    </Show>
  );
}
