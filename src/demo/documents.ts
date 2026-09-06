import { z } from 'zod';

import { defineTool } from '../index.js';
import { CRASH_LOOP_RUNBOOK, ROLLBACK_POLICY } from './fixtures.js';

export const crashLoopRunbook = () =>
  defineTool({
    kind: 'tool',
    name: 'crash_loop_runbook',
    description: 'How to diagnose a container that keeps restarting, and what not to do.',
    readOnly: true,
    input: z.strictObject({}),
    invoke: () => CRASH_LOOP_RUNBOOK,
  });

export const rollbackPolicy = () =>
  defineTool({
    kind: 'tool',
    name: 'rollback_policy',
    description: 'When a rollback is the right remediation, and what it costs.',
    readOnly: true,
    input: z.strictObject({}),
    invoke: () => ROLLBACK_POLICY,
  });
