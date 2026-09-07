import type { CompiledApplication, CompiledNode, CompiledRole } from './compiler.js';
import { compareCodePoints, matchingRefs, type ReferenceMatches } from './reference-queries.js';

const SEPARATOR = '/';

/** A requested projection cannot be represented by this application's roots. */
export class RootSelectionError extends Error {
  override readonly name = 'RootSelectionError';
}

/** A ref points outside the root projection active for the current operation. */
export class RootOutsideSelectionError extends Error {
  override readonly name = 'RootOutsideSelectionError';

  constructor(readonly ref: string) {
    super(
      `Reference ${JSON.stringify(ref)} is outside this request's root surface. ` +
        'Call contexture_discover and use a ref from its result.',
    );
  }
}

/** An immutable all-roots value or exact allowlist of complete root trees. */
export class RootSelection {
  readonly #names: ReadonlySet<string> | undefined;

  private constructor(names?: Iterable<string>) {
    this.#names = names === undefined ? undefined : new Set(names);
    Object.freeze(this);
  }

  static all(): RootSelection {
    return new RootSelection();
  }

  static only(names: Iterable<string> | string): RootSelection {
    const values = typeof names === 'string' ? [names] : [...names];
    const normalized = values.map((name) => name.trim());
    if (normalized.length === 0 || normalized.some((name) => name.length === 0)) {
      throw new RootSelectionError('A root selection must name at least one root.');
    }
    const descendants = normalized.filter((name) => name.includes(SEPARATOR));
    if (descendants.length > 0) {
      throw new RootSelectionError(
        `Root selection accepts root refs only, not descendant refs: ${descendants
          .sort(compareCodePoints)
          .map((name) => JSON.stringify(name))
          .join(', ')}`,
      );
    }
    return new RootSelection(normalized);
  }

  get names(): readonly string[] | undefined {
    return this.#names === undefined
      ? undefined
      : Object.freeze([...this.#names].sort(compareCodePoints));
  }

  resolve(index: CompiledApplication): RootSelection {
    if (this.#names === undefined) return this;
    const roots = new Set(index.roots.map((node) => index.refOf(node)));
    const unknown = [...this.#names].filter((name) => !roots.has(name)).sort(compareCodePoints);
    if (unknown.length > 0) {
      throw new RootSelectionError(
        `Unknown Contexture root selection: ${unknown.map((name) => JSON.stringify(name)).join(', ')}`,
      );
    }
    return this;
  }

  containsRef(ref: string): boolean {
    const root = ref.split(SEPARATOR).find((segment) => segment.length > 0);
    return this.#names === undefined || root === undefined || this.#names.has(root);
  }

  requireRef(ref: string): void {
    if (!this.containsRef(ref)) throw new RootOutsideSelectionError(ref);
  }

  intersect(other: RootSelection): RootSelection {
    if (this.#names === undefined) return other;
    if (other.#names === undefined) return this;
    const names = [...this.#names].filter((name) => other.#names?.has(name));
    if (names.length === 0) throw new RootSelectionError('The effective root selection is empty.');
    return new RootSelection(names);
  }
}

/** Read-only forest facts that never enumerate nodes outside a selection. */
export class SelectedGraph {
  readonly selection: RootSelection;

  constructor(
    readonly index: CompiledApplication,
    selection: RootSelection = RootSelection.all(),
  ) {
    this.selection = selection.resolve(index);
    Object.freeze(this);
  }

  get roots(): readonly CompiledNode[] {
    return Object.freeze(
      this.index.roots.filter((node) => this.selection.containsRef(this.index.refOf(node))),
    );
  }

  *walk(): IterableIterator<readonly [string, CompiledNode]> {
    for (const [ref, node] of this.index.walk()) {
      if (this.selection.containsRef(ref)) yield Object.freeze([ref, node]);
    }
  }

  find(ref: string): CompiledNode {
    this.selection.requireRef(ref);
    return this.index.find(ref);
  }

  parentOf(node: CompiledNode): CompiledRole | undefined {
    this.selection.requireRef(this.index.refOf(node));
    return this.index.parentOf(node);
  }

  refOf(node: CompiledNode): string {
    const ref = this.index.refOf(node);
    this.selection.requireRef(ref);
    return ref;
  }

  childrenOf(node: CompiledNode): readonly CompiledNode[] {
    this.refOf(node);
    return this.index.childrenOf(node);
  }

  usesOf(ref: string): readonly string[] {
    this.selection.requireRef(ref);
    return Object.freeze(
      this.index.usesOf(ref).filter((target) => this.selection.containsRef(target)),
    );
  }

  dependentsOf(ref: string): readonly string[] {
    this.selection.requireRef(ref);
    return Object.freeze(
      this.index.dependentsOf(ref).filter((source) => this.selection.containsRef(source)),
    );
  }

  matchingRefs(value: string, limit: number): ReferenceMatches {
    return matchingRefs(
      (function* selectedRefs(graph: SelectedGraph): IterableIterator<string> {
        for (const [ref] of graph.walk()) yield ref;
      })(this),
      value,
      limit,
    );
  }
}
