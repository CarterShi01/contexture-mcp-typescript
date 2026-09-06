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

Foundation owns constants and errors. The model owns declaration validation,
canonical refs, immutable Index facts, root-selected views, disclosure,
execution bindings, and lifecycle protocols. MCP-interface declares Prompt,
Resource, and the fixed Tool plane without reaching into the model. Core cannot
import MCP, HTTP, CLI, or framework-specific packages.

The server layer maps compiled APIs to the official MCP SDK and optional Host
surfaces. Business Tools never become top-level MCP tools; Contexture exposes a
fixed navigation and invocation gateway.

## Current implementation status

1. Core node model, registration, validation, and immutable Index.
2. Disclosure API and exact golden discover/open/refusal payloads.
3. Typed Tool binding, execution context, and fixed MCP gateway.
4. Prompt, Resource, completion, and selected-root behavior.
5. Channels lifecycle, identity, telemetry, HTTP, and explicit REST routes.

The first five areas have focused conformance evidence and a packed npm
external-consumer import check. They do not yet establish full product parity:
CLI, scaffolding, transport-free inspection, maintained demo, complete
documentation, and mapped Python product tests remain planned work.
