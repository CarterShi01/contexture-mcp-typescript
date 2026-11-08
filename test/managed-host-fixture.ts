/** Real native serving/runtime with an explicit TEST Host, not production credentials. */
import { AsyncLocalStorage } from 'node:async_hooks';
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
  prepareGeneration,
} from '../src/managed.js';
import type {
  CapturedRelease,
  ManagedCallContext,
  ManagedIdentity,
  RequestAuthorization,
} from '../src/managed.js';
import { ManagedHostAdapter } from '../src/server/managed.js';
import type {
  ManagedHostScope,
  ManagedRunCarrier,
  ManagedTransportHost,
} from '../src/server/managed.js';

export function barrier() {
  let resolve: () => void = () => {
    throw new Error('Barrier not initialized');
  };
  const promise = new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Test Host barrier timeout')), 10000);
    timer.unref();
    resolve = () => {
      clearTimeout(timer);
      done();
    };
  });
  return { promise, resolve };
}

export async function hostFixture() {
  const storage = new AsyncLocalStorage<ManagedIdentity>();
  const baseIdentity: ManagedIdentity = {
    actor_id: 'actor',
    tenant_id: 'tenant',
    authority_revision: 'policy1',
  };
  let revision = 'policy1';
  let allowed: Set<string> | undefined;
  let handler: ((label: string, context: ManagedCallContext) => Promise<unknown>) | undefined;
  let verifyHook: ((request: RequestAuthorization) => Promise<void>) | undefined;
  let scope: ManagedHostScope = {
    selection: ['root'],
    publicationSelection: ['command', 'promptOnly'],
  };
  let desired: CapturedRelease | undefined;
  let epoch = 0;
  const plans = new Map<string, StructuralPlan>();
  const disposed: string[] = [];
  const calls: string[] = [];
  const verified: RequestAuthorization[] = [];
  const serving = new LocalServingCoordinator({
    graphID: 'graph',
    targetID: 'target',
    instanceID: 'instance',
    authority: {
      capture: () => desired,
      fence(attempt, ready, adopt) {
        if (attempt.release.release_epoch !== desired?.release_epoch) return false;
        if (ready.plan.manifest.manifestDigest !== desired.manifest_digest)
          throw new Error('Test Host rejects mismatched compilation');
        adopt();
        return true;
      },
    },
    provider: {
      prepare(attempt, signal) {
        const plan = plans.get(attempt.release.manifest_digest);
        if (plan === undefined) throw new Error('No verified test compilation');
        return prepareGeneration(
          plan,
          {
            graph_id: 'graph',
            revision: attempt.release.snapshot.revision,
            generation_uuid: attempt.generation_uuid,
          },
          Object.fromEntries(
            Object.entries(plan.bindings).map(([id, binding]) => [
              id,
              {
                binding_id: binding.registration.descriptor.binding_id,
                version: binding.registration.descriptor.version,
                abi: 'typescript-managed-call/v1',
                contract_digest: binding.registration.contract_digest,
                acquire: () => ({
                  handle: `${id}:${attempt.release.snapshot.revision}`,
                  dispose: () => {
                    disposed.push(`${id}:${attempt.release.snapshot.revision}`);
                  },
                }),
              },
            ]),
          ),
          signal,
        );
      },
    },
  });
  const runtime = new ManagedRuntime(
    serving,
    {
      current() {
        const identity = storage.getStore();
        if (identity === undefined) throw new GraphError('permission_denied', 'No trusted context');
        return { ...identity, authority_revision: revision };
      },
    },
    {
      async verify(request) {
        verified.push(request);
        await verifyHook?.(request);
        return request.requestedIDs.filter((id) => allowed === undefined || allowed.has(id));
      },
    },
  );
  const runs = new RunLeaseService(runtime);
  const host: ManagedTransportHost = {
    async enter(input, dispatch) {
      let identity = baseIdentity;
      if (input.transport !== 'stdio') {
        const token = input.request?.headers.get('authorization');
        if (token === 'Bearer test-b') identity = { ...baseIdentity, actor_id: 'other' };
        else if (token === 'Bearer test-tenant')
          identity = { ...baseIdentity, tenant_id: 'otherTenant' };
        else if (token !== 'Bearer test-a')
          throw new GraphError('permission_denied', 'TEST Host authentication required');
      }
      return storage.run(identity, () => dispatch(scope));
    },
  };
  async function swap(label: string) {
    const readerDescriptor = bindingDescriptor({
      binding_id: 'reader',
      version: '1',
      kind: 'registered',
      portability: { kind: 'portable', contract_id: 'reader-contract' },
    });
    const writerDescriptor = bindingDescriptor({
      binding_id: 'writer',
      version: '1',
      kind: 'registered',
      portability: { kind: 'portable', contract_id: 'writer-contract' },
    });
    const reader = BindingRegistration.create({
      ...readerDescriptor,
      effect: 'read_only',
      argument_free: true,
      abi: 'typescript-managed-call/v1',
      artifact_digest: `sha256:${(label === 'one' ? '1' : '2').repeat(64)}`,
      input_schema: { type: 'object', additionalProperties: false },
      validator_contract_id: 'validator',
      decoder_contract_id: 'decoder',
      default_contract_id: 'defaults',
      coercion_contract_id: 'coercion',
      decoder: () => ({}),
      validator: () => {},
      async handler(_input, context) {
        calls.push(`read:${label}`);
        return handler === undefined ? `EXACT ${label}\n` : handler(label, context);
      },
    });
    const writer = BindingRegistration.create({
      ...writerDescriptor,
      effect: 'write',
      abi: 'typescript-managed-call/v1',
      artifact_digest: `sha256:${(label === 'one' ? '3' : '4').repeat(64)}`,
      input_schema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      validator_contract_id: 'writer-validator',
      decoder_contract_id: 'writer-decoder',
      default_contract_id: 'defaults',
      coercion_contract_id: 'coercion',
      decoder: (input) => input,
      validator: () => {},
      handler(input, context) {
        calls.push(`write:${label}`);
        return { input, actor: context.identity.actor_id, resource: context.resource };
      },
    });
    const definition = GraphDefinition.fromJSON(
      {
        schema: 'contexture.graph/v1',
        semantic_version: '1',
        graph_id: 'graph',
        application_name: 'test-native-host',
        mode: 'runtime',
        nodes: [
          {
            node_id: 'root',
            kind: 'role',
            name: 'Root',
            description: `Root ${label}`,
            instruction_template: {
              parts: [
                { kind: 'Text', text: `PROGRAM ${label} ` },
                { kind: 'NodeRef', target_id: 'reader' },
              ],
            },
            members: { pre_process: 'pre', skills: ['skill'], tools: ['reader', 'writer'] },
            uses: ['reader'],
          },
          {
            node_id: 'pre',
            kind: 'role',
            role_variant: 'pre_process',
            name: 'Pre',
            description: 'Pre',
            instructions: 'PROCESS',
          },
          {
            node_id: 'skill',
            kind: 'skill',
            name: 'Skill',
            description: 'Skill',
            instructions: 'SKILL',
          },
          {
            node_id: 'reader',
            kind: 'tool',
            name: 'Read',
            description: 'Read',
            binding: readerDescriptor,
          },
          {
            node_id: 'writer',
            kind: 'tool',
            name: 'Write',
            description: 'Write',
            binding: writerDescriptor,
          },
          {
            node_id: 'command',
            kind: 'skill',
            name: 'Reserved',
            description: 'Reserved command',
            instructions: `COMMAND ${label}`,
          },
          {
            node_id: 'promptOnly',
            kind: 'skill',
            name: 'PromptOnly',
            description: 'Prompt-only command',
            instructions: `PROMPT ${label}`,
          },
        ],
        roots: [
          { node_id: 'root', plane: 'model' },
          { node_id: 'command', plane: 'model' },
          { node_id: 'promptOnly', plane: 'prompt' },
        ],
        publications: [
          {
            kind: 'prompt',
            publication_id: 'cmd',
            name: 'Exact.Command',
            description: 'Exact command',
            opens_id: 'command',
            model_may_open: false,
          },
          {
            kind: 'prompt',
            publication_id: 'prompt',
            name: 'Prompt.Only',
            description: 'Prompt only',
            opens_id: 'promptOnly',
            model_may_open: false,
          },
          {
            kind: 'resource',
            publication_id: 'doc',
            name: 'Exact.Document',
            uri: 'urn:document:test',
            mime_type: 'text/plain',
            opens_id: 'reader',
          },
          {
            kind: 'route',
            publication_id: 'get',
            method: 'GET',
            path: '/read',
            opens_id: 'reader',
          },
          {
            kind: 'route',
            publication_id: 'head',
            method: 'HEAD',
            path: '/read',
            opens_id: 'reader',
          },
          {
            kind: 'route',
            publication_id: 'post',
            method: 'POST',
            path: '/write',
            opens_id: 'writer',
          },
        ],
        presentations: { default_locale: 'en', catalogs: [] },
      },
      {
        reader: reader.resolve(readerDescriptor).publicationContract,
        writer: writer.resolve(writerDescriptor).publicationContract,
      },
    );
    const plan = StructuralPlan.compile(definition, {
      registry: new RegistryGeneration({ build: label, registrations: [reader, writer] }),
      compiler_contract_version: 'candidate-1',
      compiler_build: 'build-1',
      app_dependency_contract: { dependency_contract_id: 'app-contract', build: 'app-1' },
      environment_compatibility: ['node-24'],
      locale: 'en',
    });
    plans.set(plan.manifest.manifestDigest, plan);
    epoch++;
    desired = Object.freeze({
      graph_id: 'graph',
      target_id: 'target',
      release_epoch: String(epoch),
      journal_seq: String(epoch),
      snapshot: new RevisionState(definition, String(epoch)),
      manifest_digest: plan.manifest.manifestDigest,
    });
    const result = await serving.prepare();
    if (result.status !== 'serving') throw new Error('Test Host preparation did not adopt');
    return result.attempt.generation_uuid;
  }
  const firstGeneration = await swap('one');
  return {
    runtime,
    serving,
    runs,
    host,
    calls,
    disposed,
    verified,
    firstGeneration,
    swap,
    inContext<T>(action: () => Promise<T>) {
      return storage.run(baseIdentity, action);
    },
    adapter(carrier?: ManagedRunCarrier, maxResponseBytes?: number) {
      return new ManagedHostAdapter({
        identity: { name: 'native-host-test', version: '0.0.0' },
        runtime,
        host,
        ...(carrier === undefined ? {} : { runs: { service: runs, carrier } }),
        ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
      });
    },
    setAllowed(ids?: readonly string[]) {
      allowed = ids === undefined ? undefined : new Set(ids);
    },
    setScope(value: ManagedHostScope) {
      scope = value;
    },
    revoke() {
      revision = 'policy2';
      allowed = new Set();
    },
    setHandler(value: typeof handler) {
      handler = value;
    },
    setVerify(value: typeof verifyHook) {
      verifyHook = value;
    },
    async close() {
      await runs.shutdown();
      await serving.shutdown();
    },
  };
}
