/** A declaration or whole-forest invariant could not be satisfied. */
export class ModelValidationError extends Error {
  override readonly name: string = 'ModelValidationError';
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
