/** Pure managed candidate compilation, separate from legacy declaration compilation. */
import { GraphError } from './canonical.js';
import { ExecutionManifest, RegistryGeneration, contractDigest } from './bindings.js';
import type { ExecutionManifestOptions, ResolvedBinding } from './bindings.js';
import { GraphIndex } from './index.js';
import { GraphDefinition, normalizeLocale } from './model.js';
import type { PublicationContract, TemplatePart } from './model.js';
import { ManagedReference } from './references.js';

export interface ManagedCompilerOptions extends Omit<
  ExecutionManifestOptions,
  'registry_digest' | 'binding_entries'
> {
  readonly registry?: RegistryGeneration;
  readonly no_execution_registry_digest?: string;
  readonly locale: string;
  readonly execution_extensions?: readonly string[];
}

const compiledPlans = new WeakSet<StructuralPlan>();

export class StructuralPlan {
  readonly index: GraphIndex;
  readonly bindings: Readonly<Record<string, ResolvedBinding>>;
  readonly publicationContracts: Readonly<Record<string, PublicationContract>>;
  readonly manifest: ExecutionManifest;
  readonly selectedLocale: string;
  readonly presentations: Readonly<
    Record<string, Readonly<{ title: string; description: string }>>
  >;
  readonly instructions: Readonly<Record<string, readonly TemplatePart[]>>;
  readonly processes: Readonly<
    Record<string, Readonly<{ pre_process?: string; post_process?: string }>>
  >;

  private constructor(definition: GraphDefinition, options: ManagedCompilerOptions) {
    if (!GraphDefinition.isValidated(definition))
      throw new GraphError('compiler_contract_invalid', 'Expected a validated managed definition');
    if (
      options.execution_extensions !== undefined &&
      (!Array.isArray(options.execution_extensions) || options.execution_extensions.length)
    )
      throw new GraphError('compiler_contract_invalid', 'Executable extensions are unsupported');
    this.selectedLocale = normalizeLocale(options.locale);
    const bindings: Record<string, ResolvedBinding> = Object.create(null) as Record<
      string,
      ResolvedBinding
    >;
    const contracts: Record<string, PublicationContract> = Object.create(null) as Record<
      string,
      PublicationContract
    >;
    let registryDigest: string;
    if (definition.mode === 'disclosure_only') {
      registryDigest = contractDigest(options.no_execution_registry_digest);
    } else {
      if (
        !(options.registry instanceof RegistryGeneration) ||
        options.no_execution_registry_digest !== undefined
      )
        throw new GraphError(
          'compiler_contract_invalid',
          'Runtime requires an exact registry generation',
        );
      registryDigest = options.registry.registryDigest;
      for (const node of Object.values(definition.nodes)) {
        if (node.kind !== 'tool') continue;
        if (node.binding === undefined)
          throw new GraphError('binding_contract_required', 'Runtime Tool requires binding');
        bindings[node.node_id] = options.registry.resolve(node.binding, node.input_contract);
        contracts[node.node_id] = bindings[node.node_id]!.publicationContract;
      }
    }
    this.index = GraphIndex.build(definition, contracts);
    this.bindings = Object.freeze(bindings);
    this.publicationContracts = Object.freeze(contracts);
    this.manifest = new ExecutionManifest({
      compiler_contract_version: options.compiler_contract_version,
      compiler_build: options.compiler_build,
      registry_digest: registryDigest,
      binding_entries: this.index.preorder
        .filter((id) => bindings[id])
        .map((id) => bindings[id]!.entry),
      app_dependency_contract: options.app_dependency_contract,
      environment_compatibility: options.environment_compatibility,
    });
    const presentations: Record<
      string,
      Readonly<{ title: string; description: string }>
    > = Object.create(null) as Record<string, Readonly<{ title: string; description: string }>>;
    const instructions: Record<string, readonly TemplatePart[]> = Object.create(null) as Record<
      string,
      readonly TemplatePart[]
    >;
    const processes: Record<
      string,
      Readonly<{ pre_process?: string; post_process?: string }>
    > = Object.create(null) as Record<
      string,
      Readonly<{ pre_process?: string; post_process?: string }>
    >;
    for (const node of this.index.walk()) {
      const presentation = this.index.presentation(node.node_id, this.selectedLocale);
      presentations[node.node_id] = Object.freeze({
        title: presentation?.title ?? node.name,
        description: presentation?.description ?? node.description,
      });
      if (node.kind !== 'tool') {
        instructions[node.node_id] =
          node.instruction_template !== undefined
            ? node.instruction_template.parts
            : Object.freeze([Object.freeze({ kind: 'Text' as const, text: node.instructions })]);
      }
      if (node.kind === 'role')
        processes[node.node_id] = Object.freeze({
          ...(node.members.pre_process === undefined
            ? {}
            : { pre_process: node.members.pre_process }),
          ...(node.members.post_process === undefined
            ? {}
            : { post_process: node.members.post_process }),
        });
    }
    this.presentations = Object.freeze(presentations);
    this.instructions = Object.freeze(instructions);
    this.processes = Object.freeze(processes);
    compiledPlans.add(this);
    Object.freeze(this);
  }

  static compile(definition: GraphDefinition, options: ManagedCompilerOptions): StructuralPlan {
    return new StructuralPlan(definition, options);
  }

  static isCompiled(value: unknown): value is StructuralPlan {
    return (
      typeof value === 'object' && value !== null && compiledPlans.has(value as StructuralPlan)
    );
  }

  get definition(): GraphDefinition {
    return this.index.definition;
  }
  get definitionDigest(): string {
    return this.definition.definitionDigest;
  }

  resolveInstructions(
    nodeID: string,
    generationUUID: string,
  ): readonly (
    | Extract<TemplatePart, { kind: 'Text' }>
    | Readonly<{ reference: ManagedReference; label?: string }>
  )[] {
    this.index.get(nodeID);
    new ManagedReference(this.definition.graph_id, generationUUID, nodeID);
    const parts = this.instructions[nodeID];
    if (!parts)
      throw new GraphError('compiler_contract_invalid', 'Node has no instruction material');
    return Object.freeze(
      parts.map((part) =>
        part.kind === 'Text'
          ? part
          : Object.freeze({
              reference: new ManagedReference(
                this.definition.graph_id,
                generationUUID,
                part.target_id,
              ),
              ...(part.label === undefined ? {} : { label: part.label }),
            }),
      ),
    );
  }
}
