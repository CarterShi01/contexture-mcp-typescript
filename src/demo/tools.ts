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

/** The current state of one Pod in the maintained demo. */
export interface PodStatus {
  readonly namespace: string;
  readonly pod: string;
  readonly phase: string;
  readonly container_state: string;
  readonly restart_count: number;
  readonly ready: boolean;
  readonly image: string;
}

/** One event recorded against a Pod in the maintained demo. */
export interface PodEvent {
  readonly type: string;
  readonly reason: string;
  readonly message: string;
  readonly count: number;
}

/** The current and previous revisions of the maintained demo Deployment. */
export interface RolloutStatus {
  readonly namespace: string;
  readonly deployment: string;
  readonly current_revision: number;
  readonly previous_revision: number;
  readonly current_image: string;
  readonly previous_image: string;
  readonly updated_replicas: number;
  readonly available_replicas: number;
  readonly rolled_out_at: string;
}

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
    input: z.object({ namespace: z.string(), pod: z.string() }),
    invoke: ({ namespace, pod }) => {
      requirePod(namespace, pod);
      return POD_STATUS satisfies PodStatus;
    },
  });

export const getPodLogs = () =>
  defineTool({
    kind: 'tool',
    name: 'get_pod_logs',
    description: 'Return the recent container logs for a Pod.',
    readOnly: true,
    input: z.object({
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
    input: z.object({ namespace: z.string(), pod: z.string() }),
    invoke: ({ namespace, pod }) => {
      requirePod(namespace, pod);
      return POD_EVENTS satisfies readonly PodEvent[];
    },
  });

export const getRolloutStatus = () =>
  defineTool({
    kind: 'tool',
    name: 'get_rollout_status',
    description: "Return the current and previous revision of a Deployment's rollout.",
    readOnly: true,
    input: z.object({ namespace: z.string(), deployment: z.string() }),
    invoke: ({ namespace, deployment }) => {
      requireDeployment(namespace, deployment);
      return ROLLOUT_STATUS satisfies RolloutStatus;
    },
  });

export const rollBackDeployment = () =>
  defineTool({
    kind: 'tool',
    name: 'roll_back_deployment',
    description: "Restore a Deployment's previous revision, replacing its running Pods.",
    readOnly: false,
    input: z.object({ namespace: z.string(), deployment: z.string() }),
    invoke: ({ namespace, deployment }) => {
      requireDeployment(namespace, deployment);
      return `Rolled ${namespace}/${deployment} back from revision ${ROLLOUT_STATUS.current_revision} to ${ROLLOUT_STATUS.previous_revision} (${ROLLOUT_STATUS.previous_image}). The failing Pods have been replaced, so their logs and events are no longer available.`;
    },
  });
