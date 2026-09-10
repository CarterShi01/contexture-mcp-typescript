import type { Principal } from '../core/foundation/principal.js';
import type { CompiledApplication } from '../core/model/compiler.js';
import { SurfaceSelection, SurfaceSelectionError } from '../core/model/root-selection.js';

/** Canonical request header for path-selected capability surfaces. */
export const SELECT_HEADER = 'Contexture-Select';
/** Legacy request header retained for root-only clients. */
export const ROOTS_HEADER = 'Contexture-Roots';

export type SurfaceCeiling = (principal: Principal | undefined) => SurfaceSelection;
export interface SurfaceSelector {
  select(
    index: CompiledApplication,
    headers?: Readonly<Record<string, string>>,
    principal?: Principal,
  ): SurfaceSelection;
}

export class FixedSurfaceSelector implements SurfaceSelector {
  constructor(readonly selection: SurfaceSelection) {
    Object.freeze(this);
  }

  select(index: CompiledApplication): SurfaceSelection {
    return this.selection.resolve(index);
  }
}

/** Resolve a path selector header and intersect it with an identity ceiling. */
export class HeaderSurfaceSelector implements SurfaceSelector {
  readonly header: string;
  readonly legacyHeader: string | undefined;
  readonly ceiling: SurfaceCeiling | undefined;
  readonly maxLength: number;
  readonly maxRoots: number;

  constructor(
    options: {
      readonly header?: string;
      readonly legacyHeader?: string | undefined;
      readonly ceiling?: SurfaceCeiling;
      readonly maxLength?: number;
      readonly maxRoots?: number;
    } = {},
  ) {
    this.header = options.header ?? SELECT_HEADER;
    this.legacyHeader = 'legacyHeader' in options ? options.legacyHeader : ROOTS_HEADER;
    this.ceiling = options.ceiling;
    this.maxLength = options.maxLength ?? 4096;
    this.maxRoots = options.maxRoots ?? 128;
    if (!Number.isInteger(this.maxLength) || this.maxLength < 1)
      throw new TypeError('HeaderSurfaceSelector maxLength must be a positive integer.');
    if (!Number.isInteger(this.maxRoots) || this.maxRoots < 1)
      throw new TypeError('HeaderSurfaceSelector maxRoots must be a positive integer.');
    Object.freeze(this);
  }

  select(
    index: CompiledApplication,
    headers: Readonly<Record<string, string>> = {},
    principal: Principal | undefined = undefined,
  ): SurfaceSelection {
    const raw = headerValue(headers, this.header);
    const legacy =
      this.legacyHeader === undefined || this.legacyHeader === this.header
        ? undefined
        : headerValue(headers, this.legacyHeader);
    if (raw !== undefined && legacy !== undefined) {
      throw new SurfaceSelectionError(
        `Send either ${this.header} or ${this.legacyHeader}, not both.`,
      );
    }
    const usedHeader = raw === undefined ? this.legacyHeader : this.header;
    const value = raw ?? legacy;
    let requested = SurfaceSelection.all();
    if (value !== undefined) {
      if (value.length > this.maxLength)
        throw new SurfaceSelectionError(
          `${String(usedHeader)} exceeds the ${this.maxLength}-character limit.`,
        );
      const selectors = value.split(',').map((item) => item.trim());
      if (selectors.length > this.maxRoots)
        throw new SurfaceSelectionError(
          `${String(usedHeader)} exceeds the ${this.maxRoots}-${usedHeader === ROOTS_HEADER ? 'root' : 'selector'} limit.`,
        );
      requested = SurfaceSelection.only(selectors).resolve(index);
    }
    requested = requested.resolve(index);
    if (this.ceiling === undefined) return requested;
    const ceiling = this.ceiling(principal);
    if (!(ceiling instanceof SurfaceSelection)) {
      throw new TypeError('A surface ceiling must return SurfaceSelection.');
    }
    return requested.intersect(ceiling.resolve(index)).resolve(index);
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

// Compatibility names are aliases, not parallel root-only implementations.
export { FixedSurfaceSelector as FixedRootSelector };
export { HeaderSurfaceSelector as HeaderRootSelector };
export type RootCeiling = SurfaceCeiling;
export type RootSelector = SurfaceSelector;
