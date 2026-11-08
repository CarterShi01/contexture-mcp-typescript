import { readFileSync } from 'node:fs';

import path from 'node:path';

import { z } from 'zod';

import { defineApplication, type ApplicationDeclaration } from '../../src/index.js';

const goldenDirectory = path.resolve('conformance/golden');

const resourceBodies = JSON.parse(
  readFileSync(path.join(goldenDirectory, 'reads.json'), 'utf8'),
) as Readonly<Record<string, string>>;

function fixture(name: string): string {
  const uri = {
    CRASH_LOOP_RUNBOOK: 'contexture://runbooks/crash-loop-backoff',
    ROLLBACK_POLICY: 'contexture://runbooks/rollback-policy',
  }[name];
  const body = uri === undefined ? undefined : resourceBodies[uri];
  if (body === undefined) throw new Error(`Missing conformance resource fixture ${name}.`);
  return body;
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
  input = z.object({}),
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

export function referenceApplication(name = 'demo'): ApplicationDeclaration {
  return defineApplication({
    name: name,
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
                z.object({ namespace: z.string(), pod: z.string() }),
              ),
              tool(
                'get_pod_logs',
                'Return the recent container logs for a Pod.',
                true,
                z.object({
                  namespace: z.string(),
                  pod: z.string(),
                  previous: z.boolean().default(false),
                }),
              ),
              tool(
                'get_pod_events',
                'Return the Kubernetes events recorded against a Pod.',
                true,
                z.object({ namespace: z.string(), pod: z.string() }),
              ),
              tool(
                'crash_loop_runbook',
                'How to diagnose a container that keeps restarting, and what not to do.',
                true,
                z.object({}),
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
                z.object({ namespace: z.string(), deployment: z.string() }),
              ),
              tool(
                'roll_back_deployment',
                "Restore a Deployment's previous revision, replacing its running Pods.",
                false,
                z.object({ namespace: z.string(), deployment: z.string() }),
              ),
              tool(
                'rollback_policy',
                'When a rollback is the right remediation, and what it costs.',
                true,
                z.object({}),
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
  });
}
