import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  ControllerManager,
  ModelValidationError,
  NodeNotFoundError,
  Channels,
  REFERENCE_SEPARATOR,
  type RoleDeclaration,
} from '../src/index.js';
import {
  ApplicationRuntime,
  compileApplication,
  compileDisclosureApplication,
} from '../src/core/index.js';

function role(name: string): RoleDeclaration {
  return { kind: 'role', name, description: `${name}.`, instructions: 'Inspect.' };
}

function tool(name: string, readOnly = true) {
  return {
    kind: 'tool' as const,
    name,
    description: `${name}.`,
    readOnly,
    input: z.strictObject({}),
    invoke: () => name,
  };
}

test('ControllerManager captures roots once, owns snapshots, and exposes Contexture root order', () => {
  const manager = new ControllerManager();
  let constructed = 0;
  const registered = manager.registerRole(() => {
    constructed += 1;
    return role('operations');
  });
  manager.registerTool(() => tool('status'));
  manager.registerSkill(() => ({
    kind: 'skill',
    name: 'diagnose',
    description: 'Diagnose.',
    instructions: 'Read.',
  }));

  assert.equal(constructed, 1);
  assert.deepEqual(
    manager.roles.map((node) => node.name),
    ['operations'],
  );
  assert.deepEqual(
    manager.skills.map((node) => node.name),
    ['diagnose'],
  );
  assert.deepEqual(
    manager.tools.map((node) => node.name),
    ['status'],
  );
  assert.deepEqual(
    manager.roots.map((node) => node.name),
    ['operations', 'diagnose', 'status'],
  );
  assert.throws(() => {
    (registered as { name: string }).name = 'mutated';
  }, TypeError);

  const captured = manager.application('captured');
  manager.registerSkill(() => ({
    kind: 'skill',
    name: 'later',
    description: 'Later.',
    instructions: 'Read later.',
  }));
  const first = manager.compile('first');
  const second = manager.compile('second');
  const old = new ApplicationRuntime(
    // A captured declaration remains isolated from a later registration.
    compileApplication(captured),
  );
  assert.equal(first.find('operations').name, 'operations');
  assert.equal(second.find('operations').name, 'operations');
  assert.notEqual(first.find('operations'), second.find('operations'));
  assert.throws(() => old.index.find('later'), NodeNotFoundError);
  assert.equal(constructed, 1);
});

test('ControllerManager validates registration groups, names, duplicate addresses, shared nodes, and cycles', () => {
  const manager = new ControllerManager();
  manager.registerTool(() => tool('shared'));
  assert.throws(() => manager.registerRole(() => role('shared')), /first segment/);
  assert.throws(
    () =>
      manager.registerRole((() => ({
        ...role('wrong'),
        skills: [(() => role('nested')) as never],
      })) as never),
    /skill group/,
  );
  assert.throws(
    () => manager.registerSkill((() => ({ ...role('not-a-skill') })) as never),
    /not a skill/,
  );
  assert.throws(
    () => manager.registerRole(() => role(`bad${REFERENCE_SEPARATOR}name`)),
    /must not contain/,
  );

  const shared = {
    kind: 'skill' as const,
    name: 'status',
    description: 'Status.',
    instructions: 'Read.',
  };
  assert.throws(
    () =>
      new ControllerManager().registerRole(() => ({
        ...role('root'),
        children: [
          () => ({ ...role('left'), skills: [() => shared] }),
          () => ({ ...role('right'), skills: [() => shared] }),
        ],
      })),
    new RegExp(
      `held twice.*root${REFERENCE_SEPARATOR}left${REFERENCE_SEPARATOR}status.*root${REFERENCE_SEPARATOR}right${REFERENCE_SEPARATOR}status`,
    ),
  );

  const outer: RoleDeclaration = { ...role('outer'), children: [] };
  const inner: RoleDeclaration = { ...role('inner'), children: [() => outer] };
  (outer as { children: readonly (() => RoleDeclaration)[] }).children = [() => inner];
  assert.throws(
    () => new ControllerManager().registerRole(() => outer),
    new RegExp(
      `contains itself.*outer.*outer${REFERENCE_SEPARATOR}inner${REFERENCE_SEPARATOR}outer`,
    ),
  );
});

test('ControllerManager builds nested canonical refs with the shared separator', () => {
  const manager = new ControllerManager();
  manager.registerRole(() => ({
    ...role('operations'),
    skills: [
      () => ({ kind: 'skill', name: 'diagnose', description: 'Diagnose.', instructions: 'Read.' }),
    ],
  }));
  const ref = ['operations', 'diagnose'].join(REFERENCE_SEPARATOR);
  assert.equal(manager.compile('manager-ref').find(ref).name, 'diagnose');
});

test('ControllerManager generic registration dispatches by kind and rejects malformed node facts immediately', () => {
  const manager = new ControllerManager();
  assert.equal(
    manager.registerRoot(() => ({
      kind: 'skill',
      name: 'dynamic',
      description: 'Dynamic.',
      instructions: 'Read.',
    })).kind,
    'skill',
  );
  for (const factory of [
    () => ({ ...role('blank'), description: ' ' }),
    () => ({ ...role('duplicate-use'), uses: ['dynamic', 'dynamic'] }),
    (() => ({ ...tool('missing-input'), input: undefined })) as never,
  ]) {
    assert.throws(() => manager.registerRoot(factory), ModelValidationError);
  }
});

test('ControllerManager captures Channels per Application lifetime and rebinds only future snapshots', async () => {
  const first = new CountingChannels();
  const second = new CountingChannels();
  const manager = new ControllerManager({ channels: first });
  manager.registerTool(() => tool('status'));
  const beforeDeclaration = manager.application('before');
  manager.rebindChannels(second);
  const before = compileApplication(beforeDeclaration);
  const after = manager.compile('after');
  assert.equal(before.channels, first);
  assert.equal(after.channels, second);
  await new ApplicationRuntime(before).serve(async () => undefined);
  await new ApplicationRuntime(after).serve(async () => undefined);
  assert.deepEqual([first.opens, first.closes], [1, 1]);
  assert.deepEqual([second.opens, second.closes], [1, 1]);
});

test('ControllerManager preserves ordinary handles without treating open and close names as a lifecycle', async () => {
  const calls: string[] = [];
  const first = Object.freeze({
    name: 'first',
    open: () => calls.push('wrong open'),
    close: () => calls.push('wrong close'),
  });
  const second = Object.freeze({ name: 'second' });
  const manager = new ControllerManager({ channels: first });
  manager.registerTool(() =>
    defineChannelsTool('status', (_input, context) => {
      assert.equal(context.channels, first);
      return (context.channels as { readonly name: string }).name;
    }),
  );
  const oldApplication = manager.application('ordinary-old');
  const oldIndex = compileApplication(oldApplication);
  manager.rebindChannels(second);
  const newIndex = manager.compile('ordinary-new');
  assert.equal(oldIndex.channels, first);
  assert.equal(newIndex.channels, second);
  await new ApplicationRuntime(oldIndex).serve(async () => {
    assert.equal(
      await new ApplicationRuntime(oldIndex).invokeReadOnly('status', {}, { channels: second }),
      'first',
    );
  });
  assert.deepEqual(calls, []);
  assert.throws(() => compileDisclosureApplication(oldApplication), /cannot declare Channels/);
});

class CountingChannels extends Channels {
  opens = 0;
  closes = 0;

  open(): void {
    this.opens += 1;
  }

  close(): void {
    this.closes += 1;
  }
}

function defineChannelsTool(
  name: string,
  invoke: (
    input: Record<string, never>,
    context: import('../src/index.js').ToolCallContext,
  ) => unknown,
) {
  return {
    kind: 'tool' as const,
    name,
    description: `${name}.`,
    readOnly: true,
    input: z.strictObject({}),
    invoke,
  };
}
