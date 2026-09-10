# Verify with Claude Code

Build the candidate first:

```bash
npm ci
npm run check
```

Create an isolated MCP configuration whose command is the absolute Node
executable and whose arguments are the absolute built CLI path followed by
`demo`. Do not add another server to that file.

Run Claude Code from outside the repository with `--strict-mcp-config`. Set both
`--tools` and `--allowed-tools` to exactly these four names:

```text
mcp__contexture-demo__contexture_discover
mcp__contexture-demo__contexture_open
mcp__contexture-demo__contexture_invoke_read_only
mcp__contexture-demo__contexture_invoke
```

Use this task:

```text
Use only the contexture-demo MCP server to diagnose why pod
payments-api-7d9c in namespace prod keeps restarting. Start from Contexture's
disclosed Role and Skill context. Do not inspect files, use shell commands, or
use any non-MCP source. Call the disclosed evidence tools and the
crash_loop_runbook Tool. Explain the root cause, cite the exit code, and give
the smallest safe next action.
```

A pass must collect status, previous logs, events, and the runbook; identify the
missing `DB_URL`; cite exit code 1 rather than 137; recommend repairing the
ConfigMap or Secret before rollout; and reject a blind restart. The JSON result
must contain no permission denials.

The 2026-09-10 run passed with Claude Code 2.1.133 against commit `dec12f5` in
seven model turns. All built-in tools were disabled, so the answer came only
from the TypeScript MCP server.

Delete the temporary MCP configuration after the run.
