# Contexture for TypeScript

[简体中文](README.zh-CN.md)

TypeScript implementation of Contexture, a progressive-disclosure framework
for building MCP applications whose capabilities stay navigable as they grow.

Implementations:
[Python](https://github.com/CarterShi01/contexture-mcp) ·
[TypeScript](https://github.com/CarterShi01/contexture-mcp-typescript) ·
[Go](https://github.com/CarterShi01/contexture-mcp-go) ·
[Specification](https://github.com/CarterShi01/contexture-mcp/tree/master/spec)

> **Status: scaffold, not released.** The package is intentionally marked
> `private` until it satisfies the release gate. It currently establishes the
> language-native API boundary, dependency layering, CI, and conformance lock;
> it is not yet a usable replacement for the Python implementation.

## Design boundary

Contexture keeps business declarations separate from Host adapters:

```text
application declarations
        ↓
SDK-neutral core
        ↓
compile → disclose → invoke
        ↓
MCP and optional HTTP surfaces
```

The core must not import an MCP SDK. The `server` export is the adapter seam
and currently proves integration with the official MCP TypeScript SDK without
claiming that Contexture's fixed gateway has been implemented.

## Development

Prerequisites are Node.js 20.19 or newer and npm 11.

```bash
git clone https://github.com/CarterShi01/contexture-mcp-typescript.git
cd contexture-mcp-typescript
npm ci
npm run check
```

The current declaration seam is deliberately small:

```ts
import { defineApplication } from '@contexture/mcp';

const application = defineApplication({
  name: 'operations',
  roots: [
    () => ({
      kind: 'role',
      name: 'operations',
      description: 'Handle routine operational questions.',
      instructions: 'Inspect first.',
    }),
  ],
});
```

Constructing this declaration does not call the root factory. Compilation,
Index construction, disclosure, and invocation are upcoming milestones.

## Conformance

The binding targets Contexture Specification 0.12 at the immutable revision in
[`conformance/specification.json`](conformance/specification.json). The status
file lists implemented rules explicitly; copied prose or an incomplete golden
run does not count as conformance.

The normative contract remains in the
[reference repository](https://github.com/CarterShi01/contexture-mcp/tree/master/spec).
TypeScript APIs should follow TypeScript conventions while producing the same
observable behavior and protocol payloads.

Implementation sessions begin with the reference repository's
[`spec/porting/TERRA_GOAL.md`](https://github.com/CarterShi01/contexture-mcp/blob/master/spec/porting/TERRA_GOAL.md)
and use its conformance matrix as the task ledger. `npm run conformance:check`
verifies this repository's revision pin, all 16 rule states, and the required
fixture and golden inventories; it does not claim those assets were executed.

## Repository map

```text
src/core/       SDK-neutral declarations and future compiler
src/server/     MCP and future Host adapters
test/           unit, layering, and package tests
conformance/    pinned specification identity and implementation status
docs/           architecture and implementation plans
```

## Language policy

English is the primary project language. Source comments, identifiers, errors,
API documentation, release notes, and the authoritative README are English.
Simplified Chinese user documentation is maintained as a translation.

## License

Apache-2.0. See [LICENSE](LICENSE).
