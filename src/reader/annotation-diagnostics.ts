import type { AnnotationAnchor, AnnotationAnchorStatus } from './renderer';

/** Session-local evidence, invalidated when the saved anchor changes. */
export class AnnotationDiagnostics {
  private annotations: readonly AnnotationAnchor[] = [];
  private readonly states = new Map<string, AnnotationAnchorStatus>();
  private readonly listeners = new Set<(states: readonly AnnotationAnchorStatus[]) => void>();

  get anchors(): readonly AnnotationAnchor[] {
    return this.annotations;
  }

  setAnchors(annotations: readonly AnnotationAnchor[]): void {
    const previous = new Map(this.annotations.map((anchor) => [anchor.id, anchor]));
    const next = new Set(annotations.map((anchor) => anchor.id));
    for (const id of this.states.keys()) if (!next.has(id)) this.states.delete(id);
    for (const anchor of annotations) {
      const old = previous.get(anchor.id);
      if (
        old?.kind !== anchor.kind ||
        old.locator.kind !== anchor.locator.kind ||
        old.locator.value !== anchor.locator.value
      )
        this.states.set(anchor.id, { id: anchor.id, state: 'unchecked' });
    }
    this.annotations = annotations;
    this.emit();
  }

  report(id: string, state: AnnotationAnchorStatus['state'], reason?: string): void {
    const previous = this.states.get(id);
    if (!previous || (previous.state === state && previous.reason === reason)) return;
    this.states.set(id, { id, state, reason });
    this.emit();
  }

  subscribe(callback: (states: readonly AnnotationAnchorStatus[]) => void): () => void {
    this.listeners.add(callback);
    callback([...this.states.values()]);
    return () => this.listeners.delete(callback);
  }

  private emit(): void {
    const states = [...this.states.values()];
    for (const listener of this.listeners) listener(states);
  }

  clear(): void {
    this.annotations = [];
    this.states.clear();
    this.listeners.clear();
  }
}
