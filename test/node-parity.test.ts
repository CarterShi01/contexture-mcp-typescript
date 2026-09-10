import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  branchesOf,
  cardOf,
  compileNode,
  CompileLevel,
  defineApplication,
  groupCards,
  membersOf,
  routeOf,
  type ContextNode,
  type View,
} from '../src/index.js';
import { compileApplication, Disclosure, ModelValidationError } from '../src/core/index.js';

type IsExact<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;

function nodeFixture() {
  return compileApplication(
    defineApplication({
      name: 'node-parity',
      roots: [
        () => ({
          kind: 'role',
          name: 'operations',
          description: 'Operate.',
          instructions: 'Choose work.',
          children: [
            () => ({
              kind: 'role',
              name: 'incidents',
              description: 'Handle incidents.',
              instructions: 'Read evidence.',
            }),
          ],
          skills: [
            () => ({
              kind: 'skill',
              name: 'triage',
              description: 'Triage.',
              instructions: 'Classify.',
            }),
          ],
          tools: [
            () => ({
              kind: 'tool',
              name: 'status',
              description: 'Read status.',
              readOnly: true,
              input: z.object({}),
              invoke: () => 'ok',
            }),
          ],
        }),
      ],
    }),
  );
}

test('Node facade preserves fixed compile levels and immutable route facts', () => {
  assert.deepEqual(CompileLevel, { ROUTE: 'route', INSPECT: 'inspect', ACTIVE: 'active' });
  assert.equal(Object.isFrozen(CompileLevel), true);
  const declaration = {
    kind: 'role' as const,
    name: 'operations',
    description: 'Operate.',
    instructions: 'Inspect.',
  };
  assert.deepEqual(routeOf(declaration), {
    kind: 'role',
    name: 'operations',
    description: 'Operate.',
  });
  assert.deepEqual(compileNode(declaration), routeOf(declaration));
  assert.throws(() => compileNode(declaration, 'middle'), ModelValidationError);
});

test('compiled nodes expose canonical containment across every kind', () => {
  const index = nodeFixture();
  const root = index.find('operations');
  if (root.kind !== 'role') throw new Error('fixture root must be a Role');
  const members = membersOf(root);
  const membersAreContextNodes: IsExact<(typeof members)[number], ContextNode> = true;
  assert.equal(membersAreContextNodes, true);
  assert.deepEqual(
    branchesOf(root).map((node) => node.name),
    ['incidents'],
  );
  assert.deepEqual(
    members.map((node) => node.name),
    ['incidents', 'triage', 'status'],
  );
  for (const ref of ['operations/incidents', 'operations/triage', 'operations/status']) {
    const node = index.find(ref);
    assert.equal(index.refOf(node), ref);
    assert.deepEqual(node.branches(), []);
    assert.deepEqual(node.members(), []);
    assert.deepEqual(branchesOf(node), []);
    assert.deepEqual(membersOf(node), []);
  }
});

test('standalone active compilation retains registered canonical references', () => {
  const index = nodeFixture();
  assert.deepEqual(compileNode(index.find('operations/status'), CompileLevel.ACTIVE), {
    kind: 'tool',
    name: 'status',
    description: 'Read status.',
    ref: 'operations/status',
    read_only: true,
    input_schema: {},
  });
  assert.deepEqual(compileNode(index.find('operations/incidents'), CompileLevel.ACTIVE), {
    kind: 'role',
    name: 'incidents',
    description: 'Handle incidents.',
    ref: 'operations/incidents',
    instructions: 'Read evidence.',
    roles: [],
    skills: [],
    tools: [],
  });
});

test('uncompiled Role containment never evaluates lazy factories', () => {
  let builds = 0;
  const declaration = {
    kind: 'role' as const,
    name: 'operations',
    description: 'Operate.',
    instructions: 'Inspect.',
    children: [
      () => {
        builds += 1;
        return {
          kind: 'role' as const,
          name: 'child',
          description: 'Child.',
          instructions: 'Continue.',
        };
      },
    ],
  };
  assert.throws(() => branchesOf(declaration), /compiled Index snapshot/);
  assert.throws(() => membersOf(declaration), /compiled Index snapshot/);
  assert.equal(builds, 0);
});

test('Disclosure implements the Node View lifecycle without changing route cards', () => {
  const index = nodeFixture();
  const view: View<(typeof index.roots)[number]> = new Disclosure(index);
  const root = index.find('operations');
  const status = index.find('operations/status');

  assert.deepEqual(cardOf(status, view), {
    kind: 'tool',
    name: 'status',
    description: 'Read status.',
    ref: 'operations/status',
    read_only: true,
    input_schema: { type: 'object', properties: {} },
  });
  assert.deepEqual(compileNode(root, CompileLevel.ACTIVE, view), {
    kind: 'role',
    name: 'operations',
    description: 'Operate.',
    ref: 'operations',
    instructions: 'Choose work.',
    roles: [
      {
        kind: 'role',
        name: 'incidents',
        description: 'Handle incidents.',
        ref: 'operations/incidents',
      },
    ],
    skills: [
      {
        kind: 'skill',
        name: 'triage',
        description: 'Triage.',
        ref: 'operations/triage',
      },
    ],
    tools: [
      {
        kind: 'tool',
        name: 'status',
        description: 'Read status.',
        ref: 'operations/status',
        read_only: true,
        input_schema: { type: 'object', properties: {} },
      },
    ],
  });
});

test('groupCards keeps the closed sibling shape and immutable declaration order', () => {
  const index = nodeFixture();
  const view = new Disclosure(index);
  const grouped = groupCards(membersOf(index.find('operations')), view);
  const typed: ContextNode = index.find('operations/status');

  assert.equal(typed.kind, 'tool');
  assert.deepEqual(
    {
      roles: grouped.roles.map((card) => card.name),
      skills: grouped.skills.map((card) => card.name),
      tools: grouped.tools.map((card) => card.name),
    },
    {
      roles: ['incidents'],
      skills: ['triage'],
      tools: ['status'],
    },
  );
  assert.equal(Object.isFrozen(grouped), true);
  assert.equal(Object.isFrozen(grouped.roles), true);
});
