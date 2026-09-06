import { z, type ZodType } from 'zod';

import type { ToolCallContext, ToolDeclaration } from './declarations.js';
import { InputValidationError, ModelValidationError } from './errors.js';

/** JSON values admitted by a Contexture wire boundary. */
export type JsonValue = boolean | number | string | null | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** One compiled tool's disclosed schema and validated execution path. */
export interface ToolBinding {
  readonly schema: JsonObject;
  call(arguments_: unknown, context: ToolCallContext): Promise<unknown>;
}

/** Create the only schema/validation/invocation binding for a declared Tool. */
export function bindTool<Input, Output>(declaration: ToolDeclaration<Input, Output>): ToolBinding {
  const schema = requireObjectSchema(declaration.input) as ZodType<Input>;
  const jsonSchema = normalizeSchema(z.toJSONSchema(schema, { io: 'input' }));
  return Object.freeze({
    schema: Object.freeze(jsonSchema),
    async call(arguments_: unknown, context: ToolCallContext): Promise<Output> {
      const parsed = schema.safeParse(arguments_ ?? {});
      if (!parsed.success) throw new InputValidationError(declaration.name, parsed.error.issues);
      return declaration.invoke(parsed.data, context);
    },
  });
}

function requireObjectSchema<Input>(schema: ZodType<Input>): ZodType<Input> {
  const rendered = z.toJSONSchema(schema, { io: 'input' });
  if (rendered.type !== 'object' || rendered.additionalProperties !== false) {
    throw new ModelValidationError(
      'A Contexture Tool input schema must be a strict JSON object; unknown properties are not permitted.',
    );
  }
  return schema;
}

function normalizeSchema(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModelValidationError('A Contexture Tool input schema must render as a JSON object.');
  }
  return normalizeObject(value as Record<string, unknown>);
}

function normalizeObject(value: Record<string, unknown>): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    // Zod-generated names and strictness implementation are incidental to
    // Contexture's schema contract; validation remains strict in the Binding.
    if (key === '$schema' || key === 'title' || (key === 'additionalProperties' && item === false))
      continue;
    result[key] = normalizeValue(item);
  }
  return result;
}

function normalizeValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === 'object') return normalizeObject(value as Record<string, unknown>);
  throw new ModelValidationError('A Tool input schema contains a non-JSON value.');
}
