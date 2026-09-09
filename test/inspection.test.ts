import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { defineApplication, defineTool } from '../src/index.js';
import { ApplicationRuntime, compileApplication, Disclosure } from '../src/core/index.js';
import {
  asJson,
  connectStep,
  Cost,
  discoverStep,
  everyRef,
  openStep,
  readStep,
  render,
  Step,
  trace,
  Trace,
} from '../src/inspection.js';
import { buildInstructions } from '../src/server/instructions.js';

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
  assert.deepEqual(Cost.of('😀').toJSON(), { characters: 1, bytes: 4, estimated_tokens: 0 });
  assert.equal(Cost.of('ab').tokens, 0);
  assert.equal(Cost.of('abcdef').tokens, 2);
  assert.deepEqual(
    [...everyRef(fixture())],
    ['operations', 'operations/diagnose', 'operations/runbook'],
  );
});

test('inspection reads content explicitly and describes binary without printing it', async () => {
  const disclosure = fixture();
  const runtime = new ApplicationRuntime(disclosure.index);
  assert.equal((await readStep(runtime, 'operations/runbook')).body, 'RUNBOOK');

  const binaryIndex = compileApplication(
    defineApplication({
      name: 'binary-inspection',
      roots: [
        () =>
          defineTool({
            kind: 'tool',
            name: 'binary',
            description: 'Read bytes.',
            readOnly: true,
            input: z.strictObject({}),
            invoke: () => new Uint8Array([1, 2, 3]),
          }),
      ],
    }),
  );
  const binary = await readStep(new ApplicationRuntime(binaryIndex), 'binary');
  assert.equal(binary.body, '<3 bytes of binary>');
});

test('inspection nested role sweep is breadth-first and discover body is honest', () => {
  const disclosure = new Disclosure(
    compileApplication(
      defineApplication({
        name: 'nested-inspection',
        roots: [
          () => ({
            kind: 'role',
            name: 'root',
            description: 'Root.',
            instructions: 'Route.',
            children: [
              () => ({
                kind: 'role',
                name: 'child',
                description: 'Child.',
                instructions: 'Route.',
                skills: [
                  () => ({
                    kind: 'skill',
                    name: 'leaf',
                    description: 'Leaf.',
                    instructions: 'Read.',
                  }),
                ],
              }),
            ],
            skills: [
              () => ({
                kind: 'skill',
                name: 'root-leaf',
                description: 'Root leaf.',
                instructions: 'Read.',
              }),
            ],
          }),
        ],
      }),
    ),
  );
  assert.deepEqual(
    [...everyRef(disclosure)],
    ['root', 'root/root-leaf', 'root/child', 'root/child/leaf'],
  );
  const discovered = discoverStep(disclosure);
  assert.deepEqual(discovered.payload, disclosure.discover());
});

test('inspection accounts for all visible roles, checks routing cards, and keeps JSON nullable', () => {
  const disclosure = new Disclosure(
    compileApplication(
      defineApplication({
        name: 'inspection-detail',
        roots: [
          () => ({
            kind: 'role',
            name: 'root',
            description: 'Route work.',
            instructions: 'Start here.',
            children: [
              () => ({
                kind: 'role',
                name: 'child',
                description: 'Continue work.',
                instructions: 'Continue here.',
              }),
            ],
            skills: [
              () => ({
                kind: 'skill',
                name: 'diagnose',
                description: 'Diagnose the service.',
                instructions: 'Inspect the service.',
              }),
            ],
            tools: [
              () =>
                defineTool({
                  kind: 'tool',
                  name: 'get_logs',
                  description: 'Read the diagnose output.',
                  readOnly: true,
                  input: z.strictObject({}),
                  invoke: () => 'logs',
                }),
            ],
          }),
        ],
      }),
    ),
  );

  const connected = connectStep(disclosure, buildInstructions(disclosure));
  assert.equal(connected.checks[2]?.ok, true);

  const opened = openStep(disclosure, 'root');
  assert.equal(opened.checks[1]?.ok, false);
  assert.match(opened.checks[1]?.note ?? '', /get_logs/);

  const replay = new Trace([new Step('synthetic', 'body')]);
  const json = JSON.parse(asJson(replay)) as { steps: Array<{ ref: unknown; aside: unknown }> };
  assert.equal(json.steps[0]?.ref, null);
  assert.equal(json.steps[0]?.aside, null);
  assert.match(render(replay, { payloads: false }), /running/);
});
