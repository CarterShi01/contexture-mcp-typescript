import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { defineApplication } from '../src/index.js';
import {
  ApplicationRuntime,
  DISCLOSURE_GATEWAY,
  DisclosureAPI,
  EXECUTION_GATEWAY,
  Gateway,
  GATEWAY,
  LookupFailure,
  NodeNotFoundError,
  RefusedError,
  RootOutsideSelectionError,
  RootSelection,
  WrongDoorError,
  compileApplication,
  Disclosure,
} from '../src/core/index.js';
import { compileRuntimeApplication } from '../src/server/index.js';

function gateway(calls: { value: number }) {
  const index = compileApplication(
    defineApplication({
      name: 'gateway-recovery',
      roots: [
        () => ({
          kind: 'role',
          name: 'alpha',
          description: 'Alpha.',
          instructions: 'Inspect.',
        }),
        () => ({
          kind: 'role',
          name: 'beta',
          description: 'Beta.',
          instructions: 'Operate.',
          tools: [
            () => ({
              kind: 'tool',
              name: 'read',
              description: 'Read.',
              readOnly: true,
              input: z.strictObject({}),
              invoke: () => {
                calls.value += 1;
                return 'read';
              },
            }),
            () => ({
              kind: 'tool',
              name: 'write',
              description: 'Write.',
              readOnly: false,
              input: z.strictObject({}),
              invoke: () => 'write',
            }),
          ],
        }),
      ],
    }),
  );
  return new Gateway(new Disclosure(index), new ApplicationRuntime(index));
}

function disclosureOnlyGateway(): Gateway {
  const index = compileApplication(
    defineApplication({
      name: 'disclosure-only',
      roots: [() => ({ kind: 'skill', name: 'read', description: 'Read.', instructions: 'Read.' })],
    }),
  );
  return new Gateway(new Disclosure(index), undefined);
}

test('Gateway owns one fixed ordered inventory and its independently installable halves', () => {
  assert.deepEqual(
    GATEWAY.map((tool) => tool.name),
    ['contexture_discover', 'contexture_open', 'contexture_invoke_read_only', 'contexture_invoke'],
  );
  assert.deepEqual(
    DISCLOSURE_GATEWAY.map((tool) => tool.name),
    ['contexture_discover', 'contexture_open'],
  );
  assert.deepEqual(
    EXECUTION_GATEWAY.map((tool) => tool.name),
    ['contexture_invoke_read_only', 'contexture_invoke'],
  );
  assert.deepEqual(disclosureOnlyGateway().tools, DISCLOSURE_GATEWAY);
});

test('DisclosureAPI exposes an independent, stateless navigation half', async () => {
  const application = compileRuntimeApplication(
    defineApplication({
      name: 'disclosure-api',
      roots: [
        () => ({
          kind: 'role',
          name: 'operations',
          description: 'Operate.',
          instructions: 'Inspect.',
          skills: [
            () => ({
              kind: 'skill',
              name: 'change',
              description: 'Change.',
              instructions: 'Ask first.',
            }),
          ],
        }),
        () => ({
          kind: 'role',
          name: 'other',
          description: 'Other.',
          instructions: 'Separate.',
        }),
      ],
    }),
  );
  const api = new DisclosureAPI(application.disclosure, { reserved: ['operations/change'] });

  assert.deepEqual(api.tools, DISCLOSURE_GATEWAY);
  assert.equal(api.index, application.index);
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(
    (await api.discover()).roles.map((card) => card.ref),
    ['operations', 'other'],
  );
  const opened = await api.open('operations');
  assert.deepEqual(
    (opened.skills as readonly { readonly ref: string }[]).map((card) => card.ref),
    ['operations/change'],
  );
  await assert.rejects(
    api.open('operations/change'),
    (error: unknown) => error instanceof RefusedError && /opened by a person/.test(error.message),
  );
  assert.equal((await api.openForPerson('operations/change')).instructions, 'Ask first.');
  assert.equal((await api.openForAPerson('operations/change')).instructions, 'Ask first.');

  const selected = api.selectedGraph(RootSelection.only('operations'));
  assert.deepEqual(
    [...selected.walk()].map(([ref]) => ref),
    ['operations', 'operations/change'],
  );
  await assert.rejects(
    api.open('other', RootSelection.only('operations')),
    (error: unknown) => error instanceof RootOutsideSelectionError,
  );
  await assert.rejects(
    api.open('operations/missing'),
    (error: unknown) =>
      error instanceof RefusedError &&
      error.cause instanceof NodeNotFoundError &&
      error.message.includes('contexture_open'),
  );
});

test('DisclosureAPI rejects an invalid runtime value at its public boundary', () => {
  assert.throws(
    () => new DisclosureAPI(undefined as unknown as Disclosure),
    /requires a Disclosure/,
  );
});

test('Gateway makes every canonical lookup failure actionable without retaining traversal state', async () => {
  const calls = { value: 0 };
  const api = gateway(calls);
  for (const [ref, fragment, reason] of [
    ['', 'contexture_discover', LookupFailure.EMPTY_REF],
    ['missing', 'This server serves: alpha, beta', LookupFailure.NO_SUCH_ROOT],
    ['alpha/nope', 'It holds nothing.', LookupFailure.NO_SUCH_MEMBER],
    ['beta/nope', 'It holds: read, write.', LookupFailure.NO_SUCH_MEMBER],
    ['beta/read/again', "Open 'read' itself with contexture_open", LookupFailure.NOT_A_CONTAINER],
  ] as const) {
    await assert.rejects(
      api.open(ref),
      (error: unknown) =>
        error instanceof RefusedError &&
        error.message.includes(fragment) &&
        error.cause instanceof NodeNotFoundError &&
        error.cause.reason === reason,
    );
  }
  const before = await api.open('beta');
  await api.discover();
  await api.open('alpha');
  await api.invokeReadOnly('beta/read', {});
  const after = await api.open('beta');
  assert.deepEqual(after, before);
});

test('Gateway renders wrong-kind and wrong-door errors before a business handler runs', async () => {
  const calls = { value: 0 };
  const api = gateway(calls);
  await assert.rejects(
    api.invokeReadOnly('beta'),
    (error: unknown) =>
      error instanceof RefusedError &&
      error.message.includes('beta names a role, not a tool') &&
      error.message.includes('contexture_open') &&
      error.cause instanceof NodeNotFoundError &&
      error.cause.reason === LookupFailure.WRONG_KIND,
  );
  await assert.rejects(
    api.invoke('beta/read', {}),
    (error: unknown) =>
      error instanceof RefusedError &&
      error.message.includes('contexture_invoke_read_only') &&
      error.cause instanceof WrongDoorError &&
      error.cause.ref === 'beta/read' &&
      error.cause.readOnly,
  );
  assert.equal(calls.value, 0);
});

test('Gateway preserves an excluded root as typed authorization without a recoverable leak', async () => {
  const api = gateway({ value: 0 });
  await assert.rejects(
    api.open('beta/read', RootSelection.only('alpha')),
    (error: unknown) =>
      error instanceof RootOutsideSelectionError &&
      error.ref === 'beta/read' &&
      !error.message.includes('alpha') &&
      !(error instanceof RefusedError),
  );
});

test('Gateway checks root selection before refusing a person-reserved Prompt target', async () => {
  const application = compileRuntimeApplication(
    defineApplication({
      name: 'reserved-gateway',
      roots: [
        () => ({
          kind: 'role',
          name: 'operations',
          description: 'Operate.',
          instructions: 'Inspect.',
          skills: [
            () => ({ kind: 'skill', name: 'change', description: 'Change.', instructions: 'Ask.' }),
          ],
        }),
        () => ({
          kind: 'role',
          name: 'hidden',
          description: 'Hidden.',
          instructions: 'Do not disclose.',
          skills: [
            () => ({ kind: 'skill', name: 'change', description: 'Change.', instructions: 'Ask.' }),
          ],
        }),
      ],
      prompts: [
        {
          name: 'operations-change',
          opens: 'operations/change',
          description: 'Change.',
          modelMayOpen: false,
        },
        {
          name: 'hidden-change',
          opens: 'hidden/change',
          description: 'Hidden change.',
          modelMayOpen: false,
        },
      ],
    }),
  );
  const api = new Gateway(application.disclosure, application.runtime);
  await assert.rejects(
    api.open('hidden/change', RootSelection.only('operations')),
    (error: unknown) =>
      error instanceof RootOutsideSelectionError && !error.message.includes('opened by a person'),
  );
  await assert.rejects(
    api.open('operations/change', RootSelection.only('operations')),
    (error: unknown) =>
      error instanceof RefusedError && error.message.includes('opened by a person'),
  );
});

test('a disclosure-only Gateway refuses invocation with a navigation recovery', async () => {
  const api = disclosureOnlyGateway();
  await assert.rejects(
    api.invokeReadOnly('anything'),
    (error: unknown) =>
      error instanceof RefusedError &&
      error.message.includes('contexture_discover or contexture_open'),
  );
});
