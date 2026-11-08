import assert from 'node:assert/strict';
import test from 'node:test';
import { LosslessNumber } from 'lossless-json';
import { ModelValidationError } from '../src/core/foundation/errors.js';
import {
  canonicalCatalogDigest,
  formatCatalogJson,
  freezeCatalogObject,
  freezeCatalogValue,
  parseCatalogJson,
} from '../src/catalog-json.js';

test('legacy Catalog preserves Unicode code-point ordering rather than managed UTF16 JCS', () => {
  const value = { '\ue000': 1, '\u{1f600}': 2 };
  assert.equal(formatCatalogJson(value), '{"\ue000":1,"\u{1f600}":2}');
  assert.equal(
    canonicalCatalogDigest(value),
    'sha256:871954531859c7572c6279f90eb83a594ddc3a289e8bdc28d2a84ffb8c1a1703',
  );
});

test('Catalog numbers preserve exact native integers and reference finite float formatting', () => {
  const value = parseCatalogJson(
    '{"huge":90071992547409931234567890,"float":1e23,"tiny":0.00001,"zero":-0.0}',
  );
  assert.equal(
    formatCatalogJson(value),
    '{"float":99999999999999991611392,"huge":90071992547409931234567890,"tiny":1e-05,"zero":0}',
  );
  assert.equal(formatCatalogJson({ value: 1e-7 }), '{"value":1e-07}');
  assert.equal(formatCatalogJson({ value: 0.0001 }), '{"value":0.0001}');
  assert.equal(
    formatCatalogJson({ value: 2.2250738585072014e-308 }),
    '{"value":2.2250738585072014e-308}',
  );
  assert.equal(formatCatalogJson({ value: 5e-324 }), '{"value":5e-324}');
  assert.equal(formatCatalogJson({ value: true }), '{"value":true}');
  assert.notEqual(canonicalCatalogDigest({ value: true }), canonicalCatalogDigest({ value: 1 }));
});

test('Catalog pretty and search serializers keep Python separators and zero indentation', () => {
  const value = { b: [1, 2], a: {} };
  assert.equal(formatCatalogJson(value, { spaced: true }), '{"a": {}, "b": [1, 2]}');
  assert.equal(
    formatCatalogJson(value, { indent: 2 }),
    '{\n  "a": {},\n  "b": [\n    1,\n    2\n  ]\n}',
  );
  assert.equal(formatCatalogJson(value, { indent: 0 }), '{\n"a": {},\n"b": [\n1,\n2\n]\n}');
  assert.equal(formatCatalogJson(value, { indent: -1 }), formatCatalogJson(value, { indent: 0 }));
});

test('Catalog frozen metadata is detached and rejects non-data/cycles without evaluating accessors', () => {
  const input = {
    nested: [{ value: 'original' }],
    exact: new LosslessNumber('90071992547409931234567890'),
  };
  const frozen = freezeCatalogObject(input);
  input.nested[0]!.value = 'changed';
  input.exact.value = 'NaN';
  assert.equal(
    formatCatalogJson(frozen),
    '{"exact":90071992547409931234567890,"nested":[{"value":"original"}]}',
  );
  assert.ok(Object.isFrozen(frozen));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse[1] = 1;
  for (const value of [undefined, NaN, Infinity, new Date(), new Set(), cyclic, sparse, '\ud800']) {
    assert.throws(() => freezeCatalogValue(value), ModelValidationError);
  }
  let executions = 0;
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      executions += 1;
      return 3;
    },
  });
  assert.throws(() => freezeCatalogValue(accessor), ModelValidationError);
  assert.equal(executions, 0);
  assert.throws(() => freezeCatalogValue(input.exact), ModelValidationError);
  assert.throws(() => freezeCatalogObject([]), ModelValidationError);
  assert.throws(
    () => freezeCatalogValue({ [Symbol('hidden')]: 'no silent loss' }),
    ModelValidationError,
  );
});
