/** Base error for every Contexture domain failure. */
export class ContextureError extends Error {
  override readonly name: string = 'ContextureError';
}

/** A declaration or whole-forest invariant could not be satisfied. */
export class ModelValidationError extends ContextureError {
  override readonly name: string = 'ModelValidationError';
}

/** A declaration uses a form the Contexture model cannot accept. */
export class DeclarationError extends ModelValidationError {
  override readonly name: string = 'DeclarationError';
}

/** Two nodes would occupy the same canonical address. */
export class DuplicateNameError extends ModelValidationError {
  override readonly name = 'DuplicateNameError';
}

/** A lazy factory attempted to contain itself through an active ancestor. */
export class ContainmentCycleError extends ModelValidationError {
  override readonly name = 'ContainmentCycleError';
}

/** A declared dependency cannot resolve in the compiled forest. */
export class UnresolvedReferenceError extends ModelValidationError {
  override readonly name = 'UnresolvedReferenceError';
}

/** Machine-readable reasons a canonical Contexture reference could not resolve. */
export const LookupFailure = Object.freeze({
  EMPTY_REF: 'empty_ref',
  NO_SUCH_ROOT: 'no_such_root',
  NOT_A_CONTAINER: 'not_a_container',
  NO_SUCH_MEMBER: 'no_such_member',
  WRONG_KIND: 'wrong_kind',
} as const);

/** One of the machine-readable {@link LookupFailure} values. */
export type LookupFailure = (typeof LookupFailure)[keyof typeof LookupFailure];

/** Stable facts supplied with a failed canonical-node lookup. */
export interface NodeNotFoundFacts {
  readonly reason: LookupFailure;
  readonly ref?: string;
  readonly segment?: string;
  readonly scope?: string;
  readonly kind?: string;
  readonly wanted?: string;
  readonly known?: readonly string[];
}

/** A canonical reference failed to resolve through the compiled graph. */
export class NodeNotFoundError extends ContextureError {
  override readonly name = 'NodeNotFoundError';

  readonly reason: LookupFailure;
  readonly ref: string | undefined;
  readonly segment: string | undefined;
  readonly scope: string | undefined;
  readonly kind: string | undefined;
  readonly wanted: string | undefined;
  readonly known: readonly string[];

  constructor(facts: NodeNotFoundFacts) {
    super(renderNodeNotFound(facts));
    this.reason = facts.reason;
    this.ref = facts.ref;
    this.segment = facts.segment;
    this.scope = facts.scope;
    this.kind = facts.kind;
    this.wanted = facts.wanted;
    this.known = Object.freeze([...(facts.known ?? [])]);
  }
}

function renderNodeNotFound(facts: NodeNotFoundFacts): string {
  const subject =
    facts.ref === undefined
      ? 'Contexture node'
      : `Contexture reference ${JSON.stringify(facts.ref)}`;
  switch (facts.reason) {
    case LookupFailure.EMPTY_REF:
      return 'Contexture reference must not be empty.';
    case LookupFailure.NO_SUCH_ROOT:
      return `${subject} has no root named ${JSON.stringify(facts.segment)}.`;
    case LookupFailure.NOT_A_CONTAINER:
      return `${subject} cannot descend through non-container ${JSON.stringify(facts.scope)}.`;
    case LookupFailure.NO_SUCH_MEMBER:
      return `${subject} has no member ${JSON.stringify(facts.segment)} below ${JSON.stringify(facts.scope)}.`;
    case LookupFailure.WRONG_KIND:
      return `${subject} is ${JSON.stringify(facts.kind)}, not required ${JSON.stringify(facts.wanted)}.`;
  }
}

/** A caller supplied arguments that do not satisfy a Tool's disclosed schema. */
export class InputValidationError extends ModelValidationError {
  override readonly name = 'InputValidationError';

  constructor(
    readonly tool: string,
    readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
  ) {
    super(`Arguments for Contexture Tool ${JSON.stringify(tool)} do not satisfy its input schema.`);
  }
}

/** A business Tool denied the authenticated caller; HTTP REST renders this as 403. */
export class PermissionError extends ContextureError {
  override readonly name = 'PermissionError';
}

/** A business Tool rejected otherwise valid input; HTTP REST renders this as 422. */
export class RejectedError extends ContextureError {
  override readonly name = 'RejectedError';
}
