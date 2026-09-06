import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CONTEXTURE_SPECIFICATION_REVISION,
  CONTEXTURE_SPECIFICATION_VERSION,
  Contexture,
  ContextureError,
  DeclarationError,
  defineApplication,
  ModelValidationError,
  NodeNotFoundError,
} from '../src/index.js';

test('the binding identifies its Contexture specification', () => {
  assert.equal(CONTEXTURE_SPECIFICATION_VERSION, '0.12');
});

test('the public specification identity matches the conformance lock', async () => {
  const lock = JSON.parse(await readFile('conformance/specification.json', 'utf8'));
  assert.equal(lock.specificationVersion, CONTEXTURE_SPECIFICATION_VERSION);
  assert.equal(lock.revision, CONTEXTURE_SPECIFICATION_REVISION);
});

test('application declaration is lazy', () => {
  let constructions = 0;
  const application = defineApplication({
    name: 'operations',
    roots: [
      () => {
        constructions += 1;
        return {
          kind: 'role',
          name: 'operations',
          description: 'Handle routine operational questions.',
          instructions: 'Inspect first.',
        };
      },
    ],
  });

  assert.equal(application.name, 'operations');
  assert.equal(constructions, 0);
});

test('Contexture is the public lazy declaration facade', () => {
  const application = Contexture({
    name: 'facade',
    roots: [
      () => ({
        kind: 'tool',
        name: 'status',
        description: 'Read status.',
        readOnly: true,
        input: {} as never,
        invoke: () => 'ok',
      }),
    ],
  });
  assert.equal(application.name, 'facade');
});

test('application declaration rejects an empty model root set', () => {
  assert.throws(
    () => defineApplication({ name: 'empty', roots: [] }),
    /at least one model-visible root/,
  );
});

test('the declaration facade exports the documented Contexture error hierarchy', () => {
  assert.ok(new ModelValidationError('invalid') instanceof ContextureError);
  assert.ok(new DeclarationError('invalid') instanceof ModelValidationError);
  assert.ok(new NodeNotFoundError('missing') instanceof ContextureError);
});
