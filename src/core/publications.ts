import type {
  ApplicationDeclaration,
  PromptDeclaration,
  ResourceDeclaration,
} from './declarations.js';
import { ModelValidationError } from './errors.js';
import { Disclosure } from './disclosure.js';
import { ApplicationRuntime } from './runtime.js';
import { RootSelection, SelectedGraph } from './root-selection.js';

const OPEN = 'contexture_open';
const READ_ONLY = 'contexture_invoke_read_only';
const INVOKE = 'contexture_invoke';

export interface PromptCard {
  readonly name: string;
  readonly description: string;
  readonly arguments: readonly { readonly name: 'ref'; readonly required: true }[];
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
    declaration: Pick<ApplicationDeclaration, 'prompts' | 'resources'> = {},
  ) {
    this.prompts = Object.freeze([...(declaration.prompts ?? [])]);
    this.resources = Object.freeze([...(declaration.resources ?? [])]);
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
          description: `${entry.description} (${entry.opens})`,
          arguments: Object.freeze([]),
        })),
      {
        name: 'goto',
        description:
          'Open any capability this server holds, by reference. The reference completes as you type, so the whole tree can be browsed here without asking the agent to go and look.',
        arguments: Object.freeze([{ name: 'ref' as const, required: true as const }]),
      },
    ]);
  }

  resourceCards(): readonly ResourceCard[] {
    return Object.freeze(
      this.resources.map((entry) =>
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

  complete(
    ref: string,
    selection: RootSelection = RootSelection.all(),
    limit = 100,
  ): {
    readonly values: readonly string[];
    readonly total: number;
  } {
    return new SelectedGraph(
      this.disclosure.index,
      this.disclosure.effectiveSelection(selection),
    ).matchingRefs(ref, limit);
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
    const view = this.disclosure.select(selection);
    const lines = [
      `Everything this server offers is behind ${OPEN}. Start from the list`,
      'below: open the role that fits the task to see its skills, tools and',
      'sub-roles, then open the skill you chose for its procedure. Each call',
      'reveals one level; keep opening down the branch that fits.',
      `Run a tool with ${READ_ONLY} or ${INVOKE}, whichever its`,
      'card says, passing the ref and arguments from that card.',
      'Collect evidence before stating a cause; never assert system state you have',
      'not read.',
      '',
      'Capabilities:',
    ];
    const queue = [...view.index.modelRoots].filter((node) =>
      view.modelCanSee(view.index.refOf(node)),
    );
    while (queue.length > 0) {
      const node = queue.shift();
      if (node === undefined) break;
      const ref = view.index.refOf(node);
      lines.push(`- ${ref}: ${node.description}`);
      if (node.kind === 'role') queue.push(...node.children);
    }
    lines.push(
      '',
      `Every card carries a \`ref\`. Pass it back to ${OPEN} to open that node; never assemble a ref yourself.`,
    );
    return lines.join('\n');
  }

  private async openForPerson(ref: string, selection: RootSelection): Promise<string> {
    const payload = this.disclosure.openForPerson(ref, selection);
    const signposts = signpost(this.disclosure, ref, selection);
    return [
      `You are at ${ref}, opened by name at a person's request.`,
      signposts,
      JSON.stringify(payload, null, 2),
      `Continue with ${OPEN}, ${READ_ONLY} or ${INVOKE}, using refs taken from what is above. Nothing listed here was reached by navigating, so nothing beside it has been shown to you.`,
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

function signpost(disclosure: Disclosure, ref: string, selection: RootSelection): string {
  const names = ref.split('/');
  const lines: string[] = [];
  for (let depth = 1; depth < names.length; depth += 1) {
    const ancestor = names.slice(0, depth).join('/');
    const node = disclosure.openForPerson(ancestor, selection);
    const roles = Array.isArray(node.roles) ? node.roles.length : 0;
    lines.push(
      roles > 0
        ? `- ${ancestor}: ${roles} sub-role(s) here; ${OPEN} to see them.`
        : `- ${ancestor}: no sub-roles; ${OPEN} to see what it holds.`,
    );
  }
  if (lines.length === 0) return '';
  return [
    `Signposts for the path above it. These are **not disclosed**: you may open one with ${OPEN}, and until you do you know only that it exists. Do not assert anything about what any of them holds.`,
    ...lines,
  ].join('\n');
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
