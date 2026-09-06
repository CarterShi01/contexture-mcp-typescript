import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Launch,
  claudeCodeConfig,
  cliCommands,
  codexConfig,
  cursorConfig,
} from '../src/server/index.js';

test('Launch renders faithful host configuration and safely quoted install commands', () => {
  const launch = new Launch({
    name: 'operations',
    command: 'node',
    args: ['dist/cli/main.js', 'serve', '--label', "O'Reilly & sons"],
  });
  assert.deepEqual(launch.asList(), [
    'node',
    'dist/cli/main.js',
    'serve',
    '--label',
    "O'Reilly & sons",
  ]);
  assert.equal(launch.asShell(), `node dist/cli/main.js serve --label 'O'"'"'Reilly & sons'`);
  const expectedJSON = `${JSON.stringify(
    {
      mcpServers: {
        operations: {
          type: 'stdio',
          command: 'node',
          args: ['dist/cli/main.js', 'serve', '--label', "O'Reilly & sons"],
        },
      },
    },
    undefined,
    2,
  )}\n`;
  assert.equal(claudeCodeConfig(launch), expectedJSON);
  assert.equal(cursorConfig(launch), expectedJSON);
  assert.equal(
    codexConfig(launch),
    `[mcp_servers.operations]\ncommand = "node"\nargs = ["dist/cli/main.js", "serve", "--label", "O'Reilly & sons"]\n`,
  );
  assert.deepEqual(cliCommands(launch), {
    'claude-code': `claude mcp add --scope project operations -- node dist/cli/main.js serve --label 'O'"'"'Reilly & sons'`,
    codex: `codex mcp add operations -- node dist/cli/main.js serve --label 'O'"'"'Reilly & sons'`,
  });
});

test('Launch uses Python-compatible empty and Unicode TOML strings', () => {
  const launch = new Launch({ name: 'unicode', command: '程序', args: ['', '世界'] });
  assert.equal(launch.asShell(), "'程序' '' '世界'");
  assert.equal(
    codexConfig(launch),
    '[mcp_servers.unicode]\ncommand = "\\u7a0b\\u5e8f"\nargs = ["", "\\u4e16\\u754c"]\n',
  );
});
