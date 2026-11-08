import { GraphError, canonicalDigest, freezeJSON } from '../src/core/graph/canonical.js';
import { GraphDefinition } from '../src/core/graph/model.js';
import type { JSONObject } from '../src/core/graph/model.js';
import { bootstrapEvent, UnseededState } from '../src/core/graph/events.js';
import type {
  GraphAdmission,
  GraphOwnerContext,
  GraphOwnerHost,
} from '../src/server/managed-graph.js';

export function graphFixture() {
  let now = '2026-11-07T04:00:00Z',
    allowed = true,
    approval = true;
  let badProof: 'subject' | 'actor' | 'expiry' | undefined;
  let approvalRequired = true;
  let beforeDecision: ((admission: GraphAdmission) => void) | undefined;
  let beforeFence: (() => void) | undefined;
  let identity: GraphOwnerContext = {
    actor_ref: 'tenant-actor',
    identity: { actor_id: 'actor', tenant_id: 'tenant', authority_revision: '1' },
    host_permissions: ['graph.bootstrap', 'graph.roots'],
  };
  let currentCalls = 0,
    approvalCalls = 0,
    decisions = 0;
  const definition = GraphDefinition.fromJSON({
    schema: 'contexture.graph/v1',
    semantic_version: '1',
    graph_id: 'graph',
    application_name: 'native-owner',
    mode: 'disclosure_only',
    nodes: [
      {
        node_id: 'root',
        kind: 'role',
        name: 'Root',
        description: 'original',
        instructions: '',
        mutable: true,
        members: { tools: ['tool'] },
      },
      { node_id: 'tool', kind: 'tool', name: 'Tool', description: 'tool', mutable: true },
    ],
    roots: [{ node_id: 'root', plane: 'model' }],
    presentations: { default_locale: 'en', catalogs: [] },
  });
  const host: GraphOwnerHost = {
    current() {
      currentCalls++;
      return identity;
    },
    verifyApproval(context, reference, subject, at) {
      approvalCalls++;
      if (!approval || reference !== 'approved' || at !== now)
        throw new GraphError('approval_stale', 'Independent approval denied');
      return {
        ...context.identity,
        actor_id: badProof === 'actor' ? 'other' : context.identity.actor_id,
        subject_digest:
          badProof === 'subject'
            ? canonicalDigest({ wrong: true }, 'contexture.command/v1')
            : subject,
        expires_at: badProof === 'expiry' ? now : '2030-01-01T00:00:00Z',
      };
    },
    decide(admission) {
      decisions++;
      beforeDecision?.(admission);
      return {
        allowed,
        authority_revision: identity.identity.authority_revision,
        scope_ids: [
          ...new Set([...admission.impact, ...admission.reference_targets, 'root', 'tool']),
        ],
        approval_required:
          approvalRequired &&
          [
            'graph.bootstrap',
            'graph.bootstrap.preview',
            'graph.preview',
            'graph.transition',
            'release.request',
            'release.prepare',
            'release.swap',
            'release.observe',
          ].includes(admission.operation),
      };
    },
    fence(_context, action) {
      beforeFence?.();
      return action();
    },
  };
  const bootstrap = (fields: Record<string, unknown> = {}) => ({
    schema: 'contexture.bootstrap/v1',
    graph_id: 'graph',
    expected_revision: '0',
    seed: { inline: definition.asJSON() },
    approval_ref: 'approved',
    idempotency_key: 'bootstrap',
    reason: 'native approved bootstrap',
    correlation_id: 'bootstrap-correlation',
    ...fields,
  });
  const transaction = (fields: Record<string, unknown> = {}) => ({
    schema: 'contexture.transaction/v1',
    graph_id: 'graph',
    base_revision: '1',
    idempotency_key: 'edit',
    approval_ref: 'approved',
    reason: 'native edit',
    correlation_id: 'edit-correlation',
    commands: [
      {
        op: 'update_node',
        node_id: 'root',
        set_fields: { description: 'changed' },
        unset_fields: [],
      },
    ],
    ...fields,
  });
  const seedDigest = canonicalDigest(
    {
      schema: 'contexture.bootstrap/v1',
      graph_id: 'graph',
      expected_revision: '0',
      seed_digest: definition.definitionDigest,
      reason: 'native approved bootstrap',
    },
    'contexture.command/v1',
  );
  const seed = bootstrapEvent(new UnseededState('graph'), definition, {
    commandDigest: seedDigest,
    reason: 'native approved bootstrap',
    approvalRef: 'approved',
  });
  return {
    definition,
    host,
    bootstrap,
    transaction,
    seed,
    seedDigest,
    clock: () => now,
    counts: () => ({ currentCalls, approvalCalls, decisions }),
    setTime(value: string) {
      now = value;
    },
    setAllowed(value: boolean) {
      allowed = value;
    },
    setApproval(value: boolean) {
      approval = value;
    },
    setBadProof(value: typeof badProof) {
      badProof = value;
    },
    setApprovalRequired(value: boolean) {
      approvalRequired = value;
    },
    setPermissions(permissions: readonly string[]) {
      identity = { ...identity, host_permissions: permissions };
    },
    setAuthority(revision: string) {
      identity = { ...identity, identity: { ...identity.identity, authority_revision: revision } };
    },
    setActor(actor: string, tenant = 'tenant') {
      identity = {
        ...identity,
        actor_ref: `${tenant}-${actor}`,
        identity: { ...identity.identity, actor_id: actor, tenant_id: tenant },
      };
    },
    setBeforeDecision(value: typeof beforeDecision) {
      beforeDecision = value;
    },
    setBeforeFence(value: typeof beforeFence) {
      beforeFence = value;
    },
  };
}
export function signedRecords() {
  const records: JSONObject[] = [];
  return {
    records,
    append(events: readonly JSONObject[], receipt?: JSONObject): JSONObject {
      const payload = { events, ...(receipt === undefined ? {} : { command_receipt: receipt }) };
      const subject = {
        schema: 'contexture.journal-record/v1',
        store_id: 'store',
        journal_seq: String(records.length + 1),
        event_batch_id: `batch-${records.length + 1}`,
        prev_record_hash: records.at(-1)?.record_hash ?? null,
        ...payload,
        written_at: '2026-11-07T04:00:00Z',
        actor_ref: 'tenant-actor',
        correlation_id: `correlation-${records.length + 1}`,
        payload_digest: canonicalDigest(payload, 'contexture.journal-payload/v1'),
      };
      const record = freezeJSON({
        ...subject,
        record_hash: canonicalDigest(subject, 'contexture.journal-record/v1'),
      }) as JSONObject;
      records.push(record);
      return record;
    },
  };
}
