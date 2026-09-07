/** The separator used by canonical Contexture references. */
const SEPARATOR = '/';

/** One completion result set, with its total before the caller's limit. */
export interface ReferenceMatches {
  readonly values: readonly string[];
  readonly total: number;
}

/**
 * Compare strings by Unicode code point, matching Python's `sorted(str)`
 * instead of the host locale or JavaScript's UTF-16 code-unit ordering.
 */
export function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference =
      (leftPoints[index]?.codePointAt(0) ?? 0) - (rightPoints[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

/** Rank canonical refs for interactive completion without following `uses`. */
export function matchingRefs(
  refs: Iterable<string>,
  value: string,
  limit: number,
): ReferenceMatches {
  if (!Number.isSafeInteger(limit)) {
    throw new RangeError('A Contexture reference-match limit must be a safe integer.');
  }
  const wanted = value.trim().toLowerCase();
  const matches: Array<readonly [number, number, string]> = [];
  for (const ref of refs) {
    const lowered = ref.toLowerCase();
    const leaf = lowered.slice(lowered.lastIndexOf(SEPARATOR) + 1);
    const rank =
      wanted.length === 0 || lowered.startsWith(wanted)
        ? 0
        : leaf.startsWith(wanted)
          ? 1
          : lowered.split(SEPARATOR).some((part) => part.startsWith(wanted))
            ? 2
            : lowered.includes(wanted)
              ? 3
              : undefined;
    if (rank !== undefined) matches.push([rank, [...ref].length, ref]);
  }
  matches.sort(
    ([leftRank, leftLength, left], [rightRank, rightLength, right]) =>
      leftRank - rightRank || leftLength - rightLength || compareCodePoints(left, right),
  );
  return Object.freeze({
    values: Object.freeze(matches.slice(0, Math.max(0, limit)).map(([, , ref]) => ref)),
    total: matches.length,
  });
}
