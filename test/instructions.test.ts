import assert from 'node:assert/strict';
import test from 'node:test';

import { defineApplication } from '../src/index.js';
import { compileApplication, Disclosure } from '../src/core/index.js';
import {
  buildInstructions,
  INSTRUCTIONS_LIMIT,
  neutralInstructions,
  ROSTER_BUDGET,
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
  assert.match(neutralInstructions(), /request-specific set of complete root capabilities/);
});
