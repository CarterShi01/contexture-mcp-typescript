import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMAND_CLOSING,
  COMMAND_PREAMBLE,
  commandDescription,
  COMPLETION_LIMIT,
  GOTO_ARGUMENT,
  GOTO_ARGUMENT_DESCRIPTION,
  GOTO_DESCRIPTION,
  GOTO_PROMPT,
  PREAMBLE,
  REF_RULE,
  signpost,
  SIGNPOST_PREAMBLE,
  truncatedCompletion,
} from '../src/server/index.js';

test('server-owned command text preserves the fixed human-facing contract', () => {
  assert.equal(GOTO_PROMPT, 'goto');
  assert.equal(GOTO_ARGUMENT, 'ref');
  assert.equal(COMPLETION_LIMIT, 100);
  assert.equal(
    GOTO_DESCRIPTION,
    'Open any capability this server holds, by reference. The reference completes as you type, so the whole tree can be browsed here without asking the agent to go and look.',
  );
  assert.equal(
    GOTO_ARGUMENT_DESCRIPTION,
    'A reference such as payments/ledger/settlement. Completes on any part of the path.',
  );
  assert.equal(
    COMMAND_PREAMBLE.replace('{ref}', 'operations/status'),
    "You are at operations/status, opened by name at a person's request.",
  );
  assert.match(
    COMMAND_CLOSING,
    /contexture_open, contexture_invoke_read_only or contexture_invoke/,
  );
  assert.equal(
    commandDescription('operations/status', 'Read status.'),
    'Read status. (operations/status)',
  );
  assert.match(PREAMBLE, /contexture_open/);
  assert.match(REF_RULE, /never assemble a ref yourself/);
});

test('signposts and truncated completion state exactly what a person may infer', () => {
  assert.equal(signpost([]), '');
  assert.equal(
    signpost([
      ['operations', 2],
      ['operations/status', 0],
    ]),
    `${SIGNPOST_PREAMBLE}\n- operations: 2 sub-role(s) here; contexture_open to see them.\n- operations/status: no sub-roles; contexture_open to see what it holds.`,
  );
  assert.equal(truncatedCompletion(100, 103), '... 3 more match; keep typing to narrow.');
});
