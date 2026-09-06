# Contexture for TypeScript

[简体中文](README.zh-CN.md)

TypeScript implementation of Contexture, a progressive-disclosure framework
for building MCP applications whose capabilities remain navigable as they grow.

Implementations:
[Python](https://github.com/CarterShi01/contexture-mcp) ·
[TypeScript](https://github.com/CarterShi01/contexture-mcp-typescript) ·
[Go](https://github.com/CarterShi01/contexture-mcp-go) ·
[Specification](https://github.com/CarterShi01/contexture-mcp/tree/master/spec)

> **Status: active 0.12 product port; not yet a release-ready Python
> replacement.** The kernel has focused evidence and this repository ships a
> native CLI, scaffold, inspection, maintained demo, MCP transports, fixed
> root surfaces, and HTTP bearer identity. Remaining parity work includes
> request-selected HTTP roots, complete documentation/scenario mapping, and a
> clean-checkout release audit. The npm package remains private until those
> release gates pass.

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
An explicit REST allowlist is also available through `RestRouter`.

## Development and conformance

Requires Node.js 20.19 or newer and npm 11.

```bash
git clone https://github.com/CarterShi01/contexture-mcp-typescript.git
cd contexture-mcp-typescript
npm ci
npm run check
```

The binding targets Contexture Specification 0.12 at the immutable revision in
[`conformance/specification.json`](conformance/specification.json). Pinned
fixtures and golden outputs are stored under `conformance/`; tests construct and
run the TypeScript implementation before comparing its observations with them.

## Repository map

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
