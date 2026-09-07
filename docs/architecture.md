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

The server layer maps compiled APIs to the official MCP SDK and optional Host
surfaces. Business Tools never become top-level MCP tools; Contexture exposes a
fixed navigation and invocation gateway.

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
product parity: request-selected HTTP roots, complete documentation and
scenario mapping, and the clean-checkout release audit remain open.
