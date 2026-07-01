# Pigram

> Chat with the [pi coding agent](https://github.com/badlogic/pi) from Telegram — rich text, streaming previews, file attachments, and native inline-keyboard dialogs.

Pigram is a **session-local** Telegram bridge for pi. It runs inside your pi session: no daemon, no background service, no extra process to babysit. Start pi, run one command, message your bot. When the pi session ends, the bridge stops with it.

[![npm](https://img.shields.io/npm/v/@jetmiky/pigram.svg)](https://www.npmjs.com/package/@jetmiky/pigram)
[![license](https://img.shields.io/npm/l/@jetmiky/pigram.svg)](./LICENSE)

---

## Why Pigram

- **One-step setup.** Install the extension, run `/pigram-setup`, paste a bot token. That's it.
- **Session-local by design.** The bridge lives and dies with your pi session. No installer, no `systemd` unit, no orphaned daemon polling Telegram while you sleep.
- **Rich output.** pi's markdown is converted to Telegram HTML — code blocks, bold, links, lists, all rendered natively.
- **Streaming previews.** Watch pi's reply build in real time via message edits, instead of waiting for the whole turn.
- **File attachments.** pi can send you generated files directly through the `telegram_attach` tool.
- **Native dialogs.** Inline-keyboard selects, confirms, and text inputs — pi can ask you a question mid-task and you tap an answer.
- **Single-user pairing.** The first account to send `/start` is paired; everyone else is ignored. No allowlist to maintain.

---

## Requirements

- **Node.js 22.19+** (pi's runtime floor)
- **pi** ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) `^0.80`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

---

## Install

```bash
pi install npm:@jetmiky/pigram
```

This adds Pigram to your pi settings so it loads on every session. To load it for a single session instead:

```bash
pi -e ./node_modules/@jetmiky/pigram/dist/index.js
```

---

## Setup (one step)

1. Create a bot with [@BotFather](https://t.me/BotFather): send `/newbot`, pick a name and a `…bot` username. BotFather replies with a token like `123456789:AAE…`.
2. In your pi session, run:

   ```
   /pigram-setup
   ```

   Paste the token when prompted. Pigram validates it against Telegram, stores it, prints a BotFather `/setcommands` block, and starts the bridge.
3. Open your bot in Telegram and send `/start` to pair your account.

Done. Send any message and it's forwarded to pi.

> **Scope:** by default the config is stored per-project (`.pi/pigram.json`, automatically git-ignored). Use `/pigram-setup global` to store it in your home directory and reuse it across projects.

---

## Commands

Send these to your bot in Telegram:

| Command | Description |
|---|---|
| `/new [name]` | Start a fresh pi session, optionally named |
| `/status` | Show session, directory, model, usage, cost, and context |
| `/model [provider/]id [thinking]` | Switch model, optionally with provider and thinking level |
| `/thinking <level>` | Change thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) |
| `/compact` | Compact the conversation context |
| `/resend` | Resend the latest assistant reply |
| `/stop` | Abort the active turn (or send: `stop`, `wait`, `cancel`, `abort`) |
| `/help` | Show help |
| `/git <status\|log\|nb>` | Run safe git shortcuts in the current directory |

Run `/help` once and copy the generated block into BotFather's `/setcommands` so the commands show up in Telegram's command menu.

### Bare-word shortcuts

For quick access, the stop command can also be triggered without a slash by sending one of these words exactly (case-insensitive):

- `stop`
- `wait`
- `cancel`
- `abort`

These are exact-match only — `"stop the music"` or `"wait for me"` are forwarded to pi as normal messages. When pi is idle, the bot replies with "Nothing to stop, Pi is idle."

### pi-session commands

These run inside pi (not Telegram) to control the bridge:

| Command | Description |
|---|---|
| `/pigram-setup [local\|global]` | Configure and connect (one-step setup) |
| `/pigram-connect [local\|global]` | Start the bridge using an existing config |
| `/pigram-disconnect` | Stop the bridge for this session |
| `/pigram-status` | Show config path, scope, paired user, and polling state |

---

## How it works

Pigram is built as a set of small, single-responsibility modules wired together by a thin composition root. There is no business logic in the entrypoint — it only constructs and connects the pieces.

```
Telegram  ⇄  Transport (Bot API)  ⇄  Poller  ⇄  Bridge  ⇄  pi session
                                                  │
                              Dialog · Pairing · Commands · Prompt mapping
```

Configuration and runtime state are kept strictly separate:

- **Config** (`.pi/pigram.json`) — user-edited: bot token + UX preferences.
- **State** (`.pi/tmp/pigram/state.json`) — machine-managed: update cursor, paired user, bot identity. Never hand-edited, always git-ignored.

See [`CONTEXT.md`](./CONTEXT.md) for the domain glossary and [`docs/adr/`](./docs/adr) for the architecture decisions (why session-local, the config shape, the package scope).

---

## Migrating from `pi-telegram`

If you used the original `pi-telegram`, Pigram reads your old `telegram.json` automatically and migrates it (non-destructively — the old file is left untouched) into the new Config/State split on first connect. Just run `/pigram-setup` or `/pigram-connect`.

---

## Development

```bash
bun install
bun test          # run the test suite
bun run typecheck # tsc --noEmit
bun run build     # bundle ESM to dist/ (peer deps stay external)
```

Built with TypeScript, tested with `bun test`, output as ESM for Node 22+. Peer dependencies (pi packages, typebox, marked) are kept external so the published bundle stays tiny and shares the host's pi runtime.

---

## Acknowledgements

Pigram stands on the shoulders of two projects:

- **[pi-telegram](https://github.com/badlogic/pi-telegram)** by **Mario Zechner** ([@badlogic](https://github.com/badlogic)) — the original Telegram bridge for pi. Pigram is a clean-architecture rewrite of that idea, and its proven markdown renderer and storage approach are carried forward here.
- **[TelePi](https://github.com/benedict2310/TelePi)** — UX inspiration for several of the interaction patterns.

Thank you to both. Pigram exists because pi-telegram showed the way.

---

## License

[MIT](./LICENSE) — see the file for the full attribution notices.
