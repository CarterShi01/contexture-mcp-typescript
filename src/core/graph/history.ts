/** Immutable retained projection, never journal storage, admission or a serving lease. */
import { List } from 'immutable';

import { freezeJSON, parseCounter, validateID } from './canonical.js';
import type { GraphDefinition, JSONObject, PublicationContracts } from './model.js';
import { GraphDefinition as Definition, placements } from './model.js';
import { definitionDiff } from './diff.js';
import type { DefinitionDiff } from './diff.js';
import {
  applyEvent,
  equalJSON,
  eventError,
  resolveFacts,
  RevisionState,
  scalarOrder,
  UnseededState,
} from './events.js';
import type { AcceptedState, ApplyEventOptions, ResolvedChange } from './events.js';

const verifiedRecords = new WeakSet<RevisionRecord>();
interface HistoryData {
  readonly entries: List<RevisionRecord>;
  cached?: readonly RevisionRecord[];
}
const verifiedHistories = new WeakMap<History, HistoryData>();

function historyData(history: History): HistoryData {
  const data = verifiedHistories.get(history);
  if (!data) return eventError('History requires a verified immutable prefix', 'schema_invalid');
  return data;
}

function installHistory(
  history: History,
  entries: List<RevisionRecord>,
  cached?: readonly RevisionRecord[],
): void {
  const data: HistoryData = { entries };
  if (cached !== undefined) data.cached = cached;
  verifiedHistories.set(history, data);
  Object.defineProperty(history, 'records', {
    enumerable: true,
    get: () => {
      if (data.cached === undefined) data.cached = Object.freeze(data.entries.toArray());
      return data.cached;
    },
  });
  Object.freeze(history);
}

export class RevisionRecord {
  readonly state: RevisionState;
  readonly event: JSONObject | null;
  constructor(
    readonly journalSeq: string,
    state: AcceptedState,
    event: unknown = null,
  ) {
    if (parseCounter(journalSeq) === 0n)
      eventError('Historical sequence must be positive', 'schema_invalid');
    this.state = new RevisionState(state.definition, state.revision, state.tombstones);
    if (this.state.definitionDigest !== state.definitionDigest)
      eventError('Historical state digest mismatch');
    const frozen = event === null ? null : freezeJSON(event);
    if (frozen !== null && (typeof frozen !== 'object' || Array.isArray(frozen)))
      eventError('Expected event object', 'schema_invalid');
    this.event = frozen as JSONObject | null;
    Object.freeze(this);
    verifiedRecords.add(this);
  }
}
export class History {
  readonly records!: readonly RevisionRecord[];
  constructor(records: readonly RevisionRecord[]) {
    if (
      !records.length ||
      records.some((r) => !(r instanceof RevisionRecord) || !verifiedRecords.has(r))
    )
      eventError('History requires accepted seed', 'schema_invalid');
    const normalized = Object.freeze([...records]);
    for (let i = 1; i < normalized.length; i++) {
      const before = normalized[i - 1]!,
        after = normalized[i]!;
      if (
        parseCounter(after.journalSeq) <= parseCounter(before.journalSeq) ||
        after.state.definition.graph_id !== before.state.definition.graph_id ||
        after.event === null
      )
        eventError('Historical sequence/graph/event mismatch');
    }
    installHistory(this, List(normalized), normalized);
  }
  static seed(state: AcceptedState, options: { journalSeq: string }): History {
    return new History([new RevisionRecord(options.journalSeq, state)]);
  }
  static bootstrap(
    base: UnseededState,
    event: unknown,
    options: { journalSeq: string; publicationContracts?: PublicationContracts },
  ): History {
    const state = applyEvent(base, event, {
      tombstones: [],
      ...(options.publicationContracts === undefined
        ? {}
        : { publicationContracts: options.publicationContracts }),
    });
    return new History([new RevisionRecord(options.journalSeq, state, event)]);
  }
  get head(): RevisionState {
    return historyData(this).entries.last()!.state;
  }
  get retainedLowerBound(): string {
    return historyData(this).entries.first()!.state.revision;
  }
  append(event: unknown, options: ApplyEventOptions & { journalSeq: string }): History {
    const entries = historyData(this).entries;
    if (parseCounter(options.journalSeq) <= parseCounter(entries.last()!.journalSeq))
      eventError('Historical sequence must increase');
    const state = applyEvent(this.head, event, options);
    const record = new RevisionRecord(options.journalSeq, state, event);
    if (state.definition.graph_id !== this.head.definition.graph_id)
      eventError('Historical graph mismatch');
    // Constructor validation remains complete for arbitrary public input.
    const next = Object.create(History.prototype) as History;
    installHistory(next, entries.push(record));
    return next;
  }
  at(revision: string): RevisionState {
    parseCounter(revision);
    for (const record of historyData(this).entries.toSeq().reverse())
      if (record.state.revision === revision) return record.state;
    return eventError('Revision outside retained verified history', 'history_unavailable');
  }
  diff(before: string, after: string): DefinitionDiff {
    return definitionDiff(this.at(before).definition, this.at(after).definition);
  }
  private matching(projection: (state: RevisionState) => unknown): readonly RevisionRecord[] {
    return Object.freeze(
      this.records
        .slice(1)
        .filter(
          (record, i) => !equalJSON(projection(this.records[i]!.state), projection(record.state)),
        ),
    );
  }
  forNode(nodeID: string): readonly RevisionRecord[] {
    validateID(nodeID);
    return this.matching((s) => nodeProjection(s.definition, nodeID));
  }
  forPublication(publicationID: string): readonly RevisionRecord[] {
    validateID(publicationID);
    return this.matching((s) =>
      s.definition.publications.flatMap((p, i) =>
        p.publication_id === publicationID ? [[i, p]] : [],
      ),
    );
  }
}
function nodeProjection(definition: GraphDefinition, id: string): unknown {
  const locations: unknown[] = definition.roots.flatMap((r, i) =>
    r.node_id === id ? [[null, i, r.plane]] : [],
  );
  for (const parent of Object.values(definition.nodes))
    if (parent.kind === 'role')
      for (const [slot, i, child] of placements(parent.members))
        if (child === id) locations.push([parent.node_id, slot, i]);
  return [
    definition.nodes[id] ?? null,
    locations,
    definition.publications.flatMap((p, i) => (p.opens_id === id ? [[i, p]] : [])),
    definition.presentations.catalogs.flatMap((c, ci) =>
      c.entries.flatMap((e, ei) => (e.node_id === id ? [[ci, c.locale, ei, e]] : [])),
    ),
    definition.presentations.default_locale,
  ];
}
export interface RevertCandidate {
  readonly baseRevision: string;
  readonly targetRevision: string;
  readonly change: ResolvedChange;
}
export function revertCandidate(
  base: AcceptedState,
  target: AcceptedState,
  options: { nodeIDs?: readonly string[]; publicationContracts?: PublicationContracts } = {},
): RevertCandidate {
  if (base.definition.graph_id !== target.definition.graph_id)
    eventError('Revert target belongs to another graph', 'schema_invalid');
  if (parseCounter(target.revision) > parseCounter(base.revision))
    eventError('Revert requires retained past revision', 'history_unavailable');
  const wire = (
    options.nodeIDs === undefined ? target.definition : base.definition
  ).asJSON() as Record<string, unknown>;
  if (options.nodeIDs !== undefined) {
    if (new Set(options.nodeIDs).size !== options.nodeIDs.length)
      eventError('Duplicate revert scope', 'schema_invalid');
    const nodes = new Map(Object.entries(base.definition.nodes));
    for (const id of options.nodeIDs) {
      validateID(id);
      const historical = target.definition.nodes[id];
      if (historical) nodes.set(id, historical);
      else if (nodes.has(id)) nodes.delete(id);
      else eventError('Revert identity absent in both revisions', 'reference_not_found');
    }
    wire.nodes = [...nodes.keys()].sort(scalarOrder).map((id) => nodes.get(id)!);
  }
  const definition = Definition.fromJSON(wire, options.publicationContracts);
  const retained = new Set(base.tombstones.map((t) => t.node_id));
  if (
    Object.keys(definition.nodes).some(
      (id) => !Object.hasOwn(base.definition.nodes, id) && !retained.has(id),
    )
  )
    eventError('Historical restoration requires retained tombstones', 'history_unavailable');
  return Object.freeze({
    baseRevision: base.revision,
    targetRevision: target.revision,
    change: resolveFacts(base, definition),
  });
}
