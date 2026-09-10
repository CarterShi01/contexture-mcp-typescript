import { ModelValidationError } from '../foundation/errors.js';
import type { JsonObject } from './binding.js';
import type { RoleDeclaration } from './role.js';
import type { SkillDeclaration } from './skill.js';
import type { ToolDeclaration } from './tool.js';

/** The only two progressive-disclosure states for a Contexture node. */
export const CompileLevel = Object.freeze({
  ROUTE: 'route',
  ACTIVE: 'active',
} as const);

/** One of the fixed values in {@link CompileLevel}. */
export type CompileLevel = (typeof CompileLevel)[keyof typeof CompileLevel];

/** A lazy factory. Calling it belongs to compilation, never declaration. */
export type Factory<T> = () => T;

/** The closed set of progressively disclosed Contexture node kinds. */
export type NodeKind = 'role' | 'skill' | 'tool';

/** Stable facts shared by declarations and immutable compiled nodes. */
export interface ContextNode {
  readonly kind: NodeKind;
  readonly name: string;
  readonly description: string;
  readonly uses?: readonly string[];
}

const COMPILED_REFERENCES = new WeakMap<object, string>();

/** @internal Record the canonical address assigned to one compiled snapshot. */
export function registerCompiledReference(node: ContextNode, ref: string): void {
  COMPILED_REFERENCES.set(node, ref);
}

/** Facts shared by every Contexture node declaration. */
export type BaseNodeDeclaration = ContextNode;

/** The closed union accepted at an application root or inside a compiled Index. */
export type NodeDeclaration = RoleDeclaration | SkillDeclaration | ToolDeclaration<never, unknown>;

/** One immutable route or active disclosure payload. */
export type CompiledContext = Readonly<Record<string, unknown>>;

/** The fixed sibling-set shape used by discovery and opened Roles. */
export interface GroupedCards {
  readonly roles: readonly CompiledContext[];
  readonly skills: readonly CompiledContext[];
  readonly tools: readonly CompiledContext[];
}

/**
 * Structural facts a node asks from the forest that owns it.
 *
 * The view, not a declaration, owns canonical references, executable schemas,
 * and policy-aware cards for related nodes.
 */
export interface View<Node extends ContextNode = ContextNode> {
  refOf(node: Node): string;
  cardOf(node: Node): CompiledContext;
  cardFor(ref: string): CompiledContext;
  cardsOf(nodes: Iterable<Node>): GroupedCards;
  cardsFor(refs: Iterable<string>): readonly CompiledContext[];
  executionOf(tool: Node): CompiledContext;
  schemaOf(tool: Node): JsonObject;
}

/** Render the minimal broad-routing facts for one node. */
export function routeOf(node: ContextNode): CompiledContext {
  return Object.freeze({ kind: node.kind, name: node.name, description: node.description });
}

/** Render one actionable routing card through its owning view. */
export function cardOf<Node extends ContextNode>(node: Node, view: View<Node>): CompiledContext {
  return Object.freeze({
    ...routeOf(node),
    ref: view.refOf(node),
    ...(node.kind === 'tool' ? view.executionOf(node) : {}),
  });
}

/** Return direct child Roles without evaluating declaration factories. */
export function branchesOf(node: ContextNode): readonly ContextNode[] {
  if (node.kind !== 'role') return Object.freeze([]);
  if (hasContainment(node)) return Object.freeze([...node.branches()]);
  if (hasDeclaredMembers(node, ['children'])) throw uncompiledNodeError();
  return Object.freeze([]);
}

/** Return direct members in Role, Skill, Tool declaration-group order. */
export function membersOf(node: ContextNode): readonly ContextNode[] {
  if (node.kind !== 'role') return Object.freeze([]);
  if (hasContainment(node)) return Object.freeze([...node.members()]);
  if (hasDeclaredMembers(node, ['children', 'publication', 'skills', 'tools']))
    throw uncompiledNodeError();
  return Object.freeze([]);
}

/** Render one immutable sibling set with all three closed kind buckets present. */
export function groupCards<Node extends ContextNode>(
  nodes: Iterable<Node>,
  view: View<Node>,
): GroupedCards {
  const roles: CompiledContext[] = [];
  const skills: CompiledContext[] = [];
  const tools: CompiledContext[] = [];
  for (const node of nodes) {
    const card = view.cardOf(node);
    if (node.kind === 'role') roles.push(card);
    else if (node.kind === 'skill') skills.push(card);
    else tools.push(card);
  }
  return Object.freeze({
    roles: Object.freeze(roles),
    skills: Object.freeze(skills),
    tools: Object.freeze(tools),
  });
}

/**
 * Compile one node at route or active level through an explicit owning view.
 *
 * A standalone route never evaluates lazy child factories. Active compilation
 * can omit the view only when no reference overlay or registered containment
 * needs a forest to resolve it.
 */
export function compileNode(
  node: ContextNode,
  level: CompileLevel | string = CompileLevel.ROUTE,
  view: View<ContextNode> = standaloneView(),
): CompiledContext {
  if (level === CompileLevel.ROUTE) return routeOf(node);
  if (level !== CompileLevel.ACTIVE) {
    throw new ModelValidationError(`Unknown Contexture compile level ${JSON.stringify(level)}.`);
  }

  const card = cardOf(node, view);
  const uses =
    (node.uses?.length ?? 0) === 0
      ? {}
      : { uses: Object.freeze([...view.cardsFor(node.uses ?? [])]) };
  if (node.kind === 'tool') return Object.freeze({ ...card, ...uses });
  const instructions = activeInstructions(node);
  if (node.kind === 'skill') return Object.freeze({ ...card, instructions, ...uses });
  const grouped = view.cardsOf(membersOf(node));
  return Object.freeze({
    ...card,
    ...publicationDetails(node, instructions, grouped, view),
    ...grouped,
    ...uses,
  });
}

/** @internal Compose the framework-owned closing obligation for a designated Publication. */
export function publicationDetails<Node extends ContextNode>(
  role: Node,
  instructions: string,
  grouped: GroupedCards,
  view: View<Node>,
): Readonly<{ instructions: string; publication?: string }> {
  const publication = Reflect.get(role, 'publication') as Node | undefined;
  if (publication === undefined) return Object.freeze({ instructions });
  const ref = view.refOf(publication);
  if (!grouped.roles.some((card) => card.ref === ref)) {
    throw new ModelValidationError(
      'The declared Publication is unavailable in this view. Open the owning Role through a surface containing its complete publication subtree.',
    );
  }
  return Object.freeze({
    publication: ref,
    instructions: `${instructions}\n\nPublication (framework contract):\nBefore finishing this role's work, call contexture_open with ref=${JSON.stringify(ref)} and follow that Publication's instructions using the work's results and evidence. Opening it only discloses the procedure; it does not execute it or establish success. Use its available capabilities as instructed, respect required approvals, and report the actual outcome. If publication is blocked, fails, or awaits approval, report that state rather than claiming success or bypassing approval.`,
  });
}

function standaloneView<Node extends ContextNode>(): View<Node> {
  const view: View<Node> = {
    refOf(node): string {
      return COMPILED_REFERENCES.get(node) ?? node.name;
    },
    cardOf(node): CompiledContext {
      return cardOf(node, view);
    },
    cardFor(ref): CompiledContext {
      throw new ModelValidationError(
        `Nothing here can resolve ${JSON.stringify(ref)}: this node is being compiled on its own, outside any forest.`,
      );
    },
    cardsOf(nodes): GroupedCards {
      return groupCards(nodes, view);
    },
    cardsFor(refs): readonly CompiledContext[] {
      return Object.freeze([...refs].map((ref) => view.cardFor(ref)));
    },
    executionOf(tool): CompiledContext {
      if (tool.kind !== 'tool') {
        throw new ModelValidationError('Only a Tool has an executable disclosure facet.');
      }
      const readOnly = Reflect.get(tool, 'readOnly');
      return Object.freeze({
        read_only: typeof readOnly === 'boolean' ? readOnly : false,
        input_schema: view.schemaOf(tool),
      });
    },
    schemaOf(): JsonObject {
      return Object.freeze({});
    },
  };
  return Object.freeze(view);
}

function activeInstructions(node: ContextNode): string {
  const instructions = Reflect.get(node, 'instructions');
  if (typeof instructions !== 'string' || instructions.trim().length === 0) {
    throw new ModelValidationError(
      `${node.kind === 'role' ? 'Role' : 'Skill'} ${JSON.stringify(node.name)} must have active instructions.`,
    );
  }
  return instructions;
}

function hasContainment(node: ContextNode): node is ContextNode & {
  branches(): readonly ContextNode[];
  members(): readonly ContextNode[];
} {
  return (
    'branches' in node &&
    typeof node.branches === 'function' &&
    'members' in node &&
    typeof node.members === 'function'
  );
}

function hasDeclaredMembers(node: ContextNode, names: readonly string[]): boolean {
  return names.some((name) => {
    const value = Reflect.get(node, name);
    return Array.isArray(value) && value.length > 0;
  });
}

function uncompiledNodeError(): ModelValidationError {
  return new ModelValidationError(
    'Node reference and containment queries require a compiled Index snapshot.',
  );
}
