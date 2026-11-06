/** Bounded WP01/WP11 candidate spike, not the legacy Catalog profile or public facade. */
import { createHash } from 'node:crypto';

export type JSONValue =
  null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type FrozenJSON =
  null | boolean | number | string | readonly FrozenJSON[] | { readonly [key: string]: FrozenJSON };

export const CANONICAL_PROFILE = 'contexture.canonical/jcs-binary64-safeint-v1';
export const MAX_SAFE_INTEGER = 9007199254740991;
export const MAX_COUNTER = 99999999999999999999n;
// Native processing budget, not an accepted cross-binding depth requirement.
export const MAX_JSON_DEPTH = 256;
export const JOURNAL_PAYLOAD_DOMAIN = 'contexture.journal-payload/v1';
export const JOURNAL_RECORD_DOMAIN = 'contexture.journal-record/v1';
export const CHECKPOINT_DOMAIN = 'contexture.checkpoint/v1';
export const JOURNAL_BACKUP_DOMAIN = 'contexture.file-journal-backup/v1';
export const DOMAINS = Object.freeze([
  'contexture.graph/v1',
  'contexture.facts/v1',
  'contexture.manifest/v1',
  JOURNAL_RECORD_DOMAIN,
  'contexture.view/v1',
  'contexture.page/v1',
  'contexture.command/v1',
  'contexture.preview/v1',
  JOURNAL_PAYLOAD_DOMAIN,
  CHECKPOINT_DOMAIN,
  JOURNAL_BACKUP_DOMAIN,
] as const);

/** Minimal typed failure for this slice; full diagnostic parity is not claimed. */
export type GraphErrorCode =
  'schema_invalid' | 'limit_exceeded' | 'reference_not_found' | 'binding_contract_required';

export class GraphError extends Error {
  declare readonly code: GraphErrorCode;
  declare readonly location: string;

  constructor(code: GraphErrorCode, message: string, location = '') {
    super(message);
    this.name = 'GraphError';
    if (
      location.length > 4096 ||
      (location !== '' && !location.startsWith('/')) ||
      /~(?![01])/.test(location)
    ) {
      throw new TypeError('Invalid diagnostic location');
    }
    scalar(location, '');
    Object.defineProperties(this, {
      code: { value: code, enumerable: true },
      location: { value: location, enumerable: true },
    });
  }
}

function invalid(message: string, location = ''): never {
  throw new GraphError('schema_invalid', message, location);
}

function scalar(value: string, location: string): string {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        invalid('JSON strings must contain Unicode scalars', location);
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      invalid('JSON strings must contain Unicode scalars', location);
    }
  }
  return value;
}

function pointer(parent: string, key: string): string {
  if (parent.length + key.length + 1 > 4096) return parent;
  const result = `${parent}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
  return result.length <= 4096 ? result : parent;
}

function depthLimit(depth: number): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new GraphError('limit_exceeded', 'JSON nesting exceeds processing budget');
  }
}

function put(object: Record<string, JSONValue>, key: string, value: JSONValue): void {
  // Ordinary objects, including an opaque __proto__ key, without prototype mutation.
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function copyJSON(value: unknown, frozen: boolean): JSONValue | FrozenJSON {
  const active = new Set<object>();
  function visit(item: unknown, location: string, depth: number): JSONValue {
    depthLimit(depth);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') return scalar(item, location);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid('JSON numbers must be finite', location);
      // JS numbers are already binary64, like Python floats. Only decodeJSON can
      // prove a raw mathematical integer's safety before binary64 rounding.
      return item;
    }
    if (typeof item !== 'object') invalid('Value is not JSON', location);
    const array = Array.isArray(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) {
      invalid('Value is not JSON', location);
    }
    if (active.has(item)) invalid('Cyclic values are not JSON', location);
    active.add(item);
    try {
      const result: JSONValue[] | Record<string, JSONValue> = array ? [] : {};
      const keys = Reflect.ownKeys(item);
      let count = 0;
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string') invalid('JSON object keys must be strings', location);
        scalar(key, location);
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          invalid('JSON properties must be enumerable data', location);
        }
        const child: unknown = descriptor.value;
        if (array) {
          if (key !== String(count)) invalid('JSON arrays must be dense', location);
          (result as JSONValue[]).push(visit(child, pointer(location, key), depth + 1));
          count++;
        } else {
          put(
            result as Record<string, JSONValue>,
            key,
            visit(child, pointer(location, key), depth + 1),
          );
        }
      }
      if (array && count !== (item as unknown[]).length) {
        invalid('JSON arrays must be dense', location);
      }
      if (frozen) Object.freeze(result);
      return result;
    } finally {
      active.delete(item);
    }
  }
  return visit(value, '', 0);
}

/** Validate, detach every alias, and recursively freeze objects/arrays; never expose a Map. */
export function freezeJSON(value: unknown): FrozenJSON {
  return copyJSON(value, true);
}

/** Return detached ordinary JSON containers, including from frozen values. */
export function thawJSON(value: unknown): JSONValue {
  return copyJSON(value, false) as JSONValue;
}

/** JCS writer: do not stringify a whole object (numeric property enumeration is not JCS). */
export function canonicalJSON(value: unknown): Uint8Array {
  const normalized = thawJSON(value);
  function write(item: JSONValue): string {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(write).join(',')}]`;
    return `{${Object.keys(item)
      .sort() // ECMAScript compares UTF-16 code units, not Unicode code points.
      .map((key) => `${JSON.stringify(key)}:${write(item[key]!)}`)
      .join(',')}}`;
  }
  return new TextEncoder().encode(write(normalized));
}

/** SDK-neutral hashing primitive; no filesystem, process, schema fetching or Host state. */
export function canonicalDigest(value: unknown, domain: unknown): string {
  if (typeof domain !== 'string' || !DOMAINS.some((known) => known === domain)) {
    invalid('Unsupported managed digest domain');
  }
  return `sha256:${createHash('sha256').update(domain).update('\0').update(canonicalJSON(value)).digest('hex')}`;
}

function rawNumber(lexeme: string): number {
  const unsigned = lexeme.replace(/^-/, '');
  const [mantissa = '', exponentText = '0'] = unsigned.toLowerCase().split('e');
  const dot = mantissa.indexOf('.');
  const fractionDigits = dot < 0 ? 0 : mantissa.length - dot - 1;
  let coefficient = mantissa.replace('.', '').replace(/^0+/, '');
  if (!coefficient) return lexeme.startsWith('-') ? -0 : 0;

  // Saturation is exact for the only questions asked here: integrality, safe
  // integer bound, overflow and underflow. Never allocate 10**attackerExponent.
  const exponentDigits = exponentText.replace(/^[+-]/, '').replace(/^0+/, '') || '0';
  const bound = BigInt(lexeme.length + 400);
  const exponentMagnitude =
    exponentDigits.length > String(bound).length
      ? bound
      : BigInt(exponentDigits) > bound
        ? bound
        : BigInt(exponentDigits);
  const exponent = exponentText.startsWith('-') ? -exponentMagnitude : exponentMagnitude;
  const trimmed = coefficient.replace(/0+$/, '');
  const scale = exponent - BigInt(fractionDigits) + BigInt(coefficient.length - trimmed.length);
  coefficient = trimmed;
  if (scale >= 0n) {
    const digits = BigInt(coefficient.length) + scale;
    if (digits > 16n || BigInt(coefficient) * 10n ** scale > BigInt(MAX_SAFE_INTEGER)) {
      invalid('Integer lexeme exceeds binary64 safe integer range');
    }
  }
  const number = Number(lexeme);
  if (!Number.isFinite(number)) invalid('JSON number overflows binary64');
  if (number === 0) invalid('Nonzero JSON number underflows binary64');
  return number;
}

/** Strict raw UTF-8 entry point. Every number is lexically checked before rounding. */
export function decodeJSON(data: unknown): JSONValue {
  if (!(data instanceof Uint8Array)) invalid('JSON input must be UTF-8 bytes');
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    invalid('JSON BOM is forbidden');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    invalid('Invalid UTF-8 JSON input');
  }
  let offset = 0;
  function malformed(): never {
    return invalid('Invalid UTF-8 JSON input');
  }
  function space(): void {
    while (offset < text.length && /[ \t\r\n]/.test(text[offset]!)) offset++;
  }
  function string(location: string): string {
    const start = offset++;
    while (offset < text.length) {
      const code = text.charCodeAt(offset++);
      if (code === 34) {
        try {
          const value: unknown = JSON.parse(text.slice(start, offset));
          if (typeof value !== 'string') return malformed();
          return scalar(value, location);
        } catch (error: unknown) {
          if (error instanceof GraphError) throw error;
          return malformed();
        }
      }
      if (code < 32) return malformed();
      if (code === 92) offset++; // The isolated string parser validates all escapes.
    }
    return malformed();
  }
  function value(depth: number, location: string): JSONValue {
    depthLimit(depth);
    space();
    const first = text[offset];
    if (first === '"') return string(location);
    if (first === '{' || first === '[') {
      offset++;
      const object: Record<string, JSONValue> = {};
      const array: JSONValue[] = [];
      const keys = new Set<string>();
      const close = first === '{' ? '}' : ']';
      space();
      if (text[offset] === close) {
        offset++;
        return first === '{' ? object : array;
      }
      while (offset < text.length) {
        space();
        if (first === '{') {
          if (text[offset] !== '"') return malformed();
          const key = string(location);
          if (keys.has(key)) invalid('Duplicate JSON object key');
          keys.add(key);
          space();
          if (text[offset++] !== ':') return malformed();
          put(object, key, value(depth + 1, pointer(location, key)));
        } else {
          array.push(value(depth + 1, pointer(location, String(array.length))));
        }
        space();
        const delimiter = text[offset++];
        if (delimiter === close) return first === '{' ? object : array;
        if (delimiter !== ',') return malformed();
      }
      return malformed();
    }
    for (const [literal, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return result;
      }
    }
    // Scan without slicing the remaining document (avoids quadratic raw parsing).
    const start = offset;
    while (offset < text.length && /[0-9eE+.-]/.test(text[offset]!)) offset++;
    const lexeme = text.slice(start, offset);
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(lexeme)) {
      return malformed();
    }
    return rawNumber(lexeme);
  }
  const result = value(0, '');
  space();
  if (offset !== text.length) return malformed();
  return result;
}

/** Wire counters are strings; local arithmetic is exact BigInt, never binary64. */
export function parseCounter(value: unknown, location = ''): bigint {
  if (
    typeof value !== 'string' ||
    value.length > 20 ||
    !/^(?:0|[1-9][0-9]*)$/.test(value) ||
    value.endsWith('\n')
  ) {
    invalid('Counter must be a canonical decimal string of at most 20 digits', location);
  }
  return BigInt(value);
}

/** Opaque scalar identity, no Unicode normalization or control-character filtering. */
export function validateID(value: unknown, location = ''): string {
  if (typeof value !== 'string') invalid('Identity must be a string', location);
  if (value.length > 256) invalid('Identity must contain 1 through 256 UTF-8 bytes', location);
  scalar(value, location);
  const bytes = new TextEncoder().encode(value).length;
  if (bytes < 1 || bytes > 256)
    invalid('Identity must contain 1 through 256 UTF-8 bytes', location);
  return value;
}
