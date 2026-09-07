import { z, type output, type ZodType } from 'zod';

import { DuplicateNameError, ModelValidationError } from '../foundation/errors.js';
import { REFERENCE_SEPARATOR } from '../foundation/vocabulary.js';
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

/** Facts accepted by the native Tool constructor before its safe defaults are applied. */
export type ToolDefinition<Schema extends ZodType, Output> = Omit<
  ToolDeclaration<output<Schema>, Output>,
  'input' | 'readOnly'
> & {
  readonly input: Schema;
  /** Omission is the safe Python-equivalent writing classification (`false`). */
  readonly readOnly?: boolean;
};

/**
 * Construct one validated executable Tool declaration.
 *
 * TypeScript cannot infer a schema from a handler signature, so the Zod input
 * is explicit. This constructor snapshots the declaration edge list and makes
 * an omitted readOnly fact explicit as `false`; a bare object declaration is
 * still validated again when its lazy factory is compiled.
 */
export function defineTool<Schema extends ZodType, Output>(
  declaration: ToolDefinition<Schema, Output>,
): ToolDeclaration<output<Schema>, Output> {
  const normalized = {
    ...declaration,
    readOnly: declaration.readOnly === undefined ? false : declaration.readOnly,
  };
  validateToolDefinition(normalized);
  return Object.freeze({
    ...normalized,
    ...(normalized.uses === undefined ? {} : { uses: Object.freeze([...normalized.uses]) }),
  }) as ToolDeclaration<output<Schema>, Output>;
}

function validateToolDefinition(
  value: unknown,
): asserts value is ToolDeclaration<unknown, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModelValidationError('A Contexture Tool declaration must be an object.');
  }
  const declaration = value as {
    readonly kind?: unknown;
    readonly name?: unknown;
    readonly description?: unknown;
    readonly uses?: unknown;
    readonly readOnly?: unknown;
    readonly input?: unknown;
    readonly invoke?: unknown;
  };
  if (declaration.kind !== 'tool') {
    throw new ModelValidationError('A Contexture Tool declaration must have kind "tool".');
  }
  requireText(declaration.name, 'Context node name must not be empty.');
  requireText(
    declaration.description,
    `Context node ${JSON.stringify(declaration.name)} must have a routing description.`,
  );
  if (declaration.name.includes(REFERENCE_SEPARATOR)) {
    throw new ModelValidationError(
      `Context node name ${JSON.stringify(declaration.name)} must not contain ${JSON.stringify(REFERENCE_SEPARATOR)}.`,
    );
  }
  if (typeof declaration.readOnly !== 'boolean') {
    throw new ModelValidationError(
      `Tool ${JSON.stringify(declaration.name)} must declare readOnly as a boolean.`,
    );
  }
  if (!(declaration.input instanceof z.ZodType)) {
    throw new ModelValidationError(
      `Tool ${JSON.stringify(declaration.name)} must declare a Zod input schema.`,
    );
  }
  if (typeof declaration.invoke !== 'function') {
    throw new ModelValidationError(`Tool ${JSON.stringify(declaration.name)} must declare invoke.`);
  }
  if (declaration.uses === undefined) return;
  if (!Array.isArray(declaration.uses)) {
    throw new ModelValidationError(
      `Node ${JSON.stringify(declaration.name)} uses must be an array.`,
    );
  }
  const seen = new Set<string>();
  for (const ref of declaration.uses) {
    requireText(ref, `Node ${JSON.stringify(declaration.name)} names an empty reference in uses.`);
    if (seen.has(ref)) {
      throw new DuplicateNameError(
        `Node ${JSON.stringify(declaration.name)} names ${JSON.stringify(ref)} more than once in uses.`,
      );
    }
    seen.add(ref);
  }
}

function requireText(value: unknown, message: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new ModelValidationError(message);
}
