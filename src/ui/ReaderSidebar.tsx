import { For, Show, createUniqueId, type JSX } from 'solid-js';
import Icon from './Icon';

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
  const prefix = createUniqueId();
  const panelId = `${prefix}-panel`;
  const tabId = (id: string) => `${prefix}-tab-${id}`;
  function close(): void {
    props.onClose();
    document.getElementById('reader-sidebar-toggle')?.focus();
  }
  function tabKey(event: KeyboardEvent, current: string): void {
    const index = props.tabs.findIndex((tab) => tab.id === current);
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % props.tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + props.tabs.length - 1) % props.tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = props.tabs.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    const tab = props.tabs[next];
    if (!tab) return;
    props.onPanel(tab.id);
    document.getElementById(tabId(tab.id))?.focus();
  }
  function resizeKey(event: KeyboardEvent): void {
    let width = props.width;
    if (event.key === 'ArrowRight') width += 20;
    else if (event.key === 'ArrowLeft') width -= 20;
    else if (event.key === 'Home') width = 220;
    else if (event.key === 'End') width = 520;
    else return;
    event.preventDefault();
    event.stopPropagation();
    props.onResize(Math.max(220, Math.min(520, width)));
  }

  function startResize(event: PointerEvent): void {
    event.preventDefault();
    const left = aside?.getBoundingClientRect().left ?? 0;
    let latest = props.width;
    // Commit the width only on release so the reading surface resizes (and the
    // engine reflows/re-renders) once, not on every pointer frame of the drag.
    const move = (moveEvent: PointerEvent): void => {
      latest = Math.max(220, Math.min(520, Math.round(moveEvent.clientX - left)));
    };
    const up = (): void => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      props.onResize(latest);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  return (
    <Show when={props.open}>
      <div class="reader-scrim" role="presentation" onClick={close} />
      <aside
        class="reader-sidebar"
        id="reader-sidebar"
        aria-label="Reader navigation"
        style={{ '--reader-sidebar-width': `${props.width}px` }}
        ref={(element) => {
          aside = element;
        }}
      >
        <div class="reader-sidebar-heading">
          <span>In this book</span>
          <button
            type="button"
            class="reader-sidebar-close"
            aria-label="Close sidebar"
            title="Close sidebar"
            onClick={close}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        <div class="reader-sidebar-tabs">
          <div role="tablist" aria-label="Reader panels" style={{ display: 'contents' }}>
            <For each={props.tabs}>
              {(tab) => (
                <button
                  type="button"
                  role="tab"
                  class="reader-tab"
                  classList={{ active: props.panel === tab.id }}
                  id={tabId(tab.id)}
                  aria-controls={panelId}
                  tabIndex={props.panel === tab.id ? 0 : -1}
                  aria-selected={props.panel === tab.id}
                  onKeyDown={(event) => tabKey(event, tab.id)}
                  onClick={() => props.onPanel(tab.id)}
                >
                  {tab.label}
                </button>
              )}
            </For>
          </div>
        </div>
        <div
          class="reader-sidebar-body"
          role="tabpanel"
          id={panelId}
          aria-labelledby={tabId(props.panel)}
          tabIndex={0}
        >
          {props.children}
        </div>
        <div
          class="reader-sidebar-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          tabIndex={0}
          aria-valuemin={220}
          aria-valuemax={520}
          aria-valuenow={props.width}
          aria-valuetext={`${props.width} pixels`}
          onKeyDown={resizeKey}
          onPointerDown={startResize}
        />
      </aside>
    </Show>
  );
}
