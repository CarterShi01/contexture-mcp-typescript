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

`RootSelection` is an all-roots value or an exact root allowlist: it trims
requested root names, rejects descendants, and can only attenuate another
selection. `SelectedGraph` exposes only selected `roots`, `walk`, `find`,
`refOf`, `parentOf`, `childrenOf`, `usesOf`, and `dependentsOf`; cross-root
uses and dependents are filtered. Request headers use the same projection and
cannot disclose roots outside an identity ceiling. `currentRootSelection()`
returns the request-local projection inside a Tool and the compatibility
all-roots value outside an invocation.

Optional framework telemetry is declared with `telemetry: new InMemoryTelemetry()`.
It aggregates successful Role and Skill opens plus successful or failed Tool
invocations as `NodeUsage` (`callCount`, `errorCount`, and `lastUsedAt`). It
does not observe discovery or opening a Tool card. A custom `Telemetry` can be
used for export; exporter rejection or a synchronous throw is isolated from
navigation and business outcomes. `compileRuntimeApplication` shares one
collector with its Disclosure, Runtime, and gateway surfaces.

The declaration facade is SDK-neutral: its public inventory is `Contexture`,
`defineApplication`, `ApplicationDeclaration`, the native `Prompt` and
`Resource` data interfaces, node declarations, and request facts such as
`Principal`. `Prompt` and `Resource` are TypeScript object shapes rather than
Python-style subclass bases. `defineApplication` snapshots them and rejects
blank `opens`, `description`, `uri`, or supplied `name` values immediately;
it also requires `modelMayOpen` to be a boolean when supplied. Resolving an
`opens` ref and checking that a Resource targets an argument-free read-only
Tool remain compilation concerns. Every public compilation entry point applies
this same normalization, so calling a compiler directly with a raw JavaScript
object cannot bypass declaration validation or Prompt reservation semantics.

`modelMayOpen` is intentionally a boolean in TypeScript: omission or `true`
keeps a Prompt model-navigable, while `false` reserves that declared capability
for person-controlled Prompt or `goto` navigation. This has the same
observable reservation meaning as the Python declaration, without copying its
syntax.

Direct compiled-index callers can classify a failed lookup with
`NodeNotFoundError`. Its `reason` is one of `LookupFailure.EMPTY_REF`,
`NO_SUCH_ROOT`, `NOT_A_CONTAINER`, `NO_SUCH_MEMBER`, or `WRONG_KIND`, and its
stable facts include the requested `ref`, relevant `segment` or `scope`, and
available `known` names when applicable. Lookup ignores empty slash segments;
the original requested `ref` remains in error facts. `known` is empty for an
empty reference or a non-container, and otherwise is canonically sorted;
`scope` is the node name where resolution stopped. Normal runtime calls
continue to render unknown capabilities as their existing refusal surface.

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

## 6. Offer person-controlled navigation

Prompts are for a person choosing from a Host menu, not an alternate surface
for a model. A declared Prompt opens one fixed ref; every served application
also publishes `goto`, whose required `ref` argument lets a person browse a
known path without asking the model to navigate first.

```js
export const app = defineApplication({
  // roots: [...],
  prompts: [
    {
      name: 'open-change-window',
      opens: 'operations/change-window',
      description: 'Open the change-window procedure.',
      modelMayOpen: false,
    },
  ],
});
```

Both the named Prompt and `goto` use the same person-controlled open path. Its
text identifies the ref, includes ancestor signposts without disclosing their
contents, then shows the normal node payload. `modelMayOpen: false` reserves a
declared capability from model navigation; it does not hide it from the person
who owns the Host. Do not present a Prompt as a business Tool or duplicate its
procedure in its description.

The native MCP completion endpoint serves only `goto`'s `ref` argument and
only refs inside the current selected root surface. It returns at most 100
values; if more match, the final visible value says how many remain while the
response keeps the true `total` and `hasMore` facts. A completion request for
another Prompt or argument returns no Contexture refs.

## 7. Publish host-readable documents

A `Resource` gives a Host a stable URI for content that already belongs to a
Tool. It must name an argument-free, read-only Tool, so a resource read uses
the same validated binding as a local read-only call and cannot change the
world. The resource metadata is what a Host lists; the URI is what it reads.

```js
export const app = defineApplication({
  // roots: [...], including a read-only `operations/runbook` Tool with no input
  resources: [
    {
      opens: 'operations/runbook',
      uri: 'contexture://operations/runbook',
      description: 'The current operations runbook.',
      mimeType: 'text/markdown',
    },
  ],
});
```

Resources outside the Host's selected root surface are neither listed nor
readable. Do not use a Resource for a parameterized lookup, a write, or a
second implementation of a Tool; use the declared Tool through Contexture's
gateway instead.

## 8. Publish an explicit REST surface

Use `RestSurface` only for a deliberately published human or service API. It
does not create a ref dispatcher: every fixed path names one existing Tool.
GET and HEAD may invoke only read-only Tools; POST, PUT, PATCH, and DELETE may
invoke only writing Tools. The same runtime Binding validates REST input and
the MCP gateway input, so there is no second business implementation.

```js
import { PermissionError, Principal, RejectedError } from '@contexture/mcp';
import { compileRuntimeApplication } from '@contexture/mcp/server';
import { RestSurface } from '@contexture/mcp/web';

const runtime = compileRuntimeApplication(app).runtime;
const rest = new RestSurface(
  runtime,
  [
    { method: 'GET', path: '/v1/status', ref: 'operations/status' },
    { method: 'POST', path: '/v1/restart', ref: 'operations/restart', status: 202 },
  ],
  async (request) =>
    request.headers.authorization === 'Bearer local-token'
      ? new Principal({ subject: 'operator' })
      : undefined,
);
const listener = await rest.listen({ host: '127.0.0.1', port: 8080 });
```

`fetch(request)` is mountable in a Fetch-compatible Host. `listen()` is the
small built-in Node adapter and opens application Channels once for the whole
listener lifetime; call `await listener.close()` during shutdown. GET/HEAD
inputs come from query parameters (a repeated key becomes a string array);
commands accept an optional `application/json` object body up to 1 MiB by
default. HEAD falls back to a declared GET route and preserves its headers but
never sends its response body.

The optional authenticator receives normalized lower-case headers and all query
values, then must return a `Principal`. A missing identity receives 401; an
unpublished path receives 404. Invalid JSON, body shape, content type, body
size, binding arguments, and authorization failures receive structured
`application/problem+json` responses with no-store caching. Do not trust a
claimed principal header without an authenticator, and do not publish a Tool
merely because it is valid in the application graph.

For a deliberate business outcome, throw `new PermissionError(detail)` for a
403 `forbidden` response or `new RejectedError(detail)` for a 422 `rejected`
response. Invalid binding arguments are also 422 `invalid-arguments`; an
ordinary unexpected `Error` is a 500 `controller-failed` response. These are
explicit Contexture error types, not string-name conventions.

Python's `Route` permits every HTTP status from 100 through 599. The
TypeScript `RestSurface` is Fetch-based and always serializes JSON, so it
rejects 1xx, 204, 205, and 304 during route construction: standard Fetch
`Response` cannot represent those body-bearing final responses. Choose a
Fetch-safe JSON status from 200 through 599 other than 204, 205, or 304.

## 9. Serve through an MCP Host

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

`ContextureOptions` also accepts `logLevel: 'debug' | 'info' | 'warn' |
'error'` for programmatic startup. Contexture lifecycle records always use
stderr, so MCP stdio owns stdout exclusively. `configureLogging(level)` is
available when an embedding Host needs to establish that policy before startup.

Unless an application supplies `instructions`, Contexture returns a compact,
breadth-first roster with the fixed navigation contract in MCP initialization.
For HTTP root selection, that roster is generated for the selected root surface
on each request; it never advertises an omitted root.

For Claude Code, Cursor, or Codex configuration, use `Launch` from
`@contexture/mcp/server`. It renders host configuration from the server command
instead of duplicating the application's declared context.

## 10. Keep the contract honest

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
