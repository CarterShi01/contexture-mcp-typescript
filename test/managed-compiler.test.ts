import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BindingRegistration,
  ExecutionManifest,
  GraphDefinition,
  GraphError,
  RegistryGeneration,
  StructuralPlan,
  bindingDescriptor,
  canonicalDigest,
  compileManagedSchema,
  prepareGeneration,
} from '../src/managed.js';
import type {
  BindingRegistrationOptions,
  JSONObject,
  PreparationAdapterRegistration,
} from '../src/managed.js';

const digest = `sha256:${'a'.repeat(64)}`;
const uuid = '11111111-1111-1111-1111-111111111111';
const descriptor = bindingDescriptor({
  binding_id: 'reader',
  version: '1',
  kind: 'registered',
  portability: { kind: 'portable', contract_id: 'reader-contract' },
});
const rawSchema = {
  type: 'object',
  properties: { value: { type: ['string', 'number'], default: 'fallback' } },
  additionalProperties: false,
};
const compiler = {
  compiler_contract_version: 'candidate-1',
  compiler_build: 'build-1',
  app_dependency_contract: { dependency_contract_id: 'app-contract', build: 'app-1' },
  environment_compatibility: ['node-24'],
  locale: 'en',
};

function registration(
  changes: Partial<BindingRegistrationOptions<{ value: string }>> = {},
): BindingRegistration {
  return BindingRegistration.create({
    ...descriptor,
    effect: 'read_only',
    abi: 'typescript-managed-call/v1',
    artifact_digest: digest,
    input_schema: rawSchema,
    validator_contract_id: 'validator-1',
    decoder_contract_id: 'decoder-1',
    default_contract_id: 'defaults-1',
    coercion_contract_id: 'coercion-1',
    decoder: (input) => {
      if (input === null || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Expected object');
      return { value: String((input as JSONObject).value ?? 'fallback') };
    },
    validator: (input) => {
      if (typeof input.value !== 'string') throw new Error('Expected native string');
    },
    handler: (input) => input,
    ...changes,
  });
}

function definition(binding = descriptor, fields: Record<string, unknown> = {}): GraphDefinition {
  return GraphDefinition.fromJSON({
    schema: 'contexture.graph/v1',
    semantic_version: '1',
    graph_id: 'graph',
    application_name: 'app',
    mode: 'runtime',
    nodes: [
      {
        node_id: 'root',
        kind: 'role',
        name: 'Root',
        description: 'root',
        members: { tools: ['tool'] },
        instruction_template: {
          parts: [
            { kind: 'Text', text: 'literal /Root/tool\n' },
            { kind: 'NodeRef', target_id: 'tool', label: '' },
          ],
        },
      },
      { node_id: 'tool', kind: 'tool', name: 'Tool', description: 'tool', binding },
    ],
    roots: [{ node_id: 'root', plane: 'model' }],
    presentations: {
      default_locale: 'en',
      catalogs: [{ locale: 'en', entries: [{ node_id: 'root', title: 'Human title' }] }],
    },
    ...fields,
  });
}

function plan(reg = registration()): StructuralPlan {
  return StructuralPlan.compile(definition(), {
    ...compiler,
    registry: new RegistryGeneration({ build: 'registry-1', registrations: [reg] }),
  });
}

function adapter(
  reg: BindingRegistration,
  acquire: PreparationAdapterRegistration['acquire'],
): PreparationAdapterRegistration {
  return {
    binding_id: descriptor.binding_id,
    version: descriptor.version,
    abi: String(reg.contract.abi),
    contract_digest: reg.contract_digest,
    acquire,
  };
}

function barrier<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Barrier not initialized');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('pure compile captures immutable registry/schema/typed instructions without execution', () => {
  let executions = 0;
  const schema = { type: 'object', additionalProperties: false };
  const reg = registration({
    input_schema: schema,
    decoder: () => {
      executions++;
      return { value: 'decoded' };
    },
    validator: () => {
      executions++;
    },
    handler: () => {
      executions++;
      return {};
    },
  });
  const source = [reg];
  const registry = new RegistryGeneration({ build: 'registry', registrations: source });
  source.splice(0);
  schema.additionalProperties = true;
  const compiled = StructuralPlan.compile(definition(), { ...compiler, registry });
  assert.equal(executions, 0);
  assert.equal(
    compiled.bindings.tool?.entry.input_schema &&
      (compiled.bindings.tool.entry.input_schema as JSONObject).additionalProperties,
    false,
  );
  assert.equal(compiled.presentations.root?.title, 'Human title');
  assert.equal(compiled.index.path('tool'), '/Root/Tool');
  const material = compiled.resolveInstructions('root', uuid);
  assert.deepEqual(material[0], { kind: 'Text', text: 'literal /Root/tool\n' });
  assert.equal(material[1] && 'label' in material[1] && material[1].label, '');
  assert.equal(material[1] && 'reference' in material[1] && material[1].reference.nodeID, 'tool');
  assert.equal(Reflect.set(compiled.bindings, 'injected', reg), false);
  assert(Object.isFrozen(compiled.manifest.subject));
  assert.equal(
    compiled.manifest.manifestDigest,
    canonicalDigest(compiled.manifest.subject, 'contexture.manifest/v1'),
  );
  assert.equal(compiled.manifest.asJSON().manifest_digest, compiled.manifest.manifestDigest);
});

test('registry identities include unused registrations and exact versions, not array order', () => {
  const first = registration();
  const unused = registration({
    binding_id: 'unused',
    artifact_digest: `sha256:${'b'.repeat(64)}`,
  });
  const a = new RegistryGeneration({ build: 'r', registrations: [first, unused] });
  const b = new RegistryGeneration({ build: 'r', registrations: [unused, first] });
  assert.equal(a.registryDigest, b.registryDigest);
  assert.notEqual(
    a.registryDigest,
    new RegistryGeneration({ build: 'r', registrations: [first] }).registryDigest,
  );
  assert.throws(
    () => a.resolve(bindingDescriptor({ ...descriptor, version: 'latest' })),
    GraphError,
  );
  assert.throws(
    () => new RegistryGeneration({ build: 'r', registrations: [first, first] }),
    GraphError,
  );
  assert.throws(
    () => first.resolve(bindingDescriptor({ ...descriptor, binding_id: 'other' })),
    GraphError,
  );
});

test('config, secret HANDLE, schema assertion, portability and expected digests fail closed', () => {
  const reg = registration({
    allowed_config: ['region'],
    config_schema: {
      type: 'object',
      properties: { region: { const: 'local' } },
      additionalProperties: false,
      required: ['region'],
    },
    allowed_secret_refs: ['secret-handle'],
  });
  const registry = new RegistryGeneration({ build: 'r', registrations: [reg] });
  const allowed = bindingDescriptor({
    ...descriptor,
    config: { region: 'local' },
    secret_refs: ['secret-handle'],
  });
  assert.equal(registry.resolve(allowed).entry.contract_digest, reg.contract_digest);
  for (const binding of [
    { ...allowed, config: { unexpected: true } },
    { ...allowed, config: { region: 'remote' } },
    { ...allowed, secret_refs: ['unauthorized'] },
    { ...allowed, expected_contract_digest: `sha256:${'0'.repeat(64)}` },
    { ...allowed, portability: { kind: 'portable', contract_id: 'other' } },
    { ...allowed, kind: 'remote' },
  ])
    assert.throws(() => registry.resolve(bindingDescriptor(binding)), GraphError);
  assert.throws(() => registry.resolve(allowed, { type: 'object' }), GraphError);
  assert.equal(registry.resolve(allowed, rawSchema).entry.contract_digest, reg.contract_digest);
});

test('offline schema validation supports local references and rejects unsupported semantics', () => {
  const local = compileManagedSchema({
    type: 'object',
    $defs: { number: { type: 'integer', minimum: 1 } },
    properties: { value: { $ref: '#/$defs/number' } },
    required: ['value'],
  });
  local.validate({ value: 2 });
  assert.throws(() => local.validate({ value: '2' }), GraphError);
  for (const schema of [
    { $ref: 'https://example.invalid/schema' },
    { $ref: '#/missing' },
    { $id: 'urn:other' },
    { $dynamicRef: '#value' },
    { customSemanticKeyword: true },
    { $schema: 'http://json-schema.org/draft-07/schema#' },
  ])
    assert.throws(() => compileManagedSchema(schema), GraphError);
  compileManagedSchema({ const: { $ref: 'not-a-schema-reference' } });
  assert.throws(() => compileManagedSchema({ $defs: { bad: { $id: 'urn:x' } } }), GraphError);
});

test('raw schema validation, defaults/coercion, native validation and handler share one binding', async () => {
  const seen: string[] = [];
  const reg = registration({
    decoder: (input) => {
      seen.push('decoder');
      if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error();
      return { value: String((input as JSONObject).value ?? 'fallback') };
    },
    validator: (input) => {
      seen.push('validator');
      assert.equal(typeof input.value, 'string');
    },
    handler: (input) => {
      seen.push('handler');
      return input;
    },
  });
  const context = {
    identity: { actor_id: 'actor', tenant_id: 'tenant', authority_revision: 'auth-1' },
    resource: undefined,
    signal: undefined,
  };
  assert.deepEqual(await reg.call({ value: 5 }, context), { value: '5' });
  assert.deepEqual(await reg.call({}, context), { value: 'fallback' });
  assert.deepEqual(seen, ['decoder', 'validator', 'handler', 'decoder', 'validator', 'handler']);
  await assert.rejects(reg.call({ value: true }, context), GraphError);
  assert.equal(seen.length, 6);
});

test('disclosure-only compile needs an explicit digest and ignores registry entirely', async () => {
  const raw = definition().asJSON() as JSONObject;
  const source = {
    ...raw,
    mode: 'disclosure_only',
    nodes: [{ node_id: 'root', kind: 'role', name: 'Root', description: 'root', instructions: '' }],
  };
  const def = GraphDefinition.fromJSON(source);
  assert.throws(() => StructuralPlan.compile(def, compiler), GraphError);
  const compiled = StructuralPlan.compile(def, {
    ...compiler,
    no_execution_registry_digest: digest,
  });
  assert.deepEqual(Object.keys(compiled.bindings), []);
  const ready = await prepareGeneration(
    compiled,
    { graph_id: 'graph', revision: '1', generation_uuid: uuid },
    {},
  );
  await ready.retire();
  assert.equal(ready.resourceState, 'retired');
  assert.throws(
    () => StructuralPlan.compile(definition(), { ...compiler, execution_extensions: ['exec'] }),
    GraphError,
  );
});

test('preparation preflights every exact adapter before acquiring anything', async () => {
  let acquired = 0;
  const reg = registration();
  const compiled = plan(reg);
  const correct = adapter(reg, () => {
    acquired++;
    return { handle: {}, dispose() {} };
  });
  await assert.rejects(
    prepareGeneration(
      compiled,
      { graph_id: 'graph', revision: '1', generation_uuid: uuid },
      { tool: { ...correct, contract_digest: digest } },
    ),
    GraphError,
  );
  assert.equal(acquired, 0);
  await assert.rejects(
    prepareGeneration(
      compiled,
      { graph_id: 'other', revision: '1', generation_uuid: uuid },
      { tool: correct },
    ),
    GraphError,
  );
  assert.equal(acquired, 0);
});

test('retirement and retained children release resources only after every real lease ends', async () => {
  const reg = registration();
  let disposed = 0;
  const ready = await prepareGeneration(
    plan(reg),
    { graph_id: 'graph', revision: '1', generation_uuid: uuid },
    {
      tool: adapter(reg, () => ({
        handle: 'owned',
        dispose() {
          disposed++;
        },
      })),
    },
  );
  const lease = ready.lease();
  const keeper = ready.retain();
  const retirement = ready.retire();
  assert.equal(ready.retire(), retirement);
  assert.throws(() => ready.lease(), GraphError);
  const child = keeper.lease();
  assert.equal(child.handle('tool'), 'owned');
  lease.close();
  keeper.close();
  assert.throws(() => keeper.lease(), GraphError);
  await Promise.resolve();
  assert.equal(disposed, 0);
  child.close();
  child.close();
  await retirement;
  assert.equal(disposed, 1);
  assert.equal(ready.resourceState, 'retired');
});

test('aborted acquisition is joined and unwound, never closed before it actually finishes', async () => {
  const reg = registration();
  const entered = barrier<void>();
  const finish = barrier<void>();
  const abort = new AbortController();
  let disposed = 0;
  const preparation = prepareGeneration(
    plan(reg),
    { graph_id: 'graph', revision: '1', generation_uuid: uuid },
    {
      tool: adapter(reg, async () => {
        entered.resolve();
        await finish.promise;
        return {
          handle: {},
          dispose() {
            disposed++;
          },
        };
      }),
    },
    abort.signal,
  );
  await entered.promise;
  abort.abort();
  await Promise.resolve();
  assert.equal(disposed, 0);
  finish.resolve();
  await assert.rejects(preparation, { name: 'AbortError' });
  assert.equal(disposed, 1);
});

test('failed cleanup is observable and repeated retirement joins the same failure', async () => {
  const reg = registration();
  const failure = new Error('cleanup');
  let disposed = 0;
  const ready = await prepareGeneration(
    plan(reg),
    { graph_id: 'graph', revision: '1', generation_uuid: uuid },
    {
      tool: adapter(reg, () => ({
        handle: {},
        dispose() {
          disposed++;
          throw failure;
        },
      })),
    },
  );
  const retired = ready.retire();
  await assert.rejects(retired, AggregateError);
  await assert.rejects(ready.retire(), AggregateError);
  assert.equal(disposed, 1);
  assert.equal(ready.resourceState, 'cleanup_failed');
});

test('manifest entries are closed validated evidence and integrity parsing never grants execution', () => {
  const manifest = plan().manifest;
  assert.equal(
    ExecutionManifest.fromJSON(manifest.asJSON()).manifestDigest,
    manifest.manifestDigest,
  );
  assert.throws(
    () =>
      ExecutionManifest.fromJSON({
        ...manifest.asJSON(),
        manifest_digest: `sha256:${'0'.repeat(64)}`,
      }),
    GraphError,
  );
  assert.throws(
    () => ExecutionManifest.fromJSON({ ...manifest.asJSON(), additional: true }),
    GraphError,
  );
  const entries = manifest.subject.binding_entries as readonly JSONObject[];
  assert.throws(
    () =>
      ExecutionManifest.fromJSON({
        ...manifest.asJSON(),
        binding_entries: [{ ...entries[0], unexpected: true }],
      }),
    GraphError,
  );
});

test('forest binding order is preserved and failed acquisition unwinds every entered resource in reverse', async () => {
  const reg = registration();
  const raw = definition().asJSON() as JSONObject;
  const multi = GraphDefinition.fromJSON({
    ...raw,
    nodes: [
      {
        node_id: 'root',
        kind: 'role',
        name: 'Root',
        description: 'root',
        instructions: '',
        members: { tools: ['z', 'a', 'last'] },
      },
      ...['a', 'last', 'z'].map((id) => ({
        node_id: id,
        kind: 'tool',
        name: id,
        description: id,
        binding: { ...descriptor, config: {} },
      })),
    ],
  });
  const compiled = StructuralPlan.compile(multi, {
    ...compiler,
    registry: new RegistryGeneration({ build: 'r', registrations: [reg] }),
  });
  assert.deepEqual(compiled.index.preorder, ['root', 'z', 'a', 'last']);
  const order: string[] = [];
  const adapters = Object.fromEntries(
    ['z', 'a', 'last'].map((id) => [
      id,
      adapter(reg, () => {
        order.push(`acquire:${id}`);
        if (id === 'last') throw new Error('partial acquisition owns its cleanup');
        return {
          handle: id,
          dispose() {
            order.push(`dispose:${id}`);
            if (id === 'a') throw new Error('one disposer must not skip the rest');
          },
        };
      }),
    ]),
  );
  await assert.rejects(
    prepareGeneration(
      compiled,
      { graph_id: 'graph', revision: '1', generation_uuid: uuid },
      adapters,
    ),
    AggregateError,
  );
  assert.deepEqual(order, ['acquire:z', 'acquire:a', 'acquire:last', 'dispose:a', 'dispose:z']);
});
