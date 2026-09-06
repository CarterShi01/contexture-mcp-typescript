import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  ApplicationRuntime,
  compileApplication,
  compileDisclosureApplication,
  defineApplication,
  Disclosure,
  ModelValidationError,
  Publications,
  RootSelection,
} from '../src/index.js';

function publications() {
  const declaration = defineApplication({
    name: 'publications',
    roots: [
      () => ({
        kind: 'role',
        name: 'operations',
        description: 'Operate services.',
        instructions: 'Inspect first.',
        tools: [
          () => ({
            kind: 'tool',
            name: 'runbook',
            description: 'Read the runbook.',
            readOnly: true,
            input: z.strictObject({}),
            invoke: () => '# Runbook\n',
          }),
        ],
        skills: [
          () => ({
            kind: 'skill',
            name: 'diagnose',
            description: 'Diagnose failures.',
            instructions: 'Read the runbook.',
          }),
        ],
      }),
    ],
    promptRoots: [
      () => ({
        kind: 'skill',
        name: 'command',
        description: 'A person command.',
        instructions: 'Only on request.',
      }),
    ],
    prompts: [
      { name: 'show-command', opens: 'command', description: 'Show the protected command.' },
    ],
    resources: [
      {
        opens: 'operations/runbook',
        uri: 'contexture://runbooks/operations',
        description: 'Read the runbook.',
        mimeType: 'text/markdown',
      },
    ],
  });
  const index = compileApplication(declaration);
  return {
    declaration,
    publications: new Publications(
      new Disclosure(index),
      new ApplicationRuntime(index),
      declaration,
    ),
  };
}

test('Prompt navigation, completion, instructions, and Resources project one compiled surface', async () => {
  const { publications: surface } = publications();
  assert.deepEqual(surface.promptCards(), [
    {
      name: 'show-command',
      description: 'Show the protected command. (command)',
      arguments: [],
    },
    {
      name: 'goto',
      description:
        'Open any capability this server holds, by reference. The reference completes as you type, so the whole tree can be browsed here without asking the agent to go and look.',
      arguments: [{ name: 'ref', required: true }],
    },
  ]);
  assert.deepEqual(surface.resourceCards(), [
    {
      name: 'runbook',
      uri: 'contexture://runbooks/operations',
      description: 'Read the runbook.',
      mimeType: 'text/markdown',
    },
  ]);
  assert.match(await surface.command('show-command'), /You are at command/);
  assert.deepEqual(surface.complete('operations').values, [
    'operations',
    'operations/runbook',
    'operations/diagnose',
  ]);
  assert.equal(await surface.read('contexture://runbooks/operations'), '# Runbook\n');
  assert.match(surface.instructions(), /Capabilities:\n- operations: Operate services\./);
  assert.deepEqual(
    surface.promptCards(RootSelection.only('operations')).map((card) => card.name),
    ['goto'],
  );
});

test('Resources reject non-Tool, argument-taking, and writing targets', () => {
  const compile = (target: 'skill' | 'writing' | 'arguments') => {
    const declaration = defineApplication({
      name: target,
      roots: [
        () =>
          target === 'skill'
            ? {
                kind: 'skill' as const,
                name: 'target',
                description: 'Target.',
                instructions: 'Target.',
              }
            : {
                kind: 'tool' as const,
                name: 'target',
                description: 'Target.',
                readOnly: target !== 'writing',
                input: z.strictObject(target === 'arguments' ? { value: z.string() } : {}),
                invoke: () => 'target',
              },
      ],
      resources: [{ opens: 'target', uri: `contexture://${target}`, description: 'Target.' }],
    });
    const index = compileApplication(declaration);
    return () =>
      new Publications(new Disclosure(index), new ApplicationRuntime(index), declaration);
  };
  for (const target of ['skill', 'writing', 'arguments'] as const) {
    assert.throws(compile(target), ModelValidationError);
  }
});

test('disclosure-only publications retain Prompt navigation but reject Resources', () => {
  const declaration = defineApplication({
    name: 'disclosure-publications',
    roots: [
      () => ({
        kind: 'skill',
        name: 'architecture',
        description: 'Architecture.',
        instructions: 'Structure.',
      }),
    ],
    prompts: [{ opens: 'architecture', description: 'Open architecture.' }],
  });
  const index = compileDisclosureApplication(declaration);
  const surface = new Publications(new Disclosure(index), undefined, declaration);
  assert.equal(surface.promptCards().length, 2);
  assert.match(surface.instructions(), /architecture/);
});
