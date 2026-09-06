import type { CompiledApplication, CompiledNode, CompiledRole, CompiledTool } from './compiler.js';
import { RootOutsideSelectionError, RootSelection } from './root-selection.js';

export type RoutingCard = Readonly<Record<string, unknown>>;
export type Discovery = Readonly<{
  roles: readonly RoutingCard[];
  skills: readonly RoutingCard[];
  tools: readonly RoutingCard[];
}>;

/** A model-plane navigation request is deliberately refused with a recovery sentence. */
export class RefusedError extends Error {
  override readonly name = 'RefusedError';
}

/** A pure, stateless progressive-disclosure projection over a compiled Index. */
export class Disclosure {
  readonly selection: RootSelection;
  readonly #promptRoots: ReadonlySet<string>;

  constructor(
    readonly index: CompiledApplication,
    options: { readonly selection?: RootSelection; readonly promptRoots?: Iterable<string> } = {},
  ) {
    this.selection = (options.selection ?? RootSelection.all()).resolve(index);
    this.#promptRoots = new Set(
      options.promptRoots ?? index.promptRoots.map((node) => index.refOf(node)),
    );
    for (const ref of this.#promptRoots) {
      const node = index.find(ref);
      if (index.parentOf(node) !== undefined) {
        throw new Error(`Prompt-only reference ${JSON.stringify(ref)} is not a root.`);
      }
    }
    Object.freeze(this);
  }

  select(selection: RootSelection): Disclosure {
    return new Disclosure(this.index, {
      selection: this.selection.intersect(selection),
      promptRoots: this.#promptRoots,
    });
  }

  unrestricted(): Disclosure {
    return new Disclosure(this.index, { selection: this.selection });
  }

  effectiveSelection(requested: RootSelection = RootSelection.all()): RootSelection {
    return this.selection.intersect(requested).resolve(this.index);
  }

  modelCanSee(ref: string, requested: RootSelection = RootSelection.all()): boolean {
    const selection = this.effectiveSelection(requested);
    return selection.containsRef(ref) && !this.#promptRoots.has(rootOf(ref));
  }

  discover(requested: RootSelection = RootSelection.all()): Discovery {
    const roots = this.index.modelRoots.filter((node) =>
      this.modelCanSee(this.index.refOf(node), requested),
    );
    return Object.freeze({
      roles: Object.freeze(roots.filter(isRole).map((node) => this.card(node))),
      skills: Object.freeze(roots.filter(isSkill).map((node) => this.card(node))),
      tools: Object.freeze(roots.filter(isTool).map((node) => this.card(node))),
    });
  }

  open(ref: string, requested: RootSelection = RootSelection.all()): RoutingCard {
    if (!this.modelCanSee(ref, requested)) {
      this.effectiveSelection(requested).requireRef(ref);
      throw new RefusedError(
        `${ref} is opened by a person, not by an agent. It is reachable only as a command in this host's menu. ` +
          'Do not reproduce its steps another way; tell the user which command runs it and let them decide when.',
      );
    }
    const selection = this.effectiveSelection(requested);
    return this.active(
      resolveRef(this.index, ref, selection, this.index.modelRoots),
      selection,
      true,
    );
  }

  openForPerson(ref: string, requested: RootSelection = RootSelection.all()): RoutingCard {
    const selection = this.effectiveSelection(requested);
    selection.requireRef(ref);
    const node = resolveRef(this.index, ref, selection, this.index.roots);
    return this.active(node, selection, true);
  }

  card(node: CompiledNode): RoutingCard {
    const ref = this.index.refOf(node);
    if (node.kind === 'tool') return toolCard(node, ref, true);
    return Object.freeze({ kind: node.kind, name: node.name, description: node.description, ref });
  }

  private active(
    node: CompiledNode,
    selection: RootSelection,
    includeSchema: boolean,
  ): RoutingCard {
    const ref = this.index.refOf(node);
    if (node.kind === 'tool') return toolCard(node, ref, includeSchema);
    if (node.kind === 'skill') {
      return Object.freeze({
        ...this.card(node),
        instructions: node.instructions,
        ...(node.uses.length === 0
          ? {}
          : {
              uses: Object.freeze(
                node.uses
                  .filter(
                    (target) =>
                      selection.containsRef(target) && this.modelCanSee(target, selection),
                  )
                  .map((target) => this.card(this.index.find(target))),
              ),
            }),
      });
    }
    return roleActive(this, node, selection);
  }
}

function roleActive(view: Disclosure, role: CompiledRole, selection: RootSelection): RoutingCard {
  const visible = (node: CompiledNode): boolean =>
    selection.containsRef(view.index.refOf(node)) &&
    view.modelCanSee(view.index.refOf(node), selection);
  return Object.freeze({
    ...view.card(role),
    instructions: role.instructions,
    roles: Object.freeze(role.children.filter(visible).map((node) => view.card(node))),
    skills: Object.freeze(role.skills.filter(visible).map((node) => view.card(node))),
    tools: Object.freeze(role.tools.filter(visible).map((node) => view.card(node))),
  });
}

function toolCard(node: CompiledTool, ref: string, includeSchema: boolean): RoutingCard {
  return Object.freeze({
    kind: 'tool',
    name: node.name,
    description: node.description,
    ref,
    read_only: node.readOnly,
    ...(includeSchema ? { input_schema: node.binding.schema } : {}),
  });
}

function resolveRef(
  index: CompiledApplication,
  ref: string,
  selection: RootSelection,
  candidates: readonly CompiledNode[],
): CompiledNode {
  if (ref.length === 0) {
    throw new RefusedError(
      'A reference must name at least a root role. Call contexture_discover for the roles this server serves.',
    );
  }
  const segments = ref.split('/');
  const roots = candidates.filter((root) => selection.containsRef(index.refOf(root)));
  let node = roots.find((root) => root.name === segments[0]);
  if (node === undefined) {
    throw new RefusedError(
      `No root role named '${segments[0]}'. This server serves: ${roots.map((root) => root.name).join(', ')}. ` +
        'Call contexture_discover for their cards, then open one to reach what is beneath it.',
    );
  }
  for (let position = 1; position < segments.length; position += 1) {
    const segment = segments[position];
    if (node.kind !== 'role') {
      throw new RefusedError(
        `Reference '${ref}' continues past '${node.name}', which is a ${node.kind} and holds nothing. ` +
          `Open '${node.name}' itself with contexture_open, or go back to the card the ref came from.`,
      );
    }
    const members = index.childrenOf(node);
    const next = members.find((child) => child.name === segment);
    if (next === undefined) {
      const known = members.map((child) => child.name).sort();
      const holds = known.length === 0 ? 'It holds nothing.' : `It holds: ${known.join(', ')}.`;
      throw new RefusedError(
        `Role '${node.name}' holds no member named '${segment}'. ${holds} ` +
          `Call contexture_open on '${node.name}' to see each member with the ref that opens it.`,
      );
    }
    node = next;
  }
  return node;
}

function rootOf(ref: string): string {
  return ref.split('/', 1)[0] ?? '';
}

function isRole(node: CompiledNode): node is CompiledRole {
  return node.kind === 'role';
}

function isSkill(node: CompiledNode): node is Extract<CompiledNode, { readonly kind: 'skill' }> {
  return node.kind === 'skill';
}

function isTool(node: CompiledNode): node is CompiledTool {
  return node.kind === 'tool';
}

export { RootOutsideSelectionError };
