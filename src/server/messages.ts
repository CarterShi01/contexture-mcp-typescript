/** Text owned by the server audience rather than the object model. */
import {
  INVOKE_GATEWAY_NAME,
  INVOKE_READ_ONLY_GATEWAY_NAME,
  OPEN_GATEWAY_NAME,
} from '../core/foundation/vocabulary.js';

/** The one person-controlled command every Contexture server publishes. */
export const GOTO_PROMPT = 'goto';
/** The sole argument accepted by the `goto` command. */
export const GOTO_ARGUMENT = 'ref';
/** Maximum values returned by one completion response. */
export const COMPLETION_LIMIT = 100;
export const PREAMBLE = `Everything this server offers is behind ${OPEN_GATEWAY_NAME}. Start from the list
below: open the role that fits the task to see its skills, tools and
sub-roles, then open the skill you chose for its procedure. Each call
reveals one level; keep opening down the branch that fits.
Run a tool with ${INVOKE_READ_ONLY_GATEWAY_NAME} or ${INVOKE_GATEWAY_NAME}, whichever its
card says, passing the ref and arguments from that card.
Collect evidence before stating a cause; never assert system state you have
not read.`;

/** The reference rule appended after a server's bootstrap roster. */
export const REF_RULE = `Every card carries a \`ref\`. Pass it back to ${OPEN_GATEWAY_NAME} to open that node; never assemble a ref yourself.`;

/** What a person reads beside the universal `goto` command. */
export const GOTO_DESCRIPTION =
  'Open any capability this server holds, by reference. The reference completes as you type, so the whole tree can be browsed here without asking the agent to go and look.';

/** What a person reads about the argument accepted by `goto`. */
export const GOTO_ARGUMENT_DESCRIPTION =
  'A reference such as payments/ledger/settlement. Completes on any part of the path.';

/** Opening text for a node reached by a person rather than model navigation. */
export const COMMAND_PREAMBLE = "You are at {ref}, opened by name at a person's request.";

/** Explains that command signposts describe existence, not disclosed contents. */
export const SIGNPOST_PREAMBLE = `Signposts for the path above it. These are **not disclosed**: you may open one with ${OPEN_GATEWAY_NAME}, and until you do you know only that it exists. Do not assert anything about what any of them holds.`;

/** Closing text for person-controlled navigation. */
export const COMMAND_CLOSING = `Continue with ${OPEN_GATEWAY_NAME}, ${INVOKE_READ_ONLY_GATEWAY_NAME} or ${INVOKE_GATEWAY_NAME}, using refs taken from what is above. Nothing listed here was reached by navigating, so nothing beside it has been shown to you.`;

/** Say that a completion response intentionally omitted remaining values. */
export function truncatedCompletion(shown: number, total: number): string {
  return `... ${total - shown} more match; keep typing to narrow.`;
}

/** Render ancestors without disclosing their contents. */
export function signpost(
  levels: readonly (readonly [ref: string, subRoleCount: number])[],
): string {
  if (levels.length === 0) return '';
  return [
    SIGNPOST_PREAMBLE,
    ...levels.map(([ref, count]) =>
      count > 0
        ? `- ${ref}: ${count} sub-role(s) here; ${OPEN_GATEWAY_NAME} to see them.`
        : `- ${ref}: no sub-roles; ${OPEN_GATEWAY_NAME} to see what it holds.`,
    ),
  ].join('\n');
}

/** Render the human-facing command description for a declared Prompt. */
export function commandDescription(ref: string, description: string): string {
  return `${description} (${ref})`;
}
