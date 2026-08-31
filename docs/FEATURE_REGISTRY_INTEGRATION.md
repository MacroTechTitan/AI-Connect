# Feature Registry Integration

Status: Planned / implementation contract

AI Connect must treat feature completion as a product-level gate, not merely an execution-agent completion message.

## Principle

A feature can exist in code without existing as a complete product. `Task complete` from Claude Code, Codex, Cursor, or another worker is evidence of implementation progress; it is not release authority.

## Agent preflight

Before feature implementation, AI Connect should obtain a Feature Work Packet containing:

- feature ID, name, status, product area, owner;
- requirements and architecture constraints;
- dependencies / impact set;
- acceptance criteria and out-of-scope rules;
- affected platforms;
- UI/discoverability obligations;
- documentation/catalog/homepage/pricing obligations;
- entitlement/permission obligations;
- required functional, security, entitlement, and visibility tests;
- security/compliance review requirements;
- changelog/release obligations.

The packet becomes part of Build Run scope and reviewer context.

## Conceptual Feature Registry operations

- `feature.list`
- `feature.get`
- `feature.create`
- `feature.update`
- `feature.validate`
- `feature.dependencies`
- `feature.impact`
- `feature.release`

These operation names are directional until implemented.

## Completion gate

When a worker reports completion, AI Connect must not automatically mark a customer feature Available. Build Control should evaluate the Feature Completion Contract and produce a structured result such as:

```text
Implementation       PASS
Tests                PASS
UI visibility         PASS
Guide                 FAIL
Feature catalog       PASS
Homepage              FAIL
Changelog             FAIL
Security review       PASS

FEATURE STATUS: IMPLEMENTED
RELEASE STATUS: BLOCKED
```

Required gates are project/framework policy. A successful Build Run may therefore end with a technically implemented feature that remains release-blocked.

## Build Control integration

Feature Registry feeds:

`Feature Record → Feature Work Packet → Build Run → execution → validation → independent review → Feature Completion Check → human approval → release eligibility`

Build Control should display failed feature gates prominently and prevent release promotion while required gates fail.

## Feature discovery and impact

Future AI Connect capabilities should compare registered features against repository evidence (routes, components, APIs, schema, navigation, permissions, tests, docs, Git history) and identify unregistered implementations, missing UI/docs/tests, stale docs, undocumented releases, and downstream features affected by a change.

## Architecture constraint

Feature Registry is a DevOS subsystem/product capability. This integration does not create or renumber a DevOS Core Engine.