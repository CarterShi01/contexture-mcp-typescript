/** Candidate native metadata Catalog; not legacy Catalog v1 or negotiated wire API. */
import { canonicalDigest, GraphError, parseCounter, validateID } from '../core/graph/canonical.js';
import { metadataCatalog } from '../core/graph/catalog.js';
import type { JSONObject } from '../core/graph/model.js';
import {
  captureServing,
  definitionView,
  selection,
  visibleDefinition,
} from './managed-read-authority.js';
import type {
  CatalogSource,
  DefinitionReadPort,
  ServingReadPort,
} from './managed-read-authority.js';
import { identity, PageProfile, resync, same, SnapshotPages } from './managed-read-state.js';
import type { PageStoreOptions } from './managed-read-state.js';

export class CatalogProfile extends PageProfile {
  constructor(options: ConstructorParameters<typeof PageProfile>[0] = {}) {
    super({ ...options, name: options.name ?? 'native-metadata-catalog-v1' });
  }
}
export type CatalogStream = 'nodes' | 'containment' | 'uses';
export interface CatalogRequest {
  readonly graph_id: string;
  readonly source: CatalogSource;
  readonly revision?: string;
  readonly selection?: readonly string[];
  readonly profile?: CatalogProfile;
}

function request(value: CatalogRequest): {
  graph_id: string;
  source: CatalogSource;
  revision: string | null;
  selection: readonly string[] | null;
  profile: JSONObject;
} {
  validateID(value.graph_id);
  if (
    !['head', 'revision', 'serving'].includes(value.source) ||
    (value.source === 'revision') !== (value.revision !== undefined) ||
    (value.profile !== undefined && !(value.profile instanceof CatalogProfile))
  )
    throw new GraphError('schema_invalid', 'Invalid native Catalog request');
  if (value.revision !== undefined) parseCounter(value.revision);
  return {
    graph_id: value.graph_id,
    source: value.source,
    revision: value.revision ?? null,
    selection: selection(value.selection) ?? null,
    profile: (value.profile ?? new CatalogProfile()).asJSON(),
  };
}

export class ManagedCatalogService {
  readonly #definition: DefinitionReadPort | undefined;
  readonly #serving: ServingReadPort | undefined;
  readonly #pages: SnapshotPages;
  constructor(
    options: PageStoreOptions & { definition?: DefinitionReadPort; serving?: ServingReadPort },
  ) {
    if (options.definition === undefined && options.serving === undefined)
      throw new TypeError('An explicit trusted definition or serving read port is required');
    this.#definition =
      options.definition === undefined
        ? undefined
        : { read: options.definition.read.bind(options.definition) };
    this.#serving =
      options.serving === undefined
        ? undefined
        : {
            runtime: options.serving.runtime,
            storeOrigin: options.serving.storeOrigin.bind(options.serving),
          };
    this.#pages = new SnapshotPages(options);
  }
  /** Trusted Host diagnostics, never included in the projection. */
  get counts() {
    return this.#pages.counts;
  }
  get requiresExplicitSweep(): boolean {
    return this.#pages.requiresExplicitSweep;
  }
  sweep(): number {
    return this.#pages.sweep();
  }
  shutdown(): void {
    this.#pages.shutdown();
  }
  async start(value: CatalogRequest, ttl = 30000): Promise<JSONObject> {
    const binding = request(value);
    const profile = value.profile ?? new CatalogProfile();
    const anchors = binding.selection ?? undefined;
    const pending = this.#pages.begin(ttl);
    try {
      if (binding.source === 'serving') {
        const port = this.#serving;
        if (port === undefined)
          throw new GraphError('not_ready', 'Catalog serving read port is not configured');
        return await captureServing(port, anchors, false, (s) => {
          if (s.plan.definition.graph_id !== binding.graph_id) resync();
          const material = metadataCatalog(
            s.plan.index,
            s.visible,
            profile.kinds,
            this.#pages.materialBudget(),
            (id) => {
              const node = s.plan.index.get(id);
              return {
                kind: node.kind,
                name: node.name,
                description: s.plan.presentations[id]!.description,
                ...(s.plan.index.presentation(id, s.plan.selectedLocale) === undefined
                  ? {}
                  : { title: s.plan.presentations[id]!.title }),
              };
            },
          );
          const descriptor = {
            source: 'serving',
            graph_id: binding.graph_id,
            detail: 'metadata_only',
            profile: { name: profile.name, kinds: profile.kinds },
            locale: s.plan.selectedLocale,
          };
          return this.#pages.create({
            binding,
            envelope: {
              ...descriptor,
              revision: s.serving.attempt.release.snapshot.revision,
              target_id: s.serving.attempt.release.target_id,
              instance_id: s.serving.attempt.instance_id,
              boot_id: s.serving.attempt.boot_id,
              generation_uuid: s.serving.generation.context.generation_uuid,
              view_digest: canonicalDigest(
                { view_descriptor: descriptor, catalog_payload: material },
                'contexture.view/v1',
              ),
            },
            streams: { ...material },
            profile,
            ...pending,
            authorize: s.authorize,
            dispose: s.dispose,
          });
        });
      }
      const port = this.#definition;
      if (port === undefined)
        throw new GraphError('not_ready', 'Catalog definition read port is not configured');
      return await port.read(
        {
          graph_id: binding.graph_id,
          source: binding.source,
          ...(binding.revision === null ? {} : { revision: binding.revision }),
        },
        (view) => {
          definitionView(view, binding.graph_id);
          if (binding.revision !== null && view.revision !== binding.revision)
            throw new GraphError('contract_mismatch', 'Historical read returned another revision');
          const capturedIdentity = identity(view.identity);
          const capturedOrigin = view.store_origin;
          const index = view.index;
          const visible = visibleDefinition(view, index, anchors);
          const ceiling = [...visible];
          const material = metadataCatalog(
            index,
            visible,
            profile.kinds,
            this.#pages.materialBudget(),
          );
          const descriptor = {
            source: binding.source,
            graph_id: binding.graph_id,
            detail: 'metadata_only',
            profile: { name: profile.name, kinds: profile.kinds },
          };
          return this.#pages.create({
            binding,
            envelope: {
              ...descriptor,
              revision: view.revision,
              view_digest: canonicalDigest(
                { view_descriptor: descriptor, catalog_payload: material },
                'contexture.view/v1',
              ),
            },
            streams: { ...material },
            profile,
            ...pending,
            authorize: (render) =>
              port.read({ graph_id: binding.graph_id, source: 'head' }, (current) => {
                definitionView(current, binding.graph_id);
                if (
                  !same(capturedIdentity, identity(current.identity)) ||
                  current.store_origin !== capturedOrigin ||
                  !same(ceiling, [...visibleDefinition(current, index, anchors)])
                )
                  resync();
                return render();
              }),
            dispose() {},
          });
        },
      );
    } finally {
      pending.finish();
    }
  }
  continuation(
    token: string,
    value: CatalogRequest & { stream: CatalogStream },
  ): Promise<JSONObject> {
    return this.#pages.page(token, value.stream, request(value));
  }
}
