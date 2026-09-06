/** A command-line request was invalid but did not indicate a framework failure. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}
