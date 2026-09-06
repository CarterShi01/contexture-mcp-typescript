import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';

import {
  ApplicationRuntime,
  compileApplication,
  defineApplication,
  Disclosure,
  Gateway,
  Publications,
  RefusedError,
} from '../src/index.js';

const goldenDirectory = path.resolve('../Contexture/spec/golden');
const fixtureSource = readFileSync(
  path.resolve('../Contexture/contexture/demo/fixtures.py'),
  'utf8',
);
function fixture(name: string): string {
  const match = new RegExp(`${name} = """\\\\?\\n([\\s\\S]*?)"""`).exec(fixtureSource);
  if (match?.[1] === undefined) throw new Error(`Missing Python demo fixture ${name}.`);
  return match[1];
}
const lines = (...value: string[]) => `${value.join('\n')}\n`;
const platform = lines(
  'Route to the specialism the task belongs to, and open only that one. Diagnose',
  'before remediating: incident-response establishes a cause from evidence, and',
  'deployment-ops reverses a release once the cause is known.',
);
const incident = lines(
  'Work from evidence, never from the shape of the question. Select the skill that',
  'matches the reported symptom, follow its procedure, and collect tool output',
  'before naming a cause. Report the root cause and the smallest safe next action.',
);
const deployment = lines(
  'Remediation follows diagnosis and never replaces it. Read the policy, establish',
  'what the previous revision would restore, and say what evidence a rollback',
  'destroys before proposing one. Anything that changes the cluster is run through',
  'contexture_invoke, where a host can put a human in front of it.',
);
const diagnose = [
  'Establish the cause from evidence, in this order.',
  '',
  '1. Call get_pod_status. A high restart_count with ready=false confirms a',
  '   restart loop rather than a slow or pending start.',
  "2. Call get_pod_logs. The container's own output names the failure; read it",
  '   before forming a hypothesis.',
  '3. Call get_pod_events. Events tell you what the kubelet observed, including',
  '   the exit code, which separates an application failure from a kill.',
  '4. Call crash_loop_runbook and match the evidence you collected against its',
  '   table of causes. The same content is optionally published to hosts at',
  '   contexture://runbooks/crash-loop-backoff.',
  '',
  'Then report the root cause and the single smallest next action.',
  '',
  'Constraints:',
  '- Do not recommend restarting or deleting the Pod before the cause is known.',
  '  A restart does not repair a configuration error; it produces one more restart.',
  '- Do not state any cluster state you have not read from a tool.',
  '- Name the specific evidence, including the exit code, that supports your',
  '  conclusion.',
].join('\n');
const rollback = [
  'A rollback destroys the evidence it was called for. Work in this order.',
  '',
  '1. Call rollback_policy before doing anything else. The same content is',
  '   optionally published to hosts at contexture://runbooks/rollback-policy.',
  '2. Call get_rollout_status. Compare the current and previous image: if they',
  '   differ only in a tag, the cause may not be in the image at all.',
  '3. Establish the cause first, by opening the procedure listed under `uses` and',
  '   following it. A rollback that follows a guess will be needed again on the',
  '   next release.',
  '4. Only then call roll_back_deployment, and say plainly what evidence is lost.',
  '',
  'Constraints:',
  '- Do not roll back before the cause is known and the evidence is captured.',
  '- A configuration fault follows the previous revision back. Say so rather than',
  '  presenting a rollback as a fix.',
  '- roll_back_deployment changes the cluster. It is not read-only, so it must be',
  '  run through contexture_invoke and a human may be asked first.',
].join('\n');

function tool(
  name: string,
  description: string,
  readOnly: boolean,
  input = z.strictObject({}),
  result: unknown = undefined,
) {
  return () => ({
    kind: 'tool' as const,
    name,
    description,
    readOnly,
    input,
    invoke: () => result,
  });
}

function demo(): { readonly gateway: Gateway; readonly publications: Publications } {
  const index = compileApplication(
    defineApplication({
      name: 'demo',
      roots: [
        () => ({
          kind: 'role',
          name: 'kubernetes-platform',
          description: 'Operate a Kubernetes platform: diagnose incidents, and reverse releases.',
          instructions: platform,
          children: [
            () => ({
              kind: 'role',
              name: 'incident-response',
              description: 'Diagnose unhealthy Kubernetes workloads from cluster evidence.',
              instructions: incident,
              skills: [
                () => ({
                  kind: 'skill',
                  name: 'diagnose-crash-loop-backoff',
                  description:
                    'Find why a Pod restarts repeatedly, before proposing any remediation.',
                  instructions: diagnose,
                }),
              ],
              tools: [
                tool(
                  'get_pod_status',
                  'Return the current phase, container state, and restart count of a Pod.',
                  true,
                  z.strictObject({ namespace: z.string(), pod: z.string() }),
                ),
                tool(
                  'get_pod_logs',
                  'Return the recent container logs for a Pod.',
                  true,
                  z.strictObject({
                    namespace: z.string(),
                    pod: z.string(),
                    previous: z.boolean().default(false),
                  }),
                ),
                tool(
                  'get_pod_events',
                  'Return the Kubernetes events recorded against a Pod.',
                  true,
                  z.strictObject({ namespace: z.string(), pod: z.string() }),
                ),
                tool(
                  'crash_loop_runbook',
                  'How to diagnose a container that keeps restarting, and what not to do.',
                  true,
                  z.strictObject({}),
                  fixture('CRASH_LOOP_RUNBOOK'),
                ),
              ],
            }),
            () => ({
              kind: 'role',
              name: 'deployment-ops',
              description: 'Inspect and reverse Kubernetes releases that have gone wrong.',
              instructions: deployment,
              skills: [
                () => ({
                  kind: 'skill',
                  name: 'roll-back-a-failed-release',
                  description: 'Decide whether to roll a release back, and what to capture first.',
                  instructions: rollback,
                  uses: ['kubernetes-platform/incident-response/diagnose-crash-loop-backoff'],
                }),
              ],
              tools: [
                tool(
                  'get_rollout_status',
                  "Return the current and previous revision of a Deployment's rollout.",
                  true,
                  z.strictObject({ namespace: z.string(), deployment: z.string() }),
                ),
                tool(
                  'roll_back_deployment',
                  "Restore a Deployment's previous revision, replacing its running Pods.",
                  false,
                  z.strictObject({ namespace: z.string(), deployment: z.string() }),
                ),
                tool(
                  'rollback_policy',
                  'When a rollback is the right remediation, and what it costs.',
                  true,
                  z.strictObject({}),
                  fixture('ROLLBACK_POLICY'),
                ),
              ],
            }),
          ],
        }),
      ],
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
  );
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
    await readFile(path.join(goldenDirectory, 'instructions.txt'), 'utf8'),
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
