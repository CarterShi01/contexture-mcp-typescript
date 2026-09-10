import assert from 'node:assert/strict';
import test from 'node:test';

import { defineApplication } from '../src/index.js';
import { compileApplication, Disclosure, RootSelection } from '../src/core/index.js';
import {
  buildInstructions,
  INSTRUCTIONS_LIMIT,
  neutralInstructions,
  ROSTER_BUDGET,
  SELF_CONTAINED_PREFIX,
} from '../src/server/index.js';

function disclosure(): Disclosure {
  return new Disclosure(
    compileApplication(
      defineApplication({
        name: 'instructions',
        roots: [
          () => ({
            kind: 'role',
            name: 'operations',
            description: 'Operate services.',
            instructions: 'Inspect first.',
            children: [
              () => ({
                kind: 'role',
                name: 'incidents',
                description: 'Diagnose incidents.',
                instructions: 'Read evidence.',
              }),
            ],
          }),
          () => ({
            kind: 'role',
            name: 'security',
            description: 'Handle security work.',
            instructions: 'Verify identity.',
          }),
        ],
      }),
    ),
  );
}

test('server instructions put a self-contained contract before a breadth-first roster', () => {
  const text = buildInstructions(disclosure());
  assert.match(text, /^Everything this server offers is behind contexture_open\./);
  assert.ok(
    text.indexOf('- operations: Operate services.') < text.indexOf('- operations/incidents:'),
  );
  assert.ok(
    text.indexOf('- security: Handle security work.') < text.indexOf('- operations/incidents:'),
  );
  assert.match(text, /Every card carries a `ref`/);
  assert.ok(Buffer.byteLength(text) <= INSTRUCTIONS_LIMIT);
});

test('server instructions cut roots individually and deeper roles by sibling group', () => {
  const text = buildInstructions(disclosure(), { budget: 1 });
  assert.match(text, /more root role\(s\); call contexture_discover/);
  assert.equal(ROSTER_BUDGET, 1200);
  assert.equal(SELF_CONTAINED_PREFIX, 512);
  assert.match(neutralInstructions(), /request-specific set of complete capability subtrees/);
  assert.match(neutralInstructions(), /surface roots available to this request/);
});

test('server instructions start their roster at promoted surface roots', () => {
  const selected = disclosure().select(RootSelection.only('operations/incidents'));
  const text = buildInstructions(selected);

  assert.match(text, /- operations\/incidents: Diagnose incidents\./);
  assert.doesNotMatch(text, /- operations: Operate services\./);
  assert.doesNotMatch(text, /- security:/);
});

test('server instructions measure Unicode in UTF-8 bytes and never split a child sibling group', () => {
  const unicode = new Disclosure(
    compileApplication(
      defineApplication({
        name: 'unicode-instructions',
        roots: [
          () => ({
            kind: 'role',
            name: 'root',
            description: '根职责',
            instructions: 'Route.',
            children: [
              () => ({
                kind: 'role',
                name: 'first',
                description: '甲'.repeat(20),
                instructions: 'A.',
              }),
              () => ({
                kind: 'role',
                name: 'second',
                description: '乙'.repeat(20),
                instructions: 'B.',
              }),
            ],
          }),
        ],
      }),
    ),
  );
  const text = buildInstructions(unicode, { budget: 100 });
  assert.match(text, /- root: 根职责/);
  assert.doesNotMatch(text, /root\/first|root\/second/);
  assert.match(text, /and 2 more role\(s\) below/);
});
