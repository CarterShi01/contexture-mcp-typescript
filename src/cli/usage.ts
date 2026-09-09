import { ContextureError } from '../core/foundation/errors.js';

/** A command-line request was invalid and remains classifiable as a Contexture error. */
export class UsageError extends ContextureError {
  override readonly name = 'UsageError';
}
