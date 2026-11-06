import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CANONICAL_PROFILE,
  DOMAINS,
  GraphError,
  MAX_COUNTER,
  MAX_JSON_DEPTH,
  canonicalDigest,
  canonicalJSON,
  decodeJSON,
  freezeJSON,
  parseCounter,
  thawJSON,
  validateID,
} from '../src/core/graph/canonical.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const canonical = (value: unknown): string => new TextDecoder().decode(canonicalJSON(value));
function rejects(action: () => unknown, location = '', code = 'schema_invalid'): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof GraphError);
    assert.equal(error.code, code);
    assert.equal(error.location, location);
    return true;
  });
}

// Test-only transcription, NOT an accepted spec snapshot or a Python self-oracle.
// Candidate spec/managed/rawcanonical/vectors.json SHA256:
// ebe15fe56dd87714b5e2d4b240047aff7ea131565bda506d69c68f55589b4b9e
// Source canonical.py SHA256:
// 5bb1890b5dd1240b96709fbcf84132a49812776a5109dc99f34d97ce6513dc46
const candidateRawVectors: readonly (readonly [string, string, string | null])[] = [
  [
    'utf16-not-codepoint',
    '7b22ee8080223a312c22f09f9880223a327d',
    '7b22f09f9880223a322c22ee8080223a317d',
  ],
  ['negative-zero', '2d302e30', '30'],
  [
    'fraction-rounding',
    '3333333333333333332e3333333333333239',
    '3333333333333333332e33333333333333',
  ],
  ['duplicate-escaped-key', '7b2261223a312c225c7530303631223a327d', null],
  ['unsafe-exponent-integer', '31653230', null],
  ['unsafe-integer', '39303037313939323534373430393933', null],
  ['nonzero-underflow', '31652d39393939', null],
  ['overflow', '316539393939', null],
  ['lone-surrogate', '225c756438303022', null],
  ['invalid-utf8', '22ff22', null],
  ['utf8-bom', 'efbbbf7b7d', null],
];

for (const [name, raw, expected] of candidateRawVectors) {
  test(`candidate raw bytes: ${name}`, () => {
    const input = Buffer.from(raw, 'hex');
    if (expected === null) rejects(() => decodeJSON(input));
    else assert.equal(Buffer.from(canonicalJSON(decodeJSON(input))).toString('hex'), expected);
  });
}

const accepted: readonly (readonly [string, string])[] = [
  ['9007199254740991', '9007199254740991'],
  ['-9007199254740991', '-9007199254740991'],
  ['90071992547409910e-1', '9007199254740991'],
  ['900719925474099100000000e-8', '9007199254740991'],
  ['9.007199254740991e15', '9007199254740991'],
  ['9007199254740991.00000000000000000', '9007199254740991'],
  ['9007199254740991.9', '9007199254740992'],
  ['123456789012345678901234567890.1', '1.2345678901234568e+29'],
  ['333333333.33333329', '333333333.3333333'],
  ['0.1', '0.1'],
  ['0.000001', '0.000001'],
  ['0.0000001', '1e-7'],
  ['5e-324', '5e-324'],
  ['3e-324', '5e-324'],
  ['-0', '0'],
  ['-0.0', '0'],
  ['0e9999999999999999999999999', '0'],
  ['-0.000e-9999999999999999999999999', '0'],
  ['1e0000000000000000000000000000000000001', '10'],
  ['"\\ud83d\\ude00"', '"😀"'],
  [' \t\r\n{"x":[true,false,null]} \n', '{"x":[true,false,null]}'],
];
for (const [raw, expected] of accepted) {
  test(`raw lexical acceptance: ${raw}`, () => {
    assert.equal(canonical(decodeJSON(bytes(raw))), expected);
  });
}

const refused = [
  '{"a":1,"a":2}',
  '{"x":{"a":0,"\\u0061":1}}',
  '{"__proto__":1,"__proto__":2}',
  '"\\udfff"',
  '{"\\ud800":0}',
  'NaN',
  'Infinity',
  '-Infinity',
  '9007199254740992',
  '-9007199254740993',
  '9007199254740993.0',
  '9.007199254740992e15',
  '-9.007199254740992e15',
  '90071992547409920e-1',
  '900719925474099200000000e-8',
  '9007199254740992.00000000000000000',
  '123456789012345678901234567890.0',
  '1e20',
  '-1E20',
  '1e21',
  '1e9999',
  '1e-9999',
  '-1e-9999',
  '2e-324',
  '1e9999999999999999999999999999',
  '1e-9999999999999999999999999999',
  '{',
  '{}{}',
  '01',
  '-01',
  '+1',
  '1.',
  '.1',
  '1e',
  '1e+',
  '[1,]',
  '{"a":1,}',
  '{a:1}',
  'true false',
  '"line\nfeed"',
  '"\\x00"',
  '"\\uZZZZ"',
  '"unterminated',
  '\uFEFF{}',
];
for (const raw of refused) {
  test(`raw lexical refusal: ${JSON.stringify(raw)}`, () => rejects(() => decodeJSON(bytes(raw))));
}

test('raw integer exponent lexemes cannot pass by binary64 rounding', () => {
  // Both would become the same unsafe binary64 number if parsed before gating.
  assert.equal(Number('9007199254740993e0'), Number('9007199254740992e0'));
  rejects(() => decodeJSON(bytes('9007199254740993e0')));
  rejects(() => decodeJSON(bytes('9007199254740993.000000000000000000000')));
  assert.equal(canonical(decodeJSON(bytes('9007199254740991.9'))), '9007199254740992');
});

test('huge exponents and coefficients are bounded without giant BigInt powers', () => {
  const exponent = '9'.repeat(10000);
  rejects(() => decodeJSON(bytes(`1e${exponent}`)));
  rejects(() => decodeJSON(bytes(`1e-${exponent}`)));
  assert.equal(canonical(decodeJSON(bytes(`-0e${exponent}`))), '0');
  const zeros = '0'.repeat(10000);
  assert.equal(canonical(decodeJSON(bytes(`1${zeros}e-10000`))), '1');
  rejects(() => decodeJSON(bytes(`9${zeros}e-9984`)));
});

test('negative zero survives decode/freeze/thaw and serializes as JCS zero', () => {
  for (const raw of ['-0', '-0.0', '-0e999999999999999999']) {
    assert.ok(Object.is(thawJSON(freezeJSON(decodeJSON(bytes(raw)))), -0));
    assert.equal(canonical(decodeJSON(bytes(raw))), '0');
  }
});

test('strict raw bytes refuse malformed, overlong, surrogate and non-UTF8 encodings', () => {
  for (const hex of [
    '22ff22',
    '22eda08022',
    '22c08022',
    '22f490808022',
    '22e28222',
    'fffe7b007d00',
    '007b007d',
  ]) {
    rejects(() => decodeJSON(Buffer.from(hex, 'hex')));
  }
  for (const value of ['{}', {}, null, new ArrayBuffer(2), new DataView(new ArrayBuffer(2))]) {
    rejects(() => decodeJSON(value));
  }
});

test('JCS uses UTF16 key order including numeric keys, escaping and no normalization', () => {
  const value = { '2': 2, '10': 10, '\ue000': 1, '😀': 2, é: 'é', 'e\u0301': 'e\u0301' };
  assert.equal(canonical(value), '{"10":10,"2":2,"é":"é","é":"é","😀":2,"\ue000":1}');
  assert.notEqual(canonical(value), JSON.stringify(value));
  assert.equal(
    canonical({ text: '\b\t\n\f\r"\\/\x00' }),
    '{"text":"\\b\\t\\n\\f\\r\\"\\\\/\\u0000"}',
  );
  assert.notEqual(canonical('e\u0301'), canonical('é'));
  const text = 'line\r\nline\t\x00 e\u0301 é\u2028\u2029';
  assert.equal(decodeJSON(canonicalJSON(text)), text);
  assert.equal(CANONICAL_PROFILE, 'contexture.canonical/jcs-binary64-safeint-v1');
});

test('native binary64 writer preserves float semantics, not raw lexeme provenance', () => {
  assert.equal(
    canonical([1e20, 1e21, 1e-6, 1e-7, -0]),
    '[100000000000000000000,1e+21,0.000001,1e-7,0]',
  );
  rejects(() => decodeJSON(bytes('1e20')));
  rejects(() => freezeJSON(9007199254740992n));
});

test('freeze/thaw detach each alias and reject all mutable Map leakage', () => {
  const child = { nested: [1] };
  const source = [child, child];
  const frozen = freezeJSON(source);
  assert.ok(Array.isArray(frozen));
  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen[0]));
  assert.notEqual(frozen[0], frozen[1]);
  assert.equal(Reflect.set(frozen[0] as object, 'nested', []), false);
  child.nested.push(2);
  assert.equal(canonical(frozen), '[{"nested":[1]},{"nested":[1]}]');
  const thawed = thawJSON(frozen);
  assert.ok(Array.isArray(thawed));
  assert.notEqual(thawed[0], thawed[1]);
  assert.notEqual(thawed[0], frozen[0]);
  assert.deepEqual(freezeJSON(frozen), frozen);
  rejects(() => freezeJSON(new Map([['x', 1]])));
});

test('ordinary objects safely retain __proto__, constructor and schema URL strings', () => {
  const raw =
    '{"__proto__":{"polluted":true},"constructor":1,"$schema":"https://invalid.example/schema"}';
  const parsed = decodeJSON(bytes(raw));
  const frozen = freezeJSON(parsed);
  assert.equal(
    canonical(frozen),
    '{"$schema":"https://invalid.example/schema","__proto__":{"polluted":true},"constructor":1}',
  );
  const thawed = thawJSON(frozen);
  assert.equal(Object.getPrototypeOf(thawed), Object.prototype);
  assert.equal(Object.hasOwn(thawed as object, '__proto__'), true);
  assert.equal(Object.hasOwn({}, 'polluted'), false);
});

test('cycles/nonJSON/accessors are refused without invoking user getters', () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  rejects(() => freezeJSON(cycle), '/0');
  let getterCalls = 0;
  const accessor = {
    get secret() {
      getterCalls++;
      return 'secret';
    },
  };
  const sparse = new Array(2);
  const custom = Object.assign([1], { extra: 2 });
  const symbol = { [Symbol('key')]: 1 };
  for (const value of [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    new Date(),
    new Set(),
    new Uint8Array(1),
    () => 1,
    /x/,
    '\ud800',
    accessor,
    sparse,
    custom,
    symbol,
  ]) {
    for (const fn of [freezeJSON, thawJSON, canonicalJSON]) rejects(() => fn(value));
  }
  assert.equal(getterCalls, 0);
  rejects(() => canonicalJSON({ 'a/b~c': { x: Infinity } }), '/a~1b~0c/x');
  rejects(() => decodeJSON(bytes('{"a/b~c":"\\ud800"}')), '/a~1b~0c');
});

test('depth and diagnostic pointer budgets are explicit and bounded', () => {
  const raw = '['.repeat(MAX_JSON_DEPTH + 1) + '0' + ']'.repeat(MAX_JSON_DEPTH + 1);
  rejects(() => decodeJSON(bytes(raw)), '', 'limit_exceeded');
  let nested: unknown = 0;
  for (let i = 0; i <= MAX_JSON_DEPTH; i++) nested = [nested];
  for (const fn of [freezeJSON, thawJSON, canonicalJSON])
    rejects(() => fn(nested), '', 'limit_exceeded');
  const key = 'x'.repeat(4097);
  assert.equal(canonical({ [key]: 0 }), `{"${key}":0}`);
  rejects(() => thawJSON({ [key]: Infinity }));
  rejects(() => thawJSON({ ['~/'.repeat(1025)]: Infinity }));
});

test('exact eleven domains hash prefix NUL and independently specified JCS bytes', () => {
  const domains = [
    'contexture.graph/v1',
    'contexture.facts/v1',
    'contexture.manifest/v1',
    'contexture.journal-record/v1',
    'contexture.view/v1',
    'contexture.page/v1',
    'contexture.command/v1',
    'contexture.preview/v1',
    'contexture.journal-payload/v1',
    'contexture.checkpoint/v1',
    'contexture.file-journal-backup/v1',
  ];
  assert.deepEqual(DOMAINS, domains);
  assert.ok(Object.isFrozen(DOMAINS));
  const results = new Set<string>();
  for (const domain of domains) {
    const expected =
      'sha256:' +
      createHash('sha256')
        .update(bytes(`${domain}\0{"10":10,"2":2}`))
        .digest('hex');
    assert.equal(canonicalDigest({ '2': 2, '10': 10 }, domain), expected);
    results.add(expected);
  }
  assert.equal(results.size, 11);
  assert.equal(
    canonicalDigest(null, 'contexture.graph/v1'),
    'sha256:b6c3eff852aaaefee276783389d2c7115dc1fc3ced6a1a90216daa936bf5ef3a',
  );
  for (const domain of [
    '',
    null,
    1,
    'contexture.graph/v2',
    'contexture.graph/v1\0',
    'contexture.transaction/v1',
    'contexture.authorized-batch/v1',
    'contexture.node-catalog/v1',
  ]) {
    rejects(() => canonicalDigest({}, domain));
  }
  assert.notEqual(canonicalDigest({}, domains[0]), canonicalDigest({ optional: null }, domains[0]));
  assert.notEqual(canonicalDigest([1, 2], domains[0]), canonicalDigest([2, 1], domains[0]));
});

test('wire counter arithmetic stays exact and code/location remain immutable', () => {
  for (const wire of ['0', '1', '9007199254740993', '99999999999999999999']) {
    assert.equal(parseCounter(wire).toString(), wire);
  }
  assert.equal(parseCounter('99999999999999999999'), MAX_COUNTER);
  assert.equal(parseCounter('9007199254740993') + 1n, 9007199254740994n);
  for (const wire of [
    0,
    1,
    true,
    null,
    '',
    '00',
    '01',
    '-0',
    '+1',
    '1.0',
    '1e2',
    ' 1',
    '1\n',
    '١',
    '１',
    '100000000000000000000',
    '9'.repeat(10000),
  ]) {
    rejects(() => parseCounter(wire, '/revision'), '/revision');
  }
  const error = new GraphError('schema_invalid', 'Invalid value', '/x');
  assert.equal(Reflect.set(error, 'code', 'changed'), false);
  assert.equal(Reflect.set(error, 'location', '/changed'), false);
  assert.throws(() => new GraphError('schema_invalid', 'Invalid value', '/bad~2'));
  assert.throws(
    () => decodeJSON(bytes('{"credential":"never-echo-this","x":{"a":1,"a":2}}')),
    (error: unknown) => {
      assert.ok(error instanceof GraphError);
      assert.ok(!error.message.includes('never-echo-this'));
      return true;
    },
  );
});

test('ID byte limits preserve opaque scalar text and locations', () => {
  for (const value of [
    'a',
    '\x00',
    'a/b:c',
    '😀'.repeat(64),
    'é'.repeat(128),
    'e\u0301',
    'é',
    'x'.repeat(256),
    '\uFEFF',
  ]) {
    assert.equal(validateID(value), value);
  }
  for (const value of [
    '',
    'x'.repeat(257),
    '😀'.repeat(65),
    'é'.repeat(129),
    '\ud800',
    '\udfff',
    1,
    null,
    bytes('a'),
  ]) {
    rejects(() => validateID(value, '/graph_id'), '/graph_id');
  }
});

test('candidate graph primitives import no filesystem/process/SDK/Host code', async () => {
  for (const file of ['canonical', 'references']) {
    const source = await readFile(new URL(`../src/core/graph/${file}.ts`, import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1]);
    assert.deepEqual(imports, file === 'canonical' ? ['node:crypto'] : ['./canonical.js']);
    assert.equal(/\b(?:fetch|eval)\s*\(/.test(source), false);
  }
});
