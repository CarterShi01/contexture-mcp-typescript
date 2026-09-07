import type { ApplicationCompilation } from '../../core/model/compiler.js';
import { ModelValidationError } from '../../core/foundation/errors.js';
import { RefusedError } from '../../core/model/disclosure.js';
import { takenByPersonMessage } from '../../core/model/system-api.js';
import type { PromptDeclaration } from '../../core/mcp-interface/prompt.js';
import type { ResourceDeclaration } from '../../core/mcp-interface/resource.js';
import { Disclosure } from '../../core/model/disclosure.js';
import { ApplicationRuntime } from '../../core/model/runtime.js';
import { RootSelection, SelectedGraph } from '../../core/model/root-selection.js';
import { buildInstructions } from '../instructions.js';
import {
  COMMAND_CLOSING,
  COMMAND_PREAMBLE,
  commandDescription,
  COMPLETION_LIMIT,
  GOTO_ARGUMENT,
  GOTO_DESCRIPTION,
  GOTO_PROMPT,
  signpost,
} from '../messages.js';

export interface PromptCard {
  readonly name: string;
  readonly description: string;
  readonly arguments: readonly { readonly name: typeof GOTO_ARGUMENT; readonly required: true }[];
}

export interface ResourceCard {
  readonly name: string;
  readonly uri: string;
  readonly description: string;
  readonly mimeType: string | undefined;
}

/** Validated prompt/resource publications over one compiled application. */
export class Publications {
  readonly prompts: readonly PromptDeclaration[];
  readonly resources: readonly ResourceDeclaration[];

  constructor(
    readonly disclosure: Disclosure,
    readonly runtime: ApplicationRuntime | undefined,
    declaration: Pick<ApplicationCompilation, 'prompts' | 'resources'> = {},
  ) {
    this.prompts = Object.freeze(
      (declaration.prompts ?? []).map((entry) => Object.freeze({ ...entry })),
    );
    this.resources = Object.freeze(
      (declaration.resources ?? []).map((entry) => Object.freeze({ ...entry })),
    );
    validatePrompts(disclosure, this.prompts);
    validateResources(disclosure, runtime, this.resources);
    Object.freeze(this);
  }

  promptCards(selection: RootSelection = RootSelection.all()): readonly PromptCard[] {
    const effective = this.disclosure.effectiveSelection(selection);
    return Object.freeze([
      ...this.prompts
        .filter((entry) => effective.containsRef(entry.opens))
        .map((entry) => ({
          name: publicationName(entry),
          description: commandDescription(entry.opens, entry.description),
          arguments: Object.freeze([]),
        })),
      {
        name: GOTO_PROMPT,
        description: GOTO_DESCRIPTION,
        arguments: Object.freeze([
          { name: GOTO_ARGUMENT as typeof GOTO_ARGUMENT, required: true as const },
        ]),
      },
    ]);
  }

  resourceCards(selection: RootSelection = RootSelection.all()): readonly ResourceCard[] {
    const effective = this.disclosure.effectiveSelection(selection);
    return Object.freeze(
      this.resources
        .filter((entry) => effective.containsRef(entry.opens))
        .map((entry) =>
          Object.freeze({
            name: publicationName(entry),
            uri: entry.uri,
            description: entry.description,
            mimeType: entry.mimeType,
          }),
        ),
    );
  }

  async command(name: string, selection: RootSelection = RootSelection.all()): Promise<string> {
    const entry = this.prompts.find((candidate) => publicationName(candidate) === name);
    if (entry === undefined)
      throw new ModelValidationError(`No Contexture Prompt named ${JSON.stringify(name)}.`);
    return this.openForPerson(entry.opens, selection);
  }

  async goto(ref: string, selection: RootSelection = RootSelection.all()): Promise<string> {
    return this.openForPerson(ref, selection);
  }

  /**
   * Apply publication-only model authorization before Gateway performs ordinary
   * navigation, so a typed lookup still reaches Gateway's one recovery layer.
   */
  checkModelOpen(ref: string, selection: RootSelection = RootSelection.all()): void {
    const effective = this.disclosure.effectiveSelection(selection);
    // Authorization precedes reservation: an excluded root must never reveal
    // that it also happens to be reachable through a person Prompt.
    effective.requireRef(ref);
    if (this.prompts.some((entry) => entry.opens === ref && entry.modelMayOpen === false)) {
      throw new RefusedError(takenByPersonMessage(ref));
    }
  }

  complete(
    ref: string,
    selection: RootSelection = RootSelection.all(),
    limit = COMPLETION_LIMIT,
  ): {
    readonly values: readonly string[];
    readonly total: number;
  } {
    const result = new SelectedGraph(
      this.disclosure.index,
      this.disclosure.effectiveSelection(selection),
    ).matchingRefs(ref, limit);
    return Object.freeze({ values: result.values, total: result.total });
  }

  async read(uri: string, selection: RootSelection = RootSelection.all()): Promise<unknown> {
    if (this.runtime === undefined)
      throw new ModelValidationError('A disclosure-only application has no Resources.');
    const entry = this.resources.find((candidate) => candidate.uri === uri);
    if (entry === undefined)
      throw new ModelValidationError(`No Contexture Resource at ${JSON.stringify(uri)}.`);
    return this.runtime.invokeReadOnly(entry.opens, undefined, {}, selection);
  }

  instructions(selection: RootSelection = RootSelection.all()): string {
    return buildInstructions(this.disclosure.select(selection));
  }

  private async openForPerson(ref: string, selection: RootSelection): Promise<string> {
    const payload = this.disclosure.openForPerson(ref, selection);
    const signposts = personSignpost(this.disclosure, ref, selection);
    return [
      COMMAND_PREAMBLE.replace('{ref}', ref),
      signposts,
      JSON.stringify(payload, null, 2),
      COMMAND_CLOSING,
    ]
      .filter((section) => section.length > 0)
      .join('\n\n');
  }
}

function validatePrompts(disclosure: Disclosure, entries: readonly PromptDeclaration[]): void {
  const names = new Set<string>();
  for (const entry of entries) {
    requireText(entry.opens, 'A Prompt must name the node it opens.');
    requireText(
      entry.description,
      `Prompt ${JSON.stringify(entry.opens)} must have a description.`,
    );
    disclosure.index.find(entry.opens);
    const name = publicationName(entry);
    if (names.has(name))
      throw new ModelValidationError(
        `Contexture Prompt ${JSON.stringify(name)} is declared more than once.`,
      );
    names.add(name);
  }
}

function validateResources(
  disclosure: Disclosure,
  runtime: ApplicationRuntime | undefined,
  entries: readonly ResourceDeclaration[],
): void {
  const names = new Set<string>();
  const uris = new Set<string>();
  for (const entry of entries) {
    if (runtime === undefined)
      throw new ModelValidationError('A disclosure-only application cannot declare Resources.');
    requireText(entry.opens, 'A Resource must name the Tool it opens.');
    requireText(entry.uri, `Resource ${JSON.stringify(entry.opens)} must have a URI.`);
    requireText(
      entry.description,
      `Resource ${JSON.stringify(entry.opens)} must have a description.`,
    );
    const node = disclosure.index.find(entry.opens);
    if (node.kind !== 'tool')
      throw new ModelValidationError(`Resource ${JSON.stringify(entry.uri)} must target a Tool.`);
    if (!node.readOnly)
      throw new ModelValidationError(
        `Resource ${JSON.stringify(entry.uri)} must target a read-only Tool.`,
      );
    if (node.binding === undefined || hasProperties(node.binding.schema)) {
      throw new ModelValidationError(
        `Resource ${JSON.stringify(entry.uri)} must target an argument-free Tool.`,
      );
    }
    const name = publicationName(entry);
    if (names.has(name))
      throw new ModelValidationError(
        `Contexture Resource ${JSON.stringify(name)} is declared more than once.`,
      );
    if (uris.has(entry.uri))
      throw new ModelValidationError(
        `Contexture Resource URI ${JSON.stringify(entry.uri)} is declared more than once.`,
      );
    names.add(name);
    uris.add(entry.uri);
  }
}

function personSignpost(disclosure: Disclosure, ref: string, selection: RootSelection): string {
  const names = ref.split('/');
  const levels: [string, number][] = [];
  for (let depth = 1; depth < names.length; depth += 1) {
    const ancestor = names.slice(0, depth).join('/');
    const node = disclosure.openForPerson(ancestor, selection);
    const roles = Array.isArray(node.roles) ? node.roles.length : 0;
    levels.push([ancestor, roles]);
  }
  return signpost(levels);
}

function publicationName(entry: PromptDeclaration | ResourceDeclaration): string {
  return entry.name ?? entry.opens.slice(entry.opens.lastIndexOf('/') + 1);
}

function hasProperties(schema: Readonly<Record<string, unknown>>): boolean {
  const properties = schema.properties;
  return (
    typeof properties === 'object' && properties !== null && Object.keys(properties).length > 0
  );
}

function requireText(value: string, message: string): void {
  if (value.trim().length === 0) throw new ModelValidationError(message);
}
