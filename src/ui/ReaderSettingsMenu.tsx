import { createSignal, createUniqueId, For, onCleanup, Show } from 'solid-js';
import {
  DEFAULT_READER_SETTINGS,
  type ReaderSettings,
  type ReaderMode,
  type ReaderTheme,
} from '~/reader/settings';
import Icon from './Icon';
import Select from './Select';

const MODES = [
  { value: 'single', label: 'Single', icon: 'page-single' },
  { value: 'double', label: 'Facing', icon: 'page-double' },
  { value: 'continuous', label: 'Continuous', icon: 'page-scroll' },
] as const;

export default function ReaderSettingsMenu(props: {
  settings: ReaderSettings;
  onChange: (patch: Partial<ReaderSettings>) => void;
  pdf: boolean;
  fixed: boolean;
  ready: boolean;
}) {
  const drawerId = `reader-settings-${createUniqueId()}`;
  let drawer!: HTMLDialogElement;
  let trigger!: HTMLButtonElement;
  let closeButton!: HTMLButtonElement;
  let backdropPointerDown = false;
  const [open, setOpen] = createSignal(false);
  const close = (restoreFocus = false) => {
    drawer.close();
    setOpen(false);
    document.documentElement.classList.remove('reader-settings-open');
    if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
  };
  const reveal = () => {
    if (drawer.open) return;
    drawer.showModal();
    setOpen(true);
    document.documentElement.classList.add('reader-settings-open');
    closeButton.focus({ preventScroll: true });
  };
  onCleanup(() => close());
  const mode = (): ReaderMode =>
    props.fixed && props.settings.mode === 'continuous' ? 'single' : props.settings.mode;
  return (
    <div class="reader-settings-popover">
      <button
        type="button"
        class="reader-icon-button reader-settings-summary"
        aria-label="Reader settings"
        aria-expanded={open()}
        aria-controls={drawerId}
        aria-haspopup="dialog"
        title="Reader settings"
        ref={(element) => {
          trigger = element;
        }}
        onClick={reveal}
      >
        <Icon name="sliders" size={19} />
        <span>Reader settings</span>
      </button>
      <dialog
        ref={(element) => {
          drawer = element;
        }}
        id={drawerId}
        class="reader-settings reader-settings-advanced reader-settings-drawer"
        aria-label="Reader settings"
        onCancel={(event) => {
          event.preventDefault();
          close(true);
        }}
        onClose={() => {
          if (drawer.open) return;
          setOpen(false);
          document.documentElement.classList.remove('reader-settings-open');
        }}
        onPointerDown={(event) => {
          const rect = drawer.getBoundingClientRect();
          backdropPointerDown =
            event.target === drawer &&
            (event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom);
        }}
        onClick={(event) => {
          const rect = drawer.getBoundingClientRect();
          const outside =
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom;
          if (backdropPointerDown && outside && event.target === drawer) close(true);
          backdropPointerDown = false;
        }}
        onKeyDown={(event) => {
          if (event.defaultPrevented) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close(true);
          } else if (event.key === 'Tab') {
            const controls = [
              ...drawer.querySelectorAll<HTMLElement>('button, input, summary'),
            ].filter((element) => !element.matches(':disabled') && element.getClientRects().length);
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div class="reader-settings-heading">
          <h3>Reader settings</h3>
          <button
            ref={(element) => {
              closeButton = element;
            }}
            type="button"
            class="reader-icon-button"
            aria-label="Close reader settings"
            onClick={() => close(true)}
          >
            <Icon name="close" size={17} />
          </button>
        </div>
        <div class="reader-settings-body">
          <div>
            <p class="reader-control-label">Page mode</p>
            <div class="reader-mode-options" role="group" aria-label="Page mode">
              <For each={MODES}>
                {(item) => (
                  <button
                    type="button"
                    aria-label={
                      item.value === 'double'
                        ? 'Facing pages'
                        : item.value === 'single'
                          ? 'Single page'
                          : 'Continuous scroll'
                    }
                    aria-pressed={mode() === item.value}
                    disabled={!props.ready || (props.fixed && item.value === 'continuous')}
                    onClick={() => props.onChange({ mode: item.value })}
                  >
                    <Icon name={item.icon} size={24} />
                    <span>{item.label}</span>
                  </button>
                )}
              </For>
            </div>
            <Show when={mode() === 'double'}>
              <p class="reader-setting-hint">
                Facing pages use a single page when the window is narrow.
              </p>
            </Show>
            <Show when={props.fixed}>
              <p class="reader-setting-hint">
                This book has a fixed publisher layout. Text reflow and continuous scrolling are
                unavailable; publisher spreads are preserved.
              </p>
            </Show>
          </div>
          <label>
            <span class="reader-setting-label">Theme</span>
            <Select<ReaderTheme>
              ariaLabel="Theme"
              value={props.settings.theme}
              onChange={(theme) => props.onChange({ theme })}
              options={[
                { value: 'light', label: 'Paper' },
                { value: 'sepia', label: 'Sepia' },
                { value: 'dark', label: 'Night' },
              ]}
            />
          </label>
          <Show
            when={props.pdf}
            fallback={
              <Show when={!props.fixed}>
                <label>
                  <span class="reader-setting-label">Typeface</span>
                  <Select
                    ariaLabel="Typeface"
                    value={props.settings.fontFamily}
                    onChange={(fontFamily) => props.onChange({ fontFamily })}
                    options={[
                      { value: 'publisher', label: 'Publisher font' },
                      { value: 'serif', label: 'Literary serif' },
                      { value: 'sans', label: 'Clean sans serif' },
                      { value: 'mono', label: 'Monospace' },
                    ]}
                  />
                </label>
                <label>
                  <span class="reader-setting-label">
                    Text size <span>{props.settings.fontSizePx}px</span>
                  </span>
                  <input
                    type="range"
                    aria-label="Text size"
                    min="12"
                    max="36"
                    value={props.settings.fontSizePx}
                    onInput={(event) =>
                      props.onChange({ fontSizePx: Number(event.currentTarget.value) })
                    }
                  />
                </label>
              </Show>
            }
          >
            <div class="reader-settings-row">
              <label>
                <span class="reader-setting-label">Fit</span>
                <Select
                  ariaLabel="Page fit"
                  value={props.settings.pdfFit}
                  onChange={(pdfFit) => props.onChange({ pdfFit })}
                  options={[
                    { value: 'width', label: 'Fit width' },
                    { value: 'page', label: 'Fit page' },
                    { value: 'actual', label: 'Actual size' },
                  ]}
                />
              </label>
              <button
                type="button"
                class="reader-rotate"
                aria-label="Rotate clockwise"
                onClick={() =>
                  props.onChange({
                    pdfRotation: ((props.settings.pdfRotation + 90) %
                      360) as ReaderSettings['pdfRotation'],
                  })
                }
              >
                <Icon name="rotate" size={18} /> {props.settings.pdfRotation}°
              </button>
            </div>
            <label>
              <span class="reader-setting-label">
                Zoom <span>{props.settings.pdfZoom}%</span>
              </span>
              <input
                type="range"
                aria-label="PDF zoom"
                min="50"
                max="400"
                step="10"
                value={props.settings.pdfZoom}
                onInput={(event) => props.onChange({ pdfZoom: Number(event.currentTarget.value) })}
              />
            </label>
            <label class="reader-check-setting">
              <input
                type="checkbox"
                checked={props.settings.pdfInvert}
                onChange={(event) => props.onChange({ pdfInvert: event.currentTarget.checked })}
              />
              <span>Invert page colours</span>
            </label>
          </Show>
          <details class="reader-layout-options">
            <summary>
              {props.pdf || props.fixed ? 'Page layout' : 'Typography & spacing'}
              <Icon name="chevron-down" size={15} />
            </summary>
            <div class="reader-advanced-fields">
              <Show when={!props.pdf && !props.fixed}>
                <label>
                  <span class="reader-setting-label">Alignment</span>
                  <Select
                    ariaLabel="Text alignment"
                    value={props.settings.textAlign}
                    onChange={(textAlign) => props.onChange({ textAlign })}
                    options={[
                      { value: 'publisher', label: 'Publisher alignment' },
                      { value: 'left', label: 'Left aligned' },
                      { value: 'justify', label: 'Justified' },
                    ]}
                  />
                </label>
                <label>
                  <span class="reader-setting-label">
                    Line height <span>{props.settings.lineHeight.toFixed(1)}</span>
                  </span>
                  <input
                    type="range"
                    aria-label="Line height"
                    min="1"
                    max="2.5"
                    step="0.1"
                    value={props.settings.lineHeight}
                    onInput={(event) =>
                      props.onChange({ lineHeight: Number(event.currentTarget.value) })
                    }
                  />
                </label>
                <label>
                  <span class="reader-setting-label">
                    Column width <span>{props.settings.textWidthPx}px</span>
                  </span>
                  <input
                    type="range"
                    aria-label="Column width"
                    min="400"
                    max="1200"
                    step="40"
                    value={props.settings.textWidthPx}
                    onInput={(event) =>
                      props.onChange({ textWidthPx: Number(event.currentTarget.value) })
                    }
                  />
                </label>
                <label>
                  <span class="reader-setting-label">
                    Letter spacing <span>{props.settings.letterSpacing.toFixed(2)}em</span>
                  </span>
                  <input
                    type="range"
                    aria-label="Letter spacing"
                    min="0"
                    max="0.12"
                    step="0.01"
                    value={props.settings.letterSpacing}
                    onInput={(event) =>
                      props.onChange({ letterSpacing: Number(event.currentTarget.value) })
                    }
                  />
                </label>
                <label>
                  <span class="reader-setting-label">
                    Paragraph spacing{' '}
                    <span>
                      {props.settings.paragraphSpacing
                        ? `${props.settings.paragraphSpacing}em`
                        : 'Publisher'}
                    </span>
                  </span>
                  <input
                    type="range"
                    aria-label="Paragraph spacing"
                    min="0"
                    max="2"
                    step="0.25"
                    value={props.settings.paragraphSpacing}
                    onInput={(event) =>
                      props.onChange({ paragraphSpacing: Number(event.currentTarget.value) })
                    }
                  />
                </label>
              </Show>
              <Show when={!props.fixed}>
                <label>
                  <span class="reader-setting-label">
                    Margins <span>{props.settings.marginPx}px</span>
                  </span>
                  <input
                    type="range"
                    aria-label="Margins"
                    min="0"
                    max="80"
                    step="4"
                    value={props.settings.marginPx}
                    onInput={(event) =>
                      props.onChange({ marginPx: Number(event.currentTarget.value) })
                    }
                  />
                </label>
              </Show>
              <Show when={props.pdf}>
                <label class="reader-check-setting">
                  <input
                    type="checkbox"
                    checked={props.settings.pdfCoverAlone}
                    onChange={(event) =>
                      props.onChange({ pdfCoverAlone: event.currentTarget.checked })
                    }
                  />
                  <span>Show cover on its own in facing mode</span>
                </label>
                <label>
                  <span class="reader-setting-label">Page order</span>
                  <Select
                    ariaLabel="Page order"
                    value={props.settings.pdfDirection}
                    onChange={(pdfDirection) => props.onChange({ pdfDirection })}
                    options={[
                      { value: 'ltr', label: 'Left to right' },
                      { value: 'rtl', label: 'Right to left' },
                    ]}
                  />
                </label>
              </Show>
              <Show when={props.fixed}>
                <p class="reader-setting-hint">
                  Pages fit the reading area automatically. Use focus mode or full screen for more
                  space.
                </p>
              </Show>
            </div>
          </details>
          <button
            type="button"
            class="reader-reset-settings"
            onClick={() => props.onChange(DEFAULT_READER_SETTINGS)}
          >
            Reset reading settings
          </button>
        </div>
      </dialog>
    </div>
  );
}
