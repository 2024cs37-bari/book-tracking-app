import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  Show,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import Icon from './Icon';
import '~/styles/select.css';

export interface SelectOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
}

interface SelectProps<T extends string> {
  readonly id?: string;
  readonly value: T;
  readonly options: readonly SelectOption<T>[];
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
}

/** Include a portaled menu when an enclosing disclosure checks outside interaction. */
export function containsSelectTarget(container: HTMLElement, target: Node): boolean {
  if (container.contains(target)) return true;
  const owner = (target instanceof Element ? target : target.parentElement)?.closest<HTMLElement>(
    '[data-select-owner]',
  )?.dataset.selectOwner;
  const trigger = owner ? document.getElementById(owner) : null;
  return trigger !== null && container.contains(trigger);
}

/**
 * Select-only combobox. Focus stays on the button; navigation previews an option
 * and Enter/Space commits it. Portaling keeps menus out of clipped scroll panels.
 */
export default function Select<T extends string>(props: SelectProps<T>) {
  const generatedId = `select-${createUniqueId()}`;
  const id = () => props.id ?? generatedId;
  const listId = () => `${id()}-options`;
  let trigger!: HTMLButtonElement;
  let menu: HTMLDivElement | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let search = '';
  let lastSearch = 0;
  const [open, setOpen] = createSignal(false);
  const [present, setPresent] = createSignal(false);
  const [activeValue, setActiveValue] = createSignal<T>();
  // Remote revisions produce fresh metadata objects. Keep interactive rows and
  // keyboard previews keyed by value through label changes and reordering.
  const optionsByValue = createMemo(() => {
    const result = new Map<T, SelectOption<T>>();
    for (const option of props.options) {
      if (!result.has(option.value)) result.set(option.value, option);
    }
    return result;
  });
  const values = createMemo(() => [...optionsByValue().keys()]);
  const active = createMemo(() =>
    Math.max(
      0,
      values().findIndex((value) => value === activeValue()),
    ),
  );
  const setActive = (index: number) => setActiveValue(() => values()[index]);
  const [position, setPosition] = createSignal({
    left: 0,
    top: 0,
    width: 200,
    height: 288,
    above: false,
  });
  const [placed, setPlaced] = createSignal(false);
  const selectedIndex = createMemo(() => values().indexOf(props.value));
  const disabled = () => props.disabled || values().length === 0;

  function close() {
    if (!open()) return;
    setOpen(false);
    search = '';
    clearTimeout(exitTimer);
    // The visual exit is inert and removed from the accessibility tree immediately.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) setPresent(false);
    else exitTimer = setTimeout(() => setPresent(false), 140);
  }

  function reveal(index = Math.max(0, selectedIndex())) {
    if (disabled()) return;
    clearTimeout(exitTimer);
    search = '';
    setActive(index);
    setPlaced(false);
    setPresent(true);
    setOpen(true);
  }

  function commit(value: T | undefined) {
    const option = value === undefined ? undefined : optionsByValue().get(value);
    if (!option || disabled()) return;
    close();
    trigger.focus({ preventScroll: true });
    if (option.value !== props.value) props.onChange(option.value);
  }

  function typeahead(character: string) {
    const now = Date.now();
    search = now - lastSearch > 700 ? character : search + character;
    lastSearch = now;
    // Repeated letters cycle through matching choices, just like a native select.
    const query = [...search].every((letter) => letter === search[0]) ? character : search;
    const start = query.length === 1 ? active() + 1 : active();
    for (let offset = 0; offset < values().length; offset++) {
      const index = (start + offset) % values().length;
      if (optionsByValue().get(values()[index]!)?.label.toLocaleLowerCase().startsWith(query)) {
        setActive(index);
        break;
      }
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (disabled() || event.ctrlKey || event.metaKey || event.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        if (event.altKey && event.key === 'ArrowUp') close();
        else if (!open()) reveal();
        else
          setActive(
            Math.max(
              0,
              Math.min(values().length - 1, active() + (event.key === 'ArrowDown' ? 1 : -1)),
            ),
          );
        break;
      case 'Home':
      case 'End':
        event.preventDefault();
        event.stopPropagation();
        if (!open()) reveal();
        setActive(event.key === 'Home' ? 0 : values().length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        event.stopPropagation();
        if (event.key === ' ' && search && Date.now() - lastSearch <= 700) typeahead(' ');
        else if (open()) commit(activeValue());
        else reveal();
        break;
      case 'Escape':
        if (open()) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        break;
      case 'Tab':
        // Leave the saved value unchanged and let normal tab order advance.
        close();
        break;
      default:
        if (event.key.length === 1 && !event.altKey) {
          event.preventDefault();
          event.stopPropagation();
          if (!open()) reveal();
          typeahead(event.key.toLocaleLowerCase());
        }
    }
  }

  function positionMenu() {
    if (!menu) return;
    const rect = trigger.getBoundingClientRect();
    const dialog = trigger.closest('dialog');
    if (
      !trigger.isConnected ||
      trigger.closest('[inert], [hidden]') ||
      (dialog && !dialog.open) ||
      rect.width === 0
    ) {
      close();
      return;
    }
    const viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
    const topEdge = (viewport?.offsetTop ?? 0) + 8;
    const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 16;
    const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 16;
    if (rect.bottom < topEdge || rect.top > bottomEdge) {
      close();
      return;
    }
    const below = Math.max(0, bottomEdge - rect.bottom - 6);
    const aboveSpace = Math.max(0, rect.top - topEdge - 6);
    const naturalHeight = Math.min(288, menu.scrollHeight);
    const above = below < naturalHeight && aboveSpace > below;
    const height = Math.min(288, above ? aboveSpace : below);
    const width = Math.min(Math.max(rect.width, 208), rightEdge - leftEdge);
    const left = Math.max(leftEdge, Math.min(rect.left, rightEdge - width));
    const top = above
      ? Math.max(topEdge, rect.top - Math.min(height, menu.scrollHeight) - 6)
      : rect.bottom + 6;
    setPosition((previous) =>
      previous.left === left &&
      previous.top === top &&
      previous.width === width &&
      previous.height === height &&
      previous.above === above
        ? previous
        : { left, top, width, height, above },
    );
    setPlaced(true);
  }

  createEffect(() => {
    if (disabled()) close();
    const current = activeValue();
    if (current === undefined || !optionsByValue().has(current))
      setActive(Math.max(0, selectedIndex()));
  });

  createEffect(() => {
    if (!open()) return;
    const outside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !trigger.contains(event.target) &&
        !menu?.contains(event.target)
      )
        close();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    document.addEventListener('fullscreenchange', close);
    // Focus and scroll anchoring can scroll a disclosure as it expands. Follow
    // a visible trigger instead of treating every scroll as dismissal; only
    // dismiss when an ancestor actually clips the trigger out of view.
    const ancestorScroll = (event: Event) => {
      if (event.target === document) positionMenu();
      else if (event.target instanceof Element && event.target.contains(trigger)) {
        const bounds = event.target.getBoundingClientRect();
        const anchor = trigger.getBoundingClientRect();
        if (
          anchor.bottom <= bounds.top ||
          anchor.top >= bounds.bottom ||
          anchor.right <= bounds.left ||
          anchor.left >= bounds.right
        )
          close();
        else positionMenu();
      }
    };
    document.addEventListener('scroll', ancestorScroll, true);
    // Follow the anchor even while its disclosure is animating, without changing
    // document layout or attaching permanent observers to every select.
    let frame = 0;
    const follow = () => {
      positionMenu();
      if (open()) frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('fullscreenchange', close);
      document.removeEventListener('scroll', ancestorScroll, true);
    });
  });

  createEffect(() => {
    const index = active();
    if (!open() || !placed()) return;
    const option = menu?.children[index] as HTMLElement | undefined;
    if (!menu || !option) return;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop - 4;
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight)
      menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight + 4;
  });

  onCleanup(() => clearTimeout(exitTimer));

  return (
    <div class="custom-select">
      <button
        ref={(element) => {
          trigger = element;
        }}
        id={id()}
        type="button"
        role="combobox"
        class="select-trigger"
        aria-label={props.ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-controls={present() ? listId() : undefined}
        aria-activedescendant={open() ? `${listId()}-${active()}` : undefined}
        data-value={props.value}
        disabled={disabled()}
        onClick={() => (open() ? close() : reveal())}
        onKeyDown={onKeyDown}
      >
        <span class="select-value">{optionsByValue().get(props.value)?.label ?? 'Choose…'}</span>
        <Icon name="chevron-down" size={16} class="select-chevron" />
      </button>
      <Show when={present()}>
        <Portal
          mount={
            trigger.closest('dialog') ??
            (document.fullscreenElement?.contains(trigger)
              ? (document.fullscreenElement as HTMLElement)
              : document.body)
          }
        >
          <div
            ref={(element) => {
              menu = element;
            }}
            id={listId()}
            role="listbox"
            aria-label={props.ariaLabel}
            aria-labelledby={props.ariaLabel ? undefined : id()}
            aria-hidden={!open()}
            inert={!open()}
            class="select-menu"
            data-select-owner={id()}
            data-state={open() ? 'open' : 'closed'}
            data-side={position().above ? 'above' : 'below'}
            style={{
              left: `${position().left}px`,
              top: `${position().top}px`,
              width: `${position().width}px`,
              'max-height': `${position().height}px`,
              visibility: placed() ? 'visible' : 'hidden',
            }}
            onMouseDown={(event) => event.preventDefault()}
          >
            <For each={values()}>
              {(value, index) => (
                <div
                  id={`${listId()}-${index()}`}
                  role="option"
                  class="select-option"
                  aria-selected={value === props.value}
                  data-active={index() === active()}
                  data-value={value}
                  onPointerMove={(event) => {
                    if (event.pointerType === 'mouse') setActive(index());
                  }}
                  onClick={() => commit(value)}
                >
                  <span>{optionsByValue().get(value)?.label}</span>
                  <Show when={value === props.value}>
                    <Icon name="check" size={16} />
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
