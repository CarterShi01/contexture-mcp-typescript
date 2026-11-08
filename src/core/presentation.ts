import { ModelValidationError } from './foundation/errors.js';
import { stripText } from './foundation/text.js';
import {
  DISCOVER_GATEWAY_NAME,
  INSPECT_GATEWAY_NAME,
  INVOKE_GATEWAY_NAME,
  INVOKE_READ_ONLY_GATEWAY_NAME,
  OPEN_GATEWAY_NAME,
  type GatewayName,
} from './foundation/vocabulary.js';

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ModelValidationError(`${label} must be a non-empty string.`);
  }
  const trimmed = stripText(value);
  if (trimmed.length === 0) {
    throw new ModelValidationError(`${label} must be a non-empty string.`);
  }
  return trimmed;
}

function mapping(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModelValidationError(`${label} must be a mapping.`);
  }
}

function fields(value: object, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ModelValidationError('Unknown presentation field.');
  }
}

/** Human titles for the five fixed gateways; machine names never change. */
export class GatewayPresentation {
  readonly discover: string;
  readonly inspect: string;
  readonly open: string;
  readonly invokeReadOnly: string;
  readonly invoke: string;

  constructor(
    options: {
      readonly discover?: string;
      readonly inspect?: string;
      readonly open?: string;
      readonly invokeReadOnly?: string;
      readonly invoke?: string;
    } = {},
  ) {
    mapping(options, 'Gateway presentation');
    fields(options, ['discover', 'inspect', 'open', 'invokeReadOnly', 'invoke']);
    this.discover = text(
      options.discover === undefined ? 'Discover capabilities' : options.discover,
      'Discover title',
    );
    this.inspect = text(
      options.inspect === undefined ? 'Inspect capabilities' : options.inspect,
      'Inspect title',
    );
    this.open = text(options.open === undefined ? 'Open capability' : options.open, 'Open title');
    this.invokeReadOnly = text(
      options.invokeReadOnly === undefined ? 'Read data' : options.invokeReadOnly,
      'Read title',
    );
    this.invoke = text(
      options.invoke === undefined ? 'Make a change' : options.invoke,
      'Change title',
    );
    Object.freeze(this);
  }

  titleFor(name: GatewayName): string {
    switch (name) {
      case DISCOVER_GATEWAY_NAME:
        return this.discover;
      case INSPECT_GATEWAY_NAME:
        return this.inspect;
      case OPEN_GATEWAY_NAME:
        return this.open;
      case INVOKE_READ_ONLY_GATEWAY_NAME:
        return this.invokeReadOnly;
      case INVOKE_GATEWAY_NAME:
        return this.invoke;
      default:
        throw new ModelValidationError('Unknown Contexture gateway name.');
    }
  }
}

/** Localized routing copy, separate from a node's name, ref and instructions. */
export class NodePresentation {
  readonly title: string;
  readonly description: string | undefined;

  constructor(options: { readonly title: string; readonly description?: string }) {
    mapping(options, 'Node presentation');
    fields(options, ['title', 'description']);
    this.title = text(options.title, 'Node title');
    this.description =
      options.description === undefined ? undefined : text(options.description, 'Node description');
    Object.freeze(this);
  }
}

/** One language-neutral or selected-locale immutable presentation. */
export class Presentation {
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly gateway: GatewayPresentation | undefined;
  readonly nodes: Readonly<Record<string, NodePresentation>>;

  constructor(
    options: {
      readonly title?: string;
      readonly description?: string;
      readonly gateway?: GatewayPresentation;
      readonly nodes?: Readonly<Record<string, NodePresentation>>;
    } = {},
  ) {
    mapping(options, 'Presentation');
    fields(options, ['title', 'description', 'gateway', 'nodes']);
    this.title =
      options.title === undefined ? undefined : text(options.title, 'Presentation title');
    this.description =
      options.description === undefined
        ? undefined
        : text(options.description, 'Presentation description');
    if (options.gateway !== undefined && !(options.gateway instanceof GatewayPresentation)) {
      throw new ModelValidationError('Gateway presentation must be a GatewayPresentation.');
    }
    this.gateway = options.gateway;
    const source = options.nodes === undefined ? {} : options.nodes;
    mapping(source, 'Presentation nodes');
    const entries = new Map<string, NodePresentation>();
    for (const [ref, node] of Object.entries(source)) {
      const normalized = text(ref, 'Presentation node ref');
      if (entries.has(normalized) || !(node instanceof NodePresentation)) {
        throw new ModelValidationError(
          'Presentation nodes require unique refs and NodePresentation values.',
        );
      }
      entries.set(normalized, node);
    }
    this.nodes = Object.freeze(Object.fromEntries(entries));
    Object.freeze(this);
  }
}

/** Normalize the reference API's practical BCP-47-style locale tags. */
export function normalizeLocale(value: string): string {
  const parts = text(value, 'Presentation locale').replaceAll('_', '-').split('-');
  const language = parts[0]!;
  if (
    !/^\p{L}{2,8}$/u.test(language) ||
    parts.slice(1).some((part) => !/^[\p{L}\p{N}]{1,8}$/u.test(part))
  ) {
    throw new ModelValidationError('Invalid BCP-47-style presentation locale.');
  }
  return [
    language.toLowerCase(),
    ...parts.slice(1).map((part) => {
      if (/^\p{L}{4}$/u.test(part)) {
        return titlecase(part);
      }
      if (/^\p{L}{2}$/u.test(part) || /^\p{Nd}{3}$/u.test(part)) return part.toUpperCase();
      return part.toLowerCase();
    }),
  ].join('-');
}

/** Exact tag, parent tags, then the explicit default; no preferred language. */
export class PresentationCatalog {
  readonly defaultLocale: string;
  readonly locales: Readonly<Record<string, Presentation>>;

  constructor(options: {
    readonly defaultLocale: string;
    readonly locales: Readonly<Record<string, Presentation>>;
  }) {
    mapping(options, 'Presentation catalog');
    fields(options, ['defaultLocale', 'locales']);
    this.defaultLocale = normalizeLocale(options.defaultLocale);
    mapping(options.locales, 'Presentation locales');
    const entries = new Map<string, Presentation>();
    for (const [locale, presentation] of Object.entries(options.locales)) {
      const tag = normalizeLocale(locale);
      if (entries.has(tag) || !(presentation instanceof Presentation)) {
        throw new ModelValidationError(
          'Presentation locales require unique tags and Presentation values.',
        );
      }
      entries.set(tag, presentation);
    }
    if (!entries.has(this.defaultLocale)) {
      throw new ModelValidationError('Presentation default locale must be declared.');
    }
    this.locales = Object.freeze(Object.fromEntries(entries));
    Object.freeze(this);
  }

  resolve(locale?: string): readonly [string, Presentation] {
    const requested = normalizeLocale(
      locale === undefined || locale === '' ? this.defaultLocale : locale,
    );
    const parts = requested.split('-');
    const candidates = parts.map((_, i) => parts.slice(0, parts.length - i).join('-'));
    for (const candidate of [...candidates, this.defaultLocale]) {
      if (Object.hasOwn(this.locales, candidate)) {
        return Object.freeze([candidate, this.locales[candidate]!]);
      }
    }
    throw new ModelValidationError('Presentation default locale is unavailable.');
  }
}

export type PresentationSource = Presentation | PresentationCatalog;

export function resolvePresentation(
  source: PresentationSource,
  locale?: string,
): readonly [string | undefined, Presentation] {
  if (source instanceof PresentationCatalog) return source.resolve(locale);
  if (!(source instanceof Presentation)) {
    throw new ModelValidationError(
      'Presentation source must be a Presentation or PresentationCatalog.',
    );
  }
  return Object.freeze([locale === undefined ? undefined : normalizeLocale(locale), source]);
}

function titlecase(value: string): string {
  const lower = value.toLowerCase();
  let offset = 0;
  let cased = false;
  let result = '';
  for (const character of value) {
    const length = character.toLowerCase().length;
    result += cased
      ? lower.slice(offset, offset + length)
      : (TITLECASE[character.codePointAt(0)!] ?? character.toUpperCase());
    offset += length;
    cased = character === '\u0295' || /\p{Cased}/u.test(character);
  }
  return result;
}

// Unicode 15 reference titlecase exceptions; uppercase is not titlecase.
const TITLECASE: Readonly<Record<number, string>> = Object.freeze({
  0xdf: 'Ss',
  0x19b: '\u019b',
  0x264: '\u0264',
  0xa7d3: '\ua7d3',
  0xa7d5: '\ua7d5',
  0x1c4: '\u01c5',
  0x1c5: '\u01c5',
  0x1c6: '\u01c5',
  0x1c7: '\u01c8',
  0x1c8: '\u01c8',
  0x1c9: '\u01c8',
  0x1ca: '\u01cb',
  0x1cb: '\u01cb',
  0x1cc: '\u01cb',
  0x1f1: '\u01f2',
  0x1f2: '\u01f2',
  0x1f3: '\u01f2',
  0x587: '\u0535\u0582',
  0x10d0: '\u10d0',
  0x10d1: '\u10d1',
  0x10d2: '\u10d2',
  0x10d3: '\u10d3',
  0x10d4: '\u10d4',
  0x10d5: '\u10d5',
  0x10d6: '\u10d6',
  0x10d7: '\u10d7',
  0x10d8: '\u10d8',
  0x10d9: '\u10d9',
  0x10da: '\u10da',
  0x10db: '\u10db',
  0x10dc: '\u10dc',
  0x10dd: '\u10dd',
  0x10de: '\u10de',
  0x10df: '\u10df',
  0x10e0: '\u10e0',
  0x10e1: '\u10e1',
  0x10e2: '\u10e2',
  0x10e3: '\u10e3',
  0x10e4: '\u10e4',
  0x10e5: '\u10e5',
  0x10e6: '\u10e6',
  0x10e7: '\u10e7',
  0x10e8: '\u10e8',
  0x10e9: '\u10e9',
  0x10ea: '\u10ea',
  0x10eb: '\u10eb',
  0x10ec: '\u10ec',
  0x10ed: '\u10ed',
  0x10ee: '\u10ee',
  0x10ef: '\u10ef',
  0x10f0: '\u10f0',
  0x10f1: '\u10f1',
  0x10f2: '\u10f2',
  0x10f3: '\u10f3',
  0x10f4: '\u10f4',
  0x10f5: '\u10f5',
  0x10f6: '\u10f6',
  0x10f7: '\u10f7',
  0x10f8: '\u10f8',
  0x10f9: '\u10f9',
  0x10fa: '\u10fa',
  0x10fd: '\u10fd',
  0x10fe: '\u10fe',
  0x10ff: '\u10ff',
  0x1f80: '\u1f88',
  0x1f81: '\u1f89',
  0x1f82: '\u1f8a',
  0x1f83: '\u1f8b',
  0x1f84: '\u1f8c',
  0x1f85: '\u1f8d',
  0x1f86: '\u1f8e',
  0x1f87: '\u1f8f',
  0x1f88: '\u1f88',
  0x1f89: '\u1f89',
  0x1f8a: '\u1f8a',
  0x1f8b: '\u1f8b',
  0x1f8c: '\u1f8c',
  0x1f8d: '\u1f8d',
  0x1f8e: '\u1f8e',
  0x1f8f: '\u1f8f',
  0x1f90: '\u1f98',
  0x1f91: '\u1f99',
  0x1f92: '\u1f9a',
  0x1f93: '\u1f9b',
  0x1f94: '\u1f9c',
  0x1f95: '\u1f9d',
  0x1f96: '\u1f9e',
  0x1f97: '\u1f9f',
  0x1f98: '\u1f98',
  0x1f99: '\u1f99',
  0x1f9a: '\u1f9a',
  0x1f9b: '\u1f9b',
  0x1f9c: '\u1f9c',
  0x1f9d: '\u1f9d',
  0x1f9e: '\u1f9e',
  0x1f9f: '\u1f9f',
  0x1fa0: '\u1fa8',
  0x1fa1: '\u1fa9',
  0x1fa2: '\u1faa',
  0x1fa3: '\u1fab',
  0x1fa4: '\u1fac',
  0x1fa5: '\u1fad',
  0x1fa6: '\u1fae',
  0x1fa7: '\u1faf',
  0x1fa8: '\u1fa8',
  0x1fa9: '\u1fa9',
  0x1faa: '\u1faa',
  0x1fab: '\u1fab',
  0x1fac: '\u1fac',
  0x1fad: '\u1fad',
  0x1fae: '\u1fae',
  0x1faf: '\u1faf',
  0x1fb2: '\u1fba\u0345',
  0x1fb3: '\u1fbc',
  0x1fb4: '\u0386\u0345',
  0x1fb7: '\u0391\u0342\u0345',
  0x1fbc: '\u1fbc',
  0x1fc2: '\u1fca\u0345',
  0x1fc3: '\u1fcc',
  0x1fc4: '\u0389\u0345',
  0x1fc7: '\u0397\u0342\u0345',
  0x1fcc: '\u1fcc',
  0x1ff2: '\u1ffa\u0345',
  0x1ff3: '\u1ffc',
  0x1ff4: '\u038f\u0345',
  0x1ff7: '\u03a9\u0342\u0345',
  0x1ffc: '\u1ffc',
  0xfb00: 'Ff',
  0xfb01: 'Fi',
  0xfb02: 'Fl',
  0xfb03: 'Ffi',
  0xfb04: 'Ffl',
  0xfb05: 'St',
  0xfb06: 'St',
  0xfb13: '\u0544\u0576',
  0xfb14: '\u0544\u0565',
  0xfb15: '\u0544\u056b',
  0xfb16: '\u054e\u0576',
  0xfb17: '\u0544\u056d',
});
