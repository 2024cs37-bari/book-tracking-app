import { createSignal, onCleanup, type Accessor } from 'solid-js';
import { useApp } from '~/app/context';

/** Refresh visible repository reads after local, background-sync or other-tab commits. */
export function useLibraryRevision(): Accessor<number> {
  const app = useApp();
  const [revision, setRevision] = createSignal(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = app.subscribeLibraryChanges(() => {
    clearTimeout(timer);
    timer = setTimeout(() => setRevision((value) => value + 1), 80);
  });
  onCleanup(() => {
    clearTimeout(timer);
    unsubscribe();
  });
  return revision;
}
