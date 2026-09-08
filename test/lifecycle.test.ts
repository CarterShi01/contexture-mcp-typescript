import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { Channels, defineApplication, type CleanupRegistrar } from '../src/index.js';
import {
  ApplicationRuntime,
  compileApplication,
  compileDisclosureApplication,
} from '../src/core/index.js';

test('Channels opens before serving, closes while acquisitions live, then unwinds in reverse', async () => {
  const events: string[] = [];
  const channels = new (class extends Channels {
    async open(registrar: CleanupRegistrar) {
      events.push('open');
      registrar.defer(async () => {
        events.push('cleanup-first');
      });
      registrar.defer(async () => {
        events.push('cleanup-second');
      });
    }
    async close() {
      events.push('close');
    }
  })();
  const runtime = new ApplicationRuntime(
    compileApplication(
      defineApplication({
        name: 'lifecycle',
        channels,
        roots: [
          () => ({
            kind: 'tool',
            name: 'status',
            description: 'Read status.',
            readOnly: true,
            input: z.strictObject({}),
            invoke: () => 'ok',
          }),
        ],
      }),
    ),
  );
  assert.equal(events.length, 0);
  await runtime.serve<void>(async () => {
    events.push('serve');
    assert.equal(await runtime.invokeReadOnly('status'), 'ok');
  });
  assert.deepEqual(events, ['open', 'serve', 'close', 'cleanup-second', 'cleanup-first']);
});

test('partial Channel open unwinds acquisitions, preserves its primary failure, and skips close', async () => {
  const events: string[] = [];
  const primary = new Error('open failed');
  const channels = new (class extends Channels {
    open(registrar: CleanupRegistrar) {
      registrar.defer(() => {
        events.push('cleanup');
      });
      throw primary;
    }
    close() {
      events.push('close');
    }
  })();
  const runtime = new ApplicationRuntime(
    compileApplication(
      defineApplication({
        name: 'partial',
        channels,
        roots: [
          () => ({
            kind: 'skill',
            name: 'read',
            description: 'Read.',
            instructions: 'Read.',
          }),
        ],
      }),
    ),
  );
  await assert.rejects(
    runtime.serve(async () => 'unreachable'),
    (error: unknown) => error === primary,
  );
  assert.deepEqual(events, ['cleanup']);
});

test('cleanup reporting cannot replace a frozen primary failure', async () => {
  const primary = Object.freeze(new Error('serve failed'));
  const runtime = new ApplicationRuntime(
    compileApplication(
      defineApplication({
        name: 'frozen-primary',
        channels: new (class extends Channels {
          open(registrar: CleanupRegistrar) {
            registrar.defer(() => {
              throw new Error('cleanup failed');
            });
          }
          close() {}
        })(),
        roots: [
          () => ({
            kind: 'skill',
            name: 'read',
            description: 'Read.',
            instructions: 'Read.',
          }),
        ],
      }),
    ),
  );
  await assert.rejects(
    runtime.serve(async () => {
      throw primary;
    }),
    (error: unknown) => error === primary,
  );
});

test('a retained cleanup registrar rejects registration outside Channels.open', async () => {
  let retained: CleanupRegistrar | undefined;
  const runtime = new ApplicationRuntime(
    compileApplication(
      defineApplication({
        name: 'retained-registrar',
        channels: new (class extends Channels {
          open(registrar: CleanupRegistrar) {
            retained = registrar;
          }
          close() {}
        })(),
        roots: [
          () => ({
            kind: 'skill',
            name: 'read',
            description: 'Read.',
            instructions: 'Read.',
          }),
        ],
      }),
    ),
  );
  await runtime.serve(async () => undefined);
  assert.throws(() => retained?.defer(() => undefined), /outside the Channels\.open lifecycle/);
});

test('a retained cleanup registrar closes after a rejected Channels.open', async () => {
  let retained: CleanupRegistrar | undefined;
  const primary = new Error('open failed');
  const runtime = new ApplicationRuntime(
    compileApplication(
      defineApplication({
        name: 'rejected-retained-registrar',
        channels: new (class extends Channels {
          open(registrar: CleanupRegistrar) {
            retained = registrar;
            throw primary;
          }
          close() {
            throw new Error('must not close');
          }
        })(),
        roots: [
          () => ({
            kind: 'skill',
            name: 'read',
            description: 'Read.',
            instructions: 'Read.',
          }),
        ],
      }),
    ),
  );
  await assert.rejects(
    runtime.serve(async () => undefined),
    (error: unknown) => error === primary,
  );
  assert.throws(() => retained?.defer(() => undefined), /outside the Channels\.open lifecycle/);
});

test('undefined lifecycle failures remain rejected failures', async () => {
  const runtime = (channels: Channels) =>
    new ApplicationRuntime(
      compileApplication(
        defineApplication({
          name: 'undefined-lifecycle-failure',
          channels,
          roots: [
            () => ({
              kind: 'skill',
              name: 'read',
              description: 'Read.',
              instructions: 'Read.',
            }),
          ],
        }),
      ),
    );
  const rejection = async (operation: () => Promise<unknown>): Promise<unknown> => {
    try {
      await operation();
      assert.fail('operation fulfilled');
    } catch (error) {
      return error;
    }
  };

  const openFailure = runtime(
    new (class extends Channels {
      open() {
        throw undefined;
      }
      close() {}
    })(),
  );
  assert.equal(await rejection(() => openFailure.serve(async () => undefined)), undefined);

  const serveFailure = runtime(
    new (class extends Channels {
      open() {}
      close() {}
    })(),
  );
  assert.equal(
    await rejection(() =>
      serveFailure.serve(async () => {
        throw undefined;
      }),
    ),
    undefined,
  );

  const closeFailure = runtime(
    new (class extends Channels {
      open() {}
      close() {
        throw undefined;
      }
    })(),
  );
  assert.equal(await rejection(() => closeFailure.serve(async () => undefined)), undefined);

  const cleanupFailure = runtime(
    new (class extends Channels {
      open(registrar: CleanupRegistrar) {
        registrar.defer(() => {
          throw undefined;
        });
      }
      close() {}
    })(),
  );
  assert.equal(await rejection(() => cleanupFailure.serve(async () => undefined)), undefined);
});

test('disclosure-only compilation is fresh, unbound, and never acquires Channels or schemas', () => {
  let opened = 0;
  const declaration = defineApplication({
    name: 'structural',
    roots: [
      () => ({
        kind: 'tool',
        name: 'architecture',
        description: 'Describe architecture.',
        readOnly: true,
        invoke: () => 'never called',
      }),
    ],
  });
  const first = compileDisclosureApplication(declaration);
  const second = compileDisclosureApplication(declaration);
  const tool = first.find('architecture');
  assert.equal(first.executionBound, false);
  assert.notEqual(first.find('architecture'), second.find('architecture'));
  assert.equal(tool.kind, 'tool');
  if (tool.kind !== 'tool') throw new Error('Expected a Tool.');
  assert.equal(tool.binding, undefined);
  assert.equal(opened, 0);
  assert.throws(
    () =>
      compileDisclosureApplication(
        defineApplication({
          name: 'invalid-disclosure',
          channels: new (class extends Channels {
            open() {
              opened += 1;
            }
            close() {}
          })(),
          roots: [
            () => ({
              kind: 'skill',
              name: 'read',
              description: 'Read.',
              instructions: 'Read.',
            }),
          ],
        }),
      ),
    /cannot declare Channels/,
  );
  assert.equal(opened, 0);
});

test('declarative applications reject structural lifecycle lookalikes before compilation', () => {
  const lookalike = {
    open() {
      throw new Error('must never be called');
    },
    close() {
      throw new Error('must never be called');
    },
  };
  assert.throws(
    () =>
      defineApplication({
        name: 'lookalike',
        channels: lookalike as never,
        roots: [
          () => ({
            kind: 'skill',
            name: 'read',
            description: 'Read.',
            instructions: 'Read.',
          }),
        ],
      }),
    /lifecycle instance/,
  );
});
