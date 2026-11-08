import { createHash } from 'node:crypto';
import { isLosslessNumber, parse as parseLossless } from 'lossless-json';
import { ModelValidationError } from './core/foundation/errors.js';
import { compareCodePoints } from './core/model/reference-queries.js';

export type CatalogValue =
  null | boolean | string | number | bigint | readonly CatalogValue[] | CatalogObject;
export interface CatalogObject {
  readonly [key: string]: CatalogValue;
}

function catalogArray(value: CatalogValue): value is readonly CatalogValue[] {
  return Array.isArray(value);
}

function invalid(): ModelValidationError {
  return new ModelValidationError('Node Catalog requires finite, scalar, acyclic JSON data.');
}

function scalar(value: string): string {
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) throw invalid();
  }
  return value;
}

/** Detach native JSON and explicit lossless integers without evaluating accessors. */
export function freezeCatalogValue(value: unknown, active = new WeakSet<object>()): CatalogValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  }
  if (typeof value === 'string') return scalar(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw invalid();
  if (isLosslessNumber(value)) {
    const field = Object.getOwnPropertyDescriptor(value, 'value');
    const raw: unknown = field?.value;
    if (
      field?.get !== undefined ||
      typeof raw !== 'string' ||
      !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(raw)
    )
      throw invalid();
    return freezeCatalogValue(
      /^-?(?:0|[1-9][0-9]*)$/.test(raw) ? BigInt(raw) : Number(raw),
      active,
    );
  }
  if (active.has(value)) throw invalid();
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: CatalogValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const field = Object.getOwnPropertyDescriptor(value, String(index));
        if (field === undefined || field.get !== undefined || field.set !== undefined)
          throw invalid();
        entries.push(freezeCatalogValue(field.value, active));
      }
      return Object.freeze(entries);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw invalid();
    if (Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
    const fields = Object.getOwnPropertyDescriptors(value);
    const entries: [string, CatalogValue][] = [];
    for (const key of Object.keys(fields)) {
      const field = fields[key]!;
      if (!field.enumerable || field.get !== undefined || field.set !== undefined) throw invalid();
      entries.push([scalar(key), freezeCatalogValue(field.value, active)]);
    }
    return Object.freeze(Object.fromEntries(entries));
  } finally {
    active.delete(value);
  }
}

export function freezeCatalogObject(value: unknown): CatalogObject {
  const result = freezeCatalogValue(value);
  if (result === null || typeof result !== 'object' || catalogArray(result)) throw invalid();
  return result;
}

/** Parse before JS Number coercion; integer text remains an exact native bigint. */
export function parseCatalogJson(text: string): CatalogValue {
  return freezeCatalogValue(parseLossless(text));
}

function numberText(value: number): string {
  if (Number.isInteger(value)) return BigInt(value).toString();
  const negative = value < 0 ? '-' : '';
  const raw = Math.abs(value).toString();
  const pieces = raw.split('e');
  const coefficient = pieces[0]!;
  const exponent =
    pieces.length === 2
      ? Number(pieces[1])
      : coefficient.startsWith('0.')
        ? -coefficient.slice(2).search(/[1-9]/) - 1
        : coefficient.split('.')[0]!.length - 1;
  if (exponent >= -4) return negative + raw;
  const digits = coefficient.replace('.', '').replace(/^0+/, '');
  const normalized = digits[0]! + (digits.length > 1 ? `.${digits.slice(1)}` : '');
  return `${negative}${normalized}e-${String(-exponent).padStart(2, '0')}`;
}

/** Legacy Catalog code-point ordering/number profile, deliberately NOT managed JCS. */
export function formatCatalogJson(
  value: unknown,
  options: { readonly indent?: number | null; readonly spaced?: boolean } = {},
): string {
  const frozen = freezeCatalogValue(value);
  const indent = options.indent ?? null;
  if (indent !== null && !Number.isSafeInteger(indent)) {
    throw new ModelValidationError('Catalog indent must be null or an integer.');
  }
  const pretty = indent !== null;
  const gap = indent === null ? '' : ' '.repeat(Math.max(0, indent));
  const separator = pretty ? ',' : options.spaced ? ', ' : ',';
  const colon = pretty || options.spaced ? ': ' : ':';
  function write(item: CatalogValue, depth: number): string {
    if (item === null || typeof item === 'boolean') return String(item);
    if (typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number') return numberText(item);
    if (typeof item === 'bigint') return item.toString();
    const array = catalogArray(item);
    const entries = array
      ? item.map((value) => write(value, depth + 1))
      : Object.keys(item)
          .sort(compareCodePoints)
          .map((key) => JSON.stringify(key) + colon + write(item[key]!, depth + 1));
    const [open, close] = array ? ['[', ']'] : ['{', '}'];
    if (entries.length === 0) return open + close;
    return pretty
      ? `${open}\n${gap.repeat(depth + 1)}${entries.join(`,\n${gap.repeat(depth + 1)}`)}\n${gap.repeat(depth)}${close}`
      : open + entries.join(separator) + close;
  }
  return write(frozen, 0);
}

export function canonicalCatalogDigest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(formatCatalogJson(freezeCatalogObject(value)))
    .digest('hex')}`;
}
