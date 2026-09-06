# Contexture TypeScript handbook

Contexture keeps a growing MCP application's capabilities navigable. A model
first sees small routing cards, opens one relevant branch at a time, and only
then receives a Skill procedure or a Tool schema. It does not choose models,
run an agent loop, or replace application authorization.

This handbook describes the TypeScript binding as it exists today. Its public
syntax is native TypeScript; its observable disclosure and gateway behavior is
anchored to the Contexture specification.

## 1. Create a project

Use Node.js 20.19+ and npm 11. The package's native `project` template creates
one lazy declaration, one read-only Tool, and a local command workflow:

```bash
npx contexture new operations --template project
cd operations
npm install
npm run check
npm run list
npm run inspect -- --all --summary
npx contexture call operations-assistant/ping --input '{"target":"local"}'
```

`new` derives stable package and Role names from its argument and refuses to
overwrite an existing directory. It is intentionally a small starting point:
add only the capabilities your application owns.

## 2. Declare one application

The generated `assistant/app.js` exports `app`. That declaration is inert: it
does not construct nodes, open Channels, start an MCP server, or import a Host
SDK.

```js
import { defineApplication, defineTool } from '@contexture/mcp';
import { z } from 'zod';

const status = defineTool({
  kind: 'tool',
  name: 'status',
  description: 'Return one service status.',
  readOnly: true,
  input: z.strictObject({ service: z.string() }),
  invoke: ({ service }) => ({ service, healthy: true }),
});

export const app = defineApplication({
  name: 'operations',
  roots: [
    () => ({
      kind: 'role',
      name: 'operations',
      description: 'Operate services.',
      instructions: 'Inspect evidence before changing anything.',
      skills: [
        () => ({
          kind: 'skill',
          name: 'diagnose',
          description: 'Diagnose an unhealthy service.',
          instructions: 'Read status, then explain the evidence.',
          uses: ['operations/status'],
        }),
      ],
      tools: [() => status],
    }),
  ],
});
```

`Contexture(declaration)` is the named public alias for `defineApplication`.
Both preserve lazy factories and normalize the application name. Use a factory
for every Role, Skill, and Tool: compilation creates a fresh immutable graph
snapshot from those factories.

## 3. Choose the right node

| Use   | When it belongs there                                                 |
| ----- | --------------------------------------------------------------------- |
| Role  | A responsibility boundary or a choice between distinct branches.      |
| Skill | A model-facing procedure, ordering rule, or evidence requirement.     |
| Tool  | Deterministic application code that Contexture validates and invokes. |

Do not add a child Role just to organize files. A model opens every direct
member of a Role together, so Skills and Tools needed for one responsibility
usually belong under the same Role. A `uses` reference names the Tool a Skill
needs; take the canonical ref from `list` or a disclosed card rather than
constructing it from memory.

## 4. Work locally before starting a Host

| Question                             | Command                                |
| ------------------------------------ | -------------------------------------- |
| Does the declaration compile?        | `npm run check`                        |
| Which refs exist?                    | `npm run list`                         |
| What will an agent receive?          | `npm run inspect -- --all --summary`   |
| What does one read-only Tool return? | `npx contexture call REF --input JSON` |

`check` compiles without opening application Channels. `call` uses the same
validated Tool Binding as serving. It permits read-only Tools by default; a
writing Tool requires the explicit `--allow-write` decision.

## 5. Inspect agent-visible context

`inspect` is a transport-free replay, not an approximation. It builds the
same instructions, discovery payloads, open cards, and recovery text used by
the native server implementation.

```bash
npx contexture inspect operations --all --summary
npx contexture inspect operations/runbook --read
npx contexture inspect --all --json > contexture-trace.json
```

`--all` visits each visible ref once in breadth-first Role order. `--summary`
keeps token estimates and Host-limit findings but suppresses payload bodies.
`--json` is suitable for CI diffs. `--read` runs only no-argument, read-only
content Tools, so use it only when that local read is intended. Outside a
project, `inspect` deliberately replays the bundled demo and writes its notice
to stderr so JSON stdout remains valid.

## 6. Serve through an MCP Host

The declaration does not change when it is served. The server adapter exposes
four fixed Contexture gateway Tools; business Tools are progressively disclosed
behind them rather than registered at MCP top level.

```bash
npm run serve
npx contexture demo --transport streamable-http --port 8000
```

Stdio is the default. Use `--transport streamable-http` only with a deliberate
Host/network configuration. Non-loopback startup requires the corresponding
Host, origin, and anonymous-access decisions; see the server option errors
rather than weakening them.

For Claude Code, Cursor, or Codex configuration, use `Launch` from
`@contexture/mcp/server`. It renders host configuration from the server command
instead of duplicating the application's declared context.

## 7. Keep the contract honest

Run the full package gate before proposing a change:

```bash
npm run check
```

It runs formatting, linting, type checks, native tests, build and package
checks, a packed external-consumer check, and a packed generated-project
workflow. Do not change golden outputs merely to make a binding pass: those
files are a cross-language protocol contract.

Read [architecture.md](architecture.md) for dependency boundaries,
[CONTRIBUTING.md](../CONTRIBUTING.md) for contribution rules, and
[RELEASING.md](../RELEASING.md) for the intentionally closed release process.
The package remains private until all product-parity and release gates are
actually satisfied.
