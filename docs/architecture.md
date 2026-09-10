# Architecture

This binding is being reorganized to share both product semantics and explicit
architecture boundaries with the Python reference implementation.

## Dependency direction

```text
public declaration facade → application declaration → core/model
                                                   ↑
core/foundation → core/mcp-interface              │
                                                   │
web route/surface ← server surface ← server/application
```

Foundation owns constants, errors, and SDK-neutral publication declaration
data. In particular it has the one spelling for package metadata, reference
segments, the fixed gateway names, and the `Prompt`/`Resource` data shapes.
The model owns declaration validation, canonical refs, immutable Index facts,
root-selected views, disclosure, execution bindings, and lifecycle protocols.
MCP-interface re-exports those publication shapes and declares their MCP-plane
projection without reaching into the model. Model code does not import that
sibling package. Core cannot import MCP, HTTP, CLI, or framework-specific
packages.

The exported `@contexture/mcp/core` entry is the native equivalent of Python's
lazy `contexture.core` facade. ESM resolves a statically declared export graph
rather than Python attributes on first access, but the boundary is the same:
SDK-neutral model, binding, lifecycle, identity, selection, telemetry, and
error concepts are available without loading a Host adapter.

The server layer maps compiled APIs to the official MCP SDK and optional Host
surfaces. Business Tools never become top-level MCP tools; Contexture exposes a
fixed navigation and invocation gateway.

The declaration-only `@contexture/mcp` entry maps Python's public authoring
concepts to native TypeScript values and types: `Contexture`, `Channels`,
`Principal`, framework errors, `Prompt`/`Resource`, Role/Skill/Tool declaration
types, package version, and current request accessors. It does not load a Host
SDK. The `@contexture/mcp/server` entry owns `ApplicationRuntime`, compiled
application containers, `ContextureServer`, options/auth/selectors, telemetry,
launch configuration, logging, and compile/build helpers.

`compileRuntimeApplication()` returns one bound container whose Index,
Disclosure, Runtime, Publications, and telemetry are shared. The independent
`compileStructuralApplication()` returns an unbound container whose `server()`
installs only discover/open plus Prompts; it has no Runtime, invoke doors, or
Resources. Python's temporary `compile_parts` helpers map to the same raw
declaration compilers, and `serve(app)` maps to `buildServer(app).start()`.
`buildServer()` seals identity and one compiled runtime container before
serving; it has no capability-registration API, and repeated `build()` calls
return the same default official-SDK adapter. Transport options remain a
separate startup concern.
The installable `@contexture/mcp/server/surface` subpath exposes the validated
`Publications` composite and `publishedName()` mapping used by Prompt and
Resource doors; declarations are fully checked before an SDK server is built.

`DisclosureAPI` is the independently installable navigation half of that
gateway. It accepts a compiled `Disclosure`, has no Runtime or transport
dependency, and exposes only `discover` and `open` through its immutable tool
inventory. `selectedGraph` uses the same request-local root ceiling as
navigation. `openForPerson` (and the compatibility spelling
`openForAPerson`) bypasses only model reservations and prompt-root visibility;
it never widens the selected roots. Ordinary lookup failures are recovered at
this API boundary while `RootOutsideSelectionError` remains typed and
non-leaking. The raw `Disclosure` remains available to Hosts that need lookup
facts instead of agent-facing recovery prose.

## Current implementation status

1. Core node model, registration, validation, and immutable Index.
2. Disclosure API and exact golden discover/open/refusal payloads.
3. Typed Tool binding, execution context, and fixed MCP gateway.
4. Prompt, Resource, completion, and selected-root behavior.
5. Channels lifecycle, identity, telemetry, HTTP, and explicit REST routes.
6. Native project discovery, scaffolding, check/list/inspect/call/serve/demo
   commands, and an installed-package consumer check.
7. Streamable HTTP and stdio launch, fixed root surfaces, HTTP bearer identity,
   and the maintained Kubernetes reference application.

The kernel areas have focused conformance evidence; the product workflows have
native integration and packed npm-consumer evidence. This is still not full
product parity: complete documentation and scenario mapping, and the
clean-checkout release audit remain open.
