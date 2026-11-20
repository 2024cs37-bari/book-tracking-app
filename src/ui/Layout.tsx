import { A, useLocation } from '@solidjs/router';
import {
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  type ParentProps,
} from 'solid-js';
import { useApp } from '~/app/context';
import { Toaster } from './toast';
import OfflineAppStatus from './OfflineAppStatus';
import Icon from './Icon';

export default function Layout(props: ParentProps) {
  const app = useApp();
  const location = useLocation();
  const [navigationOpen, setNavigationOpen] = createSignal(false);
  let navigation: HTMLDialogElement | undefined;
  let navigationToggle: HTMLButtonElement | undefined;
  let navigationClose: HTMLButtonElement | undefined;
  let backdropPointerDown = false;

  const closeNavigation = (restoreFocus = false) => {
    navigation?.close();
    setNavigationOpen(false);
    document.documentElement.classList.remove('nav-open');
    if (restoreFocus) navigationToggle?.focus({ preventScroll: true });
  };
  const openNavigation = () => {
    if (!navigation || navigation.open) return;
    navigation.showModal();
    setNavigationOpen(true);
    document.documentElement.classList.add('nav-open');
    navigationClose?.focus({ preventScroll: true });
  };

  createEffect(
    on(
      () => `${location.pathname}${location.search}${location.hash}`,
      () => {
        if (!navigationOpen()) return;
        const hadNavigationFocus = navigation?.contains(document.activeElement);
        closeNavigation();
        if (hadNavigationFocus) document.getElementById('main')?.focus({ preventScroll: true });
      },
    ),
  );

  onMount(() => {
    const mobile = window.matchMedia('(max-width: 767px)');
    const handleViewportChange = () => {
      if (mobile.matches || !navigationOpen()) return;
      closeNavigation();
      document
        .querySelector<HTMLElement>('#desktop-navigation a[aria-current="page"]')
        ?.focus({ preventScroll: true });
    };
    mobile.addEventListener('change', handleViewportChange);
    onCleanup(() => {
      mobile.removeEventListener('change', handleViewportChange);
      closeNavigation();
    });
  });

  // The reader fills the screen; every other route is a centered column.
  const isReader = () => location.pathname.startsWith('/read');
  // Lock the document scroll in the reader so a stray overflow (e.g. pdf.js's
  // body-mounted measurement canvas) can never raise a window scrollbar and make
  // the whole shell shake. Toggled on <html> so it survives the focused shell.
  createEffect(() => {
    document.documentElement.classList.toggle('reader-locked', isReader());
  });
  onCleanup(() => document.documentElement.classList.remove('reader-locked'));

  return (
    <div class="app-shell">
      <a
        class="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById('main');
          main?.focus({ preventScroll: true });
          main?.scrollIntoView({ block: 'start' });
        }}
      >
        Skip to content
      </a>

      {/* The reader is a focused shell: its own toolbar is the only chrome, so
          the app header, nav and footer are hidden on the reader route. */}
      <Show when={!isReader()}>
        <header class="app-header">
          <A class="app-title" href="/">
            <Icon name="book" size={24} />
            <span>Book Reader</span>
          </A>
          <button
            ref={(element) => {
              navigationToggle = element;
            }}
            type="button"
            class="app-nav-toggle"
            aria-label="Open navigation"
            aria-expanded={navigationOpen()}
            aria-controls="navigation-drawer"
            aria-haspopup="dialog"
            onClick={openNavigation}
          >
            <Icon name="menu" size={24} />
          </button>
          <nav id="desktop-navigation" class="app-nav" aria-label="Main">
            <A href="/" end>
              Library
            </A>
            <A href="/stats">Stats</A>
            <A href="/settings">Settings</A>
          </nav>
        </header>

        <Show when={app.storageWarning}>
          {(warning) => (
            <p class="banner banner-warning" role="status">
              <strong>Storage notice:</strong> {warning()}
              <Show when={!app.files.durable}>
                {' '}
                Books imported now will be lost when this page is closed. Export your originals
                before leaving, or use a browser with local storage enabled.
              </Show>
            </p>
          )}
        </Show>
      </Show>

      <dialog
        ref={(element) => {
          navigation = element;
        }}
        id="navigation-drawer"
        class="app-nav-drawer"
        aria-label="Navigation"
        onCancel={(event) => {
          event.preventDefault();
          closeNavigation(true);
        }}
        onClose={() => {
          if (navigation?.open) return;
          setNavigationOpen(false);
          document.documentElement.classList.remove('nav-open');
        }}
        onPointerDown={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          backdropPointerDown =
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom;
        }}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const outside =
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom;
          if (backdropPointerDown && outside) closeNavigation(true);
          backdropPointerDown = false;
        }}
        onKeyDown={(event) => {
          // Native modality makes the background inert; wrap the small tab sequence
          // explicitly so keyboard focus never takes a detour through browser chrome.
          if (event.key !== 'Tab') return;
          const controls = event.currentTarget.querySelectorAll<HTMLElement>('button, a[href]');
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div class="app-drawer-header">
          <h2>Navigation</h2>
          <button
            ref={(element) => {
              navigationClose = element;
            }}
            type="button"
            class="app-drawer-close"
            aria-label="Close navigation"
            onClick={() => closeNavigation(true)}
          >
            <Icon name="close" size={22} />
          </button>
        </div>
        <nav
          id="main-navigation"
          class="app-drawer-nav"
          aria-label="Main"
          onClick={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest('a') &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.shiftKey &&
              !event.altKey
            ) {
              closeNavigation();
              document.getElementById('main')?.focus({ preventScroll: true });
            }
          }}
        >
          <A href="/" end>
            <Icon name="book" size={20} /> Library
          </A>
          <A href="/stats">
            <Icon name="chart" size={20} /> Stats
          </A>
          <A href="/settings">
            <Icon name="settings" size={20} /> Settings
          </A>
        </nav>
      </dialog>

      <main id="main" tabIndex={-1} class="app-main" classList={{ 'app-main-reader': isReader() }}>
        {props.children}
      </main>

      <Show when={!isReader()}>
        <footer class="app-footer">
          <OfflineAppStatus />
          <p class="footer-privacy">
            <A href="/settings#settings-backups">
              Back up your library <Icon name="arrow-right" size={14} />
            </A>
          </p>
        </footer>
      </Show>
      <Toaster />
    </div>
  );
}
