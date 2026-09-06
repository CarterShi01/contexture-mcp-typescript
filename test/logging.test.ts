import assert from 'node:assert/strict';
import test from 'node:test';

import { configureLogging, log } from '../src/server/logging.js';

test('Contexture logging writes eligible lifecycle records to stderr, never stdout', () => {
  const write = process.stderr.write;
  let output = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    configureLogging('warn');
    log('info', 'not emitted');
    log('warn', 'served safely');
  } finally {
    process.stderr.write = write;
    configureLogging('info');
  }
  assert.doesNotMatch(output, /not emitted/);
  assert.match(output, /WARN contexture: served safely/);
});
