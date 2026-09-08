import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { defineApplication } from '../src/index.js';
import {
  compileApplication,
  Disclosure,
  LookupFailure,
  NodeNotFoundError,
  RefusedError,
  RootOutsideSelectionError,
  RootSelection,
  SelectedGraph,
} from '../src/core/index.js';

function view(): Disclosure {
  return new Disclosure(
    compileApplication(
      defineApplication({
        name: 'operations',
        roots: [
          () => ({
            kind: 'role',
            name: 'operations',
            description: 'Operate services.',
            instructions: 'Inspect evidence.',
            children: [
              () => ({
                kind: 'role',
                name: 'incident',
                description: 'Handle incidents.',
                instructions: 'Find the cause.',
                skills: [
                  () => ({
                    kind: 'skill',
                    name: 'diagnose',
                    description: 'Diagnose failures.',
                    instructions: 'Read status.',
                    uses: ['operations/status'],
                  }),
                ],
              }),
            ],
            tools: [
              () => ({
                kind: 'tool',
                name: 'status',
                description: 'Read service status.',
                readOnly: true,
                input: z.object({ service: z.string() }),
                invoke: (input) => input,
              }),
            ],
          }),
        ],
        promptRoots: [
          () => ({
            kind: 'role',
            name: 'commands',
            description: 'User commands.',
            instructions: 'Wait for the user.',
            tools: [
              () => ({
                kind: 'tool',
                name: 'restart',
                description: 'Restart a service.',
                readOnly: false,
                input: z.object({ service: z.string() }),
                invoke: (input) => input,
              }),
            ],
          }),
        ],
      }),
    ),
  );
}

test('discover and open disclose exactly one selected level and Tool Binding schemas', () => {
  const disclosure = view();
  assert.deepEqual(disclosure.discover(), {
    roles: [
      {
        kind: 'role',
        name: 'operations',
        description: 'Operate services.',
        ref: 'operations',
      },
    ],
    skills: [],
    tools: [],
  });
  assert.deepEqual(disclosure.open('operations'), {
    kind: 'role',
    name: 'operations',
    description: 'Operate services.',
    ref: 'operations',
    instructions: 'Inspect evidence.',
    roles: [
      {
        kind: 'role',
        name: 'incident',
        description: 'Handle incidents.',
        ref: 'operations/incident',
      },
    ],
    skills: [],
    tools: [
      {
        kind: 'tool',
        name: 'status',
        description: 'Read service status.',
        ref: 'operations/status',
        read_only: true,
        input_schema: {
          type: 'object',
          properties: { service: { type: 'string' } },
          required: ['service'],
        },
      },
    ],
  });
  assert.deepEqual(disclosure.open('operations/incident/diagnose'), {
    kind: 'skill',
    name: 'diagnose',
    description: 'Diagnose failures.',
    ref: 'operations/incident/diagnose',
    instructions: 'Read status.',
    uses: [
      {
        kind: 'tool',
        name: 'status',
        description: 'Read service status.',
        ref: 'operations/status',
        read_only: true,
        input_schema: {
          type: 'object',
          properties: { service: { type: 'string' } },
          required: ['service'],
        },
      },
    ],
  });
});

test('model navigation excludes prompt roots but person navigation reaches them', () => {
  const disclosure = view();
  assert.throws(() => disclosure.open('commands'), RefusedError);
  assert.deepEqual(disclosure.openForPerson('commands/restart'), {
    kind: 'tool',
    name: 'restart',
    description: 'Restart a service.',
    ref: 'commands/restart',
    read_only: false,
    input_schema: {
      type: 'object',
      properties: { service: { type: 'string' } },
      required: ['service'],
    },
  });
});

test('root selection aliases are path-aware, monotonic, and hide cross-surface dependency cards', () => {
  const index = compileApplication(
    defineApplication({
      name: 'roots',
      roots: [
        () => ({
          kind: 'skill',
          name: 'alpha',
          description: 'First.',
          instructions: 'First.',
          uses: ['beta'],
        }),
        () => ({ kind: 'skill', name: 'beta', description: 'Second.', instructions: 'Second.' }),
      ],
    }),
  );
  const selected = new Disclosure(index).select(RootSelection.only('alpha'));
  assert.deepEqual(
    selected.discover().skills.map((card) => card.ref),
    ['alpha'],
  );
  assert.deepEqual(selected.open('alpha'), {
    kind: 'skill',
    name: 'alpha',
    description: 'First.',
    ref: 'alpha',
    instructions: 'First.',
    uses: [],
  });
  assert.throws(() => selected.open('beta'), RootOutsideSelectionError);
  assert.deepEqual(RootSelection.only('alpha/child').selectors, ['alpha/child']);
  assert.throws(
    () => selected.select(RootSelection.only('beta')),
    /effective surface selection is empty/,
  );
  assert.deepEqual(
    [...new SelectedGraph(index, RootSelection.only('alpha')).walk()].map(([ref]) => ref),
    ['alpha'],
  );
  const graph = new SelectedGraph(index, RootSelection.only('alpha'));
  assert.equal(graph.refOf(index.find('alpha')), 'alpha');
  assert.deepEqual(
    graph.childrenOf(index.find('alpha')).map((node) => node.name),
    [],
  );
  assert.deepEqual(graph.usesOf('alpha'), []);
  assert.deepEqual(graph.dependentsOf('alpha'), []);
  assert.throws(() => graph.refOf(index.find('beta')), RootOutsideSelectionError);
});

test('open recovery strings retain the protocol recovery action', () => {
  const disclosure = view();
  assert.throws(
    () => disclosure.open(''),
    (error: unknown) =>
      error instanceof NodeNotFoundError && error.reason === LookupFailure.EMPTY_REF,
  );
  assert.throws(
    () => disclosure.open('operations/status/deeper'),
    (error: unknown) =>
      error instanceof NodeNotFoundError && error.reason === LookupFailure.NOT_A_CONTAINER,
  );
});
