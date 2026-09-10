# Contexture for TypeScript

[简体中文](README.zh-CN.md)

TypeScript implementation of Contexture, a progressive-disclosure framework
for building MCP applications whose capabilities remain navigable as they grow.

Implementations:
[Python](https://github.com/CarterShi01/contexture-mcp) ·
[TypeScript](https://github.com/CarterShi01/contexture-mcp-typescript) ·
[Go](https://github.com/CarterShi01/contexture-mcp-go) ·
[Specification](https://github.com/CarterShi01/contexture-mcp/tree/master/spec)

> **Status: Python 0.14 optional Role Publication parity, Python 0.13
> path-selected surface parity, and all applicable 0.12
> product rows are verified; release remains guarded.** This repository ships a native CLI, scaffold,
> inspection, maintained demo, MCP transports, fixed and request-selected HTTP
> surfaces, REST, and bearer identity. Remaining parity work is documentation
> and release-asset review plus a clean-checkout release audit. The npm package
> remains private until those release gates pass.

Public entry points are `@contexture/mcp`, `@contexture/mcp/core`,
`@contexture/mcp/server`, `@contexture/mcp/server/surface`,
`@contexture/mcp/web`, `@contexture/mcp/demo`, `@contexture/mcp/inspection`,
and `@contexture/mcp/cli`. The release check installs the packed tarball into a
separate project and imports each entry point.

## Node model

TypeScript uses declarations rather than Python-style runtime classes. The
closed node set has explicit modules — `node.ts`, `role.ts`, `skill.ts`,
and `tool.ts` — under `src/core/model/`; `declarations.ts` remains their
compatibility barrel. The application composition root lives in
`src/application.ts`:

- `RoleDeclaration` is a responsibility and containment boundary.
- `SkillDeclaration` is procedure followed by a model.
- `ToolDeclaration` is an executable capability with one Zod-backed Binding.
- `NodeDeclaration` is their discriminated union.

The `kind` field performs the same distinction that the Python `Role`, `Skill`,
and `Tool` classes perform. Interfaces disappear from emitted JavaScript; this
is intentional TypeScript-native syntax, not a missing implementation.

### Optional Publication

Use `definePublication` when finishing a Role requires a separately disclosed
procedure and equipment. Assign its lazy factory to `publication`; omitting the
member disables the obligation:

```ts
const owner = {
  kind: 'role' as const,
  name: 'task-worker',
  description: 'Complete one task.',
  instructions: 'Produce an evidence-backed result.',
  publication: () =>
    definePublication({
      kind: 'role',
      name: 'publish',
      description: 'Preserve the result.',
      instructions: 'Review evidence, obtain approval, then save the result.',
    }),
};
```

A Publication remains a Role on the wire and can contain ordinary Roles,
Skills, Tools, and an explicitly nested Publication. It is finishing equipment,
not an alternative child branch or an automatic callback. Opening the owner
adds the Publication card and a framework closing contract; opening the
Publication only discloses its procedure. Only explicit Tool invocation has
effects, and blocked, failed, or approval-pending publication must be reported
honestly.

## Example

```ts
import { z } from 'zod';
import { defineApplication, defineTool } from '@contexture/mcp';
import {
  compileRuntimeApplication,
  createContextureMcpServer,
  Gateway,
} from '@contexture/mcp/server';

const status = defineTool({
  kind: 'tool',
  name: 'status',
  description: 'Return one service status.',
  readOnly: true,
  input: z.strictObject({ service: z.string() }),
  invoke: ({ service }) => ({ service, healthy: true }),
});

const application = defineApplication({
  name: 'operations',
  roots: [
    () => ({
      kind: 'role',
      name: 'operations',
      description: 'Operate services.',
      instructions: 'Inspect before changing anything.',
      skills: [
        () => ({
          kind: 'skill',
          name: 'diagnose',
          description: 'Diagnose an unhealthy service.',
          instructions: 'Read status and explain the evidence.',
          uses: ['operations/status'],
        }),
      ],
      tools: [() => status],
    }),
  ],
});

const compiled = compileRuntimeApplication(application);
const gateway = new Gateway(compiled.disclosure, compiled.runtime);

await gateway.open('operations');
await gateway.invokeReadOnly('operations/status', { service: 'api' });

const adapter = createContextureMcpServer({ name: 'operations', version: '0.1.0' }, gateway);
// Connect adapter.server to an official MCP SDK transport chosen by the Host.
```

Business Tools remain behind Contexture's four fixed gateway Tools. The core is
SDK-neutral; `@contexture/mcp/server` is the official MCP SDK adapter boundary.
An explicit REST allowlist is available through `RestSurface` from
`@contexture/mcp/web`; it offers mountable Fetch handling and an optional Node
listener over the same validated Tool Binding. `RestRouter` remains the
lower-level in-memory compatibility adapter.

`Contexture(declaration)` is the named public alias for `defineApplication`;
both create the same lazy application declaration.

## Inspect agent-visible context

`contexture inspect` replays the exact instructions, discovery payload, and
progressive-disclosure cards produced by the native implementation. It starts
no MCP transport. Use it after changing a declaration, before connecting a
Host:

```bash
npx contexture inspect operations --all --summary
npx contexture inspect operations/runbook --read
npx contexture inspect --all --json > contexture-trace.json
```

`--all` walks every visible ref once in breadth-first role order; `--summary`
keeps the cost and host-limit checks while omitting payload bodies; `--json`
creates a stable trace for CI comparison. `--read` additionally calls only a
no-argument, read-only content Tool, so use it only when that local read is
intended. With no project configuration or explicit target, `inspect` replays
the bundled demo and reports that fallback on stderr.

## Create and run a project

The native command creates the single supported `project` template. Its
generated application owns its local workflows, so run them from the new
project rather than from this repository:

```bash
npx contexture new operations --template project
cd operations
npm install
npm run check
npm run list
npm run inspect -- --all --summary
npx contexture call operations-assistant/ping --input '{"target":"local"}'
```

`contexture new` refuses an existing destination and unknown templates. The
generated `check` validates without opening application dependencies; `call`
uses the same runtime Binding as a served application and requires
`--allow-write` for a writing Tool.

## Host configuration

Keep host configuration as a pointer to the server command, rather than a copy
of an application's declared context. `Launch` produces the exact formats for
Claude Code, Cursor, and Codex:

```ts
import { Launch, claudeCodeConfig, codexConfig } from '@contexture/mcp/server';

const launch = new Launch({
  name: 'operations',
  command: 'node',
  args: ['dist/cli/main.js', 'serve'],
});

console.log(claudeCodeConfig(launch)); // .mcp.json or .cursor/mcp.json
console.log(codexConfig(launch)); // stanza for ~/.codex/config.toml
```

`cliCommands(launch)` returns safely quoted `claude mcp add` and `codex mcp
add` commands. The same API is available to applications that distribute a
custom stdio entry point.

## Development and conformance

Requires Node.js 20.19 or newer and npm 11.

```bash
git clone https://github.com/CarterShi01/contexture-mcp-typescript.git
cd contexture-mcp-typescript
npm ci
npm run check
```

The binding targets Contexture Specification 0.14 at the immutable revision in
[`conformance/specification.json`](conformance/specification.json). Pinned
fixtures and golden outputs are stored under `conformance/`; tests construct and
run the TypeScript implementation before comparing its observations with them.

For streamable HTTP, `Contexture-Select: operations/diagnose` promotes that
complete subtree without exposing its ancestors or siblings;
`Contexture-Select: operations/*` selects only direct members. Application
identity ceilings can only narrow this selection. `Contexture-Roots` remains a
root-only compatibility header, and sending both headers is invalid.

## Repository map

Read the [TypeScript handbook](docs/handbook.md), its
[Simplified Chinese translation](docs/handbook.zh-CN.md), and the
[architecture document](docs/architecture.md). Real Host evidence and
reproduction steps are recorded in [Host verification](docs/verification/hosts.md).

```text
src/application.ts        Contexture application declaration and composition root
src/core/foundation/      Shared constants and errors
src/core/model/           Role, Skill, Tool, Node, Binding, Index, and runtime model
src/core/mcp-interface/   Prompt, Resource, and fixed MCP Tool-plane declarations
src/server/               Runtime compilation, MCP SDK adapter, and Host surfaces
src/web/                  Explicit REST route and surface adapter
test/                     focused conformance and package tests
conformance/              pinned specification identity, fixtures, and golden data
```

English is the primary project language. Simplified Chinese documentation is a
maintained translation.

## License

Apache-2.0. See [LICENSE](LICENSE).
