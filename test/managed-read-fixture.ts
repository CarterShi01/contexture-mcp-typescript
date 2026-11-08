/** Explicit trusted-port contract fixtures, NOT a durable owner implementation. */
import assert from 'node:assert/strict';
import {
  GraphDefinition,
  GraphError,
  GraphIndex,
  LocalServingCoordinator,
  ManagedRuntime,
  RevisionState,
  StructuralPlan,
  canonicalJSON,
  prepareGeneration,
} from '../src/managed.js';
import type {
  CapturedRelease,
  CommittedBatchReadPort,
  CommittedDefinitionBatch,
  CommittedReadCut,
  DefinitionReadPort,
  DefinitionReadRequest,
  DefinitionReadView,
  FrozenJSON,
  JSONObject,
  ManagedIdentity,
  RequestAuthorization,
} from '../src/managed.js';

export function tree(
  options: {
    label?: string;
    hidden?: string;
    description?: string;
    program?: string;
    width?: number;
    omit?: readonly string[];
    prefixHidden?: boolean;
  } = {},
): GraphDefinition {
  const width = options.width ?? 3;
  const ids = Array.from({ length: width }, (_, i) => `tool${i}`);
  const tools = ids.filter((id) => !options.omit?.includes(id));
  const nodes: JSONObject[] = [
    {
      node_id: 'owner',
      kind: 'role',
      name: options.label ?? 'Owner',
      description: 'Owner description',
      instructions: options.program ?? 'ORIGINAL PROGRAM',
      members: {
        pre_process: 'pre',
        children: options.prefixHidden ? ['interleaved', 'branch'] : ['branch'],
        post_process: 'post',
        skills: ['skill'],
        tools,
      },
      uses: [...tools, 'skill', 'hidden'],
    },
    {
      node_id: 'pre',
      kind: 'role',
      role_variant: 'pre_process',
      name: 'Before',
      description: 'Before',
      instructions: 'Before program',
    },
    {
      node_id: 'post',
      kind: 'role',
      role_variant: 'post_process',
      name: 'After',
      description: 'After',
      instructions: 'After program',
    },
    {
      node_id: 'branch',
      kind: 'role',
      name: 'Branch',
      description: 'Branch',
      instructions: 'Branch program',
    },
    {
      node_id: 'skill',
      kind: 'skill',
      name: 'Skill',
      description: 'Skill',
      instructions: 'Skill program',
    },
    {
      node_id: 'hidden',
      kind: 'role',
      name: options.hidden ?? 'SECRET',
      description: 'SECRET description',
      instructions: 'SECRET PROGRAM',
    },
    ...tools.map((id) => ({
      node_id: id,
      kind: 'tool',
      name: id,
      description:
        id === 'tool1' ? (options.description ?? 'Tool description') : 'Tool description',
    })),
    ...(options.prefixHidden
      ? [
          {
            node_id: 'interleaved',
            kind: 'role',
            name: 'PRIVATE prefix',
            description: 'PRIVATE prefix',
            instructions: 'PRIVATE program',
          },
        ]
      : []),
  ];
  return GraphDefinition.fromJSON({
    schema: 'contexture.graph/v1',
    semantic_version: '1',
    graph_id: 'graph',
    application_name: 'SECRET application',
    mode: 'disclosure_only',
    nodes,
    roots: [
      { node_id: 'owner', plane: 'model' },
      { node_id: 'hidden', plane: 'prompt' },
    ],
    presentations: {
      default_locale: 'en',
      catalogs: [
        {
          locale: 'en',
          entries: [{ node_id: 'owner', title: 'Localized', description: 'Localized description' }],
        },
      ],
    },
  });
}
export const initialIdentity: ManagedIdentity = Object.freeze({
  actor_id: 'actor',
  tenant_id: 'tenant',
  authority_revision: 'auth-1',
});
export class Clock {
  now = 0;
  read = (): number => this.now;
}
export function text(value: FrozenJSON | undefined): string {
  assert.equal(typeof value, 'string');
  return value as string;
}
export function object(value: FrozenJSON | undefined): JSONObject {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as JSONObject;
}
export function array(value: FrozenJSON | undefined): readonly FrozenJSON[] {
  assert.ok(Array.isArray(value));
  return value;
}
export function objects(value: FrozenJSON | undefined): readonly JSONObject[] {
  return array(value).map(object);
}
export function failure(code: string): (error: unknown) => boolean {
  return (error) => error instanceof GraphError && error.code === code;
}

export class DefinitionFixture implements DefinitionReadPort {
  context = initialIdentity;
  origin = 'store:incarnation:1';
  scope: readonly string[];
  current: GraphIndex;
  revision = '1';
  readonly history = new Map<string, GraphIndex>();
  denied = false;
  calls = 0;
  error: Error | undefined;
  constructor(graph = tree()) {
    this.current = GraphIndex.build(graph);
    this.scope = this.current.preorder.filter((id) => id !== 'hidden');
    this.history.set('1', this.current);
  }
  advance(graph: GraphDefinition): void {
    this.current = GraphIndex.build(graph);
    this.revision = String(Number(this.revision) + 1);
    this.history.set(this.revision, this.current);
  }
  async read<T>(
    request: DefinitionReadRequest,
    dispatch: (view: DefinitionReadView) => T,
  ): Promise<T> {
    this.calls++;
    if (this.error !== undefined) throw this.error;
    if (this.denied) throw new GraphError('permission_denied', 'Denied');
    const revision = request.source === 'revision' ? request.revision! : this.revision;
    const index = this.history.get(revision);
    if (index === undefined) throw new GraphError('history_unavailable', 'Pruned');
    return dispatch({
      identity: this.context,
      store_origin: this.origin,
      current_index: this.current,
      index,
      revision,
      scope_ids: this.scope,
    });
  }
}

export async function servingFixture(graph = tree()) {
  let context = initialIdentity;
  let origin = 'store:incarnation:1';
  let desired: CapturedRelease | undefined;
  let plan: StructuralPlan;
  let scope: readonly string[] = Object.keys(graph.nodes).filter((id) => id !== 'hidden');
  const calls: RequestAuthorization[] = [];
  let blocker: (() => Promise<void>) | undefined;
  const serving = new LocalServingCoordinator({
    graphID: 'graph',
    targetID: 'target',
    instanceID: 'instance',
    authority: {
      capture: () => desired,
      fence(attempt, ready, adopt) {
        if (attempt.release !== desired && attempt.release.release_epoch !== desired?.release_epoch)
          return false;
        assert.equal(ready.plan.definitionDigest, desired?.snapshot.definitionDigest);
        adopt();
        return true;
      },
    },
    provider: {
      prepare: (attempt) =>
        prepareGeneration(
          plan,
          {
            graph_id: 'graph',
            revision: attempt.release.snapshot.revision,
            generation_uuid: attempt.generation_uuid,
          },
          {},
        ),
    },
  });
  const runtime = new ManagedRuntime(
    serving,
    { current: () => context },
    {
      async verify(request) {
        calls.push(request);
        await blocker?.();
        return request.requestedIDs.filter((id) => scope.includes(id));
      },
    },
  );
  async function swap(definition: GraphDefinition) {
    plan = StructuralPlan.compile(definition, {
      compiler_contract_version: 'candidate-1',
      compiler_build: 'build-1',
      no_execution_registry_digest: 'sha256:' + '1'.repeat(64),
      app_dependency_contract: { dependency_contract_id: 'app-contract', build: 'app-1' },
      environment_compatibility: ['node-24'],
      locale: 'en',
    });
    const epoch = String(Number(desired?.release_epoch ?? '0') + 1);
    desired = {
      graph_id: 'graph',
      target_id: 'target',
      release_epoch: epoch,
      journal_seq: epoch,
      snapshot: new RevisionState(definition, epoch),
      manifest_digest: plan.manifest.manifestDigest,
    };
    assert.equal((await serving.prepare()).status, 'serving');
  }
  await swap(graph);
  return {
    runtime,
    serving,
    calls,
    port: { runtime, storeOrigin: () => origin },
    swap,
    context(value: ManagedIdentity) {
      context = value;
    },
    origin(value: string) {
      origin = value;
    },
    scope(value: readonly string[]) {
      scope = value;
    },
    block(value?: () => Promise<void>) {
      blocker = value;
    },
  };
}

export class CommittedFixture implements CommittedBatchReadPort {
  context = initialIdentity;
  origin = 'store:incarnation:1';
  scope: readonly string[] = ['owner'];
  retained = '1';
  watermark = '1';
  denied = false;
  error: Error | undefined;
  corrupt = false;
  calls = 0;
  lastBounds: unknown;
  readonly records: CommittedDefinitionBatch[] = [
    { position: '1', state: new RevisionState(tree(), '1') },
  ];
  /** Deliberately separate uncommitted authoring state; watch MUST NOT read it. */
  uncommitted = tree({ label: 'UNCOMMITTED' });
  append(graph: GraphDefinition): void {
    this.watermark = String(Number(this.watermark) + 1);
    this.records.push({
      position: this.watermark,
      state: new RevisionState(graph, this.watermark),
    });
  }
  read<T>(graphID: string, dispatch: (cut: CommittedReadCut) => T): T {
    assert.equal(graphID, 'graph');
    this.calls++;
    if (this.error !== undefined) throw this.error;
    if (this.denied) throw new GraphError('permission_denied', 'Denied');
    const records = [...this.records];
    return dispatch({
      identity: this.context,
      store_origin: this.origin,
      scope_ids: this.scope,
      snapshot: records.at(-1)!.state,
      watermark: this.watermark,
      retained_after: this.retained,
      readBatches: (after, bounds) => {
        this.lastBounds = bounds;
        if (BigInt(after) < BigInt(this.retained))
          throw new GraphError('history_unavailable', 'Pruned');
        const batches = records.filter((r) => BigInt(r.position) > BigInt(after));
        const size = batches.reduce(
          (n, batch) => n + canonicalJSON(batch.state.definition.asJSON()).length,
          0,
        );
        return {
          before: records.filter((r) => BigInt(r.position) <= BigInt(after)).at(-1)!.state,
          batches: this.corrupt ? [...batches, ...batches] : batches,
          through: this.watermark,
          overflow: batches.length > bounds.max_batches || size > bounds.max_bytes,
        };
      },
    });
  }
}
