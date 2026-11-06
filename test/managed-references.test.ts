import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphError } from '../src/core/graph/canonical.js';
import {
  MAX_REFERENCE_BYTES,
  ManagedReference,
  formatReference,
  parseReference,
} from '../src/core/graph/references.js';

// Candidate references.py SHA256, not accepted spec or a public API commitment:
// 653e83ef4b7501bcb03f83c907ff43ad455b15cfb8a6d2bfd6d7243813d47caf
const GENERATION = '12345678-9abc-4def-8123-456789abcdef';
const wire = (graph: string, node = 'bg'): string => `ctxg:v1:${graph}:${GENERATION}:${node}`;

for (const [graph, node, expectedGraph, expectedNode] of [
  ['g', 'n', 'Zw', 'bg'],
  ['图😀', 'node/a:b\x00', '5Zu-8J-YgA', 'bm9kZS9hOmIA'],
  ['e\u0301', 'é', 'ZcyB', 'w6k'],
  ['\uFEFF', '\x00', '77u_', 'AA'],
] as const) {
  test(`reference independently fixed bytes: ${JSON.stringify(graph)}`, () => {
    const expected = `ctxg:v1:${expectedGraph}:${GENERATION}:${expectedNode}`;
    assert.equal(formatReference(graph, GENERATION, node), expected);
    const result = parseReference(expected);
    assert.deepEqual(result, new ManagedReference(graph, GENERATION, node));
    assert.equal(result.toString(), expected);
    assert.equal(result.graphID, graph);
    assert.equal(result.generationUUID, GENERATION);
    assert.equal(result.nodeID, node);
    assert.ok(Object.isFrozen(result));
    assert.equal(Reflect.set(result, 'nodeID', 'other'), false);
    assert.equal('authorized' in result, false);
  });
}

const invalidWires: unknown[] = [
  '',
  'g/n',
  wire('Zw').replace('v1', 'v2'),
  wire('Zw='),
  wire('Zw=='),
  wire('Zx'),
  wire('Z2d'),
  wire('Zw', 'bh'),
  wire(''),
  wire('Zw', ''),
  wire('/w'),
  wire('_w'),
  wire('7aCA'),
  wire('Z'),
  wire('Z w'),
  wire('Zw\n'),
  wire('Zw') + ':extra',
  wire('Zw') + '\n',
  wire('Zw').replace(GENERATION, GENERATION.toUpperCase()),
  wire('Zw').replace(GENERATION, GENERATION.replace(/-/g, '')),
  wire('Zw').replace(GENERATION, `{${GENERATION}}`),
  wire('Zw').replace(GENERATION, 'not-a-uuid'),
  wire('图'),
  'x'.repeat(1025),
  null,
  Buffer.from('ctxg:v1'),
  wire(Buffer.from('x'.repeat(257)).toString('base64url')),
  wire(Buffer.from('😀'.repeat(65)).toString('base64url')),
];
for (const [index, input] of invalidWires.entries()) {
  test(`strict noncanonical reference refusal ${index}`, () => {
    assert.throws(
      () => parseReference(input),
      (error: unknown) => {
        assert.ok(error instanceof GraphError);
        assert.equal(error.code, 'schema_invalid');
        assert.equal(error.location, '');
        assert.equal(error.message, 'Invalid canonical managed reference');
        return true;
      },
    );
  });
}

test('constructor and formatter validate every erased runtime input', () => {
  for (const [graph, generation, node] of [
    ['', GENERATION, 'n'],
    ['g', GENERATION, ''],
    ['g', GENERATION, '\ud800'],
    ['x'.repeat(257), GENERATION, 'n'],
    ['g', GENERATION.toUpperCase(), 'n'],
    ['g', 'bad', 'n'],
    [1, GENERATION, 'n'],
    ['g', null, 'n'],
    ['g', GENERATION, {}],
  ]) {
    assert.throws(() => new ManagedReference(graph, generation, node), GraphError);
    assert.throws(() => formatReference(graph, generation, node), GraphError);
  }
});

test('IDs meet UTF8 limits and opaque controls remain inside exactly five segments', () => {
  for (const identity of [
    '😀'.repeat(64),
    'é'.repeat(128),
    'x'.repeat(256),
    '\x00\x01\t\n\r /:\\?%=#',
  ]) {
    const encoded = formatReference(identity, GENERATION, identity);
    assert.equal(encoded.split(':').length, 5);
    assert.ok(!/[^\x21-\x7e]/.test(encoded));
    assert.ok(Buffer.byteLength(encoded) <= MAX_REFERENCE_BYTES);
    const decoded = parseReference(encoded);
    assert.equal(decoded.graphID, identity);
    assert.equal(decoded.nodeID, identity);
  }
});

test('base64url unused bits are canonical for both possible tail lengths', () => {
  for (const [canonical, alias] of [
    ['Zw', 'Zx'],
    ['Z2c', 'Z2d'],
  ]) {
    assert.equal(parseReference(wire(canonical!)).toString(), wire(canonical!));
    assert.throws(() => parseReference(wire(alias!)), GraphError);
    assert.throws(() => parseReference(wire('Zw', alias!)), GraphError);
  }
});

test('no Unicode or base64 case normalization, UUID version or freshness authority', () => {
  assert.notEqual(
    formatReference('é', GENERATION, 'n'),
    formatReference('e\u0301', GENERATION, 'n'),
  );
  assert.equal(parseReference(wire('dw')).graphID, 'w');
  assert.equal(parseReference(wire('Zw')).graphID, 'g');
  for (const generation of [
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
    '12345678-9abc-0def-0123-456789abcdef',
  ]) {
    const result = parseReference(formatReference('g', generation, 'n'));
    assert.equal(result.generationUUID, generation);
    assert.equal('fresh' in result, false);
  }
});
