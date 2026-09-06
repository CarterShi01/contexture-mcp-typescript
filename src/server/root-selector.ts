import type { Principal } from '../core/foundation/principal.js';
import type { CompiledApplication } from '../core/model/compiler.js';
import { RootSelection } from '../core/model/root-selection.js';

/** The request header that can attenuate, but never assert, a root surface. */
export const ROOTS_HEADER = 'Contexture-Roots';

/** Application policy deriving the maximum root surface for an authenticated caller. */
export type RootCeiling = (principal: Principal | undefined) => RootSelection;

/** Transport-neutral resolution of request facts into an immutable root surface. */
export interface RootSelector {
  select(
    index: CompiledApplication,
    headers?: Readonly<Record<string, string>>,
    principal?: Principal,
  ): RootSelection;
}

/** A fixed root surface, useful for stdio and single-tenant embeddings. */
export class FixedRootSelector implements RootSelector {
  constructor(readonly selection: RootSelection) {
    Object.freeze(this);
  }

  select(index: CompiledApplication): RootSelection {
    return this.selection.resolve(index);
  }
}

/**
 * Resolve a comma-separated root request header, intersecting it with an
 * optional identity-derived ceiling. A header is a request to see less, never
 * evidence that a caller may see more.
 */
export class HeaderRootSelector implements RootSelector {
  readonly header: string;
  readonly ceiling: RootCeiling | undefined;
  readonly maxLength: number;
  readonly maxRoots: number;

  constructor(
    options: {
      readonly header?: string;
      readonly ceiling?: RootCeiling;
      readonly maxLength?: number;
      readonly maxRoots?: number;
    } = {},
  ) {
    this.header = options.header ?? ROOTS_HEADER;
    this.ceiling = options.ceiling;
    this.maxLength = options.maxLength ?? 4096;
    this.maxRoots = options.maxRoots ?? 128;
    if (!Number.isInteger(this.maxLength) || this.maxLength < 1)
      throw new TypeError('HeaderRootSelector maxLength must be a positive integer.');
    if (!Number.isInteger(this.maxRoots) || this.maxRoots < 1)
      throw new TypeError('HeaderRootSelector maxRoots must be a positive integer.');
    Object.freeze(this);
  }

  select(
    index: CompiledApplication,
    headers: Readonly<Record<string, string>> = {},
    principal: Principal | undefined = undefined,
  ): RootSelection {
    const raw = headerValue(headers, this.header);
    let requested = RootSelection.all();
    if (raw !== undefined) {
      if (raw.length > this.maxLength)
        throw new Error(`${this.header} exceeds the ${this.maxLength}-character limit.`);
      const roots = raw.split(',').map((value) => value.trim());
      if (roots.length > this.maxRoots)
        throw new Error(`${this.header} exceeds the ${this.maxRoots}-root limit.`);
      requested = RootSelection.only(roots);
    }
    requested = requested.resolve(index);
    if (this.ceiling === undefined) return requested;
    return requested.intersect(this.ceiling(principal).resolve(index)).resolve(index);
  }
}

function headerValue(
  headers: Readonly<Record<string, string>>,
  wanted: string,
): string | undefined {
  const match = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === wanted.toLowerCase(),
  );
  return match?.[1];
}
