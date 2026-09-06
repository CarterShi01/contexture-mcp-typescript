import { Disclosure } from './disclosure.js';
import { ApplicationRuntime } from './runtime.js';
import { RootSelection } from './root-selection.js';
import type { ToolCallContext } from './declarations.js';

/** One immutable system-controlled tool in Contexture's MCP plane. */
export interface GatewayTool {
  readonly name: GatewayName;
  readonly description: string;
  readonly readOnly: boolean;
}

export type GatewayName =
  'contexture_discover' | 'contexture_open' | 'contexture_invoke_read_only' | 'contexture_invoke';

/** The fixed system plane, ordered independently of all business declarations. */
export const GATEWAY: readonly GatewayTool[] = Object.freeze([
  Object.freeze({
    name: 'contexture_discover',
    readOnly: true,
    description:
      'List the top-level capabilities this server serves, as short routing cards. Most are roles: open the one that matches the task; its sub-roles arrive with it, one level at a time, so a large tree costs only the branch you enter. A role card is a name, a sentence, and the ref that opens it — instructions and what a role holds arrive on opening, never here.',
  }),
  Object.freeze({
    name: 'contexture_open',
    readOnly: true,
    description:
      "Open one role, skill or tool by ref. Opening a role returns its instructions and a card for every skill, tool and sub-role it holds, each with the ref that opens it and each tool with the schema needed to call it. Opening a skill returns its complete procedure, available here and nowhere else. A tool's card is already complete, so run the tool rather than opening it. Pass a ref taken from a card; never assemble one.",
  }),
  Object.freeze({
    name: 'contexture_invoke_read_only',
    readOnly: true,
    description:
      'Run a tool that leaves the world unchanged. Use this for every tool whose card says read_only: true. The ref and arguments come from that card. A tool that is not read-only is refused here.',
  }),
  Object.freeze({
    name: 'contexture_invoke',
    readOnly: false,
    description:
      'Run a tool that changes something. Use this for every tool whose card says read_only: false. The ref and arguments come from that card. A read-only tool is refused here, so that a host can tell the two apart before a human is asked to approve anything.',
  }),
]);

/** Transport-neutral implementation of Contexture's fixed gateway. */
export class Gateway {
  constructor(
    readonly disclosure: Disclosure,
    readonly runtime: ApplicationRuntime | undefined,
  ) {
    Object.freeze(this);
  }

  get tools(): readonly GatewayTool[] {
    return this.runtime === undefined ? GATEWAY.slice(0, 2) : GATEWAY;
  }

  async discover(selection: RootSelection = RootSelection.all()): Promise<unknown> {
    return this.disclosure.discover(selection);
  }

  async open(ref: string, selection: RootSelection = RootSelection.all()): Promise<unknown> {
    return this.disclosure.open(ref, selection);
  }

  async invokeReadOnly(
    ref: string,
    arguments_: unknown = undefined,
    context: ToolCallContext = {},
    selection: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    if (this.runtime === undefined) throw new Error('This Contexture server is disclosure-only.');
    return this.runtime.invokeReadOnly(ref, arguments_, context, selection);
  }

  async invoke(
    ref: string,
    arguments_: unknown = undefined,
    context: ToolCallContext = {},
    selection: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    if (this.runtime === undefined) throw new Error('This Contexture server is disclosure-only.');
    return this.runtime.invoke(ref, arguments_, context, selection);
  }
}
