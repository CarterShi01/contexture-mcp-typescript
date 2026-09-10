import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  defineApplication,
  definePostProcess,
  defineTool,
  ModelValidationError,
  type Factory,
  type PostProcessDeclaration,
  type RoleDeclaration,
} from '../src/index.js';
import {
  compileApplication,
  compileDisclosureApplication,
  ControllerManager,
  Disclosure,
  SelectedGraph,
  SurfaceSelection,
} from '../src/core/index.js';
import { everyRef } from '../src/inspection.js';

function application() {
  return defineApplication({
    name: 'publication',
    roots: [
      () => ({
        kind: 'role' as const,
        name: 'worker',
        description: 'Complete work.',
        instructions: '  Preserve business whitespace.  ',
        children: [
          () => ({
            kind: 'role' as const,
            name: 'branch',
            description: 'Alternative work.',
            instructions: 'Do branch work.',
          }),
        ],
        postProcess: () =>
          definePostProcess({
            kind: 'role',
            name: 'publish',
            description: 'Preserve the result.',
            instructions: 'Review evidence before preserving it.',
            tools: [
              () =>
                defineTool({
                  kind: 'tool',
                  name: 'save',
                  description: 'Save the result.',
                  readOnly: false,
                  input: z.strictObject({ value: z.string() }),
                  invoke: ({ value }) => ({ saved: value }),
                }),
            ],
          }),
        skills: [
          () => ({
            kind: 'skill' as const,
            name: 'draft',
            description: 'Draft the result.',
            instructions: 'Draft carefully.',
          }),
        ],
      }),
    ],
  });
}

test('Publication is a Role member and finishing contract, not a work branch', () => {
  const index = compileApplication(application());
  const worker = index.find('worker');
  assert.equal(worker.kind, 'role');
  if (worker.kind !== 'role') throw new Error('expected Role');

  assert.deepEqual(
    worker.members().map((node) => node.name),
    ['branch', 'publish', 'draft'],
  );
  assert.deepEqual(
    worker.branches().map((node) => node.name),
    ['branch'],
  );
  assert.deepEqual(
    [...index.walk()].map(([ref]) => ref),
    ['worker', 'worker/branch', 'worker/publish', 'worker/publish/save', 'worker/draft'],
  );
  assert.deepEqual(
    [...index.rolesByLevel()].map(([ref]) => ref),
    ['worker', 'worker/branch'],
  );
  assert.deepEqual(index.signpost('worker/publish/save'), [
    { ref: 'worker', subRoleCount: 1 },
    { ref: 'worker/publish', subRoleCount: 0 },
  ]);

  const disclosure = new Disclosure(index);
  assert.equal('publication' in disclosure.discover(), false);
  const opened = disclosure.open('worker');
  assert.equal(opened.post_process, 'worker/publish');
  assert.deepEqual(
    (opened.roles as readonly { ref: string }[]).map((card) => card.ref),
    ['worker/branch', 'worker/publish'],
  );
  assert.equal(
    (opened.instructions as string).startsWith('  Preserve business whitespace.  \n\n'),
    true,
  );
  assert.match(opened.instructions as string, /Call contexture_open/);
  assert.match(opened.instructions as string, /blocked, fails, or awaits approval/);
  assert.doesNotMatch(JSON.stringify(opened), /Review evidence|input_schema/);

  const publication = disclosure.open('worker/publish');
  assert.equal(publication.instructions, 'Review evidence before preserving it.');
  assert.equal('publication' in publication, false);
  assert.match(JSON.stringify(publication), /worker\/publish\/save/);
});

test('Publication supports promoted surfaces, structural inspection, and disclosure-only tools', () => {
  const index = compileApplication(application());
  const selection = SurfaceSelection.only('worker/publish').resolve(index);
  const promoted = new Disclosure(index, { selection });
  assert.deepEqual(
    (promoted.discover().roles as readonly { ref: string }[]).map((card) => card.ref),
    ['worker/publish'],
  );
  assert.throws(() => promoted.open('worker'));
  const graph = new SelectedGraph(index, selection);
  assert.equal(graph.parentOf(graph.find('worker/publish')), undefined);
  assert.deepEqual(
    [...everyRef(new Disclosure(index))],
    ['worker', 'worker/draft', 'worker/branch', 'worker/publish', 'worker/publish/save'],
  );

  const structural = compileDisclosureApplication(application());
  const opened = new Disclosure(structural).open('worker/publish');
  assert.doesNotMatch(JSON.stringify(opened), /input_schema|read_only/);
  assert.throws(() => structural.bindingOf('worker/publish/save'), ModelValidationError);
});

test('publication factories reject ordinary Roles', () => {
  const ordinary = {
    kind: 'role' as const,
    name: 'ordinary',
    description: 'Not designated.',
    instructions: 'Do ordinary work.',
  } as PostProcessDeclaration;
  assert.throws(
    () =>
      compileApplication(
        defineApplication({
          name: 'invalid-publication',
          roots: [
            () => ({
              kind: 'role',
              name: 'owner',
              description: 'Owner.',
              instructions: 'Work.',
              postProcess: () => ordinary,
            }),
          ],
        }),
      ),
    /definePostProcess/,
  );
});

test('ControllerManager preserves Publication designation in fresh snapshots', () => {
  const manager = new ControllerManager();
  manager.registerRole(application().roots[0]! as Factory<RoleDeclaration>);
  const first = manager.compile('first');
  const second = manager.compile('second');
  const firstRole = first.find('worker');
  const secondRole = second.find('worker');
  assert.equal(firstRole.kind, 'role');
  assert.equal(secondRole.kind, 'role');
  if (firstRole.kind !== 'role' || secondRole.kind !== 'role') throw new Error('expected Roles');
  assert.equal(firstRole.postProcess?.name, 'publish');
  assert.equal(secondRole.postProcess?.name, 'publish');
  assert.notEqual(firstRole.postProcess, secondRole.postProcess);
});
