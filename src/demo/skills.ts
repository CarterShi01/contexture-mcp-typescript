import { INVOKE_GATEWAY_NAME } from '../core/foundation/vocabulary.js';

export const DIAGNOSIS = 'kubernetes-platform/incident-response/diagnose-crash-loop-backoff';

export const diagnoseCrashLoopBackOff = () => ({
  kind: 'skill' as const,
  name: 'diagnose-crash-loop-backoff',
  description: 'Find why a Pod restarts repeatedly, before proposing any remediation.',
  instructions: `Establish the cause from evidence, in this order.

1. Call get_pod_status. A high restart_count with ready=false confirms a
   restart loop rather than a slow or pending start.
2. Call get_pod_logs. The container's own output names the failure; read it
   before forming a hypothesis.
3. Call get_pod_events. Events tell you what the kubelet observed, including
   the exit code, which separates an application failure from a kill.
4. Call crash_loop_runbook and match the evidence you collected against its
   table of causes. The same content is optionally published to hosts at
   contexture://runbooks/crash-loop-backoff.

Then report the root cause and the single smallest next action.

Constraints:
- Do not recommend restarting or deleting the Pod before the cause is known.
  A restart does not repair a configuration error; it produces one more restart.
- Do not state any cluster state you have not read from a tool.
- Name the specific evidence, including the exit code, that supports your
  conclusion.`,
});

export const rollBackAFailedRelease = () => ({
  kind: 'skill' as const,
  name: 'roll-back-a-failed-release',
  description: 'Decide whether to roll a release back, and what to capture first.',
  uses: [DIAGNOSIS],
  instructions: `A rollback destroys the evidence it was called for. Work in this order.

1. Call rollback_policy before doing anything else. The same content is
   optionally published to hosts at contexture://runbooks/rollback-policy.
2. Call get_rollout_status. Compare the current and previous image: if they
   differ only in a tag, the cause may not be in the image at all.
3. Establish the cause first, by opening the procedure listed under \`uses\` and
   following it. A rollback that follows a guess will be needed again on the
   next release.
4. Only then call roll_back_deployment, and say plainly what evidence is lost.

Constraints:
- Do not roll back before the cause is known and the evidence is captured.
- A configuration fault follows the previous revision back. Say so rather than
  presenting a rollback as a fix.
- roll_back_deployment changes the cluster. It is not read-only, so it must be
  run through ${INVOKE_GATEWAY_NAME} and a human may be asked first.`,
});
