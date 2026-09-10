# Host verification

## Contexture 0.12 TypeScript candidate

Recorded 2026-09-10 with Claude Code 2.1.133 against commit `dec12f5`.

| Client                         | Version | Result                                            |
| ------------------------------ | ------- | ------------------------------------------------- |
| Claude Code                    | 2.1.133 | passed: MCP-only diagnosis, no permission denials |
| Codex CLI                      | 0.153.0 | blocked before inference: not logged in           |
| Official TypeScript MCP client | 2.0.0   | passed in the automated suite                     |

Claude Code was started with an isolated MCP configuration that launched the
built TypeScript demo. All built-in tools were disabled; the explicit available
and allowed set contained only `contexture_discover`, `contexture_open`,
`contexture_invoke_read_only`, and `contexture_invoke` from that server.

The model navigated the maintained Kubernetes incident, called Pod status,
previous logs, events, and `crash_loop_runbook`, and reported:

- `CrashLoopBackOff`, 14 restarts, and `ready=false`;
- `DB_URL` missing from the process environment;
- exit code 1, explicitly distinguished from OOM/137;
- add the key to the projected ConfigMap or Secret, then roll out;
- do not restart or delete the Pod first.

The successful result used seven model turns, returned no permission denial,
and did not use repository, shell, filesystem, or web evidence. This verifies
that a real Host can navigate and invoke the packed candidate's current
four-gateway surface. Request-selected HTTP surfaces and Prompt-only roots
remain covered by official-client integration tests because this diagnosis is a
stdio model-navigation scenario.

Codex CLI was available through the pinned ephemeral npm package, but
`codex login status` returned `Not logged in`. No model request was made and no
pass or product failure is claimed for that row.

See [verify_claude_code.md](verify_claude_code.md) and
[verify_codex.md](verify_codex.md) for reproduction and cleanup.
