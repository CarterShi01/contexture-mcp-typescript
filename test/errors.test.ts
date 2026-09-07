import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContextureError,
  DeclarationError,
  DuplicateNameError,
  LookupFailure,
  ModelValidationError,
  NodeNotFoundError,
  RootOutsideSelectionError,
  RootSelectionError,
  WrongDoorError,
} from '../src/index.js';
import { GATEWAY, RefusedError, unresolvedMessage } from '../src/core/index.js';

test('native error categories preserve Contexture domain classification', () => {
  const declaration = new DeclarationError('unsupported declaration');
  const duplicate = new DuplicateNameError('duplicate node');
  assert.ok(declaration instanceof ModelValidationError);
  assert.ok(declaration instanceof ContextureError);
  assert.ok(duplicate instanceof ModelValidationError);
  assert.ok(duplicate instanceof ContextureError);
  assert.ok(new RootSelectionError('invalid roots') instanceof ContextureError);
  assert.ok(new RootOutsideSelectionError('hidden/tool') instanceof ContextureError);
  assert.ok(new RefusedError('use another gateway entry') instanceof ContextureError);
});

test('NodeNotFoundError retains exhaustive immutable facts and separates developer from agent prose', () => {
  const known = ['diagnose', 'status'];
  for (const reason of Object.values(LookupFailure)) {
    const failure = new NodeNotFoundError({
      reason,
      segment: 'missing',
      scope: 'operations',
      kind: 'skill',
      wanted: 'tool',
      known,
    });
    assert.ok(failure instanceof ContextureError);
    assert.equal(failure.reason, reason);
    assert.match(failure.message, new RegExp(`^${reason}: segment=`));
    assert.equal(failure.developerSummary(), failure.message);
    const agent = unresolvedMessage(failure);
    assert.ok(agent.length > 40, `${reason} needs an actionable recovery`);
    assert.ok(
      GATEWAY.some((tool) => agent.includes(tool.name)),
      `${reason} needs a gateway recovery name`,
    );
  }
  const local = new NodeNotFoundError({
    reason: LookupFailure.NO_SUCH_MEMBER,
    segment: 'missing',
    scope: 'operations',
    known,
  });
  known.push('caller-mutation-after-construction');
  assert.deepEqual(local.known, ['diagnose', 'status']);
  const attached = local.within('operations/missing');
  assert.notStrictEqual(attached, local);
  assert.equal(attached.ref, 'operations/missing');
  assert.deepEqual(attached.known, ['diagnose', 'status']);
  known.push('caller-mutation-after-within');
  assert.deepEqual(local.known, ['diagnose', 'status']);
  assert.deepEqual(attached.known, ['diagnose', 'status']);
  assert.throws(() => (local.known as string[]).push('leak'), TypeError);
  assert.throws(() => (attached.known as string[]).push('leak'), TypeError);
  const complete = new NodeNotFoundError({ reason: LookupFailure.EMPTY_REF, ref: '' });
  assert.strictEqual(complete.within('replacement'), complete);
});

test('WrongDoorError remains a typed framework failure with native Tool facts', () => {
  const readOnly = new WrongDoorError('operations/status', true);
  const writing = new WrongDoorError('operations/restart', false);
  assert.ok(readOnly instanceof ContextureError);
  assert.equal(readOnly.ref, 'operations/status');
  assert.equal(readOnly.readOnly, true);
  assert.equal(readOnly.message, '"operations/status" is a read-only Tool');
  assert.equal(writing.message, '"operations/restart" is a writing Tool');
});
