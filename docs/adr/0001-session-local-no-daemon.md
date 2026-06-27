# ADR-0001: Session-local bridge, no daemon

- Status: Accepted
- Date: 2026-06-27

## Context

Pigram is a rewrite of `badlogic/pi-telegram`. Two reference designs exist:

1. **badlogic/pi-telegram** — a session-local bridge. The Telegram bridge runs
   inside a pi session and lives only as long as that session. Setup is one
   step; there is no background service.
2. **benedict2310/TelePi** — an always-on remote control. A user-level service
   (launchd on macOS, systemd on Linux) keeps a bridge alive independent of any
   terminal, enabling `/handoff` (terminal → Telegram) and `/handback`
   (Telegram → terminal). This is powerful but requires installing and managing
   a background service, which is the main source of its setup complexity.

Pigram's headline goal is great UX with effortless setup for an international
audience publishing as an npm package.

## Decision

Pigram is **session-local only**. The Bridge exists only while its pi Session is
alive. We will not install a launchd/systemd service, and we will not implement
`/handoff` or `/handback`.

## Consequences

- Setup stays a single guided step; nothing to install or manage at the OS level.
- The bot only responds while a pi session owns it; closing pi ends the Bridge.
- Cross-terminal session continuity (handoff/handback) is out of scope for v0.1.
  If real demand appears, it can be reconsidered in a future version — but it
  would reopen the service-management complexity this decision avoids.
- Per-topic and cross-workspace session management (also from TelePi) are
  likewise deferred.
