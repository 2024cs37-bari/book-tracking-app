import { createResource, For, Show } from 'solid-js';
import { useApp } from '~/app/context';
import type { ReadingStats } from '~/domain/session';

interface StatsData {
  readonly stats: ReadingStats;
  readonly titles: ReadonlyMap<string, string>;
}

export default function StatsView() {
  const app = useApp();

  const [data] = createResource<StatsData>(async () => {
    const [stats, books] = await Promise.all([
      app.sessions.stats(),
      app.books.list({ lifecycle: 'all' }),
    ]);
    const titles = new Map(books.map((book) => [book.id, book.title]));
    return { stats, titles };
  });

  return (
    <section class="stats">
      <h2>Reading statistics</h2>
      <p class="note">
        Derived from reading sessions recorded on this device. Sessions are local until sync is
        configured.
      </p>

      <Show when={data.error}>
        <p class="note note-error" role="alert">
          Statistics could not be collected: {String(data.error)}
        </p>
      </Show>

      <Show when={data()} fallback={<p class="note">Collecting statistics…</p>}>
        {(loaded) => (
          <>
            <div class="stat-tiles">
              <div class="stat-tile">
                <span class="stat-value">{formatDuration(loaded().stats.totalSeconds)}</span>
                <span class="stat-label">Total time read</span>
              </div>
              <div class="stat-tile">
                <span class="stat-value">{loaded().stats.sessionCount}</span>
                <span class="stat-label">Sessions</span>
              </div>
              <div class="stat-tile">
                <span class="stat-value">{loaded().stats.booksRead}</span>
                <span class="stat-label">Books opened</span>
              </div>
            </div>

            <Show
              when={loaded().stats.perBook.size > 0}
              fallback={
                <div class="empty-state">
                  <h3>No reading recorded yet</h3>
                  <p>Open a book and read for a few seconds; time spent appears here.</p>
                </div>
              }
            >
              <h3>Time per book</h3>
              <ul class="stat-book-list">
                <For each={sortedPerBook(loaded().stats)}>
                  {([bookId, seconds]) => (
                    <li class="stat-book-row">
                      <span class="stat-book-title">
                        {loaded().titles.get(bookId) ?? 'Removed book'}
                      </span>
                      <span class="stat-book-time">{formatDuration(seconds)}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}

function sortedPerBook(stats: ReadingStats): Array<[string, number]> {
  return [...stats.perBook.entries()].sort((left, right) => right[1] - left[1]);
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}
