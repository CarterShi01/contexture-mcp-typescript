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

/** A canonical reference failed to resolve through the compiled graph. */
export class NodeNotFoundError extends ContextureError {
  override readonly name = 'NodeNotFoundError';
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
