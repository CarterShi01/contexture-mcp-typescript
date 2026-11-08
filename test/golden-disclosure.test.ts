import { referenceApplication } from './support/reference-demo.js';
import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  ApplicationRuntime,
  compileApplication,
  Disclosure,
  RefusedError,
} from '../src/core/index.js';
import { Gateway, Publications } from '../src/server/index.js';

const goldenDirectory = path.resolve('conformance/golden');

function demo(): { readonly gateway: Gateway; readonly publications: Publications } {
  const index = compileApplication(referenceApplication());
  const disclosure = new Disclosure(index);
  const runtime = new ApplicationRuntime(index);
  return {
    gateway: new Gateway(disclosure, runtime),
    publications: new Publications(disclosure, runtime, {
      prompts: [
        {
          opens: 'kubernetes-platform/deployment-ops/roll-back-a-failed-release',
          name: 'roll-back-a-release',
          description:
            'Put the rollback procedure in context: what to capture before a release is reversed, and what reversing it destroys.',
        },
      ],
      resources: [
        {
          opens: 'kubernetes-platform/incident-response/crash_loop_runbook',
          uri: 'contexture://runbooks/crash-loop-backoff',
          description: 'How to diagnose a container that keeps restarting, and what not to do.',
          mimeType: 'text/markdown',
        },
        {
          opens: 'kubernetes-platform/deployment-ops/rollback_policy',
          uri: 'contexture://runbooks/rollback-policy',
          description: 'When a rollback is the right remediation, and what it costs.',
          mimeType: 'text/markdown',
        },
      ],
    }),
  };
}

async function golden<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(goldenDirectory, name), 'utf8')) as T;
}

test('the TypeScript demo produces normative discover and open payloads', async () => {
  const api = demo().gateway;
  assert.deepEqual(await api.discover(), await golden('discover.json'));
  for (const [ref, expected] of Object.entries(await golden<Record<string, unknown>>('open.json')))
    assert.deepEqual(await api.open(ref), expected, ref);
});

test('the TypeScript demo produces every normative recovery string', async () => {
  const api = demo().gateway;
  for (const [call, expected] of Object.entries(
    await golden<Record<string, string>>('refusals.json'),
  )) {
    const ref = call.slice(call.indexOf("'") + 1, -1);
    const operation = call.startsWith('open')
      ? () => api.open(ref)
      : call.startsWith('invoke_read_only')
        ? () => api.invokeReadOnly(ref)
        : () => api.invoke(ref);
    await assert.rejects(
      operation(),
      (error: unknown) => error instanceof RefusedError && error.message === expected,
    );
  }
});

test('the TypeScript demo produces normative publication cards, completion, instructions, and commands', async () => {
  const publications = demo().publications;
  const prompts = await golden<
    Array<{
      readonly name: string;
      readonly description: string;
      readonly arguments: readonly { readonly name: string; readonly required: boolean }[];
    }>
  >('prompts.json');
  assert.deepEqual(
    publications.promptCards(),
    prompts.map(({ name, description, arguments: args }) => ({
      name,
      description,
      arguments: args.map(({ name: argument, required }) => ({
        name: argument as 'ref',
        required: required as true,
      })),
    })),
  );
  const resources = await golden<
    Array<{
      readonly name: string;
      readonly uri: string;
      readonly description: string;
      readonly mime_type: string;
    }>
  >('resources.json');
  assert.deepEqual(
    publications.resourceCards(),
    resources.map(({ name, uri, description, mime_type: mimeType }) => ({
      name,
      uri,
      description,
      mimeType,
    })),
  );
  assert.equal(
    publications.instructions(),
    (await readFile(path.join(goldenDirectory, 'instructions.txt'), 'utf8')).replace(/\n$/, ''),
  );
  const completions =
    await golden<Record<string, { readonly values: readonly string[]; readonly total: number }>>(
      'completions.json',
    );
  for (const [input, expected] of Object.entries(completions))
    assert.deepEqual(publications.complete(input), expected);
  const commands = await golden<Record<string, string>>('commands.json');
  assert.equal(await publications.command('roll-back-a-release'), commands['roll-back-a-release']);
  assert.equal(await publications.goto('kubernetes-platform/deployment-ops'), commands.goto);
  const reads = await golden<Record<string, string>>('reads.json');
  for (const [uri, expected] of Object.entries(reads)) {
    assert.equal(await publications.read(uri), expected);
  }
});
