/** Pure complete-item slicing. The caller budgets the entire response envelope. */
import { canonicalJSON, GraphError } from './canonical.js';

/** Fail during construction, not after retaining an arbitrarily large projection. */
export class MaterialBudget {
  #entries = 0;
  #bytes = 0;
  constructor(
    readonly maxEntries: number,
    readonly maxBytes: number,
  ) {
    if (![maxEntries, maxBytes].every((n) => Number.isSafeInteger(n) && n > 0))
      throw new GraphError('schema_invalid', 'Invalid projection material bounds');
  }
  add(value: unknown, entry = true): void {
    this.#entries += Number(entry);
    this.#bytes += canonicalJSON(value).length;
    if (this.#entries > this.maxEntries || this.#bytes > this.maxBytes)
      throw new GraphError('too_large', 'Native projection exceeds material budget');
  }
}

export function sliceItems(
  items: readonly string[],
  offset: number,
  limit: number,
  byteLimit: number,
): Readonly<{ items: readonly string[]; nextOffset: number | null }> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > items.length ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isSafeInteger(byteLimit) ||
    byteLimit < 2
  )
    throw new GraphError('schema_invalid', 'Invalid native page bounds');
  let end = offset;
  let size = 2;
  while (end < Math.min(items.length, offset + limit)) {
    const added = Buffer.byteLength(items[end]!) + Number(end > offset);
    if (size + added > byteLimit) {
      if (end === offset) throw new GraphError('too_large', 'One page item exceeds byte budget');
      break;
    }
    size += added;
    end++;
  }
  return { items: items.slice(offset, end), nextOffset: end < items.length ? end : null };
}
