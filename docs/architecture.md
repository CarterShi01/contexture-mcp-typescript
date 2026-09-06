# Architecture

This binding shares semantics, not implementation structure, with the Python
reference implementation.

## Dependency direction

```text
public facade → core model/compiler → disclosure and execution APIs
                                      ↑
               server adapters ───────┘
```

The core owns declaration validation, canonical refs, immutable Index facts,
root-selected views, disclosure, execution bindings, and lifecycle protocols.
It cannot import MCP, HTTP, CLI, or framework-specific packages.

The server layer maps compiled APIs to the official MCP SDK and optional Host
surfaces. Business Tools never become top-level MCP tools; Contexture exposes a
fixed navigation and invocation gateway.

## Intended milestones

1. Core node model, registration, validation, and immutable Index.
2. Disclosure API and exact golden discover/open/refusal payloads.
3. Typed Tool binding, execution context, and fixed MCP gateway.
4. Prompt, Resource, completion, and selected-root behavior.
5. Channels lifecycle, identity, telemetry, HTTP, and explicit REST routes.
6. CLI/scaffold, package-consumer tests, real Host verification, and RC release.

Each milestone must add conformance evidence before the status file advances.
