import { Disclosure } from '../core/model/disclosure.js';
import { DISCOVER_GATEWAY_NAME } from '../core/foundation/vocabulary.js';

import { PREAMBLE, REF_RULE } from './messages.js';

/** Claude Code's server-instructions byte limit. */
export const INSTRUCTIONS_LIMIT = 2048;
/** Leave the remaining instruction budget for fixed gateway descriptions. */
export const ROSTER_BUDGET = 1200;
/** The prefix Codex reads while deciding whether to use a server. */
export const SELF_CONTAINED_PREFIX = 512;

/** Bootstrap text for a request-selected server without a global roster. */
export function neutralInstructions(): string {
  return (
    'This Contexture server exposes a request-specific set of complete capability subtrees. ' +
    `Call ${DISCOVER_GATEWAY_NAME} for the surface roots available to this request, open the one that fits ` +
    'the task, and continue one level at a time using refs exactly as returned. Run a disclosed ' +
    'tool through the read-only or writing Contexture invoke door named on its card.'
  );
}

/** Build server bootstrap instructions: contract first, breadth-first roster second. */
export function buildInstructions(
  disclosure: Disclosure,
  options: { readonly preamble?: string; readonly budget?: number } = {},
): string {
  const preamble = options.preamble ?? PREAMBLE;
  const budget = options.budget ?? ROSTER_BUDGET;
  const roster: string[] = [];
  let spent = 0;
  let dropped = 0;
  let full = false;

  for (const [index, group] of [...siblingGroups(disclosure)].entries()) {
    const entries = group.map(([ref, description]) => `- ${ref}: ${description}`);
    const cost = entries.reduce((total, entry) => total + byteLength(entry) + 1, 0);
    if (index === 0) {
      for (const entry of entries) {
        if (spent + byteLength(entry) > budget) {
          dropped += 1;
          continue;
        }
        roster.push(entry);
        spent += byteLength(entry) + 1;
      }
      if (dropped > 0) {
        roster.push(
          `- ...and ${dropped} more root role(s); call ${DISCOVER_GATEWAY_NAME} for the complete list.`,
        );
        return assemble(preamble, roster);
      }
      continue;
    }
    if (full || spent + cost > budget) {
      full = true;
      dropped += entries.length;
      continue;
    }
    roster.push(...entries);
    spent += cost;
  }
  if (dropped > 0) {
    roster.push(
      `- ...and ${dropped} more role(s) below these; open one of the roles above to see what it holds.`,
    );
  }
  return assemble(preamble, roster);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function assemble(preamble: string, roster: readonly string[]): string {
  return [preamble.trim(), '', 'Capabilities:', ...roster, '', REF_RULE].join('\n');
}

function* siblingGroups(
  disclosure: Disclosure,
): IterableIterator<readonly (readonly [string, string])[]> {
  const visible = disclosure.selection
    .rootsIn(disclosure.index)
    .filter((node) => disclosure.modelCanSee(disclosure.index.refOf(node)));
  yield visible.map((node) => [disclosure.index.refOf(node), node.description] as const);

  const queue = visible.filter((node) => node.kind === 'role');
  while (queue.length > 0) {
    const role = queue.shift();
    if (role === undefined) return;
    const children = role.children.filter((child) =>
      disclosure.modelCanSee(disclosure.index.refOf(child)),
    );
    if (children.length > 0) {
      yield children.map((child) => [disclosure.index.refOf(child), child.description] as const);
      queue.push(...children);
    }
  }
}
