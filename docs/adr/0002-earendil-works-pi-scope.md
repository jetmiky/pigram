# ADR-0002: Depend on the @earendil-works pi packages

- Status: Accepted
- Date: 2026-06-27

## Context

The pi coding agent has been published under two npm scopes:

- `@mariozechner/pi-*` — the older scope. Latest observed: `0.73.1`.
- `@earendil-works/pi-*` — the current scope. Latest observed: `0.80.2`, with
  identical package descriptions, i.e. a scope rename that continues active
  development.

The original `pi-telegram` source was inconsistent: its `package.json` declared
`@earendil-works/*` peer dependencies while its TypeScript imported from
`@mariozechner/*`. The locally installed pi CLI resolves through
`@earendil-works/pi-coding-agent@0.80.2`.

## Decision

Pigram depends exclusively on the **`@earendil-works`** scope, pinned to
`^0.80.0` for all three pi packages (`pi-ai`, `pi-agent-core`,
`pi-coding-agent`) plus `@sinclair/typebox`. All imports use this scope. The
`@mariozechner/*` scope is not referenced anywhere.

## Consequences

- We track the actively developed line of pi and match the installed CLI.
- Adapter code in the `pi/` modules must be verified against the
  `@earendil-works/*@0.80` type surface before building on it, since the exact
  exported symbols may differ from the older scope.
- If pi changes scope again, this is a single, well-located change (peer deps +
  imports) rather than a scattered one.
