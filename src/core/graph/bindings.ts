/** Native candidate contracts. Private hash preimages are not accepted wire protocols. */
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

import {
  GraphError,
  canonicalDigest,
  canonicalJSON,
  decodeJSON,
  freezeJSON,
  thawJSON,
  validateID,
} from './canonical.js';
import type { FrozenJSON } from './canonical.js';
import { bindingDescriptor, PublicationContract } from './model.js';
import type { BindingDescriptor, JSONObject, Portability } from './model.js';

export type ManagedSchema = boolean | JSONObject;
export type ManagedEffect = 'read_only' | 'write';

export interface ManagedIdentity {
  readonly actor_id: string;
  readonly tenant_id: string;
  readonly authority_revision: string;
}

export interface ManagedCallContext {
  readonly identity: ManagedIdentity;
  readonly resource: unknown;
  readonly signal: AbortSignal | undefined;
}

export function bindingError(message: string): never {
  throw new GraphError('binding_contract_invalid', message);
}

export function contractText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) bindingError('Expected nonempty text');
  freezeJSON(value);
  return value;
}

export function contractDigest(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 71 || !/^sha256:[0-9a-f]{64}$/u.test(value))
    bindingError('Expected a SHA256 digest');
  return value;
}

function privateDigest(value: unknown, domain: string): string {
  return `sha256:${createHash('sha256').update(domain).update('\0').update(canonicalJSON(value)).digest('hex')}`;
}

function same(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalJSON(left)).equals(Buffer.from(canonicalJSON(right)));
}

const schemaMaps = ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas'];
const schemaSingles = [
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'items',
  'contains',
  'unevaluatedItems',
  'not',
  'if',
  'then',
  'else',
];

/** Offline Draft 2020-12 only; no remote retrieval, coercion, defaults or mutation. */
export function compileManagedSchema(value: unknown): Readonly<{
  schema: ManagedSchema;
  validate(value: unknown): void;
}> {
  const schema = freezeJSON(value);
  if (
    typeof schema !== 'boolean' &&
    (schema === null || typeof schema !== 'object' || Array.isArray(schema))
  )
    bindingError('Expected a boolean or object JSON Schema');
  const pending: FrozenJSON[] = [schema];
  const visited = new Set<FrozenJSON>();
  while (pending.length) {
    const current = pending.pop()!;
    if (typeof current === 'boolean' || visited.has(current)) continue;
    if (current === null || typeof current !== 'object' || Array.isArray(current))
      bindingError('Invalid nested schema');
    visited.add(current);
    const node = current as JSONObject;
    if (['$id', '$anchor', '$dynamicAnchor', '$dynamicRef', '$async'].some((k) => k in node))
      bindingError('Schema identifiers, anchors, dynamic refs and async schemas are unsupported');
    if ('$schema' in node && node.$schema !== 'https://json-schema.org/draft/2020-12/schema')
      bindingError('Unsupported schema dialect');
    if ('$ref' in node) {
      const ref = node.$ref;
      if (typeof ref !== 'string' || (ref !== '#' && !ref.startsWith('#/')))
        bindingError('Only local JSON-pointer schema refs are supported');
      let target: FrozenJSON = schema;
      let pointer: string;
      try {
        pointer = decodeURIComponent(ref.slice(1));
      } catch {
        return bindingError('Invalid schema reference');
      }
      if (/~(?![01])/u.test(pointer)) bindingError('Invalid schema reference');
      for (const raw of pointer
        .slice(1)
        .split('/')
        .filter(() => pointer !== '')) {
        const key = raw.replace(/~1/gu, '/').replace(/~0/gu, '~');
        if (target === null || typeof target !== 'object' || !Object.hasOwn(target, key))
          bindingError('Unresolved schema reference');
        target = (target as JSONObject)[key]!;
      }
      pending.push(target);
    }
    for (const key of schemaMaps) {
      const map = node[key];
      if (map !== undefined && map !== null && typeof map === 'object' && !Array.isArray(map))
        pending.push(...Object.values(map));
    }
    for (const key of schemaSingles) if (node[key] !== undefined) pending.push(node[key]!);
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
      if (Array.isArray(node[key])) pending.push(...node[key]);
    }
  }
  let validator: ValidateFunction;
  try {
    const ajv = new Ajv2020({
      strict: false,
      strictSchema: true,
      validateFormats: false,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
    });
    validator = ajv.compile(thawJSON(schema) as boolean | Record<string, unknown>);
  } catch {
    return bindingError('Invalid, unresolved or unsupported JSON Schema');
  }
  return Object.freeze({
    schema: schema as ManagedSchema,
    validate(input: unknown): void {
      let valid: boolean;
      try {
        valid = validator(thawJSON(input)) as boolean;
      } catch {
        return bindingError('Schema validation failed');
      }
      if (!valid) bindingError('Value does not satisfy the registered schema');
    },
  });
}

export interface BindingRegistrationOptions<Input> {
  readonly binding_id: string;
  readonly version: string;
  readonly kind: 'registered' | 'remote';
  readonly portability: Portability;
  readonly effect: ManagedEffect;
  readonly abi: 'typescript-managed-call/v1';
  readonly artifact_digest: string;
  readonly input_schema: ManagedSchema;
  readonly validator_contract_id: string;
  readonly decoder_contract_id: string;
  readonly default_contract_id: string;
  readonly coercion_contract_id: string;
  readonly decoder: (arguments_: FrozenJSON) => Input;
  readonly validator: (input: Input) => void;
  readonly handler: (input: Input, context: ManagedCallContext) => unknown | Promise<unknown>;
  readonly allowed_config?: readonly string[];
  readonly config_schema?: ManagedSchema;
  readonly allowed_secret_refs?: readonly string[];
  readonly resource_policy?: JSONObject;
  readonly argument_free?: boolean;
}

/** Closure capture is not a sandbox: trusted code must keep callable semantics stable. */
export class BindingRegistration {
  readonly descriptor: BindingDescriptor;
  readonly contract: JSONObject;
  readonly contract_digest: string;
  readonly input_schema: ManagedSchema;
  readonly #invoke: (input: unknown, context: ManagedCallContext) => Promise<FrozenJSON>;
  readonly #config: ReturnType<typeof compileManagedSchema>;

  private constructor(
    descriptor: BindingDescriptor,
    contract: JSONObject,
    invoke: (input: unknown, context: ManagedCallContext) => Promise<FrozenJSON>,
  ) {
    this.descriptor = descriptor;
    this.contract = contract;
    this.contract_digest = privateDigest(contract, 'contexture.binding-contract/implementation-v1');
    this.input_schema = contract.input_schema as ManagedSchema;
    this.#config = compileManagedSchema(contract.config_schema);
    this.#invoke = invoke;
    Object.freeze(this);
  }

  static create<Input>(options: BindingRegistrationOptions<Input>): BindingRegistration {
    const { decoder, validator, handler } = options;
    if ([decoder, validator, handler].some((fn) => typeof fn !== 'function'))
      bindingError('Explicit decoder, validator and handler are required');
    if (options.abi !== 'typescript-managed-call/v1') bindingError('Unsupported native ABI');
    if (!['read_only', 'write'].includes(options.effect)) bindingError('Invalid binding effect');
    const descriptor = bindingDescriptor({
      kind: options.kind,
      binding_id: options.binding_id,
      version: options.version,
      portability: options.portability,
    });
    if (
      descriptor.portability.kind === 'native' &&
      descriptor.portability.language !== 'typescript'
    )
      bindingError('This native ABI requires TypeScript portability');
    const input = compileManagedSchema(options.input_schema);
    const config = compileManagedSchema(
      options.config_schema ?? { type: 'object', additionalProperties: false },
    );
    const ids = (values: readonly string[]): readonly string[] => {
      const result = values.map((value) => validateID(value));
      if (new Set(result).size !== result.length) bindingError('Duplicate contract identity');
      return result;
    };
    const argumentFree = options.argument_free ?? false;
    if (typeof argumentFree !== 'boolean') bindingError('Invalid argument-free attestation');
    if (argumentFree) input.validate({});
    const policy = freezeJSON(options.resource_policy ?? {});
    if (policy === null || typeof policy !== 'object' || Array.isArray(policy))
      bindingError('Resource policy must be an object');
    const contract = freezeJSON({
      binding_id: descriptor.binding_id,
      version: descriptor.version,
      kind: descriptor.kind,
      portability: descriptor.portability,
      effect: options.effect,
      abi: options.abi,
      artifact_digest: contractDigest(options.artifact_digest),
      input_schema: input.schema,
      validator_contract_id: validateID(options.validator_contract_id),
      decoder_contract_id: validateID(options.decoder_contract_id),
      default_contract_id: validateID(options.default_contract_id),
      coercion_contract_id: validateID(options.coercion_contract_id),
      allowed_config: ids(options.allowed_config ?? []),
      config_schema: config.schema,
      allowed_secret_refs: ids(options.allowed_secret_refs ?? []),
      resource_policy: policy,
      argument_free: argumentFree,
      has_factory: false,
    }) as JSONObject;
    return new BindingRegistration(descriptor, contract, async (arguments_, context) => {
      const detached = freezeJSON(arguments_);
      input.validate(detached);
      const decoded = decoder(thawJSON(detached));
      const result: unknown = validator(decoded);
      if (result !== undefined) bindingError('Native validator must return undefined');
      // No await separates native decoding/validation from captured handler dispatch.
      return freezeJSON(await handler(decoded, context));
    });
  }

  resolve(value: BindingDescriptor, inputContract?: ManagedSchema): ResolvedBinding {
    const binding = bindingDescriptor(value);
    if (
      binding.binding_id !== this.descriptor.binding_id ||
      binding.version !== this.descriptor.version ||
      binding.kind !== this.descriptor.kind ||
      !same(binding.portability, this.descriptor.portability) ||
      (binding.expected_contract_digest !== undefined &&
        binding.expected_contract_digest !== this.contract_digest)
    )
      bindingError('Binding kind, portability or expected contract mismatch');
    if (
      inputContract !== undefined &&
      !same(compileManagedSchema(inputContract).schema, this.input_schema)
    )
      bindingError('Input contract assertion mismatch');
    const configKeys = this.contract.allowed_config as readonly string[];
    const secretRefs = this.contract.allowed_secret_refs as readonly string[];
    if (
      Object.keys(binding.config).some((key) => !configKeys.includes(key)) ||
      binding.secret_refs.some((ref) => !secretRefs.includes(ref))
    )
      bindingError('Configuration key or secret HANDLE is not allowed');
    this.#config.validate(binding.config);
    const entry = freezeJSON({
      binding,
      contract_digest: this.contract_digest,
      artifact_digest: this.contract.artifact_digest,
      effect: this.contract.effect,
      abi: this.contract.abi,
      input_schema: this.input_schema,
      validator_contract_id: this.contract.validator_contract_id,
    }) as JSONObject;
    return Object.freeze({
      entry,
      registration: this,
      publicationContract: new PublicationContract(
        binding,
        this.contract.effect,
        this.contract.argument_free,
      ),
    });
  }

  call(arguments_: unknown, context: ManagedCallContext): Promise<FrozenJSON> {
    return this.#invoke(arguments_, context);
  }
}

export interface ResolvedBinding {
  readonly entry: JSONObject;
  readonly registration: BindingRegistration;
  readonly publicationContract: PublicationContract;
}

export class RegistryGeneration {
  readonly build: string;
  readonly registryDigest: string;
  readonly #registrations: ReadonlyMap<string, BindingRegistration>;

  constructor(options: { build: string; registrations: Iterable<BindingRegistration> }) {
    this.build = contractText(options.build);
    const captured = new Map<string, BindingRegistration>();
    for (const registration of options.registrations) {
      if (!(registration instanceof BindingRegistration))
        bindingError('Trusted registration required');
      const key = JSON.stringify([
        registration.descriptor.binding_id,
        registration.descriptor.version,
      ]);
      if (captured.has(key)) bindingError('Duplicate binding identity/version');
      captured.set(key, registration);
    }
    this.#registrations = captured;
    this.registryDigest = privateDigest(
      {
        build: this.build,
        registrations: [...captured.values()]
          .sort((a, b) => {
            const x = [a.descriptor.binding_id, a.descriptor.version];
            const y = [b.descriptor.binding_id, b.descriptor.version];
            for (let i = 0; i < 2; i++) {
              const left = Array.from(x[i]!, (c) => c.codePointAt(0)!);
              const right = Array.from(y[i]!, (c) => c.codePointAt(0)!);
              for (let n = 0; n < Math.min(left.length, right.length); n++)
                if (left[n] !== right[n]) return left[n]! - right[n]!;
              if (left.length !== right.length) return left.length - right.length;
            }
            return 0;
          })
          .map((r) => r.contract),
      },
      'contexture.registry-contract/implementation-v1',
    );
    Object.freeze(this);
  }

  resolve(binding: BindingDescriptor, inputContract?: ManagedSchema): ResolvedBinding {
    const descriptor = bindingDescriptor(binding);
    const found = this.#registrations.get(
      JSON.stringify([descriptor.binding_id, descriptor.version]),
    );
    if (!found) bindingError('No registration for exact binding identity/version');
    return found.resolve(descriptor, inputContract);
  }
}

export interface ExecutionManifestOptions {
  readonly compiler_contract_version: string;
  readonly compiler_build: string;
  readonly registry_digest: string;
  readonly binding_entries: readonly JSONObject[];
  readonly app_dependency_contract: Readonly<{ dependency_contract_id: string; build: string }>;
  readonly environment_compatibility: readonly string[];
}

function closedObject(value: unknown, fields: readonly string[]): JSONObject {
  const frozen = freezeJSON(value);
  if (
    frozen === null ||
    typeof frozen !== 'object' ||
    Array.isArray(frozen) ||
    Object.keys(frozen).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(frozen, key))
  )
    bindingError('Missing required or unknown contract fields');
  return frozen as JSONObject;
}

function bindingEntry(value: unknown): JSONObject {
  const entry = closedObject(value, [
    'binding',
    'contract_digest',
    'artifact_digest',
    'effect',
    'abi',
    'input_schema',
    'validator_contract_id',
  ]);
  const binding = bindingDescriptor(entry.binding);
  const digest = contractDigest(entry.contract_digest);
  if (binding.expected_contract_digest !== undefined && binding.expected_contract_digest !== digest)
    bindingError('Expected binding contract digest mismatch');
  if (entry.effect !== 'read_only' && entry.effect !== 'write')
    bindingError('Invalid binding effect');
  return freezeJSON({
    binding,
    contract_digest: digest,
    artifact_digest: contractDigest(entry.artifact_digest),
    effect: entry.effect,
    abi: contractText(entry.abi),
    input_schema: compileManagedSchema(entry.input_schema).schema,
    validator_contract_id: validateID(entry.validator_contract_id),
  }) as JSONObject;
}

export class ExecutionManifest {
  readonly subject: JSONObject;
  readonly manifestDigest: string;

  constructor(options: ExecutionManifestOptions) {
    if (
      !Array.isArray(options.binding_entries) ||
      !Array.isArray(options.environment_compatibility)
    )
      bindingError('Manifest entries and environments must be arrays');
    const dependency = closedObject(options.app_dependency_contract, [
      'dependency_contract_id',
      'build',
    ]);
    const environment = options.environment_compatibility.map((id) => validateID(id));
    if (new Set(environment).size !== environment.length)
      bindingError('Duplicate environment identity');
    this.subject = freezeJSON({
      schema: 'contexture.manifest/v1',
      compiler_contract_version: contractText(options.compiler_contract_version),
      compiler_build: contractText(options.compiler_build),
      registry_digest: contractDigest(options.registry_digest),
      binding_entries: options.binding_entries.map(bindingEntry),
      app_dependency_contract: {
        dependency_contract_id: validateID(dependency.dependency_contract_id),
        build: contractText(dependency.build),
      },
      environment_compatibility: environment,
    }) as JSONObject;
    this.manifestDigest = canonicalDigest(this.subject, 'contexture.manifest/v1');
    Object.freeze(this);
  }

  asJSON(): JSONObject {
    return freezeJSON({ ...this.subject, manifest_digest: this.manifestDigest }) as JSONObject;
  }

  /** Integrity parsing creates inert evidence, never trusted registry authority. */
  static fromJSON(value: unknown): ExecutionManifest {
    const object = closedObject(value instanceof Uint8Array ? decodeJSON(value) : value, [
      'schema',
      'compiler_contract_version',
      'compiler_build',
      'registry_digest',
      'binding_entries',
      'app_dependency_contract',
      'environment_compatibility',
      'manifest_digest',
    ]);
    if (
      object.schema !== 'contexture.manifest/v1' ||
      !Array.isArray(object.binding_entries) ||
      !Array.isArray(object.environment_compatibility)
    )
      bindingError('Invalid manifest schema or arrays');
    const dependency = closedObject(object.app_dependency_contract, [
      'dependency_contract_id',
      'build',
    ]);
    const manifest = new ExecutionManifest({
      compiler_contract_version: contractText(object.compiler_contract_version),
      compiler_build: contractText(object.compiler_build),
      registry_digest: contractDigest(object.registry_digest),
      binding_entries: object.binding_entries.map(bindingEntry),
      app_dependency_contract: {
        dependency_contract_id: validateID(dependency.dependency_contract_id),
        build: contractText(dependency.build),
      },
      environment_compatibility: object.environment_compatibility.map((id) => validateID(id)),
    });
    if (contractDigest(object.manifest_digest) !== manifest.manifestDigest)
      bindingError('Manifest digest mismatch');
    return manifest;
  }
}
