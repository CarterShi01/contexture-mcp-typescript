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
  LookupFailure,
  ModelValidationError,
  NodeNotFoundError,
  type Prompt,
  type Resource,
} from '../src/index.js';

test('the binding identifies its Contexture specification', () => {
  assert.equal(CONTEXTURE_SPECIFICATION_VERSION, '0.13');
});

test('the public specification identity matches the conformance lock', async () => {
  const lock = JSON.parse(await readFile('conformance/specification.json', 'utf8'));
  assert.equal(lock.specificationVersion, CONTEXTURE_SPECIFICATION_VERSION);
  assert.equal(lock.revision, CONTEXTURE_SPECIFICATION_REVISION);
});

test('application declaration is lazy', () => {
  let constructions = 0;
  const application = defineApplication({
    name: ' operations ',
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

test('the declaration facade snapshots native Prompt and Resource values without loading a Host', async () => {
  const prompt = {
    name: 'approve',
    opens: 'operations/approval',
    description: 'Open the approval procedure.',
    modelMayOpen: false,
  } satisfies Prompt;
  const resource = {
    name: 'runbook',
    opens: 'operations/runbook',
    uri: 'contexture://operations/runbook',
    description: 'Read the operations runbook.',
  } satisfies Resource;
  const application = Contexture({
    name: 'native-declarations',
    roots: [() => ({}) as never],
    prompts: [prompt],
    resources: [resource],
  });
  prompt.name = 'changed-after-declaration';
  resource.uri = 'contexture://changed';

  assert.deepEqual(application.prompts, [
    {
      name: 'approve',
      opens: 'operations/approval',
      description: 'Open the approval procedure.',
      modelMayOpen: false,
    },
  ]);
  assert.deepEqual(application.resources, [
    {
      name: 'runbook',
      opens: 'operations/runbook',
      uri: 'contexture://operations/runbook',
      description: 'Read the operations runbook.',
    },
  ]);
  const facade = await readFile('src/index.ts', 'utf8');
  assert.doesNotMatch(facade, /server\//);
  assert.doesNotMatch(facade, /web\//);
});

test('declaration-local Prompt and Resource validation rejects malformed scalar facts early', () => {
  const root = () => ({}) as never;
  for (const declaration of [
    { prompts: [{ opens: ' ', description: 'Description.' }] },
    { prompts: [{ opens: 'node', description: ' ' }] },
    { prompts: [{ name: ' ', opens: 'node', description: 'Description.' }] },
    { prompts: [{ opens: 'node', description: 'Description.', modelMayOpen: 'yes' as never }] },
    { resources: [{ opens: ' ', uri: 'contexture://item', description: 'Description.' }] },
    { resources: [{ opens: 'node', uri: ' ', description: 'Description.' }] },
    { resources: [{ opens: 'node', uri: 'contexture://item', description: ' ' }] },
    {
      resources: [
        { name: ' ', opens: 'node', uri: 'contexture://item', description: 'Description.' },
      ],
    },
  ]) {
    assert.throws(
      () => defineApplication({ name: 'invalid-publication', roots: [root], ...declaration }),
      TypeError,
    );
  }
});

test('application declaration rejects an empty model root set', () => {
  assert.throws(
    () => defineApplication({ name: 'empty', roots: [] }),
    /at least one model-visible root/,
  );
});

test('application declaration rejects a blank name', () => {
  assert.throws(
    () => defineApplication({ name: ' \t', roots: [() => ({}) as never] }),
    /name must not be empty/,
  );
});

test('the declaration facade exports the documented Contexture error hierarchy', () => {
  assert.ok(new ModelValidationError('invalid') instanceof ContextureError);
  assert.ok(new DeclarationError('invalid') instanceof ModelValidationError);
  assert.ok(
    new NodeNotFoundError({ reason: LookupFailure.NO_SUCH_ROOT, ref: 'missing' }) instanceof
      ContextureError,
  );
});
