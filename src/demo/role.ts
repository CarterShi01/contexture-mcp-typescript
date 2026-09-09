import { crashLoopRunbook, rollbackPolicy } from './documents.js';
import { diagnoseCrashLoopBackOff, rollBackAFailedRelease } from './skills.js';
import { INVOKE_GATEWAY_NAME } from '../core/foundation/vocabulary.js';
import {
  getPodEvents,
  getPodLogs,
  getPodStatus,
  getRolloutStatus,
  rollBackDeployment,
} from './tools.js';

export const incidentResponse = () => ({
  kind: 'role' as const,
  name: 'incident-response',
  description: 'Diagnose unhealthy Kubernetes workloads from cluster evidence.',
  instructions: [
    'Work from evidence, never from the shape of the question. Select the skill that',
    'matches the reported symptom, follow its procedure, and collect tool output',
    'before naming a cause. Report the root cause and the smallest safe next action.',
  ].join('\n'),
  skills: [diagnoseCrashLoopBackOff],
  tools: [getPodStatus, getPodLogs, getPodEvents, crashLoopRunbook],
});

export const deploymentOps = () => ({
  kind: 'role' as const,
  name: 'deployment-ops',
  description: 'Inspect and reverse Kubernetes releases that have gone wrong.',
  instructions: [
    'Remediation follows diagnosis and never replaces it. Read the policy, establish',
    'what the previous revision would restore, and say what evidence a rollback',
    'destroys before proposing one. Anything that changes the cluster is run through',
    `${INVOKE_GATEWAY_NAME}, where a host can put a human in front of it.`,
  ].join('\n'),
  skills: [rollBackAFailedRelease],
  tools: [getRolloutStatus, rollBackDeployment, rollbackPolicy],
});

export const kubernetesPlatform = () => ({
  kind: 'role' as const,
  name: 'kubernetes-platform',
  description: 'Operate a Kubernetes platform: diagnose incidents, and reverse releases.',
  instructions: [
    'Route to the specialism the task belongs to, and open only that one. Diagnose',
    'before remediating: incident-response establishes a cause from evidence, and',
    'deployment-ops reverses a release once the cause is known.',
  ].join('\n'),
  children: [incidentResponse, deploymentOps],
});
