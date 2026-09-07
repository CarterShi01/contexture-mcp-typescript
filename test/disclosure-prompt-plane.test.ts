import assert from 'node:assert/strict';
import test from 'node:test';

import { defineApplication, ModelValidationError } from '../src/index.js';
import {
  compileApplication,
  Disclosure,
  RefusedError,
  RootOutsideSelectionError,
  RootSelection,
} from '../src/core/index.js';
import { compileRuntimeApplication } from '../src/server/index.js';

function promptPlaneIndex() {
  return compileApplication(
    defineApplication({
      name: 'prompt-plane',
      roots: [
        () => ({
          kind: 'role' as const,
          name: 'operations',
          description: 'Operate services.',
          instructions: 'Inspect the service.',
          skills: [
            () => ({
              kind: 'skill' as const,
              name: 'status',
              description: 'Read status.',
              instructions: 'Read current state.',
            }),
          ],
        }),
      ],
      promptRoots: [
        () => ({
          kind: 'role' as const,
          name: 'commands',
          description: 'Commands for a person.',
          instructions: 'Wait for the person.',
          skills: [
            () => ({
              kind: 'skill' as const,
              name: 'restart',
              description: 'Restart a service.',
              instructions: 'Confirm the service first.',
            }),
          ],
        }),
      ],
    }),
  );
}

test('unrestricted removes prompt-root model ownership without widening its selection ceiling', () => {
  const disclosure = new Disclosure(promptPlaneIndex()).select(RootSelection.only('commands'));

  assert.deepEqual(disclosure.discover(), { roles: [], skills: [], tools: [] });
  assert.throws(() => disclosure.open('commands'), RefusedError);

  const unrestricted = disclosure.unrestricted();
  assert.deepEqual(
    unrestricted.discover().roles.map((card) => card.ref),
    ['commands'],
  );
  assert.equal(unrestricted.open('commands').ref, 'commands');
  assert.throws(() => unrestricted.open('operations'), RootOutsideSelectionError);
});

test('prompt roots remain model-hidden while person navigation returns canonical selected payloads', () => {
  const disclosure = new Disclosure(promptPlaneIndex());

  assert.deepEqual(
    disclosure.discover().roles.map((card) => card.ref),
    ['operations'],
  );
  assert.throws(() => disclosure.open('commands'), RefusedError);
  assert.deepEqual(
    disclosure.openForPerson('commands'),
    disclosure.unrestricted().open('commands'),
  );
  assert.equal(disclosure.openForPerson('commands/restart').ref, 'commands/restart');
  assert.throws(
    () => disclosure.openForPerson('commands', RootSelection.only('operations')),
    RootOutsideSelectionError,
  );
});

test('reserved nodes stay card-visible, refuse model opens, and stay absent from Role and Skill uses', async () => {
  const application = compileRuntimeApplication(
    defineApplication({
      name: 'reserved-prompt-plane',
      roots: [
        () => ({
          kind: 'role' as const,
          name: 'operations',
          description: 'Operate services.',
          instructions: 'Route safely.',
          uses: ['operations/approval'],
          skills: [
            () => ({
              kind: 'skill' as const,
              name: 'approval',
              description: 'A person approves.',
              instructions: 'Wait for a person.',
            }),
            () => ({
              kind: 'skill' as const,
              name: 'release',
              description: 'Release safely.',
              instructions: 'Ask for approval.',
              uses: ['operations/approval'],
            }),
          ],
        }),
      ],
      prompts: [
        {
          name: 'approve',
          opens: 'operations/approval',
          description: 'Open approval.',
          modelMayOpen: false,
        },
      ],
    }),
  );

  const role = application.disclosure.open('operations');
  assert.deepEqual(
    (role.skills as readonly Record<string, unknown>[]).map((card) => card.ref),
    ['operations/approval', 'operations/release'],
  );
  assert.deepEqual(role.uses, []);
  assert.deepEqual(application.disclosure.open('operations/release').uses, []);
  assert.throws(() => application.disclosure.open('operations/approval'), RefusedError);

  const personPayload = application.disclosure.openForPerson('operations/approval');
  assert.equal(personPayload.ref, 'operations/approval');
  assert.match(
    await application.publications.command('approve'),
    /You are at operations\/approval/,
  );
});

test('custom nested promptRoots fail with the public validation error', () => {
  const index = promptPlaneIndex();
  assert.throws(
    () => new Disclosure(index, { promptRoots: ['operations/status'] }),
    ModelValidationError,
  );
});
