import { caseFold } from 'unicode-case-folding';

// These mappings were assigned after the recorded Unicode 15 reference.
const LATER_FOLDING = new Set([
  0x1c89, 0xa7cb, 0xa7cc, 0xa7ce, 0xa7d2, 0xa7d4, 0xa7da, 0xa7dc, 0xa7dd, 0xa7e2, 0xab6c, 0xab6d,
  0x1df40, 0x1df48, 0x1df4a, 0x1df4d, 0x1df51, 0x1df68, 0x1df6a, 0x1df6c, 0x1df6e, 0x1df72, 0x1df74,
  0x1df76, 0x1df78, 0x1df7a, 0x1df7c, 0x1df7e, 0x1df95,
]);

/** Reuse maintained full folding while retaining the current reference profile. */
export function foldCatalogText(value: string): string {
  const result: string[] = [];
  for (const character of value) {
    const point = character.codePointAt(0)!;
    result.push(
      LATER_FOLDING.has(point) ||
        (point >= 0x10d50 && point <= 0x10d65) ||
        (point >= 0x16ea0 && point <= 0x16eb8)
        ? character
        : caseFold(character),
    );
  }
  return result.join('');
}
