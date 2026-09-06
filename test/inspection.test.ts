import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { defineApplication, defineTool } from '../src/index.js';
import { compileApplication, Disclosure } from '../src/core/index.js';
import { asJson, connectStep, Cost, everyRef, openStep, render, trace } from '../src/inspection.js';

function fixture(): Disclosure {
  return new Disclosure(
    compileApplication(
      defineApplication({
        name: 'inspection',
        roots: [
          () => ({
            kind: 'role',
            name: 'operations',
            description: 'Operate services.',
            instructions: 'Inspect first.',
            skills: [
              () => ({
                kind: 'skill',
                name: 'diagnose',
                description: 'Diagnose incidents.',
                instructions: 'Read status.',
              }),
            ],
            tools: [
              () =>
                defineTool({
                  kind: 'tool',
                  name: 'runbook',
                  description: 'Read the runbook.',
                  readOnly: true,
                  input: z.strictObject({}),
                  invoke: () => 'RUNBOOK',
                }),
            ],
          }),
        ],
      }),
    ),
  );
}

test('inspection measures the exact discover/open payloads and keeps refusals readable', async () => {
  const disclosure = fixture();
  const connected = connectStep(disclosure);
  assert.equal(connected.call, 'session start');
  assert.equal(
    connected.checks.every((check) => check.ok),
    true,
  );

  const opened = openStep(disclosure, 'operations');
  assert.equal(opened.refused, false);
  assert.deepEqual(opened.payload, disclosure.open('operations'));

  const refused = openStep(disclosure, 'operations/nope');
  assert.equal(refused.refused, true);
  assert.match(refused.body, /holds no member named 'nope'/);

  const replay = await trace(disclosure, ['operations', 'operations/nope']);
  assert.equal(replay.steps.length, 4);
  assert.equal(replay.failures.length, 1);
  assert.match(render(replay), /step 3 {2}contexture_open {2}operations\/nope {2}\[refused\]/);
  assert.deepEqual(JSON.parse(asJson(replay)).total, replay.total.toJSON());
});

test('inspection uses UTF-8 bytes and wide characters in its approximate cost', () => {
  assert.deepEqual(Cost.of('a中').toJSON(), { characters: 2, bytes: 4, estimated_tokens: 1 });
  assert.deepEqual(
    [...everyRef(fixture())],
    ['operations', 'operations/diagnose', 'operations/runbook'],
  );
});
