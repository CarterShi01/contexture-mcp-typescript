/** Pure snapshot-local managed candidate indexes; no resolver or execution I/O. */
import { canonicalDigest } from './canonical.js';
import {
  GraphDefinition,
  PublicationContract,
  modelError,
  normalizeLocale,
  placements,
} from './model.js';
import type {
  NodeSpec,
  Plane,
  Presentation,
  PublicationContracts,
  Slot,
  Placement,
} from './model.js';

export interface NodeLocation {
  readonly parent_id: string | null;
  readonly slot: Slot | null;
  readonly ordinal: number;
  readonly member_ordinal: number;
  readonly root_ordinal: number;
  readonly plane: Plane;
  readonly depth: number;
  readonly preorder: number;
  readonly subtree_end: number;
  readonly effective_mutable: boolean;
  readonly false_barrier: boolean;
}
export interface TemplateReference {
  readonly source_id: string;
  readonly part_ordinal: number;
}
type Table<T> = Readonly<Record<string, T>>;
function table<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
function frozenLists<T>(value: Record<string, T[]>): Table<readonly T[]> {
  for (const list of Object.values(value)) Object.freeze(list);
  return Object.freeze(value);
}
interface IndexFields {
  readonly definition: GraphDefinition;
  readonly locations: Table<NodeLocation>;
  readonly preorder: readonly string[];
  readonly reverseUses: Table<readonly string[]>;
  readonly templateRefs: Table<readonly TemplateReference[]>;
  readonly publications: Table<readonly string[]>;
  readonly presentationRefs: Table<readonly string[]>;
  readonly childNames: Table<Table<string>>;
  readonly rootNames: Table<string>;
  readonly catalogs: Table<Table<Presentation>>;
  readonly reserved: Table<true>;
}
const indexToken = Symbol('validated managed index');

/** O(nodes + edges + parts + publications + presentations), no full-path cache. */
export class GraphIndex {
  readonly definition: GraphDefinition;
  readonly locations: Table<NodeLocation>;
  readonly preorder: readonly string[];
  readonly reverseUses: Table<readonly string[]>;
  readonly templateRefs: Table<readonly TemplateReference[]>;
  readonly publications: Table<readonly string[]>;
  readonly presentationRefs: Table<readonly string[]>;
  readonly childNames: Table<Table<string>>;
  readonly rootNames: Table<string>;
  readonly #catalogs: Table<Table<Presentation>>;
  readonly #reserved: Table<true>;

  private constructor(token: symbol, fields: IndexFields) {
    if (token !== indexToken) modelError('Use GraphIndex.build');
    this.definition = fields.definition;
    this.locations = fields.locations;
    this.preorder = fields.preorder;
    this.reverseUses = fields.reverseUses;
    this.templateRefs = fields.templateRefs;
    this.publications = fields.publications;
    this.presentationRefs = fields.presentationRefs;
    this.childNames = fields.childNames;
    this.rootNames = fields.rootNames;
    this.#catalogs = fields.catalogs;
    this.#reserved = fields.reserved;
    Object.freeze(this);
  }

  static build(definition: GraphDefinition, contracts?: PublicationContracts): GraphIndex {
    if (!GraphDefinition.isValidated(definition)) modelError('Expected validated GraphDefinition');
    const nodes = definition.nodes;
    if (!Object.keys(nodes).length || !definition.roots.some((root) => root.plane === 'model'))
      modelError('Committed forest requires at least one model root', '/roots');
    type Parent = Readonly<{
      parent_id: string | null;
      slot: Slot | null;
      ordinal: number;
      member_ordinal: number;
    }>;
    const parents = table<Parent>();
    const children = table<readonly Placement[]>();
    const names = table<Record<string, string>>();
    const rootNames = table<string>();
    const reverse = table<string[]>();
    const templates = table<TemplateReference[]>();
    const pubs = table<string[]>();
    const presentationRefs = table<string[]>();
    function target(id: string): NodeSpec {
      const found = nodes[id];
      if (!found) modelError('Reference target does not exist', '', 'reference_not_found');
      return found;
    }
    function place(
      id: string,
      parent: string | null,
      slot: Slot | null,
      ordinal: number,
      memberOrdinal: number,
    ): void {
      const node = target(id);
      if (Object.hasOwn(parents, id)) modelError('Duplicate containment, alias or multiple parent');
      const siblings = parent === null ? rootNames : names[parent]!;
      if (Object.hasOwn(siblings, node.name))
        modelError('Names must be unique across sibling slots or roots');
      parents[id] = { parent_id: parent, slot, ordinal, member_ordinal: memberOrdinal };
      siblings[node.name] = id;
    }
    definition.roots.forEach((root, i) => place(root.node_id, null, null, i, i));
    for (const node of Object.values(nodes)) {
      reverse[node.node_id] = [];
      templates[node.node_id] = [];
      pubs[node.node_id] = [];
      presentationRefs[node.node_id] = [];
      if (node.kind === 'tool') {
        if (definition.mode === 'runtime' && !node.binding)
          modelError('Runtime Tool requires binding');
        if (
          definition.mode === 'disclosure_only' &&
          (node.binding || Object.hasOwn(node, 'input_contract'))
        )
          modelError('Disclosure-only Tools cannot carry execution contracts');
      }
      if (node.kind === 'role') {
        names[node.node_id] = table<string>();
        const entries = placements(node.members);
        children[node.node_id] = entries;
        entries.forEach(([slot, ordinal, id], memberOrdinal) => {
          const child = target(id);
          const kind = slot === 'skills' ? 'skill' : slot === 'tools' ? 'tool' : 'role';
          if (child.kind !== kind) modelError('Member kind does not match typed slot');
          if (
            (slot === 'pre_process' || slot === 'post_process') &&
            (child.kind !== 'role' || child.role_variant !== slot)
          )
            modelError('Process slot requires matching Role variant');
          place(id, node.node_id, slot, ordinal, memberOrdinal);
        });
      }
      for (const used of node.uses) {
        target(used);
        if (used === node.node_id) modelError('Self uses is forbidden');
      }
      if (node.kind !== 'tool' && node.instruction_template) {
        for (const part of node.instruction_template.parts)
          if (part.kind === 'NodeRef') target(part.target_id);
      }
    }
    if (Object.keys(parents).length !== Object.keys(nodes).length)
      modelError('Every node must have exactly one root or parent placement');

    const order: string[] = [];
    const locations = table<NodeLocation>();
    const entered = new Set<string>();
    type Frame = {
      id: string;
      plane: Plane;
      root: number;
      depth: number;
      inherited: boolean;
      blocked: boolean;
      exit: boolean;
    };
    const stack: Frame[] = [];
    for (let i = definition.roots.length - 1; i >= 0; i--) {
      const root = definition.roots[i]!;
      stack.push({
        id: root.node_id,
        plane: root.plane,
        root: i,
        depth: 0,
        inherited: false,
        blocked: false,
        exit: false,
      });
    }
    while (stack.length) {
      const frame = stack.pop()!;
      const { id, plane, root, depth } = frame;
      if (frame.exit) {
        locations[id] = Object.freeze({ ...locations[id]!, subtree_end: order.length });
        continue;
      }
      if (entered.has(id)) modelError('Containment cycle or alias');
      entered.add(id);
      const node = nodes[id]!;
      const barrier = frame.blocked || node.mutable === false;
      const effective = !barrier && (node.mutable === true || frame.inherited);
      locations[id] = {
        ...parents[id]!,
        root_ordinal: root,
        plane,
        depth,
        preorder: order.length,
        subtree_end: -1,
        effective_mutable: effective,
        false_barrier: barrier,
      };
      order.push(id);
      stack.push({ ...frame, exit: true });
      const entries = children[id] ?? [];
      for (let i = entries.length - 1; i >= 0; i--) {
        stack.push({
          id: entries[i]![2],
          plane,
          root,
          depth: depth + 1,
          inherited: effective,
          blocked: barrier,
          exit: false,
        });
      }
    }
    if (entered.size !== Object.keys(nodes).length)
      modelError('Unreachable containment component or cycle');
    for (const id of order) {
      const node = nodes[id]!;
      for (const used of node.uses) reverse[used]!.push(id);
      if (node.kind !== 'tool' && node.instruction_template) {
        node.instruction_template.parts.forEach((part, ordinal) => {
          if (part.kind === 'NodeRef')
            templates[part.target_id]!.push(
              Object.freeze({ source_id: id, part_ordinal: ordinal }),
            );
        });
      }
    }

    const publicationIDs = new Set<string>();
    const publicNames = new Set<string>();
    const uris = new Set<string>();
    const routes = new Set<string>();
    const reserved = table<true>();
    for (const [ordinal, publication] of definition.publications.entries()) {
      const location = `/publications/${ordinal}`;
      const node = target(publication.opens_id);
      if (publicationIDs.has(publication.publication_id))
        modelError('Duplicate publication identity', location);
      publicationIDs.add(publication.publication_id);
      pubs[node.node_id]!.push(publication.publication_id);
      if (publication.kind !== 'route') {
        if (publicNames.has(publication.name)) modelError('Duplicate public name', location);
        publicNames.add(publication.name);
      }
      if (publication.kind === 'prompt') {
        if (!publication.model_may_open) reserved[node.node_id] = true;
        continue;
      }
      if (definition.mode !== 'runtime' || node.kind !== 'tool' || !node.binding)
        modelError('Executable publication requires a runtime Tool', location);
      const evidence =
        contracts && Object.hasOwn(contracts, node.node_id) ? contracts[node.node_id] : undefined;
      if (
        !PublicationContract.isValidated(evidence) ||
        canonicalDigest(evidence.binding, 'contexture.graph/v1') !==
          canonicalDigest(node.binding, 'contexture.graph/v1')
      )
        modelError(
          'Pinned registry contract required for exact binding descriptor',
          location,
          'binding_contract_required',
        );
      if (publication.kind === 'resource') {
        if (evidence.effect !== 'read_only' || !evidence.argument_free)
          modelError('Resource requires an argument-free read-only Tool', location);
        if (uris.has(publication.uri)) modelError('Duplicate Resource URI', location);
        uris.add(publication.uri);
      } else {
        const effect =
          publication.method === 'GET' || publication.method === 'HEAD' ? 'read_only' : 'write';
        if (effect !== evidence.effect)
          modelError('Route method and registry effect mismatch', location);
        const key = `${publication.method}\0${publication.path}`;
        if (routes.has(key)) modelError('Duplicate Route method/path', location);
        routes.add(key);
      }
    }
    const catalogs = table<Table<Presentation>>();
    for (const catalog of definition.presentations.catalogs) {
      const entries = table<Presentation>();
      for (const entry of catalog.entries) {
        target(entry.node_id);
        entries[entry.node_id] = entry;
        presentationRefs[entry.node_id]!.push(catalog.locale);
      }
      catalogs[catalog.locale.toLowerCase()] = Object.freeze(entries);
    }
    for (const siblings of Object.values(names)) Object.freeze(siblings);
    return new GraphIndex(indexToken, {
      definition,
      locations: Object.freeze(locations),
      preorder: Object.freeze(order),
      reverseUses: frozenLists(reverse),
      templateRefs: frozenLists(templates),
      publications: frozenLists(pubs),
      presentationRefs: frozenLists(presentationRefs),
      childNames: Object.freeze(names),
      rootNames: Object.freeze(rootNames),
      catalogs: Object.freeze(catalogs),
      reserved: Object.freeze(reserved),
    });
  }

  get(identity: string, by: 'id' | 'path' = 'id'): NodeSpec {
    if (by === 'path') {
      if (typeof identity !== 'string' || !identity.startsWith('/'))
        modelError('Expected absolute author path');
      let siblings = this.rootNames;
      let found: string | undefined;
      for (const segment of identity.slice(1).split('/')) {
        found = siblings[segment];
        if (found === undefined) modelError('Author path not found', '', 'reference_not_found');
        siblings = this.childNames[found] ?? Object.freeze(table<string>());
      }
      return this.definition.nodes[found!]!;
    }
    if (by !== 'id') modelError('Lookup selector must be id or path');
    if (typeof identity !== 'string') modelError('Expected node identity');
    const node = this.definition.nodes[identity];
    if (!node) modelError('Node identity not found', '', 'reference_not_found');
    return node;
  }

  path(nodeID: string): string {
    this.get(nodeID);
    const segments: string[] = [];
    let current: string | null = nodeID;
    while (current !== null) {
      segments.push(this.definition.nodes[current]!.name);
      current = this.locations[current]!.parent_id;
    }
    return `/${segments.reverse().join('/')}`;
  }

  *walk(plane?: Plane): IterableIterator<NodeSpec> {
    if (plane !== undefined && plane !== 'model' && plane !== 'prompt') modelError('Invalid plane');
    for (const id of this.preorder)
      if (plane === undefined || this.locations[id]!.plane === plane)
        yield this.definition.nodes[id]!;
  }

  *subtree(nodeID: string, includeSelf = true): IterableIterator<NodeSpec> {
    this.get(nodeID);
    if (typeof includeSelf !== 'boolean') modelError('Expected includeSelf boolean');
    const loc = this.locations[nodeID]!;
    for (let i = loc.preorder + (includeSelf ? 0 : 1); i < loc.subtree_end; i++)
      yield this.definition.nodes[this.preorder[i]!]!;
  }

  modelMayOpen(nodeID: string): boolean {
    this.get(nodeID);
    return this.locations[nodeID]!.plane === 'model' && !Object.hasOwn(this.#reserved, nodeID);
  }

  presentation(nodeID: string, locale: string): Presentation | undefined {
    this.get(nodeID);
    let candidate = normalizeLocale(locale).toLowerCase();
    while (candidate) {
      const entry = this.#catalogs[candidate]?.[nodeID];
      if (entry) return entry;
      candidate = candidate.slice(0, Math.max(0, candidate.lastIndexOf('-')));
      if (candidate.split('-').at(-1)?.length === 1)
        candidate = candidate.slice(0, Math.max(0, candidate.lastIndexOf('-')));
    }
    return this.#catalogs[this.definition.presentations.default_locale.toLowerCase()]?.[nodeID];
  }
}
