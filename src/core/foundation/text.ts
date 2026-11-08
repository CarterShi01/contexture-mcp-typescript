// Python str.strip includes NEL/FS and excludes the ECMAScript BOM whitespace.
const WHITESPACE = new Set([
  0x9, 0xa, 0xb, 0xc, 0xd, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002,
  0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f,
  0x3000,
]);

/** Strip the current reference's whitespace without changing interior text. */
export function stripText(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && WHITESPACE.has(value.charCodeAt(start))) start += 1;
  while (end > start && WHITESPACE.has(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}
