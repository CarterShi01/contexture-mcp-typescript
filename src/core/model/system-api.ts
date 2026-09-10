import { Disclosure, RefusedError } from './disclosure.js';
import type { Discovery, RoutingCard } from './disclosure.js';
import { ApplicationRuntime, WrongDoorError } from './runtime.js';
import { RootOutsideSelectionError, RootSelection, SelectedGraph } from './root-selection.js';
import type { ToolCallContext } from './declarations.js';
import { LookupFailure, ModelValidationError, NodeNotFoundError } from '../foundation/errors.js';
import {
  DISCOVER_GATEWAY_NAME,
  INSPECT_GATEWAY_NAME,
  INVOKE_GATEWAY_NAME,
  INVOKE_READ_ONLY_GATEWAY_NAME,
  OPEN_GATEWAY_NAME,
  REFERENCE_SEPARATOR,
  type GatewayName,
} from '../foundation/vocabulary.js';
import { reportInspection } from './telemetry.js';

/** One immutable system-controlled tool in Contexture's MCP plane. */
export interface GatewayTool {
  readonly name: GatewayName;
  readonly description: string;
  readonly readOnly: boolean;
}

/** Compatibility type name for one fixed framework-controlled entry point. */
export type SystemTool = GatewayTool;

/** The fixed system plane, ordered independently of all business declarations. */
export const GATEWAY: readonly GatewayTool[] = Object.freeze([
  Object.freeze({
    name: DISCOVER_GATEWAY_NAME,
    readOnly: true,
    description:
      'List the top-level capabilities this server serves, as short routing cards. Most are roles: open the one that matches the task; its sub-roles arrive with it, one level at a time, so a large tree costs only the branch you enter. A role card is a name, a sentence, and the ref that opens it — instructions and what a role holds arrive on opening, never here.',
  }),
  Object.freeze({
    name: INSPECT_GATEWAY_NAME,
    readOnly: true,
    description:
      "Inspect one or more refs without activating them. The response contains a fixed evaluation notice, each requested node's routing card, and one level of routing cards for direct members and declared uses. It never returns instructions, Tool execution facets, framework process contracts, or invocation results. Pass 1 through 32 unique refs from existing cards.",
  }),
  Object.freeze({
    name: OPEN_GATEWAY_NAME,
    readOnly: true,
    description:
      "Open one role, skill or tool by ref. Opening a role returns its instructions and a card for every skill, tool and sub-role it holds, each with the ref that opens it and each tool with the schema needed to call it. Opening a skill returns its complete procedure, available here and nowhere else. A tool's card is already complete, so run the tool rather than opening it. Pass a ref taken from a card; never assemble one.",
  }),
  Object.freeze({
    name: INVOKE_READ_ONLY_GATEWAY_NAME,
    readOnly: true,
    description:
      'Run a tool that leaves the world unchanged. Use this for every tool whose card says read_only: true. The ref and arguments come from that card. A tool that is not read-only is refused here.',
  }),
  Object.freeze({
    name: INVOKE_GATEWAY_NAME,
    readOnly: false,
    description:
      'Run a tool that changes something. Use this for every tool whose card says read_only: false. The ref and arguments come from that card. A read-only tool is refused here, so that a host can tell the two apart before a human is asked to approve anything.',
  }),
]);

/** The fixed navigation half, usable without an execution runtime. */
export const DISCLOSURE_GATEWAY: readonly GatewayTool[] = Object.freeze(GATEWAY.slice(0, 3));
/** The fixed invocation half, present only on an executable application. */
export const EXECUTION_GATEWAY: readonly GatewayTool[] = Object.freeze(GATEWAY.slice(3));
/** Compatibility names-only inventory in the same fixed registration order. */
export const GATEWAY_TOOLS: readonly GatewayName[] = Object.freeze(
  GATEWAY.map((tool) => tool.name),
);

/** Turn structured Index lookup facts into the one next action an agent can take. */
export function unresolvedMessage(failure: NodeNotFoundError): string {
  const known = failure.known.join(', ');
  switch (failure.reason) {
    case LookupFailure.EMPTY_REF:
      return `A reference must name at least a root role. Call ${DISCOVER_GATEWAY_NAME} for the roles this server serves.`;
    case LookupFailure.NO_SUCH_ROOT:
      return (
        `No root role named '${failure.scope}'. This server serves: ${known}. ` +
        `Call ${DISCOVER_GATEWAY_NAME} for their cards, then open one to reach what is beneath it.`
      );
    case LookupFailure.NOT_A_CONTAINER:
      return (
        `Reference '${failure.ref}' continues past '${failure.scope}', which is a ${failure.kind} and holds nothing. ` +
        `Open '${failure.scope}' itself with ${OPEN_GATEWAY_NAME}, or go back to the card the ref came from.`
      );
    case LookupFailure.NO_SUCH_MEMBER: {
      const holds = known.length === 0 ? 'It holds nothing.' : `It holds: ${known}.`;
      return (
        `Role '${failure.scope}' holds no member named '${failure.segment}'. ${holds} ` +
        `Call ${OPEN_GATEWAY_NAME} on '${failure.scope}' to see each member with the ref that opens it.`
      );
    }
    case LookupFailure.WRONG_KIND: {
      const recovery =
        failure.kind === 'tool'
          ? `Run it with ${INVOKE_READ_ONLY_GATEWAY_NAME} or ${INVOKE_GATEWAY_NAME}, whichever its card says.`
          : `Open it with ${OPEN_GATEWAY_NAME}.`;
      return `${failure.ref} names a ${failure.kind ?? 'node'}, not a ${failure.wanted ?? 'requested kind'}. ${recovery}`;
    }
  }
}

/** Identify the one fixed invocation door whose host hint matches a Tool. */
export function wrongDoorMessage(ref: string, readOnly: boolean): string {
  const stated = readOnly ? 'read-only' : 'not read-only';
  const door = readOnly ? INVOKE_READ_ONLY_GATEWAY_NAME : INVOKE_GATEWAY_NAME;
  return `${ref} is ${stated}, so it must be run through ${door}.`;
}

/** Explain that a model-visible card is reserved for a person-controlled Prompt. */
export function takenByPersonMessage(ref: string): string {
  return (
    `${ref} is opened by a person, not by an agent. It is reachable only as a command in this host's menu. ` +
    'Do not reproduce its steps another way; tell the user which command runs it and let them decide when.'
  );
}

/** Validate and normalize one atomic inspect shortlist before authorization. */
export function normalizeInspectionRefs(refs: readonly string[]): readonly string[] {
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 32) {
    throw new RefusedError(
      `${INSPECT_GATEWAY_NAME} requires from 1 through 32 unique non-empty refs.`,
    );
  }
  const normalized: string[] = [];
  for (const value of refs as readonly unknown[]) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new RefusedError(
        `${INSPECT_GATEWAY_NAME} requires from 1 through 32 unique non-empty refs.`,
      );
    }
    const ref = value.trim();
    if (normalized.includes(ref)) {
      throw new RefusedError(`${INSPECT_GATEWAY_NAME} names a ref more than once: '${ref}'.`);
    }
    normalized.push(ref);
  }
  return Object.freeze(normalized);
}

/**
 * SDK-neutral progressive-navigation half of Contexture's fixed gateway.
 *
 * It owns neither a Runtime nor a transport. The supplied Disclosure remains
 * the authority for cards, telemetry, prompt-root visibility, and monotonic
 * root selection. Optional reservations are an embedding policy only; MCP
 * Prompt `modelMayOpen` policy stays in the server Publications adapter.
 */
export class DisclosureAPI {
  readonly #reserved: ReadonlySet<string>;

  constructor(
    readonly disclosure: Disclosure,
    options: { readonly reserved?: Iterable<string> } = {},
  ) {
    if (!(disclosure instanceof Disclosure)) {
      throw new ModelValidationError('DisclosureAPI requires a Disclosure.');
    }
    this.#reserved = new Set([...(options.reserved ?? [])].map((ref) => canonicalRef(ref)));
    Object.freeze(this);
  }

  /** The immutable ordered discover/open half, with no execution doors. */
  get tools(): readonly GatewayTool[] {
    return DISCLOSURE_GATEWAY;
  }

  /** Immutable compiled facts underlying this disclosure projection. */
  get index(): Disclosure['index'] {
    return this.disclosure.index;
  }

  /** Request-safe graph facts under the same effective root ceiling as navigation. */
  selectedGraph(requested: RootSelection = RootSelection.all()): SelectedGraph {
    return new SelectedGraph(this.disclosure.index, this.disclosure.effectiveSelection(requested));
  }

  /** Return one routing-card level for each selected model-visible root. */
  async discover(selection: RootSelection = RootSelection.all()): Promise<Discovery> {
    return Promise.resolve(this.disclosure.discover(selection));
  }

  /** Inspect an atomic shortlist without activating any candidate. */
  async inspect(
    refs: readonly string[],
    selection: RootSelection = RootSelection.all(),
  ): Promise<import('./disclosure.js').Inspection> {
    const normalized = normalizeInspectionRefs(refs);

    const effective = this.disclosure.effectiveSelection(selection);
    for (const ref of normalized) {
      effective.requireRef(ref);
      if (this.#reserved.has(canonicalRef(ref))) {
        throw new RefusedError(takenByPersonMessage(ref));
      }
    }
    const payload = await this.recover(() =>
      Promise.resolve(this.disclosure.inspect(normalized, selection)),
    );
    for (const ref of normalized) void reportInspection(this.disclosure.telemetry, ref);
    return payload;
  }

  /**
   * Open through the model door. Ordinary lookup failures become one
   * agent-facing recovery refusal; a selected-root violation remains typed and
   * intentionally names no alternative root.
   */
  async open(ref: string, selection: RootSelection = RootSelection.all()): Promise<RoutingCard> {
    const effective = this.disclosure.effectiveSelection(selection);
    effective.requireRef(ref);
    if (this.#reserved.has(canonicalRef(ref))) {
      throw new RefusedError(takenByPersonMessage(ref));
    }
    return this.recover(() => Promise.resolve(this.disclosure.open(ref, selection)));
  }

  /**
   * Open through the person door, bypassing only model reservations and
   * prompt-root visibility. It never widens the selected root surface.
   */
  async openForPerson(
    ref: string,
    selection: RootSelection = RootSelection.all(),
  ): Promise<RoutingCard> {
    return this.recover(() => Promise.resolve(this.disclosure.openForPerson(ref, selection)));
  }

  /** Compatibility spelling retained for hosts that use the Python name. */
  async openForAPerson(
    ref: string,
    selection: RootSelection = RootSelection.all(),
  ): Promise<RoutingCard> {
    return this.openForPerson(ref, selection);
  }

  protected async recover<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RootOutsideSelectionError || error instanceof RefusedError) throw error;
      if (error instanceof NodeNotFoundError)
        throw new RefusedError(unresolvedMessage(error), { cause: error });
      throw error;
    }
  }
}

/** SDK-neutral invocation half of Contexture's fixed gateway. */
export class ExecutionAPI {
  constructor(readonly runtime: ApplicationRuntime) {
    if (!(runtime instanceof ApplicationRuntime)) {
      throw new ModelValidationError('ExecutionAPI requires a bound ApplicationRuntime.');
    }
    Object.freeze(this);
  }

  /** The immutable ordered read-only/write invocation half. */
  get tools(): readonly GatewayTool[] {
    return EXECUTION_GATEWAY;
  }

  /** Immutable compiled facts underlying this execution projection. */
  get index(): ApplicationRuntime['index'] {
    return this.runtime.index;
  }

  async invokeReadOnly(
    ref: string,
    arguments_: unknown = undefined,
    context: ToolCallContext = {},
    selection: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    return this.invokeForModel(ref, arguments_, true, context, selection);
  }

  async invoke(
    ref: string,
    arguments_: unknown = undefined,
    context: ToolCallContext = {},
    selection: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    return this.invokeForModel(ref, arguments_, false, context, selection);
  }

  /**
   * Read an argument-free, read-only target through a Host-controlled path.
   * Prompt roots remain available here because the model does not own this door.
   */
  async readForHost(
    ref: string,
    context: ToolCallContext = {},
    selection: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    try {
      return await this.runtime.invokeReadOnly(ref, undefined, context, selection);
    } catch (error) {
      if (error instanceof NodeNotFoundError) {
        throw new RefusedError(unresolvedMessage(error), { cause: error });
      }
      throw error;
    }
  }

  /** Compatibility spelling retained for hosts that use the Python name. */
  async readForAHost(
    ref: string,
    context: ToolCallContext = {},
    selection: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    return this.readForHost(ref, context, selection);
  }

  private async invokeForModel(
    ref: string,
    arguments_: unknown,
    readOnly: boolean,
    context: ToolCallContext,
    selection: RootSelection,
  ): Promise<unknown> {
    const effective = this.runtime.effectiveRootSelection(selection);
    effective.requireRef(ref);
    const root = ref.split(REFERENCE_SEPARATOR).find((segment) => segment.length > 0);
    if (
      root !== undefined &&
      this.runtime.index.promptRoots.some((candidate) => candidate.name === root)
    ) {
      throw new RefusedError(takenByPersonMessage(ref));
    }
    return this.recover(() =>
      readOnly
        ? this.runtime.invokeReadOnly(ref, arguments_, context, selection)
        : this.runtime.invoke(ref, arguments_, context, selection),
    );
  }

  private async recover<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RootOutsideSelectionError || error instanceof RefusedError) throw error;
      if (error instanceof WrongDoorError) {
        throw new RefusedError(wrongDoorMessage(error.ref, error.readOnly), { cause: error });
      }
      if (error instanceof NodeNotFoundError) {
        throw new RefusedError(unresolvedMessage(error), { cause: error });
      }
      throw error;
    }
  }
}

/** Transport-neutral implementation of Contexture's fixed gateway. */
export class Gateway {
  readonly navigation: DisclosureAPI;
  readonly execution: ExecutionAPI | undefined;

  constructor(
    readonly disclosure: Disclosure,
    readonly runtime: ApplicationRuntime | undefined,
  ) {
    this.navigation = new DisclosureAPI(disclosure);
    this.execution = runtime === undefined ? undefined : new ExecutionAPI(runtime);
    Object.freeze(this);
  }

  get tools(): readonly GatewayTool[] {
    return this.execution === undefined ? DISCLOSURE_GATEWAY : GATEWAY;
  }

  async discover(selection: RootSelection = RootSelection.all()): Promise<unknown> {
    return this.navigation.discover(selection);
  }

  async inspect(
    refs: readonly string[],
    selection: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    return this.navigation.inspect(refs, selection);
  }

  async open(ref: string, selection: RootSelection = RootSelection.all()): Promise<unknown> {
    return this.navigation.open(ref, selection);
  }

  async openForPerson(
    ref: string,
    selection: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    return this.navigation.openForPerson(ref, selection);
  }

  async openForAPerson(
    ref: string,
    selection: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    return this.openForPerson(ref, selection);
  }

  async invokeReadOnly(
    ref: string,
    arguments_: unknown = undefined,
    context: ToolCallContext = {},
    selection: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    if (this.execution === undefined) {
      throw new RefusedError(
        `This Contexture server is disclosure-only. Call ${DISCOVER_GATEWAY_NAME} or ${OPEN_GATEWAY_NAME} instead.`,
      );
    }
    return this.execution.invokeReadOnly(ref, arguments_, context, selection);
  }

  async invoke(
    ref: string,
    arguments_: unknown = undefined,
    context: ToolCallContext = {},
    selection: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    if (this.execution === undefined) {
      throw new RefusedError(
        `This Contexture server is disclosure-only. Call ${DISCOVER_GATEWAY_NAME} or ${OPEN_GATEWAY_NAME} instead.`,
      );
    }
    return this.execution.invoke(ref, arguments_, context, selection);
  }

  async readForHost(
    ref: string,
    context: ToolCallContext = {},
    selection: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    if (this.execution === undefined) {
      throw new RefusedError(
        `This Contexture server is disclosure-only. Call ${DISCOVER_GATEWAY_NAME} or ${OPEN_GATEWAY_NAME} instead.`,
      );
    }
    return this.execution.readForHost(ref, context, selection);
  }

  async readForAHost(
    ref: string,
    context: ToolCallContext = {},
    selection: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    return this.readForHost(ref, context, selection);
  }
}

function canonicalRef(ref: string): string {
  return ref
    .split(REFERENCE_SEPARATOR)
    .filter((segment) => segment.length > 0)
    .join(REFERENCE_SEPARATOR);
}

// Compatibility names share the native implementations rather than creating
// parallel framework models.
export { Gateway as SystemAPI };
export { RefusedError as Refused };
