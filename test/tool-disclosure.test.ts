import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { defineApplication } from '../src/index.js';
import {
  compileApplication,
  compileDisclosureApplication,
  Disclosure,
  RootSelection,
} from '../src/core/index.js';

function runtimeDisclosure(): Disclosure {
  return new Disclosure(
    compileApplication(
      defineApplication({
        name: 'tool-uses',
        roots: [
          () => ({
            kind: 'role',
            name: 'operations',
            description: 'Operations.',
            instructions: 'Route.',
            uses: ['operations/prepare'],
            skills: [
              () => ({
                kind: 'skill',
                name: 'prepare',
                description: 'Prepare.',
                instructions: 'Prepare safely.',
              }),
            ],
            tools: [
              () => ({
                kind: 'tool',
                name: 'first',
                description: 'First tool.',
                readOnly: true,
                input: z.strictObject({}),
                invoke: () => 'first',
                uses: ['operations/second', 'support'],
              }),
              () => ({
                kind: 'tool',
                name: 'second',
                description: 'Second tool.',
                readOnly: false,
                input: z.strictObject({}),
                invoke: () => 'second',
                uses: ['operations/first'],
              }),
            ],
          }),
          () => ({
            kind: 'skill',
            name: 'support',
            description: 'Support root.',
            instructions: 'Support.',
            uses: [],
          }),
        ],
      }),
    ),
  );
}

test('active Tools expose one direct routing-card uses layer without following Tool cycles', () => {
  const opened = runtimeDisclosure().open('operations/first');
  assert.equal(opened.read_only, true);
  assert.ok('input_schema' in opened);
  assert.deepEqual(opened.uses, [
    {
      kind: 'tool',
      name: 'second',
      description: 'Second tool.',
      ref: 'operations/second',
      read_only: false,
      input_schema: { type: 'object', properties: {} },
    },
    {
      kind: 'skill',
      name: 'support',
      description: 'Support root.',
      ref: 'support',
    },
  ]);
  const second = (opened.uses as readonly Record<string, unknown>[])[0];
  assert.ok(second !== undefined);
  assert.equal('uses' in second, false);
  assert.equal('instructions' in second, false);
});

test('active Roles expose one direct routing-card uses layer', () => {
  const opened = runtimeDisclosure().open('operations');
  assert.equal(opened.instructions, 'Route.');
  assert.deepEqual(opened.uses, [
    {
      kind: 'skill',
      name: 'prepare',
      description: 'Prepare.',
      ref: 'operations/prepare',
    },
  ]);
  const referenced = (opened.uses as readonly Record<string, unknown>[])[0];
  assert.ok(referenced !== undefined);
  assert.equal('instructions' in referenced, false);
  assert.equal('uses' in referenced, false);
});

test('selected roots filter active Tool uses without leaking another root', () => {
  const selected = runtimeDisclosure().select(RootSelection.only('operations'));
  const opened = selected.open('operations/first');
  assert.deepEqual(opened.uses, [
    {
      kind: 'tool',
      name: 'second',
      description: 'Second tool.',
      ref: 'operations/second',
      read_only: false,
      input_schema: { type: 'object', properties: {} },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(opened), /support|foreign/);
});

test('disclosure-only Tool cards omit callable facts while retaining active structural uses', () => {
  const index = compileDisclosureApplication(
    defineApplication({
      name: 'structural-tool',
      roots: [
        () => ({
          kind: 'role',
          name: 'architecture',
          description: 'Architecture.',
          instructions: 'Route.',
          skills: [
            () => ({
              kind: 'skill',
              name: 'fact',
              description: 'Fact.',
              instructions: 'Read facts.',
            }),
          ],
          tools: [
            () => ({
              kind: 'tool',
              name: 'provider',
              description: 'Provider.',
              readOnly: true,
              uses: ['architecture/fact'],
              invoke: () => 'must not bind',
            }),
          ],
        }),
      ],
    }),
  );
  const disclosure = new Disclosure(index);
  const role = disclosure.open('architecture');
  const member = (role.tools as readonly Record<string, unknown>[])[0];
  assert.ok(member !== undefined);
  assert.equal('read_only' in member, false);
  assert.equal('input_schema' in member, false);

  const tool = disclosure.open('architecture/provider');
  assert.equal('read_only' in tool, false);
  assert.equal('input_schema' in tool, false);
  assert.deepEqual(tool.uses, [
    { kind: 'skill', name: 'fact', description: 'Fact.', ref: 'architecture/fact' },
  ]);
});
