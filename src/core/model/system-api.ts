import { Disclosure } from './disclosure.js';
import { RefusedError } from './disclosure.js';
import { ApplicationRuntime, WrongDoorError } from './runtime.js';
import { RootOutsideSelectionError, RootSelection } from './root-selection.js';
import type { ToolCallContext } from './declarations.js';
import { LookupFailure, NodeNotFoundError } from '../foundation/errors.js';
import {
  DISCOVER_GATEWAY_NAME,
  INVOKE_GATEWAY_NAME,
  INVOKE_READ_ONLY_GATEWAY_NAME,
  OPEN_GATEWAY_NAME,
  type GatewayName,
} from '../foundation/vocabulary.js';

/** One immutable system-controlled tool in Contexture's MCP plane. */
export interface GatewayTool {
  readonly name: GatewayName;
  readonly description: string;
  readonly readOnly: boolean;
}

/** The fixed system plane, ordered independently of all business declarations. */
export const GATEWAY: readonly GatewayTool[] = Object.freeze([
  Object.freeze({
    name: DISCOVER_GATEWAY_NAME,
    readOnly: true,
    description:
      'List the top-level capabilities this server serves, as short routing cards. Most are roles: open the one that matches the task; its sub-roles arrive with it, one level at a time, so a large tree costs only the branch you enter. A role card is a name, a sentence, and the ref that opens it — instructions and what a role holds arrive on opening, never here.',
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
export const DISCLOSURE_GATEWAY: readonly GatewayTool[] = Object.freeze(GATEWAY.slice(0, 2));
/** The fixed invocation half, present only on an executable application. */
export const EXECUTION_GATEWAY: readonly GatewayTool[] = Object.freeze(GATEWAY.slice(2));

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

/** Transport-neutral implementation of Contexture's fixed gateway. */
export class Gateway {
  constructor(
    readonly disclosure: Disclosure,
    readonly runtime: ApplicationRuntime | undefined,
  ) {
    Object.freeze(this);
  }

  get tools(): readonly GatewayTool[] {
    return this.runtime === undefined ? DISCLOSURE_GATEWAY : GATEWAY;
  }

  async discover(selection: RootSelection = RootSelection.all()): Promise<unknown> {
    return this.recover(() => Promise.resolve(this.disclosure.discover(selection)));
  }

  async open(ref: string, selection: RootSelection = RootSelection.all()): Promise<unknown> {
    return this.recover(() => Promise.resolve(this.disclosure.open(ref, selection)));
  }

  async invokeReadOnly(
    ref: string,
    arguments_: unknown = undefined,
    context: ToolCallContext = {},
    selection: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    const runtime = this.runtime;
    if (runtime === undefined) {
      throw new RefusedError(
        `This Contexture server is disclosure-only. Call ${DISCOVER_GATEWAY_NAME} or ${OPEN_GATEWAY_NAME} instead.`,
      );
    }
    return this.recover(() => runtime.invokeReadOnly(ref, arguments_, context, selection));
  }

  async invoke(
    ref: string,
    arguments_: unknown = undefined,
    context: ToolCallContext = {},
    selection: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    const runtime = this.runtime;
    if (runtime === undefined) {
      throw new RefusedError(
        `This Contexture server is disclosure-only. Call ${DISCOVER_GATEWAY_NAME} or ${OPEN_GATEWAY_NAME} instead.`,
      );
    }
    return this.recover(() => runtime.invoke(ref, arguments_, context, selection));
  }

  private async recover<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      // A root ceiling is authorization, not a model-navigation mistake. Its
      // typed error deliberately carries no alternative roots or recovery path.
      if (error instanceof RootOutsideSelectionError || error instanceof RefusedError) throw error;
      if (error instanceof WrongDoorError)
        throw new RefusedError(wrongDoorMessage(error.ref, error.readOnly), { cause: error });
      if (error instanceof NodeNotFoundError)
        throw new RefusedError(unresolvedMessage(error), { cause: error });
      throw error;
    }
  }
}
