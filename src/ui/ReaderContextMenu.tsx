import { For, type JSX, onCleanup, onMount, Show } from 'solid-js';

/** A single entry in the reader context menu. */
export interface ContextMenuAction {
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
}

/** A highlight colour swatch offered at the top of the menu. */
export interface ContextMenuColor {
  readonly token: string;
  readonly label: string;
  readonly css: string;
}

export interface ReaderContextMenuProps {
  /** Pointer x in viewport (CSS) pixels; the menu is clamped to stay on screen. */
  readonly x: number;
  readonly y: number;
  readonly actions: readonly ContextMenuAction[];
  /**
   * Optional highlight-colour swatches rendered as a row above the actions.
   * When present (with {@link onColor}), choosing a swatch highlights the
   * selection in that colour.
   */
  readonly colors?: readonly ContextMenuColor[];
  readonly onColor?: (token: string) => void;
  /** Called when the menu should disappear (action chosen, Escape, outside click). */
  readonly onClose: () => void;
}

const EDGE_MARGIN = 8;

/**
 * A small positioned menu shown over a text selection in the reader. It is a
 * controlled, transient surface: the parent owns the open/closed state and the
 * action handlers; this component only renders, places and dismisses itself.
 *
 * Accessibility: role=menu with role=menuitem children, first item focused on
 * open, Up/Down (wrapping) + Home/End move focus, Escape and outside clicks
 * close it.
 */
export default function ReaderContextMenu(props: ReaderContextMenuProps): JSX.Element {
  let menuRef: HTMLDivElement | undefined;
  const swatchEls: (HTMLButtonElement | undefined)[] = [];
  const itemEls: (HTMLButtonElement | undefined)[] = [];

  // All focusable controls in DOM order: colour swatches first, then actions.
  function enabledEls(): HTMLButtonElement[] {
    const result: HTMLButtonElement[] = [];
    (props.colors ?? []).forEach((_, index) => {
      const element = swatchEls[index];
      if (element !== undefined) result.push(element);
    });
    props.actions.forEach((action, index) => {
      const element = itemEls[index];
      if (action.disabled !== true && element !== undefined) result.push(element);
    });
    return result;
  }

  function focusByOffset(offset: number): void {
    const items = enabledEls();
    if (items.length === 0) return;
    const active = document.activeElement;
    const current = items.findIndex((element) => element === active);
    const base = current === -1 ? (offset > 0 ? -1 : 0) : current;
    const next = (base + offset + items.length) % items.length;
    items[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      focusByOffset(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      focusByOffset(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      enabledEls()[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      const items = enabledEls();
      items[items.length - 1]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
    }
  }

  function choose(action: ContextMenuAction): void {
    if (action.disabled === true) return;
    action.onSelect();
    props.onClose();
  }

  function chooseColor(token: string): void {
    props.onColor?.(token);
    props.onClose();
  }

  onMount(() => {
    // Clamp to the viewport once the real size is known, so the menu never
    // spills off the edge near the pointer.
    const element = menuRef;
    if (element !== undefined) {
      const rect = element.getBoundingClientRect();
      const maxLeft = Math.max(EDGE_MARGIN, window.innerWidth - rect.width - EDGE_MARGIN);
      const maxTop = Math.max(EDGE_MARGIN, window.innerHeight - rect.height - EDGE_MARGIN);
      element.style.left = `${Math.max(EDGE_MARGIN, Math.min(props.x, maxLeft))}px`;
      element.style.top = `${Math.max(EDGE_MARGIN, Math.min(props.y, maxTop))}px`;
    }
    enabledEls()[0]?.focus();

    const onPointerDown = (event: Event): void => {
      const target = event.target;
      if (menuRef !== undefined && target instanceof Node && !menuRef.contains(target)) {
        props.onClose();
      }
    };
    const onDocKey = (event: KeyboardEvent): void => {
      // Capture-phase so Escape closes the menu without also reaching the
      // reader shell's own key handling (which would, e.g., close the sidebar).
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }
    };
    const onDismiss = (): void => props.onClose();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onDocKey, true);
    window.addEventListener('resize', onDismiss);
    window.addEventListener('scroll', onDismiss, true);
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onDocKey, true);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('scroll', onDismiss, true);
    });
  });

  return (
    <div
      ref={(element) => {
        menuRef = element;
      }}
      class="reader-context-menu"
      role="menu"
      aria-label="Selection actions"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
      onKeyDown={onKeyDown}
    >
      <Show when={(props.colors?.length ?? 0) > 0}>
        <div class="reader-context-menu-swatches" role="group" aria-label="Highlight colour">
          <For each={props.colors}>
            {(colour, index) => (
              <button
                ref={(element) => {
                  swatchEls[index()] = element;
                }}
                type="button"
                class="reader-context-menu-swatch"
                role="menuitem"
                style={{ background: colour.css }}
                aria-label={`Highlight ${colour.label}`}
                title={`Highlight ${colour.label}`}
                onClick={() => chooseColor(colour.token)}
              />
            )}
          </For>
        </div>
      </Show>
      <For each={props.actions}>
        {(action, index) => (
          <button
            ref={(element) => {
              itemEls[index()] = element;
            }}
            type="button"
            class="reader-context-menu-item"
            role="menuitem"
            disabled={action.disabled === true}
            onClick={() => choose(action)}
          >
            {action.label}
          </button>
        )}
      </For>
    </div>
  );
}
