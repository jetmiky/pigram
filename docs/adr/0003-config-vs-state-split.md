# ADR-0003: Separate Config from State

- Status: Accepted
- Date: 2026-06-27

## Context

The original `pi-telegram` stored everything in one file (`telegram.json`):
the bot token, UX flags, **and** the Telegram update cursor (`lastUpdateId`)
plus cached bot identity. This mixes two kinds of data with opposite audiences
and lifecycles:

- **Config** is written and read by a human: the bot token and UX preferences.
- **State** is written and read by the machine: the update cursor, the paired
  user, the cached bot id/username. It changes constantly at runtime and is
  meaningless to edit by hand.

Mixing them means a human editing Config can accidentally corrupt runtime State,
the file churns on every poll, and a config example cannot be shared without
leaking or staling runtime values.

## Decision

Pigram stores **Config** and **State** in separate files. Config holds only the
bot token and UX preferences and is the only file a user edits. State holds the
runtime cursor, paired user, and cached bot identity, is machine-managed, lives
under a temp directory, and is never committed to version control.

This is a breaking change from the legacy single-file format. A one-time,
non-destructive migration reads the old `telegram.json`, writes the new Config,
moves runtime values into State, and leaves the old file untouched.

## Consequences

- Editing Config can never corrupt runtime State, and vice versa.
- The Config file is stable and shareable as an example; State churns silently
  out of the way.
- Pigram must resolve and read two files instead of one, and ship a migration
  for legacy users. This cost is paid once and localized in the ConfigStore.
