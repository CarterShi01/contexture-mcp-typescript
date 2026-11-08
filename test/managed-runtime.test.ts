import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BindingRegistration,
  GraphDefinition,
  GraphError,
  LocalServingCoordinator,
  ManagedRuntime,
  RegistryGeneration,
  RevisionState,
  RunLeaseService,
  StructuralPlan,
  bindingDescriptor,
  formatReference,
  prepareGeneration,
} from '../src/managed.js';
import type {
  BindingRegistrationOptions,
  CapturedRelease,
  JSONObject,
  ManagedCallContext,
  ManagedIdentity,
  ManagedRequest,
  RequestAuthorization,
  ServingAttempt,
  ServingPreparationProvider,
} from '../src/managed.js';

function barrier<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Barrier not initialized');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const descriptor = bindingDescriptor({
  binding_id: 'reader',
  version: '1',
  kind: 'registered',
  portability: { kind: 'portable', contract_id: 'reader-contract' },
});
const compiler = {
  compiler_contract_version: 'candidate-1',
  compiler_build: 'build-1',
  app_dependency_contract: { dependency_contract_id: 'app-contract', build: 'app-1' },
  environment_compatibility: ['node-24'],
  locale: 'en',
};

function candidate(
  label: string,
  handler: (input: { value: string }, context: ManagedCallContext) => unknown | Promise<unknown> = (
    input,
    context,
  ) => ({ ...input, resource: context.resource }),
  bindingOverrides: Partial<BindingRegistrationOptions<{ value: string }>> = {},
) {
  const registration = BindingRegistration.create({
    ...descriptor,
    effect: 'read_only',
    abi: 'typescript-managed-call/v1',
    artifact_digest: `sha256:${label === 'one' ? '1'.repeat(64) : '2'.repeat(64)}`,
    input_schema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    validator_contract_id: `validator-${label}`,
    decoder_contract_id: `decoder-${label}`,
    default_contract_id: 'no-defaults',
    coercion_contract_id: 'no-coercion',
    decoder: (input) => {
      if (input === null || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Invalid input');
      const object = input as JSONObject;
      if (typeof object.value !== 'string') throw new Error('Invalid input');
      return { value: object.value };
    },
    validator: (input) => {
      if (typeof input.value !== 'string') throw new Error('Invalid native input');
    },
    handler,
    ...bindingOverrides,
  });
  const definition = GraphDefinition.fromJSON({
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
        instructions: label,
        members: { tools: ['tool', 'other'] },
      },
      { node_id: 'tool', kind: 'tool', name: 'Tool', description: label, binding: descriptor },
      { node_id: 'other', kind: 'tool', name: 'Other', description: label, binding: descriptor },
    ],
    roots: [{ node_id: 'root', plane: 'model' }],
    presentations: { default_locale: 'en', catalogs: [] },
  });
  const registry = new RegistryGeneration({ build: label, registrations: [registration] });
  const plan = StructuralPlan.compile(definition, { ...compiler, registry });
  return { label, registration, definition, registry, plan };
}

function fixture(
  options: {
    verify?: (request: RequestAuthorization) => Promise<readonly string[]>;
    prepare?: (
      attempt: ServingAttempt,
      signal: AbortSignal | undefined,
      defaultPrepare: ServingPreparationProvider['prepare'],
    ) => ReturnType<ServingPreparationProvider['prepare']>;
    fence?: () => void;
    adopt?: (adopt: () => void) => boolean;
  } = {},
) {
  const candidates = new Map<string, ReturnType<typeof candidate>>();
  const disposed: string[] = [];
  let desired: CapturedRelease | undefined;
  let identity: ManagedIdentity = {
    actor_id: 'actor',
    tenant_id: 'tenant',
    authority_revision: 'auth-1',
  };
  const defaultPrepare: ServingPreparationProvider['prepare'] = async (attempt, signal) => {
    const item = candidates.get(attempt.release.manifest_digest);
    if (item === undefined) throw new Error('Unknown candidate');
    return prepareGeneration(
      item.plan,
      {
        graph_id: 'graph',
        revision: attempt.release.snapshot.revision,
        generation_uuid: attempt.generation_uuid,
      },
      Object.fromEntries(
        ['tool', 'other'].map((nodeID) => [
          nodeID,
          {
            binding_id: 'reader',
            version: '1',
            abi: 'typescript-managed-call/v1',
            contract_digest: item.registration.contract_digest,
            acquire: () => ({
              handle: `${item.label}:${nodeID}`,
              dispose() {
                disposed.push(`${item.label}:${nodeID}`);
              },
            }),
          },
        ]),
      ),
      signal,
    );
  };
  const serving = new LocalServingCoordinator({
    graphID: 'graph',
    targetID: 'target',
    instanceID: 'instance',
    authority: {
      capture: () => desired,
      fence: (attempt, ready, adopt) => {
        options.fence?.();
        if (desired?.release_epoch !== attempt.release.release_epoch) return false;
        const current = candidates.get(desired.manifest_digest);
        assert.equal(current?.plan.manifest.manifestDigest, ready.plan.manifest.manifestDigest);
        if (options.adopt !== undefined) return options.adopt(adopt);
        adopt();
        return true;
      },
    },
    provider: {
      prepare: (attempt, signal) =>
        options.prepare === undefined
          ? defaultPrepare(attempt, signal)
          : options.prepare(attempt, signal, defaultPrepare),
    },
  });
  const runtime = new ManagedRuntime(
    serving,
    { current: () => identity },
    { verify: options.verify ?? (async (request) => request.requestedIDs) },
  );
  function desire(item: ReturnType<typeof candidate>, epoch: string) {
    candidates.set(item.plan.manifest.manifestDigest, item);
    desired = Object.freeze({
      graph_id: 'graph',
      target_id: 'target',
      release_epoch: epoch,
      journal_seq: epoch,
      snapshot: new RevisionState(item.definition, epoch),
      manifest_digest: item.plan.manifest.manifestDigest,
    });
  }
  return {
    serving,
    runtime,
    disposed,
    desire,
    setIdentity(value: ManagedIdentity) {
      identity = value;
    },
  };
}

test('one request keeps schema, captured handler and resource in one generation through release', async () => {
  const f = fixture();
  f.desire(candidate('one'), '1');
  assert.equal((await f.serving.prepare()).status, 'serving');
  let escaped: ManagedRequest | undefined;
  await f.runtime.request(async (request) => {
    escaped = request;
    const ref = request.reference('tool');
    const before = await request.inspect(ref);
    f.desire(
      candidate('two', undefined, {
        input_schema: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
          additionalProperties: false,
        },
        decoder: (input) => {
          if (input === null || typeof input !== 'object' || Array.isArray(input))
            throw new Error();
          return { value: String((input as JSONObject).value) };
        },
      }),
      '2',
    );
    assert.equal((await f.serving.prepare()).status, 'serving');
    const after = await request.inspect(ref);
    assert.deepEqual(before, after);
    assert.deepEqual(await request.invoke(ref, { value: 'old' }), {
      value: 'old',
      resource: 'one:tool',
    });
    await assert.rejects(request.invoke(ref, { value: 42 }), GraphError);
    assert.deepEqual(f.disposed, []);
  });
  await f.runtime.request(async (request) => {
    assert.deepEqual(await request.invoke(request.reference('tool'), { value: 42 }), {
      value: '42',
      resource: 'two:tool',
    });
  });
  assert(escaped);
  assert.throws(() => escaped?.reference('tool'), GraphError);
  await f.serving.shutdown();
  assert.deepEqual(f.disposed.sort(), ['one:other', 'one:tool', 'two:other', 'two:tool']);
});

test('late preparation cannot regress newer desired epoch; superseded resources retire', async () => {
  const oldEntered = barrier<void>();
  const oldFinish = barrier<void>();
  const f = fixture({
    prepare: async (attempt, signal, prepare) => {
      const ready = await prepare(attempt, signal);
      if (attempt.release.release_epoch === '1') {
        oldEntered.resolve();
        await oldFinish.promise;
      }
      return ready;
    },
  });
  f.desire(candidate('one'), '1');
  const late = f.serving.prepare();
  await oldEntered.promise;
  f.desire(candidate('two'), '2');
  assert.equal((await f.serving.prepare()).status, 'serving');
  const active = f.serving.current;
  oldFinish.resolve();
  assert.equal((await late).status, 'superseded');
  assert.equal(f.serving.current, active);
  await f.serving.shutdown();
  assert.equal(f.disposed.length, 4);
});

test('final desired/admission fence can refuse without touching last-known-good', async () => {
  let reject = false;
  const f = fixture({
    fence: () => {
      if (reject) throw new GraphError('permission_denied', 'Approval revoked');
    },
  });
  f.desire(candidate('one'), '1');
  await f.serving.prepare();
  const active = f.serving.current;
  reject = true;
  f.desire(candidate('two'), '2');
  assert.equal((await f.serving.prepare()).status, 'failed');
  assert.equal(f.serving.current, active);
  await f.serving.shutdown();
  assert.equal(f.disposed.length, 4);
});

test('failed or aborted preparation preserves LKG and owns cancellation cleanup', async () => {
  const entered = barrier<void>();
  const finish = barrier<void>();
  const f = fixture({
    prepare: async (attempt, signal, prepare) => {
      const ready = await prepare(attempt, signal);
      if (attempt.release.release_epoch === '2') {
        entered.resolve();
        await finish.promise;
      }
      return ready;
    },
  });
  f.desire(candidate('one'), '1');
  await f.serving.prepare();
  const active = f.serving.current;
  const abort = new AbortController();
  f.desire(candidate('two'), '2');
  const pending = f.serving.prepare(abort.signal);
  await entered.promise;
  abort.abort();
  assert.equal(f.disposed.length, 0);
  finish.resolve();
  assert.equal((await pending).status, 'failed');
  assert.equal(f.serving.current, active);
  await f.serving.shutdown();
  assert.equal(f.disposed.length, 4);
});

test('every call intersects current authorization with pinned initial selection ceiling', async () => {
  let grants = new Set(['root', 'tool']);
  let executions = 0;
  const f = fixture({
    verify: async (request) => request.requestedIDs.filter((id) => grants.has(id)),
  });
  f.desire(
    candidate('one', () => {
      executions++;
      return {};
    }),
    '1',
  );
  await f.serving.prepare();
  await f.runtime.request(async (request) => {
    const ref = request.reference('tool');
    assert.throws(() => request.reference('other'), GraphError);
    grants = new Set(['root', 'other']);
    await assert.rejects(request.invoke(ref, { value: 'denied' }), GraphError);
    grants = new Set(['root', 'tool', 'other']);
    await assert.rejects(request.invoke(ref, { value: 'cannot-reexpand' }), GraphError);
  });
  assert.equal(executions, 0);
  await f.serving.shutdown();
});

test('authority await crossing an active pointer or identity change refuses before handler', async () => {
  const entered = barrier<void>();
  const finish = barrier<void>();
  let executions = 0;
  const f = fixture({
    verify: async (request) => {
      if (request.operation === 'invoke') {
        entered.resolve();
        await finish.promise;
      }
      return request.requestedIDs;
    },
  });
  f.desire(
    candidate('one', () => {
      executions++;
      return {};
    }),
    '1',
  );
  await f.serving.prepare();
  const request = f.runtime.request(async (current) => {
    await assert.rejects(
      current.invoke(current.reference('tool'), { value: 'denied' }),
      GraphError,
    );
  });
  await entered.promise;
  f.setIdentity({ actor_id: 'actor', tenant_id: 'tenant', authority_revision: 'auth-2' });
  finish.resolve();
  await request;
  assert.equal(executions, 0);
  await f.serving.shutdown();
});

test('active pointer movement during authority await fails closed rather than using old evidence', async () => {
  const entered = barrier<void>();
  const finish = barrier<void>();
  let executions = 0;
  const f = fixture({
    verify: async (request) => {
      if (request.operation === 'invoke') {
        entered.resolve();
        await finish.promise;
      }
      return request.requestedIDs;
    },
  });
  f.desire(
    candidate('one', () => {
      executions++;
      return {};
    }),
    '1',
  );
  await f.serving.prepare();
  const pending = f.runtime.request(async (request) => {
    await assert.rejects(request.invoke(request.reference('tool'), { value: 'x' }), GraphError);
  });
  await entered.promise;
  f.desire(candidate('two'), '2');
  await f.serving.prepare();
  finish.resolve();
  await pending;
  assert.equal(executions, 0);
  await f.serving.shutdown();
});

test('wrong-generation references, raw-schema errors and read-only door checks do not execute', async () => {
  let executions = 0;
  const f = fixture();
  f.desire(
    candidate('one', () => {
      executions++;
      return {};
    }),
    '1',
  );
  await f.serving.prepare();
  await f.runtime.request(
    async (request) => {
      const stale = formatReference('graph', '00000000-0000-0000-0000-000000000000', 'tool');
      await assert.rejects(request.invoke(stale, { value: 'x' }), GraphError);
      await assert.rejects(request.invoke(request.reference('tool'), { value: 42 }), GraphError);
    },
    { selection: ['tool'] },
  );
  assert.equal(executions, 0);
  await f.serving.shutdown();
});

test('cancelled non-cooperative handler keeps its real lease until completion and shutdown waits', async () => {
  const entered = barrier<void>();
  const finish = barrier<void>();
  const f = fixture();
  f.desire(
    candidate('one', async (_input, context) => {
      entered.resolve();
      await finish.promise;
      assert.equal(context.signal?.aborted, true);
      assert.equal(f.disposed.length, 0);
      return {};
    }),
    '1',
  );
  await f.serving.prepare();
  const abort = new AbortController();
  const pending = f.runtime.request(
    (request) => request.invoke(request.reference('tool'), { value: 'x' }),
    { signal: abort.signal },
  );
  await entered.promise;
  abort.abort();
  const shutdown = f.serving.shutdown();
  let stopped = false;
  void shutdown.then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(f.disposed.length, 0);
  assert.throws(() => f.serving.lease(), GraphError);
  finish.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  await shutdown;
  assert.equal(f.disposed.length, 2);
});

test('an unawaited dispatched handler is joined before request scope releases resources', async () => {
  const entered = barrier<void>();
  const finish = barrier<void>();
  const exit = barrier<void>();
  const f = fixture();
  f.desire(
    candidate('one', async () => {
      entered.resolve();
      await finish.promise;
      return {};
    }),
    '1',
  );
  await f.serving.prepare();
  const pending = f.runtime.request(async (request) => {
    void request.invoke(request.reference('tool'), { value: 'x' });
    await entered.promise;
    exit.resolve();
  });
  await exit.promise;
  const shutdown = f.serving.shutdown();
  await Promise.resolve();
  assert.equal(f.disposed.length, 0);
  finish.resolve();
  await pending;
  await shutdown;
  assert.equal(f.disposed.length, 2);
});

test('shutdown joins in-flight preparation and refuses adoption after it closes admission', async () => {
  const entered = barrier<void>();
  const finish = barrier<void>();
  const f = fixture({
    prepare: async (attempt, signal, prepare) => {
      const ready = await prepare(attempt, signal);
      entered.resolve();
      await finish.promise;
      return ready;
    },
  });
  f.desire(candidate('one'), '1');
  const pending = f.serving.prepare();
  await entered.promise;
  const shutdown = f.serving.shutdown();
  assert.equal(f.serving.closed, true);
  assert.throws(() => f.serving.prepare(), GraphError);
  finish.resolve();
  assert.equal((await pending).status, 'superseded');
  await shutdown;
  assert.equal(f.disposed.length, 2);
  assert.deepEqual(f.serving.counts, { preparing: 0, retiring: 0, active: 0 });
});

test('run pin renews current authority, explicitly upgrades, and never expands its ceiling', async () => {
  let now = 0;
  let allowed = ['root', 'tool'];
  const f = fixture({
    verify: async (request) => request.requestedIDs.filter((id) => allowed.includes(id)),
  });
  f.desire(candidate('one'), '1');
  await f.serving.prepare();
  const runs = new RunLeaseService(f.runtime, { clock: () => now, maxTTL: 100, maxRuns: 1 });
  const run = await runs.create(50);
  assert.equal(runs.requiresExplicitSweep, true);
  assert.throws(() => JSON.stringify(run), TypeError);
  assert.throws(() => runs.create(50), GraphError);
  f.desire(candidate('two'), '2');
  await f.serving.prepare();
  allowed = ['root', 'tool', 'other'];
  await runs.request(run, async (request) => {
    assert.deepEqual(await request.invoke(request.reference('tool'), { value: 'pinned' }), {
      value: 'pinned',
      resource: 'one:tool',
    });
    assert.throws(() => request.reference('other'), GraphError);
  });
  await runs.renew(run, 80);
  await runs.upgrade(run, 80);
  await runs.request(run, async (request) => {
    assert.deepEqual(await request.invoke(request.reference('tool'), { value: 'upgraded' }), {
      value: 'upgraded',
      resource: 'two:tool',
    });
    assert.throws(() => request.reference('other'), GraphError);
  });
  now = 81;
  assert.equal(runs.sweep(), 1);
  assert.throws(() => runs.request(run, () => undefined), GraphError);
  await runs.shutdown();
  await f.serving.shutdown();
  assert.equal(f.disposed.length, 4);
});

test('run expiration closes its keeper, not an already entered child request', async () => {
  let now = 0;
  const entered = barrier<void>();
  const finish = barrier<void>();
  const f = fixture();
  f.desire(
    candidate('one', async () => {
      entered.resolve();
      await finish.promise;
      return {};
    }),
    '1',
  );
  await f.serving.prepare();
  const runs = new RunLeaseService(f.runtime, { clock: () => now, maxTTL: 10 });
  const run = await runs.create(5);
  const child = runs.request(run, (request) =>
    request.invoke(request.reference('tool'), { value: 'x' }),
  );
  await entered.promise;
  f.desire(candidate('two'), '2');
  await f.serving.prepare();
  now = 6;
  assert.equal(runs.sweep(), 1);
  assert.equal(f.disposed.length, 0);
  assert.throws(() => runs.request(run, () => undefined), GraphError);
  finish.resolve();
  await child;
  await runs.shutdown();
  await f.serving.shutdown();
  assert.equal(f.disposed.length, 4);
});

test('wrong actor, tenant, service and expired run envelopes cannot authorize a request', async () => {
  const f = fixture();
  f.desire(candidate('one'), '1');
  await f.serving.prepare();
  const runs = new RunLeaseService(f.runtime);
  const other = new RunLeaseService(f.runtime);
  const run = await runs.create(1000);
  assert.throws(() => other.request(run, () => undefined), GraphError);
  f.setIdentity({ actor_id: 'actor', tenant_id: 'other-tenant', authority_revision: 'auth-1' });
  assert.throws(() => runs.request(run, () => undefined), GraphError);
  f.setIdentity({ actor_id: 'other-actor', tenant_id: 'tenant', authority_revision: 'auth-1' });
  assert.throws(() => runs.release(run), GraphError);
  f.setIdentity({ actor_id: 'actor', tenant_id: 'tenant', authority_revision: 'auth-1' });
  runs.release(run);
  assert.throws(() => runs.request(run, () => undefined), GraphError);
  await runs.shutdown();
  await other.shutdown();
  await f.serving.shutdown();
});

test('returning an already-owned generation fails without retiring last-known-good', async () => {
  let reuse = false;
  const f = fixture({
    prepare: (attempt, signal, prepare) => {
      if (reuse) {
        const current = f.serving.current;
        assert(current);
        return Promise.resolve(current.generation);
      }
      return prepare(attempt, signal);
    },
  });
  f.desire(candidate('one'), '1');
  await f.serving.prepare();
  const active = f.serving.current;
  reuse = true;
  f.desire(candidate('two'), '2');
  assert.equal((await f.serving.prepare()).status, 'failed');
  assert.equal(f.serving.current, active);
  assert.equal(active?.generation.resourceState, 'prepared');
  await f.runtime.request((request) =>
    request.invoke(request.reference('tool'), { value: 'still-serving' }),
  );
  await f.serving.shutdown();
  assert.equal(f.disposed.length, 2);
});

test('read-only door and detached arguments cannot be changed while current authority awaits', async () => {
  const entered = barrier<void>();
  const finish = barrier<void>();
  let executions = 0;
  const f = fixture({
    verify: async (request) => {
      if (request.operation === 'invoke_read_only') {
        entered.resolve();
        await finish.promise;
      }
      return request.requestedIDs;
    },
  });
  f.desire(
    candidate(
      'one',
      () => {
        executions++;
        return {};
      },
      { effect: 'write' },
    ),
    '1',
  );
  await f.serving.prepare();
  await f.runtime.request(async (request) => {
    const options = { readOnly: true };
    const pending = request.invoke(request.reference('tool'), { value: 'x' }, options);
    await entered.promise;
    options.readOnly = false;
    finish.resolve();
    await assert.rejects(pending, GraphError);
  });
  assert.equal(executions, 0);
  await f.serving.shutdown();

  const authEntered = barrier<void>();
  const authFinish = barrier<void>();
  const detached = fixture({
    verify: async (request) => {
      if (request.operation === 'invoke') {
        authEntered.resolve();
        await authFinish.promise;
      }
      return request.requestedIDs;
    },
  });
  detached.desire(candidate('one'), '1');
  await detached.serving.prepare();
  await detached.runtime.request(async (request) => {
    const arguments_ = { value: 'captured' };
    const pending = request.invoke(request.reference('tool'), arguments_);
    await authEntered.promise;
    arguments_.value = 'mutated';
    authFinish.resolve();
    assert.deepEqual(await pending, { value: 'captured', resource: 'one:tool' });
  });
  await detached.serving.shutdown();
});

test('renewal attenuates a run ceiling and new grants cannot restore it', async () => {
  let allowed = ['root', 'tool'];
  const f = fixture({
    verify: async (request) => request.requestedIDs.filter((id) => allowed.includes(id)),
  });
  f.desire(candidate('one'), '1');
  await f.serving.prepare();
  const runs = new RunLeaseService(f.runtime, { clock: () => 0 });
  const run = await runs.create(100);
  allowed = ['root'];
  await runs.renew(run, 100);
  allowed = ['root', 'tool', 'other'];
  await runs.renew(run, 100);
  await runs.request(run, (request) => {
    assert.throws(() => request.reference('tool'), GraphError);
    assert.throws(() => request.reference('other'), GraphError);
  });
  await runs.shutdown();
  await f.serving.shutdown();
});

test('run shutdown joins pending creation and releases its keeper before serving shutdown', async () => {
  const entered = barrier<void>();
  const finish = barrier<void>();
  const f = fixture({
    verify: async (request) => {
      if (request.operation === 'run.create') {
        entered.resolve();
        await finish.promise;
      }
      return request.requestedIDs;
    },
  });
  f.desire(candidate('one'), '1');
  await f.serving.prepare();
  const runs = new RunLeaseService(f.runtime);
  const pending = runs.create(1000);
  await entered.promise;
  const shutdown = runs.shutdown();
  finish.resolve();
  await assert.rejects(pending, GraphError);
  await shutdown;
  assert.deepEqual(runs.counts, { runs: 0, pending: 0 });
  await f.serving.shutdown();
  assert.equal(f.disposed.length, 2);
});

test('a saved adoption callback cannot install a candidate after its fence has returned', async () => {
  let late: (() => void) | undefined;
  const f = fixture({
    adopt: (callback) => {
      late = callback;
      return false;
    },
  });
  f.desire(candidate('one'), '1');
  assert.equal((await f.serving.prepare()).status, 'superseded');
  assert(late);
  assert.throws(() => late?.(), GraphError);
  assert.equal(f.serving.current, undefined);
  await f.serving.shutdown();
  assert.equal(f.disposed.length, 2);
});
