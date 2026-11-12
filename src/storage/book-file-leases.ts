/** Protect originals used by readers/imports from cache removal, including other tabs. */
export class BookFileLeases {
  private readonly readers = new Map<string, number>();
  private readonly removing = new Set<string>();

  constructor(
    private readonly locks: LockManager | undefined = typeof navigator === 'undefined'
      ? undefined
      : navigator.locks,
  ) {}

  get crossTabSafe(): boolean {
    return this.locks !== undefined;
  }

  isHeld(hash: string): boolean {
    return (this.readers.get(hash) ?? 0) > 0;
  }

  async acquire(hash: string): Promise<() => void> {
    if (this.removing.has(hash)) throw new Error('This original is being removed. Try again.');
    let unlock: (() => void) | undefined;
    if (this.locks !== undefined) {
      await new Promise<void>((resolve, reject) => {
        void this.locks!.request(`book-reader:file:${hash}`, { mode: 'shared' }, async () => {
          await new Promise<void>((release) => {
            unlock = release;
            resolve();
          });
        }).catch(reject);
      });
    }
    this.readers.set(hash, (this.readers.get(hash) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.readers.get(hash) ?? 1) - 1;
      if (count === 0) this.readers.delete(hash);
      else this.readers.set(hash, count);
      unlock?.();
    };
  }

  async tryExclusive<T>(hash: string, action: () => Promise<T>): Promise<T | undefined> {
    if (this.isHeld(hash) || this.removing.has(hash)) return undefined;
    // Without Web Locks another browser tab's reader cannot be protected. Refuse cache removal.
    if (this.locks === undefined && typeof window !== 'undefined') return undefined;
    const run = async () => {
      if (this.isHeld(hash) || this.removing.has(hash)) return undefined;
      this.removing.add(hash);
      try {
        return await action();
      } finally {
        this.removing.delete(hash);
      }
    };
    if (this.locks === undefined) return run();
    return this.locks.request(
      `book-reader:file:${hash}`,
      { mode: 'exclusive', ifAvailable: true },
      (lock) => (lock === null ? undefined : run()),
    );
  }
}

export const bookFileLeases = new BookFileLeases();
