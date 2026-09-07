import type { output, ZodType } from 'zod';

import type { Principal } from '../foundation/principal.js';
import type { ChannelHandle } from './channels.js';
import type { BaseNodeDeclaration } from './node.js';

/** Context supplied by Contexture when it invokes a business Tool. */
export interface ToolCallContext {
  /** Framework-owned deployment handle captured by the compiled application. */
  readonly channels?: ChannelHandle;
  readonly signal?: AbortSignal;
  readonly host?: unknown;
  readonly principal?: Principal | undefined;
  readonly telemetry?: unknown;
  readonly graph?: unknown;
  readonly selection?: unknown;
}

/** A tool is an executable capability; its Binding owns schema and validation. */
export interface ToolDeclaration<Input = never, Output = unknown> extends BaseNodeDeclaration {
  readonly kind: 'tool';
  readonly readOnly: boolean;
  /** The one schema used for both the disclosed contract and invocation validation. */
  readonly input?: ZodType;
  readonly invoke: (input: Input, context: ToolCallContext) => Output | Promise<Output>;
}

/** Preserve a Zod input type when declaring a Tool inside a heterogeneous tree. */
export function defineTool<Schema extends ZodType, Output>(
  declaration: Omit<ToolDeclaration<output<Schema>, Output>, 'input'> & { readonly input: Schema },
): ToolDeclaration<output<Schema>, Output> {
  return Object.freeze({ ...declaration }) as ToolDeclaration<output<Schema>, Output>;
}
