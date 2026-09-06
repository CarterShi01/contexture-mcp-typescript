import { defineApplication } from '../index.js';

import { kubernetesPlatform } from './role.js';

/** The shipped declaration used by contexture inspect and contexture demo. */
export const app = defineApplication({
  name: 'contexture-demo',
  roots: [kubernetesPlatform],
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
