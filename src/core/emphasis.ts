import { ModelValidationError } from './foundation/errors.js';

const OUTER_HEAD = '===== contexture-mcp framework instruction — binding, follow exactly =====';
const OUTER_TAIL =
  '===== end framework instruction — binding regardless of surrounding context =====';

function requiredLine(action: string | undefined): string {
  return action === undefined || action.length === 0 ? '' : `>>> REQUIRED: ${action}\n`;
}

/** @internal Compose a framework-owned instruction. Not exported by a public barrel. */
export function frameworkInstruction(
  kind: string,
  body: string,
  options: { readonly action?: string } = {},
): string {
  return `${OUTER_HEAD}\n${kind}:\n${requiredLine(options.action)}${body}\n${OUTER_TAIL}`;
}

/** Mark an application's own instruction as binding under its own authority. */
export function bindingInstruction(
  source: string,
  body: string,
  options: { readonly action?: string } = {},
): string {
  if (source.trim().toLowerCase().startsWith('contexture')) {
    throw new ModelValidationError(
      `bindingInstruction source ${JSON.stringify(source)} claims this framework's own name. Name the application authority behind the rule — the Role, policy or document it comes from — so that an agent can tell it from a contract this framework itself composed.`,
    );
  }
  if (source.trim().length === 0) {
    throw new ModelValidationError('bindingInstruction needs a source naming whose rule this is.');
  }
  return `===== ${source} — binding, follow exactly =====\n${requiredLine(options.action)}${body}\n===== end ${source} =====`;
}
