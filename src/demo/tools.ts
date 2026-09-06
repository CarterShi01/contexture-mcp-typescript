import { z } from 'zod';

import { ContextureError, defineTool } from '../index.js';

import {
  DEPLOYMENT,
  NAMESPACE,
  POD,
  POD_EVENTS,
  POD_LOGS,
  POD_STATUS,
  ROLLOUT_STATUS,
} from './fixtures.js';

function requirePod(namespace: string, pod: string): void {
  if (namespace === NAMESPACE && pod === POD) return;
  throw new ContextureError(
    `No pod ${JSON.stringify(pod)} in namespace ${JSON.stringify(namespace)}. This demo serves a single fixed incident: pod ${JSON.stringify(POD)} in namespace ${JSON.stringify(NAMESPACE)}.`,
  );
}

function requireDeployment(namespace: string, deployment: string): void {
  if (namespace === NAMESPACE && deployment === DEPLOYMENT) return;
  throw new ContextureError(
    `No deployment ${JSON.stringify(deployment)} in namespace ${JSON.stringify(namespace)}. This demo serves a single fixed incident: deployment ${JSON.stringify(DEPLOYMENT)} in namespace ${JSON.stringify(NAMESPACE)}.`,
  );
}

export const getPodStatus = () =>
  defineTool({
    kind: 'tool',
    name: 'get_pod_status',
    description: 'Return the current phase, container state, and restart count of a Pod.',
    readOnly: true,
    input: z.strictObject({ namespace: z.string(), pod: z.string() }),
    invoke: ({ namespace, pod }) => {
      requirePod(namespace, pod);
      return POD_STATUS;
    },
  });

export const getPodLogs = () =>
  defineTool({
    kind: 'tool',
    name: 'get_pod_logs',
    description: 'Return the recent container logs for a Pod.',
    readOnly: true,
    input: z.strictObject({
      namespace: z.string(),
      pod: z.string(),
      previous: z.boolean().default(false),
    }),
    invoke: ({ namespace, pod }) => {
      requirePod(namespace, pod);
      return POD_LOGS;
    },
  });

export const getPodEvents = () =>
  defineTool({
    kind: 'tool',
    name: 'get_pod_events',
    description: 'Return the Kubernetes events recorded against a Pod.',
    readOnly: true,
    input: z.strictObject({ namespace: z.string(), pod: z.string() }),
    invoke: ({ namespace, pod }) => {
      requirePod(namespace, pod);
      return POD_EVENTS;
    },
  });

export const getRolloutStatus = () =>
  defineTool({
    kind: 'tool',
    name: 'get_rollout_status',
    description: "Return the current and previous revision of a Deployment's rollout.",
    readOnly: true,
    input: z.strictObject({ namespace: z.string(), deployment: z.string() }),
    invoke: ({ namespace, deployment }) => {
      requireDeployment(namespace, deployment);
      return ROLLOUT_STATUS;
    },
  });

export const rollBackDeployment = () =>
  defineTool({
    kind: 'tool',
    name: 'roll_back_deployment',
    description: "Restore a Deployment's previous revision, replacing its running Pods.",
    readOnly: false,
    input: z.strictObject({ namespace: z.string(), deployment: z.string() }),
    invoke: ({ namespace, deployment }) => {
      requireDeployment(namespace, deployment);
      return `Rolled ${namespace}/${deployment} back from revision ${ROLLOUT_STATUS.current_revision} to ${ROLLOUT_STATUS.previous_revision} (${ROLLOUT_STATUS.previous_image}). The failing Pods have been replaced, so their logs and events are no longer available.`;
    },
  });
