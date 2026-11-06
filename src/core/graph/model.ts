/** WP03/WP11 managed candidate values, not an accepted profile or public facade. */
import {
  GraphError,
  canonicalDigest,
  decodeJSON,
  freezeJSON,
  thawJSON,
  validateID,
} from './canonical.js';
import type { FrozenJSON, GraphErrorCode, JSONValue } from './canonical.js';
import { GraphIndex } from './index.js';

export type Kind = 'role' | 'skill' | 'tool';
export type Plane = 'model' | 'prompt';
export type Slot = 'pre_process' | 'children' | 'post_process' | 'skills' | 'tools';
export type Mutable = boolean | 'inherit';
export type JSONObject = { readonly [key: string]: FrozenJSON };

export function modelError(
  message: string,
  location = '',
  code: GraphErrorCode = 'schema_invalid',
): never {
  throw new GraphError(code, message, location);
}

function object(value: unknown, required: string, optional = ''): JSONObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    modelError('Expected an object');
  const keys = Object.keys(value);
  const allowed = new Set(`${required} ${optional}`.split(' ').filter(Boolean));
  if (
    required
      .split(' ')
      .filter(Boolean)
      .some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  )
    modelError('Missing required or unknown core fields');
  return value as JSONObject;
}

function array(value: unknown): readonly FrozenJSON[] {
  if (!Array.isArray(value)) modelError('Expected an array');
  return value as readonly FrozenJSON[];
}

function text(value: unknown, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value)) modelError('Expected text');
  freezeJSON(value);
  return value;
}

function name(value: unknown): string {
  const result = text(value);
  if (
    Array.from(result).some(
      (char) =>
        char === '/' ||
        char.codePointAt(0)! < 32 ||
        (char.codePointAt(0)! >= 127 && char.codePointAt(0)! <= 159),
    )
  )
    modelError('Names cannot contain slash or control characters');
  return result;
}

function choice<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== 'string' || !choices.includes(value)) modelError('Invalid enum value');
  return value as T[number];
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') modelError('Expected a boolean');
  return value;
}

function ids(value: unknown): readonly string[] {
  const result = array(value).map((id) => validateID(id));
  if (new Set(result).size !== result.length) modelError('Duplicate identity');
  return Object.freeze(result);
}

function jsonObject(value: unknown): JSONObject {
  const result = freezeJSON(value);
  if (result === null || typeof result !== 'object' || Array.isArray(result))
    modelError('Expected a JSON object');
  return result as JSONObject;
}

function extensions(value: unknown): JSONObject {
  const result = jsonObject(value);
  if (
    Object.keys(result).some(
      (key) => !/^[a-z][a-z0-9.-]*:[A-Za-z0-9_.-]+$/u.test(key) || key.endsWith('\n'),
    )
  )
    modelError('Extension keys must be namespace:key');
  return result;
}

export type TemplatePart =
  | Readonly<{ kind: 'Text'; text: string }>
  | Readonly<{ kind: 'NodeRef'; target_id: string; label?: string }>;
export type InstructionTemplate = Readonly<{ parts: readonly TemplatePart[] }>;

function template(value: unknown): InstructionTemplate {
  const obj = object(value, 'parts');
  return Object.freeze({
    parts: Object.freeze(
      array(obj.parts).map((raw): TemplatePart => {
        const tag = object(raw, 'kind', 'text target_id label');
        if (tag.kind === 'Text') {
          const part = object(raw, 'kind text');
          return Object.freeze({ kind: 'Text', text: text(part.text, true) });
        }
        if (tag.kind === 'NodeRef') {
          const part = object(raw, 'kind target_id', 'label');
          return Object.freeze({
            kind: 'NodeRef',
            target_id: validateID(part.target_id),
            ...(Object.hasOwn(part, 'label') ? { label: text(part.label, true) } : {}),
          });
        }
        return modelError('Unknown template part kind');
      }),
    ),
  });
}

export interface Members {
  readonly pre_process?: string;
  readonly children: readonly string[];
  readonly post_process?: string;
  readonly skills: readonly string[];
  readonly tools: readonly string[];
}

function members(value: unknown): Members {
  const obj = object(value, '', 'pre_process children post_process skills tools');
  return Object.freeze({
    ...(Object.hasOwn(obj, 'pre_process') ? { pre_process: validateID(obj.pre_process) } : {}),
    children: ids(Object.hasOwn(obj, 'children') ? obj.children : []),
    ...(Object.hasOwn(obj, 'post_process') ? { post_process: validateID(obj.post_process) } : {}),
    skills: ids(Object.hasOwn(obj, 'skills') ? obj.skills : []),
    tools: ids(Object.hasOwn(obj, 'tools') ? obj.tools : []),
  });
}

export type Placement = readonly [slot: Slot, ordinal: number, nodeID: string];
export function placements(value: Members): readonly Placement[] {
  const result: Placement[] = [];
  if (value.pre_process !== undefined) result.push(['pre_process', 0, value.pre_process]);
  value.children.forEach((id, i) => result.push(['children', i, id]));
  if (value.post_process !== undefined) result.push(['post_process', 0, value.post_process]);
  value.skills.forEach((id, i) => result.push(['skills', i, id]));
  value.tools.forEach((id, i) => result.push(['tools', i, id]));
  return Object.freeze(result.map((entry) => Object.freeze(entry)));
}

export type Portability =
  | Readonly<{ kind: 'portable'; contract_id: string }>
  | Readonly<{
      kind: 'native';
      language: 'python' | 'typescript' | 'go';
      version: string;
      factory: string;
    }>;

function portability(value: unknown): Portability {
  const obj = object(value, 'kind', 'contract_id language version factory');
  if (obj.kind === 'portable') {
    object(value, 'kind contract_id');
    return Object.freeze({ kind: 'portable', contract_id: validateID(obj.contract_id) });
  }
  object(value, 'kind language version factory');
  return Object.freeze({
    kind: choice(obj.kind, ['native']),
    language: choice(obj.language, ['python', 'typescript', 'go']),
    version: text(obj.version),
    factory: text(obj.factory),
  });
}

export interface BindingDescriptor {
  readonly kind: 'registered' | 'remote';
  readonly binding_id: string;
  readonly version: string;
  readonly portability: Portability;
  readonly config: JSONObject;
  readonly secret_refs: readonly string[];
  readonly expected_contract_digest?: string;
}

/** Detach evidence and definitions through the same complete descriptor decoder. */
export function bindingDescriptor(value: unknown): BindingDescriptor {
  const obj = object(
    freezeJSON(value),
    'kind binding_id version portability',
    'config secret_refs expected_contract_digest',
  );
  let digest: string | undefined;
  if (Object.hasOwn(obj, 'expected_contract_digest')) {
    digest = text(obj.expected_contract_digest);
    if (!/^sha256:[0-9a-f]{64}$/u.test(digest) || digest.endsWith('\n'))
      modelError('Invalid expected contract digest');
  }
  return Object.freeze({
    kind: choice(obj.kind, ['registered', 'remote']),
    binding_id: validateID(obj.binding_id),
    version: text(obj.version),
    portability: portability(obj.portability),
    config: jsonObject(Object.hasOwn(obj, 'config') ? obj.config : {}),
    secret_refs: ids(Object.hasOwn(obj, 'secret_refs') ? obj.secret_refs : []),
    ...(digest !== undefined ? { expected_contract_digest: digest } : {}),
  });
}

/**
 * Bounded assertion-syntax profile only, never an execution validator.
 * Unknown JSON Schema keywords (including vocabularies/dynamic refs) refuse
 * explicitly. No regex compilation, reference resolution or remote fetching.
 */
function inputContract(value: unknown): boolean | JSONObject {
  const frozen = freezeJSON(value);
  const stack: FrozenJSON[] = [frozen];
  const annotation = new Set([
    '$id',
    '$schema',
    '$ref',
    '$anchor',
    '$comment',
    'title',
    'description',
    'format',
    'contentEncoding',
    'contentMediaType',
  ]);
  const numeric = new Set([
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
  ]);
  const counts = new Set([
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minContains',
    'maxContains',
    'minProperties',
    'maxProperties',
  ]);
  const subschema = new Set([
    'items',
    'contains',
    'additionalProperties',
    'propertyNames',
    'not',
    'if',
    'then',
    'else',
    'unevaluatedItems',
    'unevaluatedProperties',
    'contentSchema',
  ]);
  const maps = new Set(['properties', '$defs', 'dependentSchemas']);
  while (stack.length) {
    const schema = stack.pop()!;
    if (typeof schema === 'boolean') continue;
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema))
      modelError('Invalid JSON Schema assertion');
    for (const [key, item] of Object.entries(schema)) {
      if (annotation.has(key)) text(item, true);
      else if (numeric.has(key)) {
        if (typeof item !== 'number' || (key === 'multipleOf' && item <= 0))
          modelError('Invalid JSON Schema numeric keyword');
      } else if (counts.has(key)) {
        if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)
          modelError('Invalid JSON Schema count');
      } else if (['readOnly', 'writeOnly', 'deprecated', 'uniqueItems'].includes(key))
        boolean(item);
      else if (key === 'type') {
        const types = typeof item === 'string' ? [item] : array(item);
        if (!types.length || new Set(types).size !== types.length)
          modelError('Invalid JSON Schema type');
        types.forEach((type) =>
          choice(type, ['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']),
        );
      } else if (key === 'required') {
        const names = array(item);
        names.forEach((entry) => text(entry, true));
        if (new Set(names).size !== names.length)
          modelError('Duplicate JSON Schema required field');
      } else if (key === 'enum') {
        const values = array(item);
        if (!values.length) modelError('Empty JSON Schema enum');
        const hashes = values.map((entry) => canonicalDigest(entry, 'contexture.graph/v1'));
        if (new Set(hashes).size !== hashes.length) modelError('Duplicate JSON Schema enum');
      } else if (key === 'const' || key === 'default') {
        /* inert JSON */
      } else if (key === 'examples') array(item);
      else if (subschema.has(key)) stack.push(item);
      else if (maps.has(key)) {
        for (const child of Object.values(jsonObject(item))) stack.push(child);
      } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) {
        const values = array(item);
        if (key !== 'prefixItems' && !values.length) modelError('Empty schema combinator');
        for (const child of values) stack.push(child);
      } else if (key === 'dependentRequired') {
        for (const required of Object.values(jsonObject(item))) {
          const names = array(required);
          names.forEach((entry) => text(entry, true));
          if (new Set(names).size !== names.length) modelError('Duplicate dependent requirement');
        }
      } else modelError('Unsupported input_contract profile keyword');
    }
  }
  return frozen as boolean | JSONObject;
}

interface NodeCommon {
  readonly node_id: string;
  readonly name: string;
  readonly description: string;
  readonly mutable: Mutable;
  readonly uses: readonly string[];
  readonly extensions: JSONObject;
}
type Instructions =
  | Readonly<{ instructions: string; instruction_template?: never }>
  | Readonly<{ instruction_template: InstructionTemplate; instructions?: never }>;
export type NodeSpec =
  | (NodeCommon &
      Instructions &
      Readonly<{
        kind: 'role';
        role_variant: 'ordinary' | 'pre_process' | 'post_process';
        members: Members;
      }>)
  | (NodeCommon & Instructions & Readonly<{ kind: 'skill' }>)
  | (NodeCommon &
      Readonly<{
        kind: 'tool';
        binding?: BindingDescriptor;
        input_contract?: boolean | JSONObject;
      }>);

function nodeSpec(value: unknown): NodeSpec {
  const obj = object(
    value,
    'node_id kind name description',
    'mutable uses extensions instructions instruction_template role_variant members binding input_contract',
  );
  const kind = choice(obj.kind, ['role', 'skill', 'tool']);
  const mutable = Object.hasOwn(obj, 'mutable') ? obj.mutable : 'inherit';
  if (typeof mutable !== 'boolean' && mutable !== 'inherit') modelError('Invalid mutable policy');
  const common: NodeCommon = {
    node_id: validateID(obj.node_id),
    name: name(obj.name),
    description: text(obj.description),
    mutable,
    uses: ids(Object.hasOwn(obj, 'uses') ? obj.uses : []),
    extensions: extensions(Object.hasOwn(obj, 'extensions') ? obj.extensions : {}),
  };
  if (kind !== 'role' && (Object.hasOwn(obj, 'members') || Object.hasOwn(obj, 'role_variant')))
    modelError('Only Roles contain members or have a variant');
  if (kind === 'tool') {
    if (Object.hasOwn(obj, 'instructions') || Object.hasOwn(obj, 'instruction_template'))
      modelError('Tools cannot have instructions');
    return Object.freeze({
      ...common,
      kind,
      ...(Object.hasOwn(obj, 'binding') ? { binding: bindingDescriptor(obj.binding) } : {}),
      ...(Object.hasOwn(obj, 'input_contract')
        ? { input_contract: inputContract(obj.input_contract) }
        : {}),
    });
  }
  if (Object.hasOwn(obj, 'binding') || Object.hasOwn(obj, 'input_contract'))
    modelError('Only Tools have execution assertions');
  if (Object.hasOwn(obj, 'instructions') === Object.hasOwn(obj, 'instruction_template'))
    modelError('Supply exactly one instruction representation');
  const instructions: Instructions = Object.hasOwn(obj, 'instructions')
    ? { instructions: text(obj.instructions, true) }
    : { instruction_template: template(obj.instruction_template) };
  if (kind === 'skill') return Object.freeze({ ...common, ...instructions, kind });
  return Object.freeze({
    ...common,
    ...instructions,
    kind,
    role_variant: choice(Object.hasOwn(obj, 'role_variant') ? obj.role_variant : 'ordinary', [
      'ordinary',
      'pre_process',
      'post_process',
    ]),
    members: members(Object.hasOwn(obj, 'members') ? obj.members : {}),
  });
}

export interface RootEntry {
  readonly node_id: string;
  readonly plane: Plane;
}
export type Publication =
  | Readonly<{
      kind: 'prompt';
      publication_id: string;
      name: string;
      description: string;
      opens_id: string;
      model_may_open: boolean;
    }>
  | Readonly<{
      kind: 'resource';
      publication_id: string;
      name: string;
      uri: string;
      mime_type: string;
      opens_id: string;
    }>
  | Readonly<{
      kind: 'route';
      publication_id: string;
      method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      path: string;
      opens_id: string;
    }>;

function resourceURI(value: unknown): string {
  const uri = text(value);
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/u.exec(uri);
  if (
    !scheme ||
    /\p{White_Space}/u.test(uri) ||
    Array.from(uri).some((char) => char.codePointAt(0)! <= 32)
  )
    modelError('Resource URI must be absolute without whitespace');
  const rest = uri.slice(scheme[0].length);
  if (!rest.startsWith('//')) return uri;
  const authority = rest.slice(2).split(/[/?#]/u, 1)[0]!;
  const plain = authority.replace(/[@:#?]/gu, '').normalize('NFKC');
  if (/[/?#@:]/u.test(plain)) modelError('Invalid resource URI authority');
  if (authority.includes('[') !== authority.includes(']')) modelError('Unbalanced IP literal');
  if (authority.includes('[')) {
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    const match = /^\[([^\]]+)\](:.*)?$/u.exec(hostPort);
    if (!match) modelError('Invalid bracketed authority');
    const host = match[1]!;
    if (/^[vV]/u.test(host)) {
      if (!/^[vV][a-fA-F0-9]+\..+$/u.test(host)) modelError('Invalid IPvFuture literal');
    } else {
      // Pure syntax only, including IPv4 suffix and an optional scope identifier.
      const scoped = host.split('%');
      if (scoped.length > 2 || (scoped.length === 2 && !scoped[1]))
        modelError('Invalid IPv6 scope');
      let address = scoped[0]!;
      if (address.includes('.')) {
        const last = address.lastIndexOf(':');
        const octets = address.slice(last + 1).split('.');
        if (
          octets.length !== 4 ||
          octets.some((part) => !/^(?:0|[1-9][0-9]{0,2})$/u.test(part) || Number(part) > 255)
        )
          modelError('Invalid IPv4 suffix');
        address = `${address.slice(0, last + 1)}0:0`;
      }
      const compressed = address.split('::');
      if (compressed.length > 2) modelError('Invalid IPv6 literal');
      const groups = compressed.flatMap((part) => (part ? part.split(':') : []));
      if (
        groups.some((part) => !/^[0-9a-fA-F]{1,4}$/u.test(part)) ||
        (compressed.length === 1 ? groups.length !== 8 : groups.length >= 8)
      )
        modelError('Invalid IPv6 literal');
    }
  }
  return uri;
}

function publication(value: unknown): Publication {
  const tag = object(
    value,
    'kind publication_id opens_id',
    'name description model_may_open uri mime_type method path',
  );
  const common = {
    publication_id: validateID(tag.publication_id),
    opens_id: validateID(tag.opens_id),
  };
  if (tag.kind === 'prompt') {
    const obj = object(value, 'kind publication_id name description opens_id model_may_open');
    return Object.freeze({
      ...common,
      kind: 'prompt',
      name: name(obj.name),
      description: text(obj.description),
      model_may_open: boolean(obj.model_may_open),
    });
  }
  if (tag.kind === 'resource') {
    const obj = object(value, 'kind publication_id name uri mime_type opens_id');
    return Object.freeze({
      ...common,
      kind: 'resource',
      name: name(obj.name),
      uri: resourceURI(obj.uri),
      mime_type: text(obj.mime_type),
    });
  }
  const obj = object(value, 'kind publication_id method path opens_id');
  choice(obj.kind, ['route']);
  const path = text(obj.path);
  if (!path.startsWith('/')) modelError('Route path must start with slash');
  return Object.freeze({
    ...common,
    kind: 'route',
    path,
    method: choice(obj.method, ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
  });
}

const grandfathered = new Map(
  (
    'en-GB-oed i-ami i-bnn i-default i-enochian i-hak i-klingon i-lux i-mingo ' +
    'i-navajo i-pwn i-tao i-tay i-tsu sgn-BE-FR sgn-BE-NL sgn-CH-DE ' +
    'art-lojban cel-gaulish no-bok no-nyn zh-guoyu zh-hakka zh-min zh-min-nan zh-xiang'
  )
    .split(' ')
    .map((tag) => [tag.toLowerCase(), tag]),
);

/** RFC5646 well-formedness/casing, without IANA alias rewriting or Intl aliases. */
export function normalizeLocale(value: unknown): string {
  const tag = text(value);
  if (/[^A-Za-z0-9-]/u.test(tag)) modelError('Invalid BCP47 locale');
  const lower = tag.toLowerCase();
  const old = grandfathered.get(lower);
  if (old) return old;
  const parts = tag.split('-');
  if (parts.some((part) => !/^[A-Za-z0-9]{1,8}$/u.test(part))) modelError('Invalid BCP47 locale');
  if (parts[0]!.toLowerCase() === 'x') {
    if (parts.length === 1) modelError('Private-use locale requires a subtag');
    return lower;
  }
  const lang = parts[0]!;
  if (!/^[A-Za-z]{2,8}$/u.test(lang)) modelError('Invalid locale language');
  const result = [lang.toLowerCase()];
  let i = 1;
  if (lang.length <= 3) {
    for (let count = 0; count < 3 && i < parts.length && /^[A-Za-z]{3}$/u.test(parts[i]!); count++)
      result.push(parts[i++]!.toLowerCase());
  }
  if (i < parts.length && /^[A-Za-z]{4}$/u.test(parts[i]!)) {
    const script = parts[i++]!;
    result.push(script[0]!.toUpperCase() + script.slice(1).toLowerCase());
  }
  if (i < parts.length && /^(?:[A-Za-z]{2}|[0-9]{3})$/u.test(parts[i]!))
    result.push(parts[i++]!.toUpperCase());
  const variants = new Set<string>();
  while (i < parts.length && /^(?:[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3})$/u.test(parts[i]!)) {
    const variant = parts[i++]!.toLowerCase();
    if (variants.has(variant)) modelError('Duplicate locale variant');
    variants.add(variant);
    result.push(variant);
  }
  const singletons = new Set<string>();
  while (i < parts.length) {
    const singleton = parts[i++]!.toLowerCase();
    if (singleton.length !== 1 || singletons.has(singleton))
      modelError('Invalid or duplicate locale extension');
    singletons.add(singleton);
    result.push(singleton);
    const start = i;
    while (i < parts.length && (singleton === 'x' || parts[i]!.length >= 2))
      result.push(parts[i++]!.toLowerCase());
    if (i === start) modelError('Locale extension requires subtags');
  }
  return result.join('-');
}

export interface Presentation {
  readonly node_id: string;
  readonly title?: string;
  readonly description?: string;
}
export interface Presentations {
  readonly default_locale: string;
  readonly catalogs: readonly Readonly<{ locale: string; entries: readonly Presentation[] }>[];
}

function presentations(value: unknown): Presentations {
  const obj = object(value, 'default_locale catalogs');
  const locales = new Set<string>();
  const catalogs = array(obj.catalogs).map((raw) => {
    const catalog = object(raw, 'locale entries');
    const locale = normalizeLocale(catalog.locale);
    if (locales.has(locale.toLowerCase())) modelError('Duplicate normalized locale');
    locales.add(locale.toLowerCase());
    const targets = new Set<string>();
    const entries = array(catalog.entries).map((rawEntry): Presentation => {
      const entry = object(rawEntry, 'node_id', 'title description');
      if (!Object.hasOwn(entry, 'title') && !Object.hasOwn(entry, 'description'))
        modelError('Presentation requires title or description');
      const node_id = validateID(entry.node_id);
      if (targets.has(node_id)) modelError('Duplicate presentation target');
      targets.add(node_id);
      return Object.freeze({
        node_id,
        ...(Object.hasOwn(entry, 'title') ? { title: text(entry.title) } : {}),
        ...(Object.hasOwn(entry, 'description') ? { description: text(entry.description) } : {}),
      });
    });
    return Object.freeze({ locale, entries: Object.freeze(entries) });
  });
  return Object.freeze({
    default_locale: normalizeLocale(obj.default_locale),
    catalogs: Object.freeze(catalogs),
  });
}

/** Pinned registry data supplied by the caller, not author assertion or authority. */
const publicationContracts = new WeakSet<PublicationContract>();

export class PublicationContract {
  readonly binding: BindingDescriptor;
  readonly effect: 'read_only' | 'write';
  readonly argument_free: boolean;

  constructor(binding: unknown, effect: unknown, argumentFree: unknown) {
    this.binding = bindingDescriptor(binding);
    this.effect = choice(effect, ['read_only', 'write']);
    this.argument_free = boolean(argumentFree);
    publicationContracts.add(this);
    Object.freeze(this);
  }

  static isValidated(value: unknown): value is PublicationContract {
    return (
      typeof value === 'object' &&
      value !== null &&
      publicationContracts.has(value as PublicationContract)
    );
  }
}
export type PublicationContracts = Readonly<Record<string, PublicationContract>>;

const definitionToken = Symbol('validated managed definition');
const definitions = new WeakSet<GraphDefinition>();

/** Unicode scalar ordering for node arrays, deliberately not JCS UTF16 key order. */
function codePointOrder(left: string, right: string): number {
  const a = left[Symbol.iterator]();
  const b = right[Symbol.iterator]();
  for (;;) {
    const x = a.next();
    const y = b.next();
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
    const delta = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (delta) return delta;
  }
}

interface DefinitionFields {
  readonly graph_id: string;
  readonly application_name: string;
  readonly mode: 'runtime' | 'disclosure_only';
  readonly nodes: Readonly<Record<string, NodeSpec>>;
  readonly roots: readonly RootEntry[];
  readonly publications: readonly Publication[];
  readonly presentations: Presentations;
  readonly extensions: JSONObject;
}

export class GraphDefinition implements DefinitionFields {
  readonly schema = 'contexture.graph/v1';
  readonly semantic_version = '1';
  readonly graph_id: string;
  readonly application_name: string;
  readonly mode: 'runtime' | 'disclosure_only';
  readonly nodes: Readonly<Record<string, NodeSpec>>;
  readonly roots: readonly RootEntry[];
  readonly publications: readonly Publication[];
  readonly presentations: Presentations;
  readonly extensions: JSONObject;

  private constructor(token: symbol, fields: DefinitionFields) {
    if (token !== definitionToken) modelError('Use GraphDefinition.fromJSON');
    this.graph_id = fields.graph_id;
    this.application_name = fields.application_name;
    this.mode = fields.mode;
    this.nodes = fields.nodes;
    this.roots = fields.roots;
    this.publications = fields.publications;
    this.presentations = fields.presentations;
    this.extensions = fields.extensions;
    definitions.add(this);
    Object.freeze(this);
  }

  /** Strict UTF8 or detached native JSON; never a partially valid serving forest. */
  static fromJSON(value: unknown, publicationContracts?: PublicationContracts): GraphDefinition {
    const obj = object(
      freezeJSON(value instanceof Uint8Array ? decodeJSON(value) : value),
      'schema semantic_version graph_id application_name mode nodes roots presentations',
      'publications extensions',
    );
    if (obj.schema !== 'contexture.graph/v1' || obj.semantic_version !== '1')
      modelError('Unsupported graph schema or semantic version');
    const nodes: Record<string, NodeSpec> = Object.create(null) as Record<string, NodeSpec>;
    for (const [ordinal, raw] of array(obj.nodes).entries()) {
      let node: NodeSpec;
      try {
        node = nodeSpec(raw);
      } catch (error: unknown) {
        if (error instanceof GraphError)
          throw new GraphError(error.code, error.message, `/nodes/${ordinal}`);
        throw error;
      }
      if (Object.hasOwn(nodes, node.node_id))
        modelError('Duplicate node identity', `/nodes/${ordinal}/node_id`);
      nodes[node.node_id] = node;
    }
    const roots = array(obj.roots).map((raw): RootEntry => {
      const root = object(raw, 'node_id plane');
      return Object.freeze({
        node_id: validateID(root.node_id),
        plane: choice(root.plane, ['model', 'prompt']),
      });
    });
    const definition = new GraphDefinition(definitionToken, {
      graph_id: validateID(obj.graph_id, '/graph_id'),
      application_name: name(obj.application_name),
      mode: choice(obj.mode, ['runtime', 'disclosure_only']),
      nodes: Object.freeze(nodes),
      roots: Object.freeze(roots),
      publications: Object.freeze(
        array(Object.hasOwn(obj, 'publications') ? obj.publications : []).map(publication),
      ),
      presentations: presentations(obj.presentations),
      extensions: extensions(Object.hasOwn(obj, 'extensions') ? obj.extensions : {}),
    });
    GraphIndex.build(definition, publicationContracts);
    return definition;
  }

  static isValidated(value: unknown): value is GraphDefinition {
    return typeof value === 'object' && value !== null && definitions.has(value as GraphDefinition);
  }

  /** Detached normalized wire object. Arrays retain authored order except node pool. */
  asJSON(): JSONValue {
    return thawJSON({
      schema: this.schema,
      semantic_version: this.semantic_version,
      graph_id: this.graph_id,
      application_name: this.application_name,
      mode: this.mode,
      nodes: Object.keys(this.nodes)
        .sort(codePointOrder)
        .map((id) => this.nodes[id]!),
      roots: this.roots,
      publications: this.publications,
      presentations: this.presentations,
      extensions: this.extensions,
    });
  }

  digest(): string {
    return canonicalDigest(this.asJSON(), 'contexture.graph/v1');
  }
  get definitionDigest(): string {
    return this.digest();
  }
}
