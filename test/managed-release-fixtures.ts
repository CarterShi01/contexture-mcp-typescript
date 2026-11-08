import assert from 'node:assert/strict';
import {
  BindingRegistration,
  GraphDefinition,
  GraphError,
  RegistryGeneration,
  StructuralPlan,
  bindingDescriptor,
  canonicalDigest,
  prepareGeneration,
} from '../src/managed.js';
import {
  applyEvent,
  bootstrapEvent,
  RevisionState,
  UnseededState,
} from '../src/core/graph/events.js';
import type { JSONObject } from '../src/managed.js';
import type {
  JournalHistoryView,
  ReleaseCompilePort,
  ReleaseGraphProjector,
  ReleaseHistoryReader,
  ReleaseHostContext,
  ReleaseHostPort,
  ReleaseHostAdmission,
} from '../src/server/managed-releases.js';
import type { ServingPreparationProvider } from '../src/application/managed-serving.js';

export const seedDigest = canonicalDigest({ seed: true }, 'contexture.command/v1');
export function barrier<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Barrier not initialized');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function nativeReleaseFixture() {
  let handlers = 0,
    decoders = 0,
    nativeValidators = 0,
    disposals = 0,
    proofCalls = 0;
  let permit = true,
    approval = true;
  let beforeFence: ((admission: ReleaseHostAdmission) => void) | undefined;
  let current: ReleaseHostContext = {
    actor_ref: 'actor',
    identity: { actor_id: 'actor', tenant_id: 'tenant', authority_revision: 'policy-1' },
  };
  const descriptor = bindingDescriptor({
    kind: 'registered',
    binding_id: 'reader',
    version: '1',
    portability: { kind: 'portable', contract_id: 'reader-contract' },
  });
  const registration = BindingRegistration.create({
    ...descriptor,
    effect: 'read_only',
    abi: 'typescript-managed-call/v1',
    artifact_digest: `sha256:${'a'.repeat(64)}`,
    input_schema: { type: 'object', additionalProperties: false },
    validator_contract_id: 'validator',
    decoder_contract_id: 'decoder',
    default_contract_id: 'defaults',
    coercion_contract_id: 'coercion',
    decoder: () => {
      decoders++;
      return {};
    },
    validator: () => {
      nativeValidators++;
    },
    handler: (_input, context) => {
      handlers++;
      return { resource: context.resource };
    },
  });
  const registry = new RegistryGeneration({ build: 'registry', registrations: [registration] });
  const definition = GraphDefinition.fromJSON({
    schema: 'contexture.graph/v1',
    semantic_version: '1',
    graph_id: 'graph',
    application_name: 'native-release',
    mode: 'runtime',
    nodes: [
      {
        node_id: 'root',
        kind: 'role',
        name: 'Root',
        description: 'root',
        instructions: '',
        mutable: true,
        members: { tools: ['tool'] },
      },
      { node_id: 'tool', kind: 'tool', name: 'Tool', description: 'tool', binding: descriptor },
    ],
    roots: [{ node_id: 'root', plane: 'model' }],
    presentations: { default_locale: 'en', catalogs: [] },
  });
  const compile = (def: GraphDefinition) =>
    StructuralPlan.compile(def, {
      registry,
      compiler_contract_version: 'candidate-1',
      compiler_build: 'build-1',
      app_dependency_contract: { dependency_contract_id: 'app-contract', build: 'app-build' },
      environment_compatibility: ['node-24'],
      locale: 'en',
    });
  const plan = compile(definition);
  const seed = bootstrapEvent(new UnseededState('graph'), definition, {
    commandDigest: seedDigest,
    reason: 'native test seed',
    approvalRef: 'approved',
  });
  function histories(records: readonly JSONObject[]) {
    let current: UnseededState | RevisionState = new UnseededState('graph');
    const found: { snapshot: RevisionState; journalSeq: string; recordHash: string }[] = [];
    for (const record of records)
      for (const event of record.events as readonly JSONObject[]) {
        if (event.type !== 'GraphChangeCommitted') continue;
        current = applyEvent(current, event, { tombstones: [] });
        assert(current instanceof RevisionState);
        found.push({
          snapshot: current,
          journalSeq: record.journal_seq as string,
          recordHash: record.record_hash as string,
        });
      }
    return found;
  }
  const history: ReleaseHistoryReader = {
    read(graphID, revision, view) {
      const found = histories(view.records).find((item) => item.snapshot.revision === revision);
      if (graphID !== 'graph' || found === undefined)
        throw new GraphError('reference_not_found', 'Historical revision absent');
      return Object.freeze({ ...found, storeID: view.storeID });
    },
  };
  const graphs: ReleaseGraphProjector = (records) => {
    const head = histories(records).at(-1)?.snapshot;
    return {
      graphs:
        head === undefined
          ? []
          : [
              {
                definition: head.definition.asJSON(),
                head: head.revision,
                definition_digest: head.definitionDigest,
                tombstones: head.tombstones,
              },
            ],
      projection_versions: {},
      blob_refs: [],
    };
  };
  const compilation: ReleaseCompilePort = {
    verify(_request, history) {
      proofCalls++;
      return compile(history.snapshot.definition);
    },
  };
  const host: ReleaseHostPort = {
    current: () => current,
    verifyApproval(admission) {
      if (
        admission.compilation.kind !== 'receipt_read' &&
        (!approval || admission.request.approvalRef !== 'approved')
      )
        throw new GraphError('permission_denied', 'Approval unavailable');
      return { digest: admission.requestDigest, context: current };
    },
    admit() {
      if (!permit) throw new GraphError('permission_denied', 'Current policy denies operation');
    },
    fence(admission, proof, action) {
      beforeFence?.(admission);
      if (!permit || (admission.compilation.kind !== 'receipt_read' && !approval))
        throw new GraphError('permission_denied', 'Policy or approval changed');
      assert.deepEqual(proof, { digest: admission.requestDigest, context: current });
      return action();
    },
  };
  const provider: ServingPreparationProvider = {
    async prepare(attempt, signal) {
      const pinned = compile(attempt.release.snapshot.definition);
      return prepareGeneration(
        pinned,
        {
          graph_id: 'graph',
          revision: attempt.release.snapshot.revision,
          generation_uuid: attempt.generation_uuid,
        },
        {
          tool: {
            binding_id: 'reader',
            version: '1',
            abi: 'typescript-managed-call/v1',
            contract_digest: registration.contract_digest,
            acquire: () => ({
              handle: attempt.generation_uuid,
              dispose() {
                disposals++;
              },
            }),
          },
        },
        signal,
      );
    },
  };
  function request(fields: Record<string, unknown> = {}) {
    return {
      schema: 'contexture.release-request/v1',
      graph_id: 'graph',
      target_id: 'target',
      revision: '1',
      definition_digest: definition.definitionDigest,
      manifest_digest: plan.manifest.manifestDigest,
      expected_desired_epoch: '0',
      idempotency_key: 'release-key',
      policy: 'exact',
      reason: 'native release',
      approval_ref: 'approved',
      ...fields,
    };
  }
  return {
    definition,
    plan,
    seed,
    host,
    history,
    compilation,
    graphs,
    provider,
    request,
    counts: () => ({ handlers, decoders, nativeValidators, disposals, proofCalls }),
    setActor(actor: string) {
      current = {
        ...current,
        actor_ref: actor,
        identity: { ...current.identity, actor_id: actor },
      };
    },
    setPermit(value: boolean) {
      permit = value;
    },
    setApproval(value: boolean) {
      approval = value;
    },
    setBeforeFence(value: typeof beforeFence) {
      beforeFence = value;
    },
    view(records: readonly JSONObject[]): JournalHistoryView {
      return { storeID: 'store', watermark: String(records.length), records };
    },
  };
}
