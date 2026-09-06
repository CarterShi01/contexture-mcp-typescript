/**
 * Transport-free replay of the Contexture surface an agent receives.
 *
 * This module intentionally calls Disclosure and Runtime directly. It never
 * starts an MCP transport or invokes a writing Tool, so a project can inspect
 * its context budget in a test or CLI before it serves anything.
 */
import type { CompiledNode } from './core/model/compiler.js';
import { Disclosure } from './core/model/disclosure.js';
import { ApplicationRuntime } from './core/model/runtime.js';
import { GATEWAY, unresolvedMessage } from './core/model/system-api.js';
import { NodeNotFoundError } from './core/foundation/errors.js';
import {
  buildInstructions,
  INSTRUCTIONS_LIMIT,
  SELF_CONTAINED_PREFIX,
} from './server/instructions.js';

/** The pseudo-call delivered when a Host connects, before any tool call. */
export const CONNECT = 'session start';
const DESCRIPTION_BUDGET = 200;

const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff],
  [0x2e80, 0x9fff],
  [0xa960, 0xa97f],
  [0xac00, 0xd7ff],
  [0xf900, 0xfaff],
  [0xff00, 0xff60],
  [0x20000, 0x3ffff],
];

/** Character, byte, and deliberately approximate token cost of one text value. */
export class Cost {
  constructor(
    readonly characters: number,
    readonly bytes: number,
    readonly tokens: number,
  ) {
    Object.freeze(this);
  }

  static of(text: string): Cost {
    const characters = [...text];
    let wide = 0;
    for (const character of characters) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (WIDE_RANGES.some(([low, high]) => low <= codePoint && codePoint <= high)) wide += 1;
    }
    return new Cost(
      characters.length,
      Buffer.byteLength(text, 'utf8'),
      Math.round(wide + (characters.length - wide) / 4),
    );
  }

  plus(other: Cost): Cost {
    return new Cost(
      this.characters + other.characters,
      this.bytes + other.bytes,
      this.tokens + other.tokens,
    );
  }

  toJSON(): Readonly<Record<string, number>> {
    return Object.freeze({
      characters: this.characters,
      bytes: this.bytes,
      estimated_tokens: this.tokens,
    });
  }
}

/** One measured host limit or disclosure-quality observation. */
export interface Check {
  readonly ok: boolean;
  readonly note: string;
}

/** One thing an agent receives while connecting or navigating. */
export class Step {
  readonly cost: Cost;

  constructor(
    readonly call: string,
    readonly body: string,
    options: {
      readonly ref?: string;
      readonly payload?: unknown;
      readonly checks?: readonly Check[];
      readonly refused?: boolean;
      readonly aside?: string | undefined;
    } = {},
  ) {
    this.cost = Cost.of(body);
    this.ref = options.ref;
    this.payload = options.payload;
    this.checks = Object.freeze([...(options.checks ?? [])]);
    this.refused = options.refused ?? false;
    this.aside = options.aside;
    Object.freeze(this);
  }

  readonly ref: string | undefined;
  readonly payload: unknown;
  readonly checks: readonly Check[];
  readonly refused: boolean;
  readonly aside: string | undefined;

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      call: this.call,
      ref: this.ref ?? null,
      refused: this.refused,
      body: this.body,
      payload: this.payload ?? null,
      checks: this.checks,
      cost: this.cost.toJSON(),
      aside: this.aside ?? null,
    });
  }
}

/** An ordered replay of a connection and progressive-disclosure session. */
export class Trace {
  constructor(readonly steps: readonly Step[]) {
    this.steps = Object.freeze([...steps]);
    Object.freeze(this);
  }

  get total(): Cost {
    return this.steps.reduce((total, step) => total.plus(step.cost), new Cost(0, 0, 0));
  }

  get failures(): readonly Step[] {
    return Object.freeze(
      this.steps.filter((step) => step.refused || step.checks.some((check) => !check.ok)),
    );
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({ steps: this.steps, total: this.total.toJSON() });
  }
}

/** Build and measure the instructions a Host receives at connection time. */
export function connectStep(
  disclosure: Disclosure,
  instructions = buildInstructions(disclosure),
): Step {
  const cost = Cost.of(instructions);
  const roles = [...disclosure.index.walk()].filter(
    ([ref, node]) => node.kind === 'role' && disclosure.modelCanSee(ref),
  ).length;
  const { listed, cut } = rosterLines(instructions);
  const checks: readonly Check[] = Object.freeze([
    Object.freeze({
      ok: cost.bytes <= INSTRUCTIONS_LIMIT,
      note: `${cost.bytes} of ${INSTRUCTIONS_LIMIT} bytes — Claude Code truncates what is over, mid-sentence`,
    }),
    Object.freeze({
      ok: instructions.slice(0, SELF_CONTAINED_PREFIX).includes('contexture_open'),
      note: `contexture_open named in the first ${SELF_CONTAINED_PREFIX} characters — that is how far Codex reads while deciding whether to use this server`,
    }),
    Object.freeze({
      ok: !cut && listed === roles,
      note: `roster lists ${listed} of ${roles} role(s)${cut ? ' — the rest were cut for budget' : ''}`,
    }),
  ]);
  return new Step(CONNECT, instructions, {
    payload: Object.freeze({ instructions, gateway: GATEWAY }),
    checks,
    aside: `the ${GATEWAY.length} gateway tool descriptions arrive here too; they are fixed and are not counted in this trace`,
  });
}

/** Replay the model-controlled discovery response. */
export function discoverStep(disclosure: Disclosure): Step {
  const payload = disclosure.discover();
  return new Step('contexture_discover', wire(payload), { payload });
}

/** Replay one model-controlled open response, retaining its recovery text on refusal. */
export function openStep(disclosure: Disclosure, ref: string): Step {
  try {
    const payload = disclosure.open(ref);
    return new Step('contexture_open', wire(payload), {
      ref,
      payload,
      checks: routingChecks(payload),
      aside: contentTool(disclosure, ref)
        ? 'the document itself is not here — an agent runs it with contexture_invoke_read_only; pass --read to include it and its cost'
        : undefined,
    });
  } catch (error) {
    return new Step(
      'contexture_open',
      error instanceof NodeNotFoundError ? unresolvedMessage(error) : message(error),
      {
        ref,
        refused: true,
        aside: 'this recovery sentence is all the agent receives',
      },
    );
  }
}

/** Read one no-argument, read-only Tool only when an inspection explicitly requests it. */
export async function readStep(runtime: ApplicationRuntime, ref: string): Promise<Step> {
  try {
    const value = await runtime.invokeReadOnly(ref);
    if (value instanceof Uint8Array) {
      return new Step('contexture_invoke_read_only', `<${value.byteLength} bytes of binary>`, {
        ref,
        aside: 'binary content is described rather than printed',
      });
    }
    return new Step(
      'contexture_invoke_read_only',
      typeof value === 'string' ? value : wire(value),
      { ref },
    );
  } catch (error) {
    return new Step('contexture_invoke_read_only', message(error), { ref, refused: true });
  }
}

/** Every ref in breadth-first role order, with each role's immediate leaves after it. */
export function* everyRef(disclosure: Disclosure): IterableIterator<string> {
  const queue = disclosure.index.modelRoots.filter((node) => node.kind === 'role');
  for (const root of disclosure.index.modelRoots) {
    if (root.kind !== 'role') yield disclosure.index.refOf(root);
  }
  while (queue.length > 0) {
    const role = queue.shift();
    if (role === undefined) return;
    const ref = disclosure.index.refOf(role);
    if (!disclosure.modelCanSee(ref)) continue;
    yield ref;
    for (const child of [...role.children, ...role.skills, ...role.tools]) {
      if (!disclosure.modelCanSee(disclosure.index.refOf(child))) continue;
      if (child.kind === 'role') queue.push(child);
      else yield disclosure.index.refOf(child);
    }
  }
}

/** Replay connect, optional discovery, opens, and opt-in content reads. */
export async function trace(
  disclosure: Disclosure,
  refs: readonly string[] = [],
  options: {
    readonly instructions?: string;
    readonly discover?: boolean;
    readonly read?: boolean;
    readonly runtime?: ApplicationRuntime;
  } = {},
): Promise<Trace> {
  const steps: Step[] = [connectStep(disclosure, options.instructions)];
  if (options.discover ?? true) steps.push(discoverStep(disclosure));
  for (const ref of refs) {
    const opened = openStep(disclosure, ref);
    steps.push(opened);
    if (
      options.read &&
      options.runtime !== undefined &&
      !opened.refused &&
      contentTool(disclosure, ref)
    ) {
      steps.push(await readStep(options.runtime, ref));
    }
  }
  return new Trace(steps);
}

/** Render a trace for terminal use without parsing a wire payload. */
export function render(trace_: Trace, options: { readonly payloads?: boolean } = {}): string {
  const payloads = options.payloads ?? true;
  const lines: string[] = [];
  trace_.steps.forEach((step, index) => {
    lines.push(
      `step ${index}  ${step.call}${step.ref === undefined ? '' : `  ${step.ref}`}${step.refused ? '  [refused]' : ''}`,
    );
    lines.push(`  ${amount(step.cost)}`);
    for (const check of step.checks) lines.push(`  ${check.ok ? 'ok  ' : 'BAD '}${check.note}`);
    if (step.aside !== undefined) lines.push(`  note: ${step.aside}`);
    if (payloads) lines.push('', ...step.body.split('\n').map((line) => `  | ${line}`));
    lines.push('');
  });
  lines.push(...renderSummary(trace_));
  return lines.join('\n');
}

/** Stable JSON rendering for CI and cross-language scenario comparison. */
export function asJson(trace_: Trace): string {
  return JSON.stringify(trace_, null, 2);
}

function routingChecks(payload: Readonly<Record<string, unknown>>): readonly Check[] {
  const cards = ['roles', 'skills', 'tools'].flatMap((key) =>
    Array.isArray(payload[key]) ? payload[key].filter(isRecord) : [],
  );
  if (cards.length === 0) return Object.freeze([]);
  const held = new Set(cards.map((card) => String(card.name ?? '')));
  const long = cards
    .filter((card) => String(card.description ?? '').length > DESCRIPTION_BUDGET)
    .map((card) => String(card.name));
  const named = new Set<string>();
  for (const card of cards) {
    for (const name of held) {
      if (name !== String(card.name ?? '') && String(card.description ?? '').includes(name)) {
        named.add(String(card.name ?? ''));
      }
    }
  }
  const opened = String(payload.description ?? '');
  if ([...held].some((name) => opened.includes(name))) named.add(String(payload.name ?? ''));
  const listing = [...named].sort();
  return Object.freeze([
    Object.freeze({
      ok: long.length === 0,
      note:
        long.length === 0
          ? `every routing sentence is within ${DESCRIPTION_BUDGET} characters`
          : `over ${DESCRIPTION_BUDGET} characters: ${long.join(', ')}`,
    }),
    Object.freeze({
      ok: listing.length === 0,
      note:
        listing.length === 0
          ? 'no routing sentence names what its node holds'
          : `${listing.join(', ')} name(s) their own members — the inside is what opening delivers, and describing it twice is how the two copies start disagreeing`,
    }),
  ]);
}

function contentTool(disclosure: Disclosure, ref: string): boolean {
  try {
    const node = disclosure.index.find(ref);
    return node.kind === 'tool' && node.readOnly && objectPropertyCount(node.binding?.schema) === 0;
  } catch {
    return false;
  }
}

function objectPropertyCount(schema: unknown): number {
  if (!isRecord(schema) || !isRecord(schema.properties)) return 0;
  return Object.keys(schema.properties).length;
}

function rosterLines(text: string): { readonly listed: number; readonly cut: boolean } {
  let listed = 0;
  let cut = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('- ')) continue;
    if (line.startsWith('- ...and ')) cut = true;
    else listed += 1;
  }
  return { listed, cut };
}

function amount(cost: Cost): string {
  return `${cost.characters} characters, ${cost.bytes} bytes, ~${cost.tokens} tokens`;
}

function renderSummary(trace_: Trace): readonly string[] {
  const width = Math.min(Math.max(3, ...trace_.steps.map((step) => (step.ref ?? '').length)), 52);
  const rule = '-'.repeat(36 + width);
  const lines = [rule, `${'#'.padStart(2)}  ${'call'.padEnd(26)}  ${'ref'.padEnd(width)}  ~tok`];
  let running = new Cost(0, 0, 0);
  trace_.steps.forEach((step, index) => {
    running = running.plus(step.cost);
    let ref = step.ref ?? '-';
    if (ref.length > width) ref = `…${ref.slice(-(width - 1))}`;
    lines.push(
      `${String(index).padStart(2)}  ${step.call.padEnd(26)}  ${ref.padEnd(width)}  ${String(step.cost.tokens).padStart(5)}  (running ${running.tokens})`,
    );
  });
  const total = trace_.total;
  lines.push(
    rule,
    `total  ${total.characters} characters, ${total.bytes} bytes, ~${total.tokens} tokens over ${trace_.steps.length} step(s)`,
  );
  const refused = trace_.steps.filter((step) => step.refused).length;
  if (refused > 0) lines.push(`       ${refused} step(s) refused`);
  const failed = trace_.steps.flatMap((step) => step.checks).filter((check) => !check.ok);
  if (failed.length > 0) lines.push(`       ${failed.length} host limit(s) not met`);
  return lines;
}

function wire(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Contexture inspection failed.';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type { CompiledNode };
