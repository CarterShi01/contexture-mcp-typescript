import type { CompiledApplication, CompiledNode, CompiledRole } from './compiler.js';
import { compareCodePoints, matchingRefs, type ReferenceMatches } from './reference-queries.js';
import { ContextureError } from '../foundation/errors.js';
import { DISCOVER_GATEWAY_NAME, REFERENCE_SEPARATOR } from '../foundation/vocabulary.js';

/** A requested path selection cannot be represented by this application. */
export class SurfaceSelectionError extends ContextureError {
  override readonly name = 'SurfaceSelectionError';
}

/** A ref points outside the capability surface active for this operation. */
export class OutsideSelectionError extends ContextureError {
  override readonly name = 'OutsideSelectionError';

  constructor(readonly ref: string) {
    super(
      `Reference ${JSON.stringify(ref)} is outside this request's selected surface. ` +
        `Call ${DISCOVER_GATEWAY_NAME} and use a ref from its result.`,
    );
  }
}

/** All capabilities, or an immutable allowlist of complete selected subtrees. */
export class SurfaceSelection {
  readonly #names: ReadonlySet<string> | undefined;

  private constructor(names?: Iterable<string>) {
    this.#names = names === undefined ? undefined : new Set(names);
    Object.freeze(this);
  }

  static all(): SurfaceSelection {
    return new SurfaceSelection();
  }

  static only(names: Iterable<string> | string): SurfaceSelection {
    const values = typeof names === 'string' ? [names] : [...names];
    const normalized = [...new Set(values.map((name) => String(name).trim()))];
    if (normalized.length === 0 || normalized.some((name) => name.length === 0)) {
      throw new SurfaceSelectionError(
        'A surface selection must name at least one ref or direct-child pattern.',
      );
    }
    for (const selector of normalized.sort(compareCodePoints)) validateSelector(selector);
    return new SurfaceSelection(normalized);
  }

  get names(): readonly string[] | undefined {
    return this.#names === undefined
      ? undefined
      : Object.freeze([...this.#names].sort(compareCodePoints));
  }

  /** Selectors before resolution and exact canonical refs afterward. */
  get selectors(): readonly string[] | undefined {
    return this.names;
  }

  resolve(index: CompiledApplication): SurfaceSelection {
    if (this.#names === undefined) return this;
    const refs = [...index.walk()].map(([ref]) => ref);
    const resolved = new Set<string>();
    const unknown: string[] = [];
    for (const selector of [...this.#names].sort(compareCodePoints)) {
      let matches: readonly string[];
      if (selector === '*') {
        matches = refs.filter((ref) => !ref.includes(REFERENCE_SEPARATOR));
      } else if (selector.endsWith(`${REFERENCE_SEPARATOR}*`)) {
        const parent = selector.slice(0, -2);
        const prefix = `${parent}${REFERENCE_SEPARATOR}`;
        matches = refs.filter(
          (ref) =>
            ref.startsWith(prefix) && !ref.slice(prefix.length).includes(REFERENCE_SEPARATOR),
        );
      } else {
        try {
          index.find(selector);
          matches = [selector];
        } catch {
          matches = [];
        }
      }
      if (matches.length === 0) unknown.push(selector);
      for (const match of matches) resolved.add(match);
    }
    if (unknown.length > 0) {
      throw new SurfaceSelectionError(
        `Unknown or empty Contexture selector: ${unknown.map((name) => JSON.stringify(name)).join(', ')}`,
      );
    }
    return new SurfaceSelection(canonical(resolved));
  }

  containsRef(ref: string): boolean {
    if (this.#names === undefined) return true;
    return [...this.#names].some((anchor) => descendantOrSelf(ref, anchor));
  }

  requireRef(ref: string): void {
    if (!this.containsRef(ref)) throw new OutsideSelectionError(ref);
  }

  rootsIn(index: CompiledApplication): readonly CompiledNode[] {
    if (this.#names === undefined) return index.roots;
    const names = new Set(this.resolve(index).names);
    return Object.freeze(
      [...index.walk()].filter(([ref]) => names.has(ref)).map(([, node]) => node),
    );
  }

  intersect(other: SurfaceSelection): SurfaceSelection {
    if (this.#names === undefined) return other;
    if (other.#names === undefined) return this;
    if ([...this.#names, ...other.#names].some((selector) => selector.includes('*'))) {
      throw new SurfaceSelectionError(
        'Resolve wildcard selectors against an Index before intersecting them.',
      );
    }
    const overlaps = new Set<string>();
    for (const left of this.#names) {
      for (const right of other.#names) {
        if (descendantOrSelf(left, right)) overlaps.add(left);
        else if (descendantOrSelf(right, left)) overlaps.add(right);
      }
    }
    if (overlaps.size === 0)
      throw new SurfaceSelectionError('The effective surface selection is empty.');
    return new SurfaceSelection(canonical(overlaps));
  }
}

/** Read-only forest facts that never enumerate nodes outside a selection. */
export class SelectedGraph {
  readonly selection: SurfaceSelection;

  constructor(
    readonly index: CompiledApplication,
    selection: SurfaceSelection = SurfaceSelection.all(),
  ) {
    this.selection = selection.resolve(index);
    Object.freeze(this);
  }

  get roots(): readonly CompiledNode[] {
    return this.selection.rootsIn(this.index);
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
    const ref = this.refOf(node);
    if (this.selection.names?.includes(ref) === true) return undefined;
    const parent = this.index.parentOf(node);
    if (parent !== undefined) this.selection.requireRef(this.index.refOf(parent));
    return parent;
  }

  refOf(node: CompiledNode): string {
    const ref = this.index.refOf(node);
    this.selection.requireRef(ref);
    return ref;
  }

  childrenOf(node: CompiledNode): readonly CompiledNode[] {
    this.refOf(node);
    return Object.freeze(
      this.index
        .childrenOf(node)
        .filter((child) => this.selection.containsRef(this.index.refOf(child))),
    );
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

function descendantOrSelf(ref: string, ancestor: string): boolean {
  return ref === ancestor || ref.startsWith(`${ancestor}${REFERENCE_SEPARATOR}`);
}

function canonical(refs: Iterable<string>): readonly string[] {
  const ordered = [...new Set(refs)].sort((left, right) => {
    const depth = left.split(REFERENCE_SEPARATOR).length - right.split(REFERENCE_SEPARATOR).length;
    return depth === 0 ? compareCodePoints(left, right) : depth;
  });
  return ordered.filter(
    (ref, index) => !ordered.slice(0, index).some((ancestor) => descendantOrSelf(ref, ancestor)),
  );
}

function validateSelector(selector: string): void {
  const segments = selector.split(REFERENCE_SEPARATOR);
  if (segments.some((segment) => segment.length === 0)) {
    throw new SurfaceSelectionError(
      `Invalid Contexture selector ${JSON.stringify(selector)}: refs contain no empty segments.`,
    );
  }
  const wildcards = segments.flatMap((segment, index) => (segment.includes('*') ? [index] : []));
  if (
    wildcards.length > 0 &&
    (wildcards.length !== 1 || wildcards[0] !== segments.length - 1 || segments.at(-1) !== '*')
  ) {
    throw new SurfaceSelectionError(
      `Invalid Contexture selector ${JSON.stringify(selector)}: '*' is allowed only as the complete final segment, for example 'team/*'.`,
    );
  }
}

// Compatibility names intentionally share the same constructors and semantics.
export { SurfaceSelection as RootSelection };
export { SurfaceSelectionError as RootSelectionError };
export { OutsideSelectionError as RootOutsideSelectionError };
