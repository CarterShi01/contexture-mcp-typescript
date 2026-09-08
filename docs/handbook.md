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

Node `name` and `description`, Role and Skill `instructions`, and every `uses`
ref are validated as non-blank when the lazy declaration compiles. A Skill may
refer to another Skill, including a cycle: opening it returns its own
instructions and only routing cards for its `uses`, never the referenced
Skill's instructions or its own `uses`. Opening a Role likewise gives its own
instructions plus one-level routing cards for contained members. These bounded
cards keep declared reference cycles safe and prevent a single open from
expanding an unrelated procedure.

`defineTool(...)` is the native executable Tool constructor. It validates the
Tool identity, strict Zod input, handler, and `uses` shape immediately, and
snapshots its `uses` list. Its omitted `readOnly` defaults to `false`: an
unclassified Tool is treated as writing, just as Python's `read_only` default.
The constructor is the recommended TypeScript declaration form because a bare
object has no constructor defaults; it is still validated again when compiled.
Each bound Tool snapshots the declared name, handler, and rendered JSON schema,
so later mutation of a caller-owned declaration cannot change a served card or
call path. A Tool without a Binding is valid only in a disclosure-only Index;
its routing cards intentionally omit `read_only` and `input_schema`, and every
attempt to obtain a Binding or make a runtime call is a typed model-validation
failure.

The same one-layer rule applies when an active Tool or Role declares `uses`.
Referenced nodes are routing cards, so their own instructions and dependencies
are never expanded in that response. A disclosure-only Tool remains structural:
its cards omit both `read_only` and `input_schema`, but an explicitly opened
Tool can still name its direct structural `uses` cards. Root selection filters
those cards before rendering, so a cross-root dependency never widens a request.
A `modelMayOpen: false` Prompt reservation removes its target from another
active node's `uses` cards. Unlike a prompt-only root, its ordinary containment
card remains visible, so the model can direct the person to the Prompt; a model
open is refused, while the named Prompt or `goto` opens the same canonical
active payload for that person. `unrestricted()` removes prompt-root model
ownership only: it preserves the existing root-selection ceiling.

`RootSelection` is an all-roots value or an exact root allowlist: it trims
requested root names, rejects descendants, and can only attenuate another
selection. `SelectedGraph` exposes only selected `roots`, `walk`, `find`,
`refOf`, `parentOf`, `childrenOf`, `usesOf`, and `dependentsOf`; cross-root
uses and dependents are filtered. Request headers use the same projection and
cannot disclose roots outside an identity ceiling. `currentRootSelection()`
returns the request-local projection inside a Tool and the compatibility
all-roots value outside an invocation.

`currentPrincipal()` returns the request identity while a Tool is running. It
returns `undefined` for an unauthenticated call and outside an invocation;
Contexture never invents an anonymous Principal. The application decides
whether its capability requires identity.

`Principal.claims` is a shallow, immutable snapshot for application code, and
may contain a complete decoded token. Its `toString()`, Node `inspect`/console
representation, and JSON representation deliberately expose only `subject`,
`clientId`, `issuer`, and code-point-sorted `scopes`; do not log raw claims.
When identity crosses the MCP authentication adapter, `claims.iss` is the
authoritative issuer when present. A machine credential may therefore retain a
`clientId`, issuer, scopes, and claims while having no `subject`.

`currentGraph()` and `currentTelemetry()` are stricter: they are available only
inside a running Tool and reject no-active-invocation access. `ToolCallContext`
preserves Host-owned `host` and cancellation `signal`, while Contexture rebuilds
its `principal`, `channels`, `telemetry`, `graph`, and `selection` facts for the
exact call. A handler therefore cannot receive a caller-supplied framework
snapshot that disagrees with its request-local context.

For an imperative embedding phase, `ControllerManager` captures a root factory
once through `registerRole`, `registerSkill`, `registerTool`, or `registerRoot`.
It validates the complete captured tree and owns a deep snapshot; `roles`,
`skills`, `tools`, and `roots` return defensive snapshots (with roots ordered
Role, Skill, Tool). `application(name)` and `compile(name)` always issue fresh
trees, so later registration or `rebindChannels()` cannot change an older
Application or compiled Index. Channels are intentionally identity snapshots:
rebinding affects only Applications produced afterward.

`Channels` is a nominal lifecycle base class: extend it when a deployment
dependency must open before serving and close afterward. Do not use a plain
object with similarly named `open` and `close` methods; it is not a lifecycle
owner. `ControllerManager` also accepts an ordinary already-built deployment
handle. It preserves that exact value without inspecting or invoking it, and a
Tool receives the same framework-owned identity as `context.channels`. This
is useful for clients, configuration, or test doubles that need no lifecycle.
The declarative `defineApplication({ channels })` entry point intentionally
accepts only a `Channels` instance; use `ControllerManager` for an ordinary
handle. Contexture overwrites any caller-provided `context.channels` value.
Manager-produced raw-handle snapshots are accepted by runtime and server
compilation, while disclosure-only compilation continues to reject every
present handle.

Every executable server exposes the same ordered four-tool `Gateway`: discover,
open, read-only invoke, and invoke. A disclosure-only host exposes its first
two navigation entries. Lookup and wrong-door failures are rendered there as
actionable `RefusedError` recoveries, while `RootOutsideSelectionError` remains
typed so an authorization ceiling cannot disclose another root. Prompt
reservations are checked only after that ceiling.

For an embedding that needs only model navigation, `DisclosureAPI` exposes the
same first two doors without a Runtime or transport. Construct it with a
`Disclosure`; its `discover`, `open`, and `selectedGraph` calls are stateless
and use the same selected-root ceiling. `openForPerson` (also available as
`openForAPerson`) bypasses only model reservations and prompt-root visibility.
The API converts ordinary lookup failures into the standard `RefusedError`
recovery while preserving `RootOutsideSelectionError` as a typed,
non-leaking authorization result. The raw `Disclosure` remains available when
a Host needs structured lookup facts instead.

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

Foundation owns the shared declaration vocabulary: `PACKAGE_NAME` is the
framework name (`contexture`), `PACKAGE_VERSION` is this binding release, and
`REFERENCE_SEPARATOR` spells a Contexture ref rather than an HTTP path or a
Resource URI. `DISCOVER_GATEWAY_NAME`, `OPEN_GATEWAY_NAME`,
`INVOKE_READ_ONLY_GATEWAY_NAME`, and `INVOKE_GATEWAY_NAME` (and their ordered
`GATEWAY_TOOL_NAMES` inventory) are the same closed names used by the model,
MCP primitive projection, and server. `Prompt` and `Resource` are likewise
foundation-owned SDK-neutral data shapes; the retained `core/mcp-interface`
type exports are compatibility spellings, not duplicate declarations.

`modelMayOpen` is intentionally a boolean in TypeScript: omission or `true`
keeps a Prompt model-navigable, while `false` reserves that declared capability
for person-controlled Prompt or `goto` navigation. This has the same
observable reservation meaning as the Python declaration, without copying its
syntax. A custom nested `Disclosure` `promptRoots` reference is invalid and
raises the public `ModelValidationError`; prompt-only ownership applies to
complete roots, not an arbitrary descendant.

Direct compiled-index callers can classify a failed lookup with
`NodeNotFoundError`. Its `reason` is one of `LookupFailure.EMPTY_REF`,
`NO_SUCH_ROOT`, `NOT_A_CONTAINER`, `NO_SUCH_MEMBER`, or `WRONG_KIND`, and its
stable facts include the requested `ref`, relevant `segment` or `scope`, and
available `known` names when applicable. Lookup ignores empty slash segments;
the original requested `ref` remains in error facts. `known` is empty for an
empty reference or a non-container, and otherwise is canonically sorted;
`scope` is the node name where resolution stopped. Normal runtime calls
continue to render unknown capabilities as their existing refusal surface.

All framework-domain failures extend `ContextureError`. Structural failures
remain classifiable as `ModelValidationError`, with `DeclarationError` and
`DuplicateNameError` as narrower categories. A `NodeNotFoundError` keeps facts
rather than agent prose: its native `message` and `developerSummary()` are
terse field-shaped diagnostics, and `within(ref)` returns a new immutable
failure only when a local lookup has no complete ref. Gateway alone renders
those facts into agent recovery prose. Direct runtime callers receive a typed
`WrongDoorError` with `ref`, `readOnly`, and a message that says whether the
Tool is read-only or writing; Gateway may wrap it in an agent-facing refusal.

### Compiled Index queries

`compileRuntimeApplication(...).index` is the public, immutable `Index`
facade (also retained under the compatibility type name `CompiledApplication`).
It records one compilation snapshot: `has`, `size`, `isBound`, root groups,
canonical `find`, `tool`, parent/child and dependency queries never run a
factory or acquire Channels. `nodesWithRefs`, `skills`, and `rolesWithRefs`
walk containment depth-first in declaration order; `rolesByLevel` walks Roles
breadth-first. None follows `uses`, because that overlay may legally cycle.

`matchingRefs(value, limit)` ranks the whole compiled address space by full
prefix, final-segment prefix, any-segment prefix, then substring; ties use
Unicode code-point length and order. Its `total` is pre-limit, and a negative
limit deliberately yields no values rather than expanding a bounded response.
`signpost(ref)` returns only ancestor refs and direct sub-Role counts;
`crossings()` lists declared `uses` edges that leave their root. Both are
structural facts, not disclosure cards.

Each compiled Role also has local structural queries. `branches()` returns its
direct child Roles; `members()` returns direct child Roles, Skills, then Tools
in declaration-group order; and `member(name)` resolves one direct member
across those groups. A missing name throws a typed `NodeNotFoundError` with
the Role scope and canonically sorted known names. These methods return fresh,
frozen arrays over the same immutable compilation snapshot and never evaluate
lazy declaration factories. Every `uses` edge is checked only after the whole
forest exists: it must be non-blank, unique, resolvable, and cannot name the
node's own canonical ref. Reference cycles between distinct nodes remain valid
because disclosure renders only one routing-card layer.

`bindingOf(ref)` and `schemaOf(tool)` are available only on a bound runtime
Index. A disclosure-only Index still supports structural queries but rejects
those execution facts. Schemas, node values, pairs, and result collections are
immutable. `Index` is a type-only export from `@contexture/mcp/server`, not a
runtime constructor. TypeScript's `compileApplication`,
`compileDisclosureApplication`, and server `compileRuntimeApplication` replace
Python's `Index.of`, `bound`, and `unbound` construction forms; serving remains
owned by the existing runtime and Channels lifecycle. The declaration root
intentionally remains SDK-neutral. `SelectedGraph` uses the same matcher over
only its selected refs, so it cannot leak another request root.

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
Host/origin policy plus either `auth` or an explicit `allowAnonymous: true`;
see the server option errors rather than weakening them.

For programmatic HTTP startup, put request authentication and the body boundary
on the transport policy:

```ts
const options = new ContextureOptions({
  transport: 'streamable-http',
  auth,
  maxRequestBodyBytes: 1024 * 1024,
  path: '/mcp',
});
const handle = await buildServer(application).start(options);
```

`buildServer(application, { auth })` remains supported for existing callers,
but setting auth there and in `ContextureOptions` is an error. HTTP-only options
(including auth, body size, and request-local root selection) are rejected with
stdio. Paths begin with `/`, contain neither `?` nor `#`, and use their
URL-canonical percent-encoded form. The body limit returns 413 before MCP
dispatch for both declared and chunked overflow. After binding, Contexture
verifies the concrete TCP host and reapplies public-bind policy; only
`localhost`, `127.0.0.1`, and canonical IPv6 loopback are treated as equivalent.

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
