import { z, type ZodType } from 'zod';

import type { ToolCallContext, ToolDeclaration } from './declarations.js';
import { InputValidationError, ModelValidationError } from '../foundation/errors.js';

/** JSON values admitted by a Contexture wire boundary. */
export type JsonValue = boolean | number | string | null | JsonObject | readonly JsonValue[];
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
  const { input, invoke, name } = declaration;
  if (!(input instanceof z.ZodType)) {
    throw new ModelValidationError(
      `Tool ${JSON.stringify(name)} must declare a Zod input schema for runtime execution.`,
    );
  }
  const schema = requireObjectSchema(input) as ZodType<Input>;
  const jsonSchema = normalizeSchema(z.toJSONSchema(schema, { io: 'input' }));
  return Object.freeze({
    schema: jsonSchema,
    async call(arguments_: unknown, context: ToolCallContext): Promise<Output> {
      const parsed = schema.safeParse(arguments_ ?? {});
      if (!parsed.success) throw new InputValidationError(name, parsed.error.issues);
      return invoke(parsed.data, context);
    },
  });
}

function requireObjectSchema<Input>(schema: ZodType<Input>): ZodType<Input> {
  requireProjectableSchema(schema);
  const rendered = z.toJSONSchema(schema, { io: 'input' });
  if (rendered.type !== 'object') {
    throw new ModelValidationError('A Contexture Tool input schema must render as a JSON object.');
  }
  return schema;
}

function requireProjectableSchema(schema: ZodType): void {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    seen.add(value);
    const candidate = value as { readonly _zod?: { readonly def?: Record<string, unknown> } };
    const definition = candidate._zod?.def;
    if (definition !== undefined) {
      const type = definition.type;
      if (
        definition.coerce === true ||
        type === 'catch' ||
        type === 'transform' ||
        type === 'pipe'
      ) {
        throw new ModelValidationError(
          'A Contexture Tool input schema cannot coerce, catch, or transform values because that behavior cannot be disclosed faithfully as JSON Schema.',
        );
      }
      visit(definition);
      return;
    }
    for (const item of Array.isArray(value) ? value : Object.values(value)) visit(item);
  };
  visit(schema);
}

function normalizeSchema(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModelValidationError('A Contexture Tool input schema must render as a JSON object.');
  }
  return normalizeObject(value as Record<string, unknown>);
}

function normalizeObject(value: Record<string, unknown>): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of orderedEntries(value)) {
    // Zod-generated names are incidental. Validation constraints and object
    // unknown-key policy remain because this same schema enforces invocation.
    if (key === '$schema' || key === 'title') continue;
    result[key] = normalizeValue(item);
  }
  if (value.type === 'number') {
    if (result.minimum === undefined) result.minimum = -Number.MAX_VALUE;
    if (result.maximum === undefined) result.maximum = Number.MAX_VALUE;
  }
  return Object.freeze(result);
}

function orderedEntries(value: Record<string, unknown>): readonly (readonly [string, unknown])[] {
  const entries = Object.entries(value);
  const objectSchema = value.type === 'object';
  const rank = (key: string): number => {
    if (objectSchema) {
      if (key === 'properties') return 0;
      if (key === 'required') return 1;
      if (key === 'type') return 2;
    }
    if (key === 'default') return 0;
    if (key === 'type') return 1;
    return 2;
  };
  return entries.sort(([left], [right]) => rank(left) - rank(right));
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
  if (Array.isArray(value)) return Object.freeze(value.map(normalizeValue));
  if (typeof value === 'object') return normalizeObject(value as Record<string, unknown>);
  throw new ModelValidationError('A Tool input schema contains a non-JSON value.');
}
