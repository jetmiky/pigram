# Pigram

> Chat with the [pi coding agent](https://github.com/badlogic/pi) from Telegram — rich text, streaming previews, session controls, and generated-file delivery.

Pigram is a **session-local** Telegram bridge for pi. It runs inside your pi session: no daemon, no background service, no extra process to babysit. Start pi, run one command, message your bot. When the pi session ends, the bridge stops with it.

[![npm](https://img.shields.io/npm/v/@jetmiky/pigram.svg)](https://www.npmjs.com/package/@jetmiky/pigram)
[![license](https://img.shields.io/npm/l/@jetmiky/pigram.svg)](./LICENSE)

---

## Why Pigram

- **One-step setup.** Install the extension, run `/pigram-setup`, paste a bot token. That's it.
- **Session-local by design.** The bridge lives and dies with your pi session. No installer, no `systemd` unit, no orphaned daemon polling Telegram while you sleep.
- **Rich output.** pi's markdown is converted to Telegram HTML — code blocks, bold, links, lists, all rendered natively.
- **Streaming previews.** Watch pi's reply build in real time via message edits, instead of waiting for the whole turn.
- **Generated-file delivery.** pi can send up to 10 existing local files per turn through the `telegram_attach` tool.
- **Busy-turn queueing.** Messages sent while pi is working are queued and processed in order after the active turn.
- **Resilient polling.** A per-bot lock prevents competing pollers; bounded long polls, conflict backoff, and stale-lock recovery keep inbound delivery healthy.
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

   Paste the token when prompted. Pigram validates it against Telegram, then
   asks whether every final assistant reply from terminal turns should be sent
   automatically to Telegram. It stores your choices, prints a BotFather
   `/setcommands` block, and starts the bridge.
3. Open your bot in Telegram and send `/start` to pair your account.

Done. Send any message and it's forwarded to pi.

> **Scope:** by default the config is stored per-project (`.pi/pigram.json`, automatically git-ignored). Use `/pigram-setup global` to store it in your home directory and reuse it across projects.

### Updating and uninstalling

```bash
pi update @jetmiky/pigram
pi remove @jetmiky/pigram
```

After updating, start a fresh pi session so the new extension bundle is loaded.

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
| `/pigram-notify [on\|off]` | Deliver the next reply (or all replies with `on`) to Telegram |

### Working from the laptop

Prompt pi in the terminal as usual, then run `/pigram-notify` (a pi command,
not a Telegram one) before or while the turn runs. When the turn completes,
the reply is delivered to your Telegram chat even though the prompt never came
from Telegram — no need to chat first. Without an argument it arms for the
next completed turn only; `/pigram-notify on` keeps delivering every reply
until `/pigram-notify off`. The target chat is the last active chat, falling
back to the paired user's DM. State resets with the session (`/new`, exit).

To deliver every final assistant reply from terminal-originated turns without
running `/pigram-notify`, add this to `.pi/pigram.json`:

```json
{
  "botToken": "123456:ABCDEF...",
  "delivery": {
    "terminalReplies": "all"
  }
}
```

`terminalReplies` accepts `"off"` (the default) or `"all"`. It sends the final
reply or error to the paired user's DM; replies to Telegram-originated turns
continue through the normal path and are not duplicated. Attachments queued by
terminal turns are sent to the same chat. `/pigram-notify on|off` overrides the
setting for the current session; `/pigram-notify` still arms only the next reply.

### Generated files

Pigram registers the `telegram_attach` tool for pi. When a Telegram user asks
for a generated artifact, pi can call it with one or more local paths. Files
must already exist; directories are rejected. Up to 10 files may be attached
per turn, and known-chat deliveries are flushed immediately.

## Rich output settings

Pigram's output controls are independent. In particular, disabling streamed
previews does **not** disable rich formatting or native tables in the final
reply:

```json
{
  "botToken": "123456:ABCDEF...",
  "ux": {
    "richText": true,
    "streamPreviews": false,
    "richTables": true
  }
}
```

| Setting | Default | Effect |
|---|---:|---|
| `ux.richText` | `true` | Render final Markdown as Telegram formatting. When disabled, replies are sent as chunked plain text. |
| `ux.streamPreviews` | `true` | Show partial assistant output by editing a live Telegram message. When disabled, Pigram shows only the final reply; typing indicators still provide liveness feedback. |
| `ux.richTables` | `true` | For final replies containing a GFM pipe table, try Telegram's native bordered, horizontally scrollable table. This works whether previews are on or off. |

With `richText` enabled, final replies support headings, bold, italic, links,
inline code, fenced code blocks, blockquotes, ordered and unordered lists,
task-list checkboxes, separators, and hard line breaks. A GFM table such as:

```markdown
| Name | Status |
|---|---|
| Build | Passing |
```

is sent through Telegram's native rich-message API when `richTables` is enabled.
If Telegram rejects or does not support that rich message, Pigram falls back to
a horizontally scrollable monospace `<pre>` grid. Setting `richTables` to
`false` uses that HTML fallback directly. Tables inside fenced code blocks are
kept as example code and are not treated as renderable tables.

| `streamPreviews` | `richTables` | Table result |
|---:|---:|---|
| `true` | `true` | Stream partial text, then replace it with the native final table. |
| `false` | `true` | Send no partial text; send the native table when the turn finishes. |
| `true` | `false` | Stream partial text, then replace it with the HTML/monospace table. |
| `false` | `false` | Send no partial text; send the HTML/monospace table when finished. |

### Complete configuration reference

The config accepts only the keys shown below; unknown keys are rejected:

```json
{
  "botToken": "123456:ABCDEF...",
  "ux": {
    "richText": true,
    "streamPreviews": true,
    "richTables": true
  },
  "delivery": {
    "terminalReplies": "off"
  }
}
```

Project config (`.pi/pigram.json`) takes precedence when present. Global config
(`~/.pi/agent/pigram.json`) is the fallback and can be selected explicitly with
`/pigram-setup global` or `/pigram-connect global`. Runtime state is kept under
the matching `.pi/tmp/pigram/` or `~/.pi/agent/tmp/pigram/` directory; it stores
pairing, the Telegram update cursor, and bot identity and must not be edited by
hand.

## Reliability and limitations

- Only the first paired Telegram user is accepted; Pigram is intentionally
  single-user.
- Only text messages are currently forwarded as prompts. Telegram photos,
  documents, and voice messages are not yet wired into inbound prompt delivery.
- If a second process tries to poll the same bot, Pigram reports the lock holder
  instead of starting a competing `getUpdates` request.
- Messages arriving while pi is busy are queued FIFO and handled after the
  current turn.
- `/new` may ask you to run `/pigram-connect` once in the pi terminal when the
  current runtime has not yet received a command-capable pi context.
- Pigram stops polling when the pi session shuts down; there is no daemon or
  cross-session background delivery.

## Troubleshooting

- **Bot does not respond:** run `/pigram-status` in pi and check `polling`, the
  config path, and whether another PID holds the bot lock.
- **Bad or replaced bot token:** rerun `/pigram-setup [local|global]`; setup
  validates the token with Telegram before storing it.
- **Telegram `/new` cannot reset the session:** run `/pigram-connect` once in
  the pi terminal, then retry `/new` from Telegram.
- **No terminal reply arrives:** pair the bot first with `/start`, then use
  `/pigram-notify` or set `delivery.terminalReplies` to `"all"`.
- **Native table fails:** Pigram automatically falls back to a monospace table;
  set `ux.richTables` to `false` to skip native delivery deliberately.

---

## How it works

Pigram is built as a set of small, single-responsibility modules wired together by a thin composition root. There is no business logic in the entrypoint — it only constructs and connects the pieces.

```
Telegram  ⇄  Transport (Bot API)  ⇄  Poller  ⇄  Bridge  ⇄  pi session
                                                  │
                              Dialog · Pairing · Commands · Prompt mapping
```

Configuration and runtime state are kept strictly separate:

- **Config** (`.pi/pigram.json`) — user-edited: bot token, UX preferences, and delivery policy.
- **State** (`.pi/tmp/pigram/state.json`) — machine-managed: update cursor, paired user, bot identity. Never hand-edited, always git-ignored.

See [`CONTEXT.md`](./CONTEXT.md) for the domain glossary and [`docs/adr/`](./docs/adr) for the architecture decisions (why session-local, the config shape, the package scope).

---

## Migrating from `pi-telegram`

If you used the original `pi-telegram`, Pigram reads your old `telegram.json` automatically and migrates it (non-destructively — the old file is left untouched) into the new Config/State split on first connect. Just run `/pigram-setup` or `/pigram-connect`.

---

## Development

```bash
git clone https://github.com/jetmiky/pigram.git
cd pigram
bun install
bun test          # run the test suite
bun run typecheck # tsc --noEmit
bun run build     # bundle ESM to dist/ (peer deps stay external)
```

Built with TypeScript, tested with `bun test`, output as ESM for Node 22+. Peer dependencies (pi packages, typebox, marked) are kept external so the published bundle stays tiny and shares the host's pi runtime.

### Contributing

Issues and pull requests are welcome. Before opening a PR:

1. Search [existing issues](https://github.com/jetmiky/pigram/issues) and open
   one for non-trivial behavioural changes so scope can be agreed first.
2. Branch from an up-to-date `main` using `fix/...`, `feat/...`, or `docs/...`.
3. Add or update tests through public behaviour; keep the change focused and
   avoid unrelated refactors.
4. Run `bun test`, `bun run typecheck`, and `bun run build`.
5. Use a Conventional Commit such as `fix(telegram): handle ...` or
   `docs: explain ...`.
6. Open a PR describing the observable change, verification performed, and the
   issue it closes.

For architecture vocabulary and constraints, read [`CONTEXT.md`](./CONTEXT.md)
and the decisions in [`docs/adr/`](./docs/adr). Please do not commit bot tokens,
local `.pi/pigram.json` files, runtime state, generated bundles unrelated to the
change, or npm credentials.

Maintainer releases are cut from clean `main`: run the full verification suite,
bump with `npm version patch|minor|major`, push the release commit and tag, create
a GitHub release, then publish the same version to npm.

---

## Acknowledgements

Pigram stands on the shoulders of two projects:

- **[pi-telegram](https://github.com/badlogic/pi-telegram)** by **Mario Zechner** ([@badlogic](https://github.com/badlogic)) — the original Telegram bridge for pi. Pigram is a clean-architecture rewrite of that idea, and its proven markdown renderer and storage approach are carried forward here.
- **[TelePi](https://github.com/benedict2310/TelePi)** — UX inspiration for several of the interaction patterns.

Thank you to both. Pigram exists because pi-telegram showed the way.

---

## License

[MIT](./LICENSE) — see the file for the full attribution notices.
