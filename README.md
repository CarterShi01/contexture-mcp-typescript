# Contexture

[简体中文](README.zh-CN.md) · [Handbook](docs/handbook.md) · [Specification](https://github.com/CarterShi01/contexture-mcp/tree/master/spec) · [Changelog](CHANGELOG.md)

Implementations: [Python](https://github.com/CarterShi01/contexture-mcp) · [TypeScript](https://github.com/CarterShi01/contexture-mcp-typescript) · [Go](https://github.com/CarterShi01/contexture-mcp-go)

Contexture is a TypeScript implementation of a framework for exposing a large
application capability graph to agents without placing every tool and
instruction in the model's context at once. You declare Roles, Skills, and
Tools; Contexture compiles an immutable graph and serves a small, fixed MCP
gateway that discloses only the branch an agent chooses.

The same application runtime can back explicit REST routes for human
interfaces. Contexture is a Controller layer: it does not contain an agent
loop, call a model, or replace your business services.

- Node.js 20+
- MCP stdio and Streamable HTTP
- TypeScript declarations and typed Zod bindings
- Apache-2.0
- Stable 1.0 public API governed by Semantic Versioning

> **Status: v1.0.1 is the current public stable TypeScript release.** The
> documented public entry points and `contexture` CLI follow Semantic
> Versioning: compatible additions use minor releases and incompatible public
> API changes require a new major version. The implementation is aligned with
> the pinned Contexture 0.16 contract and applicable product rows.

Public entry points are `contexture-mcp`, `contexture-mcp/core`,
`contexture-mcp/server`, `contexture-mcp/server/surface`,
`contexture-mcp/web`, `contexture-mcp/demo`, `contexture-mcp/inspection`,
and `contexture-mcp/cli`. The release check installs the packed tarball into a
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

### Optional process members

Use `definePreProcess` and `definePostProcess` when preparing or finishing a
Role requires a separately disclosed procedure and equipment. Assign lazy
factories to `preProcess` and `postProcess`; omitting either slot adds no member
or obligation:

```ts
const owner = {
  kind: 'role' as const,
  name: 'task-worker',
  description: 'Complete one task.',
  instructions: 'Produce an evidence-backed result.',
  preProcess: () =>
    definePreProcess({
      kind: 'role',
      name: 'prepare',
      description: 'Prepare the task workspace.',
      instructions: 'Check prerequisites and prepare the workspace.',
    }),
  postProcess: () =>
    definePostProcess({
      kind: 'role',
      name: 'finish',
      description: 'Preserve the result.',
      instructions: 'Review evidence, obtain approval, then save the result.',
    }),
};
```

Both declarations remain Roles on the wire and may contain ordinary Roles,
Skills, Tools, and explicitly nested process members. They are equipment, not
alternative child branches or automatic callbacks. Opening the owner composes
fixed framework contracts around unchanged business instructions; opening a
process Role only discloses its procedure. Only explicit Tool invocation has
effects. `Publication`, `definePublication`, and the `publication` slot were
removed in 0.16: migrate finishing declarations to `definePostProcess` and
`postProcess`; there is no compatibility alias and raw legacy input is rejected.

## Example

```ts
import { z } from 'zod';
import { defineApplication, defineTool } from 'contexture-mcp';
import {
  compileRuntimeApplication,
  createContextureMcpServer,
  Gateway,
} from 'contexture-mcp/server';

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

await gateway.inspect(['operations', 'operations/diagnose']);
await gateway.open('operations');
await gateway.invokeReadOnly('operations/status', { service: 'api' });

const adapter = createContextureMcpServer({ name: 'operations', version: '0.1.0' }, gateway);
// Connect adapter.server to an official MCP SDK transport chosen by the Host.
```

Business Tools remain behind Contexture's five fixed gateway Tools. The core is
SDK-neutral; `contexture-mcp/server` is the official MCP SDK adapter boundary.
An explicit REST allowlist is available through `RestSurface` from
`contexture-mcp/web`; it offers mountable Fetch handling and an optional Node
listener over the same validated Tool Binding. `RestRouter` remains the
lower-level in-memory compatibility adapter.

`Contexture(declaration)` is the named public alias for `defineApplication`;
both create the same lazy application declaration.

## Inspect agent-visible context

The model-controlled `contexture_inspect` gateway accepts one through 32 unique,
trimmed refs from existing cards. It atomically validates the whole batch, then
returns a fixed evaluation notice and pure routing cards for each target, its
direct members, and declared uses. It preserves request and declaration order,
does not recurse, and discloses no instructions, Tool schemas or classification,
framework process contract, content, or invocation result. It invokes nothing and
records separate inspection telemetry. Disclosure-only servers expose discover,
inspect, and open, without invocation gateways.

The similarly named local CLI command is intentionally unchanged: it remains a
transport-free diagnostic trace of connection instructions, discovery, opens,
and explicitly requested local reads.

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
import { Launch, claudeCodeConfig, codexConfig } from 'contexture-mcp/server';

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

## Native managed accepted-cut reuse

The candidate `FileJournalGraphOwner` from `contexture-mcp/server/managed-graph`
reuses its immutable semantic projection only while the same native Journal's
accepted watermark is unchanged. Every read/write still checks current identity,
admission, approval where required, and the Host fence; cached facts are not
cached permission. New accepted records use `GraphJournalProjection.extend` to
validate and reduce only the suffix from that verified prefix; a failed suffix
cannot change the old immutable cut. Sequence/origin/hash, receipt/batch uniqueness,
graph/release facts and blob closure remain checked. Fresh construction and
physical recovery always replay completely. Native tests verify prefix/full
equivalence, corruption refusal, revocation and fresh-owner replay. Remaining
history/map copies and Journal work are not whole-operation O(delta) or a
10k/100k capacity certification.

## Development and conformance

Requires Node.js 20.19 or newer and npm 11.

```bash
git clone https://github.com/CarterShi01/contexture-mcp-typescript.git
cd contexture-mcp-typescript
npm ci
npm run check
```

The binding targets Contexture Specification 0.16 at the immutable revision in
[`conformance/specification.json`](conformance/specification.json). Pinned
fixtures and golden outputs are stored under `conformance/`; tests construct and
run the TypeScript implementation before comparing its observations with them.

For streamable HTTP, `Contexture-Select: operations/diagnose` promotes that
complete subtree without exposing its ancestors or siblings;
`Contexture-Select: operations/*` selects only direct members. Application
identity ceilings can only narrow this selection. `Contexture-Roots` remains a
root-only compatibility header, and sending both headers is invalid.

## Native managed-runtime candidate

`contexture-mcp/managed` is an explicit, SDK-neutral candidate API, separate
from the manifest-pinned static contract. It provides exact native binding and
registry snapshots, pure `StructuralPlan.compile`, resource-only
`prepareGeneration`, a fenced `LocalServingCoordinator`, `ManagedRuntime`
request scopes, and bounded boot-local `RunLeaseService` pins. It does **not**
establish managed-profile acceptance or cross-language product parity.

Bindings couple offline Draft 2020-12 raw-JSON validation, a synchronous native
decoder/validator, and the captured typed handler. Schema/default/coercion and
artifact contract IDs are explicit deployment attestations; changing callable
semantics requires changing those IDs. Only local JSON-pointer schema references
are supported. Config keys and secret HANDLE identities have independent
allowlists. No secret resolution, factory inference, or Python subprocess runs.

Hosts supply a trusted `ReleaseAuthority`: `capture` must read committed desired
intent and retained `RevisionState`, and `fence` must recheck current admission,
approval, desired epoch and independently compiled registry/manifest evidence
under the same synchronous owner boundary as pointer adoption. Author JSON,
graph head, uncommitted intent and old manifest digests are not authority.
`ServingPreparationProvider` compiles exact captured history and prepares
generation-exclusive resources outside that gate. The separate
`contexture-mcp/server/managed-releases` and `server/managed-graph` entry points
provide native durable owners through explicit trusted Host ports; see their
[candidate API evidence](docs/verification/managed-durable-release-api-20261107.txt).

`server/managed-graph` also exports trusted offline `StoreOperations` for source-read-only
doctor, exclusively locked consistent backup, and confirmed fresh isolated restore.
`contexture store --help` lists the additive CLI route. An explicit private operator
configuration and exact registered managed schema/software support are mandatory;
no application or historical authorization is executed. Backup verifies a real native
restore and reports its privileged watermark/digest manifest. This remains a Linux-local
candidate, not production cutover or Windows/macOS/power-loss certification. See the
[offline API and limits](docs/verification/managed-offline-api-20261107.txt).

`runtime.request(async request => { ... })` pins one generation for disclosure,
schema and execution. References are generation-scoped. Every operation checks
current Host authority against the initial selection ceiling; run pins retain
lifetime, never permission. `RunLeaseService` provides explicit create, renew,
upgrade, release and expiry, with monotonic millisecond TTLs. Custom clocks
require explicit `sweep()`. Tokens are opaque in-process envelopes, not business
arguments, serialized credentials or durable Task provenance.

Preparation adapters must unwind failed acquisition themselves and must not run
business handlers/validators, create background consumers, or share owned
resources across generations. Successfully acquired resources unwind in reverse
order. Cancellation is cooperative: acquisition and native handlers are joined,
not raced against an abort signal. A non-cooperative handler can therefore delay
draining indefinitely; no timeout fabricates resource release. Close run leases
with `await runs.shutdown()` before `await coordinator.shutdown()`; shutdown
stops admission synchronously and waits for real preparation, leases and cleanup.

### Opt-in native managed Host

`contexture-mcp/server/managed` exports `ManagedHostAdapter`: official-SDK stdio,
streamable HTTP, exact published REST routes, and explicitly mounted REST
navigation. It requires an existing `ManagedRuntime` plus a trusted
`ManagedTransportHost.enter` that authenticates and binds current identity,
authority and selection. There is **no** permissive default Principal, approval,
head/static fallback, CLI replacement, or inferred publication.

This is the explicitly negotiated `contexture.native-host-candidate/v1` Host
candidate, **not an accepted managed wire revision**. MCP requests require
`params._meta["contexture/profile"]`; HTTP also requires
`Contexture-Managed-Profile`, both with that exact candidate value. Prompt and
Resource gets require the exact listed generation-qualified
`contexture/reference` metadata. Published REST routes require
`Contexture-Reference`. Successful generation fields come from the actual
serving lease, never an input header.

Optional run carriers are mutually exclusive: protected server/channel
`RunLeaseContext`, or HTTP `Contexture-Run` with a required fresh trusted
`approve` callback returning a real service-owned context. Run create/renew/
upgrade/release remain trusted native `RunLeaseService` operations, not invented
remote command/approval endpoints. Run lifetime never grants permission.
`listen()` is loopback-only; external deployments must supply their own listener
and production Host authority. Close the adapter before run/read/coordinator/
Journal owners. See the
[public Host API and measured limitations](docs/verification/managed-native-host-api-20261107.txt).

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
