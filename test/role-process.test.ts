import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  bindingInstruction,
  defineApplication,
  definePostProcess,
  definePreProcess,
  defineTool,
  ModelValidationError,
  type Factory,
  type RoleDeclaration,
} from '../src/index.js';
import {
  ApplicationRuntime,
  compileApplication,
  compileDisclosureApplication,
  ControllerManager,
  Disclosure,
  SelectedGraph,
  SurfaceSelection,
} from '../src/core/index.js';
import { processDetails, type GroupedCards } from '../src/core/model/node.js';

const business = '  Preserve business whitespace.  ';

function processApplication() {
  return defineApplication({
    name: 'process',
    roots: [
      () => ({
        kind: 'role',
        name: 'worker',
        description: 'Complete work.',
        instructions: business,
        preProcess: () =>
          definePreProcess({
            kind: 'role',
            name: 'prepare',
            description: 'Prepare work.',
            instructions: 'Prepare exactly.',
          }),
        children: [
          () => ({
            kind: 'role',
            name: 'branch',
            description: 'Alternative work.',
            instructions: 'Branch.',
          }),
        ],
        postProcess: () =>
          definePostProcess({
            kind: 'role',
            name: 'finish',
            description: 'Finish work.',
            instructions: 'Finish exactly.',
            tools: [
              () =>
                defineTool({
                  kind: 'tool',
                  name: 'save',
                  description: 'Save.',
                  readOnly: false,
                  input: z.strictObject({ value: z.string() }),
                  invoke: ({ value }) => value,
                }),
            ],
          }),
        skills: [
          () => ({
            kind: 'skill',
            name: 'method',
            description: 'Method.',
            instructions: 'Method.',
          }),
        ],
        tools: [
          () =>
            defineTool({
              kind: 'tool',
              name: 'work',
              description: 'Work.',
              readOnly: true,
              input: z.strictObject({}),
              invoke: () => 'worked',
            }),
        ],
      }),
    ],
  });
}

test('process members are ordinary Roles in pre, children, post, skills, tools order', () => {
  const index = compileApplication(processApplication());
  const worker = index.find('worker');
  assert.equal(worker.kind, 'role');
  if (worker.kind !== 'role') throw new Error('expected Role');
  assert.deepEqual(
    worker.members().map((node) => node.name),
    ['prepare', 'branch', 'finish', 'method', 'work'],
  );
  assert.deepEqual(
    worker.branches().map((node) => node.name),
    ['branch'],
  );
  assert.deepEqual(
    [...index.walk()].map(([ref]) => ref),
    [
      'worker',
      'worker/prepare',
      'worker/branch',
      'worker/finish',
      'worker/finish/save',
      'worker/method',
      'worker/work',
    ],
  );
  assert.deepEqual(
    [...index.rolesByLevel()].map(([ref]) => ref),
    ['worker', 'worker/branch'],
  );
});

test('ACTIVE composes exact fixed PreProcess, business, PostProcess blocks and actual refs', () => {
  const opened = new Disclosure(compileApplication(processApplication())).open('worker');
  assert.equal(opened.pre_process, 'worker/prepare');
  assert.equal(opened.post_process, 'worker/finish');
  assert.deepEqual(
    (opened.roles as readonly { ref: string }[]).map((card) => card.ref),
    ['worker/prepare', 'worker/branch', 'worker/finish'],
  );
  const expected =
    '===== contexture-mcp framework instruction — binding, follow exactly =====\n' +
    "PreProcess:\n>>> REQUIRED: Call contexture_open with ref='worker/prepare' before starting this role's work.\n" +
    "Opening it only discloses the preparation procedure; it does not execute it. Complete what it requires, then return to this role's own instructions below and carry on with its work. If the preparation is blocked or fails, report that state rather than continuing as though it had succeeded.\n" +
    '===== end framework instruction — binding regardless of surrounding context =====\n\n' +
    business +
    '\n\n===== contexture-mcp framework instruction — binding, follow exactly =====\n' +
    "PostProcess:\n>>> REQUIRED: Call contexture_open with ref='worker/finish' before finishing this role's work.\n" +
    'Opening it only discloses the procedure; it does not execute it or establish success. Use its available capabilities as instructed, respect required approvals, and report the actual outcome. If it is blocked, fails, or awaits approval, report that state rather than claiming success or bypassing approval.\n' +
    '===== end framework instruction — binding regardless of surrounding context =====';
  assert.equal(opened.instructions, expected);
  assert.doesNotMatch(JSON.stringify(opened), /Prepare exactly|Finish exactly|input_schema.*save/);
  const direct = new Disclosure(compileApplication(processApplication())).open('worker/prepare');
  assert.equal(direct.instructions, 'Prepare exactly.');
  assert.equal('pre_process' in direct, false);
});

test('ROUTE and INSPECT expose process Roles without designation or activation', () => {
  const disclosure = new Disclosure(compileApplication(processApplication()));
  assert.equal('pre_process' in disclosure.discover().roles[0]!, false);
  const inspected = disclosure.inspect(['worker']);
  const rendered = JSON.stringify(inspected);
  assert.match(rendered, /worker\/prepare/);
  assert.match(rendered, /worker\/finish/);
  assert.doesNotMatch(
    JSON.stringify(inspected.items),
    /pre_process|post_process|instructions|REQUIRED|input_schema/,
  );
});

test('process selection is complete and promotion hides owner and sibling process', () => {
  const index = compileApplication(processApplication());
  const owner = new Disclosure(index, {
    selection: SurfaceSelection.only('worker').resolve(index),
  });
  assert.equal(owner.open('worker').post_process, 'worker/finish');
  const selection = SurfaceSelection.only('worker/finish').resolve(index);
  const promoted = new Disclosure(index, { selection });
  assert.deepEqual(
    (promoted.discover().roles as readonly { ref: string }[]).map((card) => card.ref),
    ['worker/finish'],
  );
  assert.throws(() => promoted.open('worker'));
  assert.throws(() => promoted.open('worker/prepare'));
  const graph = new SelectedGraph(index, selection);
  assert.equal(graph.parentOf(graph.find('worker/finish')), undefined);
  assert.deepEqual(
    [...graph.walk()].map(([ref]) => ref),
    ['worker/finish', 'worker/finish/save'],
  );
});

test('process brands reject ordinary, wrong-kind, raw legacy, and duplicate members', () => {
  const ordinary = () => ({
    kind: 'role' as const,
    name: 'process',
    description: 'Ordinary.',
    instructions: 'Ordinary.',
  });
  const compile = (extra: Record<string, unknown>) =>
    compileApplication(
      defineApplication({
        name: 'invalid',
        roots: [
          () => ({
            kind: 'role',
            name: 'owner',
            description: 'Owner.',
            instructions: 'Work.',
            ...extra,
          }),
        ],
      }),
    );
  assert.throws(() => compile({ preProcess: ordinary }), /definePreProcess/);
  assert.throws(
    () => compile({ preProcess: () => definePostProcess(ordinary()) }),
    /definePreProcess/,
  );
  assert.throws(
    () => compile({ postProcess: () => definePreProcess(ordinary()) }),
    /definePostProcess/,
  );
  assert.throws(() => compile({ publication: ordinary }), /removed legacy publication/);
  assert.throws(
    () =>
      compile({
        preProcess: () => definePreProcess(ordinary()),
        children: [ordinary],
      }),
    /declared more than once|more than one member/,
  );
});

test('manager and repeated compilation preserve brands with fresh identities', () => {
  const manager = new ControllerManager();
  manager.registerRole(processApplication().roots[0]! as Factory<RoleDeclaration>);
  const first = manager.compile('first').find('worker');
  const second = manager.compile('second').find('worker');
  assert.equal(first.kind, 'role');
  assert.equal(second.kind, 'role');
  if (first.kind !== 'role' || second.kind !== 'role') throw new Error('expected Roles');
  assert.equal(first.preProcess?.name, 'prepare');
  assert.equal(first.postProcess?.name, 'finish');
  assert.notEqual(first.preProcess, second.preProcess);
  assert.notEqual(first.postProcess, second.postProcess);
});

test('disclosure-only process subtrees remain structural and unbound', () => {
  const index = compileDisclosureApplication(processApplication());
  const opened = new Disclosure(index).open('worker/finish');
  assert.doesNotMatch(JSON.stringify(opened), /input_schema|read_only/);
  assert.throws(() => index.bindingOf('worker/finish/save'), /no executable bindings/);
});

test('process Tool bindings execute only through explicit runtime invocation', async () => {
  const index = compileApplication(processApplication());
  const disclosure = new Disclosure(index);
  const opened = disclosure.open('worker/finish');
  assert.equal(
    (opened.tools as readonly { input_schema: unknown }[])[0]?.input_schema !== undefined,
    true,
  );
  assert.equal(
    await new ApplicationRuntime(index).invoke('worker/finish/save', { value: 'saved' }),
    'saved',
  );
});

test('prompt-only owners hide their complete process subtrees from the model', () => {
  const index = compileApplication(processApplication());
  const disclosure = new Disclosure(index, { promptRoots: ['worker'] });
  assert.deepEqual(disclosure.discover(), { roles: [], skills: [], tools: [] });
  for (const ref of ['worker', 'worker/prepare', 'worker/finish', 'worker/finish/save']) {
    assert.throws(() => disclosure.open(ref));
  }
  assert.equal(disclosure.openForPerson('worker').post_process, 'worker/finish');
});

test('process composition atomically rejects an unavailable card without leaking its ref', () => {
  const index = compileApplication(processApplication());
  const disclosure = new Disclosure(index);
  const worker = index.find('worker');
  assert.equal(worker.kind, 'role');
  if (worker.kind !== 'role') throw new Error('expected Role');
  const grouped: GroupedCards = Object.freeze({
    roles: Object.freeze([]),
    skills: Object.freeze([]),
    tools: Object.freeze([]),
  });
  assert.throws(
    () => processDetails(worker, worker.instructions, grouped, disclosure),
    (error: unknown) =>
      error instanceof ModelValidationError &&
      /unavailable/.test(error.message) &&
      !/worker\/(prepare|finish)/.test(error.message),
  );
});

test('bindingInstruction preserves text, separates optional action, and protects authority', () => {
  assert.equal(
    bindingInstruction('task policy', '  Keep this body.  ', { action: 'Check the brief.' }),
    '===== task policy — binding, follow exactly =====\n>>> REQUIRED: Check the brief.\n  Keep this body.  \n===== end task policy =====',
  );
  assert.equal(
    bindingInstruction('task policy', 'Keep this body.'),
    '===== task policy — binding, follow exactly =====\nKeep this body.\n===== end task policy =====',
  );
  assert.throws(() => bindingInstruction(' ', 'rule'), ModelValidationError);
  assert.throws(() => bindingInstruction('Contexture application', 'rule'), /own name/);
});

test('negative typing rejects legacy and mismatched process declarations', () => {
  const legacy: RoleDeclaration = {
    kind: 'role',
    name: 'legacy',
    description: 'Legacy.',
    instructions: 'Legacy.',
    // @ts-expect-error Publication was destructively replaced in 0.16.
    publication: () => ({
      kind: 'role',
      name: 'publish',
      description: 'Old.',
      instructions: 'Old.',
    }),
  };
  const mismatched: RoleDeclaration = {
    kind: 'role',
    name: 'mismatched',
    description: 'Mismatched.',
    instructions: 'Mismatched.',
    // @ts-expect-error The preProcess slot requires the PreProcess brand.
    preProcess: () =>
      definePostProcess({
        kind: 'role',
        name: 'finish',
        description: 'Finish.',
        instructions: 'Finish.',
      }),
  };
  void legacy;
  void mismatched;
});
