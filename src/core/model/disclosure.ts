import type { CompiledApplication, CompiledNode, CompiledRole } from './compiler.js';
import type { JsonObject } from './binding.js';
import {
  ContextureError,
  LookupFailure,
  ModelValidationError,
  NodeNotFoundError,
} from '../foundation/errors.js';
import { REFERENCE_SEPARATOR } from '../foundation/vocabulary.js';
import { RootOutsideSelectionError, RootSelection } from './root-selection.js';
import { InMemoryTelemetry, reportTelemetry, type Telemetry } from './telemetry.js';
import {
  cardOf as nodeCard,
  groupCards,
  type CompiledContext,
  type GroupedCards,
  type View,
} from './node.js';

export type RoutingCard = Readonly<Record<string, unknown>>;
export type Discovery = Readonly<{
  roles: readonly RoutingCard[];
  skills: readonly RoutingCard[];
  tools: readonly RoutingCard[];
}>;

/** A model-plane navigation request is deliberately refused with a recovery sentence. */
export class RefusedError extends ContextureError {
  override readonly name = 'RefusedError';

  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message);
    if (options.cause !== undefined) Object.defineProperty(this, 'cause', { value: options.cause });
  }
}

/** A pure, stateless progressive-disclosure projection over a compiled Index. */
export class Disclosure implements View<CompiledNode> {
  readonly selection: RootSelection;
  readonly telemetry: Telemetry;
  readonly #promptRoots: ReadonlySet<string>;
  readonly #reserved: ReadonlySet<string>;

  constructor(
    readonly index: CompiledApplication,
    options: {
      readonly selection?: RootSelection;
      readonly promptRoots?: Iterable<string>;
      readonly reserved?: Iterable<string>;
      readonly telemetry?: Telemetry;
    } = {},
  ) {
    this.selection = (options.selection ?? RootSelection.all()).resolve(index);
    this.#promptRoots = new Set(
      options.promptRoots ?? index.promptRoots.map((node) => index.refOf(node)),
    );
    this.#reserved = new Set(options.reserved ?? []);
    this.telemetry = options.telemetry ?? new InMemoryTelemetry();
    for (const ref of this.#promptRoots) {
      const node = index.find(ref);
      if (index.parentOf(node) !== undefined) {
        throw new ModelValidationError(
          `Prompt-only reference ${JSON.stringify(ref)} is not a root.`,
        );
      }
    }
    Object.freeze(this);
  }

  select(selection: RootSelection): Disclosure {
    return new Disclosure(this.index, {
      selection: this.selection.intersect(selection.resolve(this.index)),
      promptRoots: this.#promptRoots,
      reserved: this.#reserved,
      telemetry: this.telemetry,
    });
  }

  unrestricted(): Disclosure {
    return new Disclosure(this.index, {
      selection: this.selection,
      promptRoots: [],
      reserved: this.#reserved,
      telemetry: this.telemetry,
    });
  }

  effectiveSelection(requested: RootSelection = RootSelection.all()): RootSelection {
    return this.selection.intersect(requested.resolve(this.index)).resolve(this.index);
  }

  modelCanSee(ref: string, requested: RootSelection = RootSelection.all()): boolean {
    const selection = this.effectiveSelection(requested);
    return selection.containsRef(ref) && !this.#promptRoots.has(rootOf(ref));
  }

  discover(requested: RootSelection = RootSelection.all()): Discovery {
    const selection = this.effectiveSelection(requested);
    const roots = selection
      .rootsIn(this.index)
      .filter((node) => this.modelCanSee(this.index.refOf(node), selection));
    return groupCards(roots, this);
  }

  open(ref: string, requested: RootSelection = RootSelection.all()): RoutingCard {
    if (!this.modelCanSee(ref, requested)) {
      this.effectiveSelection(requested).requireRef(ref);
      throw new RefusedError(
        `${ref} is opened by a person, not by an agent. It is reachable only as a command in this host's menu. ` +
          'Do not reproduce its steps another way; tell the user which command runs it and let them decide when.',
      );
    }
    if (this.#reserved.has(ref)) {
      throw new RefusedError(
        `${ref} is opened by a person, not by an agent. It is reachable only as a command in this host's menu. ` +
          'Do not reproduce its steps another way; tell the user which command runs it and let them decide when.',
      );
    }
    const selection = this.effectiveSelection(requested);
    const result = this.active(resolveRef(this.index, ref, selection, this.index.roots), selection);
    this.reportOpen(ref, result);
    return result;
  }

  openForPerson(ref: string, requested: RootSelection = RootSelection.all()): RoutingCard {
    // Person navigation removes only prompt-root model ownership. It retains
    // this view's root ceiling and still bypasses model-only reservations.
    const personView = this.#promptRoots.size === 0 ? this : this.unrestricted();
    const selection = personView.effectiveSelection(requested);
    selection.requireRef(ref);
    const node = resolveRef(personView.index, ref, selection, personView.index.roots);
    const result = personView.active(node, selection);
    personView.reportOpen(ref, result);
    return result;
  }

  private reportOpen(ref: string, card: RoutingCard): void {
    if (card.kind === 'role' || card.kind === 'skill') void reportTelemetry(this.telemetry, ref);
  }

  refOf(node: CompiledNode): string {
    return this.index.refOf(node);
  }

  cardOf(node: CompiledNode): RoutingCard {
    return nodeCard(node, this);
  }

  cardFor(ref: string): RoutingCard {
    this.effectiveSelection().requireRef(ref);
    if (!this.modelCanSee(ref) || this.#reserved.has(ref)) {
      throw new ModelValidationError(
        `${JSON.stringify(ref)} has no model-visible routing card in this Disclosure.`,
      );
    }
    return this.cardOf(this.index.find(ref));
  }

  cardsOf(nodes: Iterable<CompiledNode>): GroupedCards {
    return groupCards(
      [...nodes].filter((node) => this.modelCanSee(this.index.refOf(node))),
      this,
    );
  }

  cardsFor(refs: Iterable<string>): readonly RoutingCard[] {
    return Object.freeze(
      [...refs]
        .filter((ref) => this.modelCanSee(ref) && !this.#reserved.has(ref))
        .map((ref) => this.cardFor(ref)),
    );
  }

  executionOf(node: CompiledNode): CompiledContext {
    if (node.kind !== 'tool') {
      throw new ModelValidationError('Only a Tool has an executable disclosure facet.');
    }
    return node.binding === undefined
      ? EMPTY_DETAILS
      : Object.freeze({ read_only: node.readOnly, input_schema: this.schemaOf(node) });
  }

  schemaOf(node: CompiledNode): JsonObject {
    return this.index.schemaOf(node);
  }

  card(node: CompiledNode): RoutingCard {
    return this.cardOf(node);
  }

  private active(node: CompiledNode, selection: RootSelection): RoutingCard {
    if (node.kind === 'tool') {
      return Object.freeze({ ...this.card(node), ...this.activeUses(node, selection) });
    }
    if (node.kind === 'skill') {
      return Object.freeze({
        ...this.card(node),
        instructions: node.instructions,
        ...this.activeUses(node, selection),
      });
    }
    return this.roleActive(node, selection);
  }

  /** Render one direct, request-safe dependency layer without recursive expansion. */
  private activeUses(
    node: CompiledNode,
    selection: RootSelection,
  ): Readonly<Record<string, unknown>> {
    if (node.uses.length === 0) return EMPTY_DETAILS;
    return Object.freeze({
      uses: Object.freeze(
        node.uses
          .filter(
            (target) =>
              selection.containsRef(target) &&
              !this.#reserved.has(target) &&
              this.modelCanSee(target, selection),
          )
          .map((target) => this.card(this.index.find(target))),
      ),
    });
  }

  private roleActive(role: CompiledRole, selection: RootSelection): RoutingCard {
    const visible = (node: CompiledNode): boolean =>
      selection.containsRef(this.index.refOf(node)) &&
      this.modelCanSee(this.index.refOf(node), selection);
    return Object.freeze({
      ...this.cardOf(role),
      instructions: role.instructions,
      ...groupCards(role.members().filter(visible), this),
      ...this.activeUses(role, selection),
    });
  }
}

const EMPTY_DETAILS: Readonly<Record<string, never>> = Object.freeze({});

function resolveRef(
  index: CompiledApplication,
  ref: string,
  selection: RootSelection,
  candidates: readonly CompiledNode[],
): CompiledNode {
  const candidateRoots = new Set(candidates.map((root) => index.refOf(root)));
  const roots = selection
    .rootsIn(index)
    .filter((root) => candidateRoots.has(rootOf(index.refOf(root))));
  let node: CompiledNode;
  try {
    // The Index alone owns structured lookup facts. Gateway is the sole
    // model-facing renderer; other Hosts can still classify the raw failure.
    node = index.find(ref);
  } catch (error) {
    if (error instanceof NodeNotFoundError && error.reason === LookupFailure.NO_SUCH_ROOT) {
      throw selectedRootFailure(error, roots);
    }
    throw error;
  }
  const root = rootOf(ref);
  if (candidateRoots.has(root) && selection.containsRef(ref)) return node;
  throw selectedRootFailure(
    new NodeNotFoundError({
      reason: LookupFailure.NO_SUCH_ROOT,
      ref,
      segment: root,
      scope: root,
    }),
    roots,
  );
}

function rootOf(ref: string): string {
  return ref.split(REFERENCE_SEPARATOR).find((segment) => segment.length > 0) ?? '';
}

function selectedRootFailure(
  failure: NodeNotFoundError,
  roots: readonly CompiledNode[],
): NodeNotFoundError {
  return new NodeNotFoundError({
    reason: LookupFailure.NO_SUCH_ROOT,
    ...(failure.ref === undefined ? {} : { ref: failure.ref }),
    ...(failure.segment === undefined ? {} : { segment: failure.segment }),
    ...(failure.scope === undefined ? {} : { scope: failure.scope }),
    known: roots.map((root) => root.name).sort(compareCodePoints),
  });
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference =
      (leftPoints[index]?.codePointAt(0) ?? 0) - (rightPoints[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export { RootOutsideSelectionError };
