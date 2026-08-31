# Pigram

> Use the [pi coding agent](https://github.com/badlogic/pi) from Telegram.

Pigram is a session-local Telegram bridge for pi. It starts inside your pi
session and stops with it—no daemon, background service, or separate process.

[![npm](https://img.shields.io/npm/v/@jetmiky/pigram.svg)](https://www.npmjs.com/package/@jetmiky/pigram)
[![license](https://img.shields.io/npm/l/@jetmiky/pigram.svg)](./LICENSE)

## Features

- Send Telegram text messages to the active pi session.
- Stream replies as they are generated, with a typing indicator between updates.
- Render Markdown as Telegram formatting, including native tables with a
  monospace fallback.
- Control sessions, models, thinking level, context, and safe Git shortcuts from
  Telegram.
- Queue messages sent while pi is busy and process them in order.
- Let pi ask native select, confirm, and text questions through `telegram_ask`.
- Send up to 10 existing local files per tool call through `telegram_attach`.
- Forward one or all terminal-originated replies to Telegram.
- Pair with one Telegram user and reject other users.
- Prevent competing pollers with a per-bot lock, conflict backoff, and stale-lock
  recovery.

## Requirements

- Node.js 22.19 or newer
- [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) `^0.84.0`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Install

```bash
pi install npm:@jetmiky/pigram
```

Update or remove it with:

```bash
pi update @jetmiky/pigram
pi remove @jetmiky/pigram
```

Start a fresh pi session after updating so pi loads the new bundle.

## Setup

1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, and create a bot.
2. In pi, run:

   ```text
   /pigram-setup
   ```

3. Paste the bot token. Pigram validates it, asks whether terminal replies
   should be forwarded automatically, saves the config, and starts the bridge.
4. Open the bot and send `/start` to pair your Telegram account. The bot
   replies with help and a BotFather `/setcommands` block.

Project config is the default. Run `/pigram-setup global` to reuse one config
across projects.

> Keep the bot token secret. Project config and runtime state are added to
> `.gitignore` automatically.

## Telegram commands

| Command | What it does |
|---|---|
| `/new [name]` | Start a fresh pi session, optionally named |
| `/status` | Show session, directory, model, token usage, context, and queue state |
| `/model [provider/]id [thinking]` | Switch model and optionally set thinking level |
| `/thinking <level>` | Set `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `/compact` | Compact the conversation context |
| `/resend` | Resend the latest assistant reply without a new model call |
| `/stop` | Abort the active turn |
| `/git status` | Show concise Git status |
| `/git log` | Show the latest 20 commits |
| `/git nb <branch-name>` | Validate, create, and switch to a new branch |
| `/help` | Show help and the BotFather `/setcommands` block |

You can also abort a turn by sending exactly `stop`, `wait`, `cancel`, or
`abort` (case-insensitive). Longer messages that contain these words are sent
to pi normally.

`/new` needs a command-capable pi context. If Pigram asks you to do so, run
`/pigram-connect` once in the terminal and retry.

## pi commands

These commands run in pi, not Telegram:

| Command | What it does |
|---|---|
| `/pigram-setup [local\|project\|global]` | Save config, validate the bot, and connect |
| `/pigram-connect [local\|project\|global]` | Connect with existing config; starts setup if none exists |
| `/pigram-disconnect` | Disconnect for the current session |
| `/pigram-status` | Show config scope, pairing, terminal delivery, lock, and polling state |
| `/pigram-notify` | Send the next completed reply to Telegram |
| `/pigram-notify on` | Send every completed reply for this session |
| `/pigram-notify off` | Stop session-level terminal reply forwarding |

`/pigram-notify` targets the last active chat, or the paired user's direct
message. Its session-level setting overrides `delivery.terminalReplies` and
resets when the session ends.

## Agent tools

Pigram registers two tools for pi:

- **`telegram_ask`** asks the active Telegram user a select, yes/no, or text
  question. One dialog can be pending at a time, with a configurable 15–900
  second timeout. It is unavailable for terminal-originated turns.
- **`telegram_attach`** sends 1–10 existing local files. Paths can be relative
  to the working directory or absolute; directories and missing files are
  rejected.

## Configuration

Pigram accepts only these keys; unknown keys are rejected:

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

| Setting | Default | Effect |
|---|---:|---|
| `botToken` | required | Telegram bot token |
| `ux.richText` | `true` | Render Markdown as Telegram HTML; otherwise send chunked plain text |
| `ux.streamPreviews` | `true` | Edit a live preview while pi generates; typing indicators still work when off |
| `ux.richTables` | `true` | Try native GFM tables, then fall back to a scrollable monospace grid |
| `delivery.terminalReplies` | `"off"` | Use `"all"` to send every terminal-originated final reply or error |

The UX settings are independent. For example, you can disable previews while
keeping rich formatting and native tables in the final reply.

### Config and state locations

| Scope | Config | Runtime state |
|---|---|---|
| Project | `.pi/pigram.json` | `.pi/tmp/pigram/state.json` |
| Global | `~/.pi/agent/pigram.json` | `~/.pi/agent/tmp/pigram/state.json` |

A project config takes precedence. If none exists, Pigram uses the global
config; if neither exists, setup defaults to project scope. Runtime state holds
the update cursor, paired user, and bot identity. Do not edit it manually.

If you used `pi-telegram`, Pigram migrates `telegram.json` into the separate
config and state files on first connect. The old file is left unchanged. Use
`/pigram-connect global` once to migrate a legacy global config.

## Rich output

With `ux.richText` enabled, Pigram supports headings, bold, italic, links,
inline and fenced code, blockquotes, ordered and unordered lists, task lists,
separators, and hard line breaks.

GFM pipe tables use Telegram's native rich-message format when supported. If
Telegram rejects it, Pigram falls back to a monospace `<pre>` grid. Set
`ux.richTables` to `false` to use the fallback directly. Tables inside fenced
code blocks remain code.

## Reliability and current limits

- Pigram is single-user: the first user to send `/start` is paired.
- Only inbound message text is currently forwarded to pi. Captions, photos,
  documents, voice messages, and other media are not yet accepted as prompts.
- Messages received during an active turn are queued FIFO.
- Only one process can poll a bot token at a time. `/pigram-status` reports the
  lock holder when another process owns it.
- Polling stops when the pi session ends; Pigram does not provide background or
  cross-session delivery.

### Troubleshooting

- **No bot reply:** run `/pigram-status`; check polling, pairing, config path,
  and lock holder.
- **Bad or replaced token:** rerun `/pigram-setup [local|project|global]`.
- **`/new` cannot reset the session:** run `/pigram-connect` once in pi, then
  retry from Telegram.
- **No terminal reply:** pair with `/start`, then use `/pigram-notify` or set
  `delivery.terminalReplies` to `"all"`.
- **Native table fails:** fallback is automatic; set `ux.richTables` to `false`
  to always use the monospace version.

## How it works

```text
Telegram ⇄ Bot API transport ⇄ Poller ⇄ Bridge ⇄ pi session
                                      ├─ pairing and commands
                                      ├─ previews and dialogs
                                      └─ prompt queue and attachments
```

Pigram keeps user-edited config separate from machine-managed state. See
[`CONTEXT.md`](./CONTEXT.md) for the domain glossary and [`docs/adr/`](./docs/adr)
for architecture decisions.

## Contributing

```bash
git clone https://github.com/jetmiky/pigram.git
cd pigram
bun install
bun test
bun run typecheck
bun run build
```

Before opening a pull request:

1. Search [existing issues](https://github.com/jetmiky/pigram/issues). Open one
   first for a non-trivial behavior change.
2. Keep the change focused and test observable behavior. Avoid unrelated
   refactors.
3. Run `bun test`, `bun run typecheck`, and `bun run build`.
4. Use a Conventional Commit, for example `fix(telegram): handle ...` or
   `docs: explain ...`.
5. Describe the user-visible change, verification, and related issue in the PR.

Do not commit bot tokens, `.pi/pigram.json`, `.pi/tmp/`, npm credentials, or
unrelated generated bundles. Read [`CONTEXT.md`](./CONTEXT.md) and
[`docs/adr/`](./docs/adr) before changing domain terms or architecture.

## Acknowledgements

- [pi-telegram](https://github.com/badlogic/pi-telegram) by Mario Zechner
  ([@badlogic](https://github.com/badlogic)), the original bridge and source of
  the Markdown renderer and storage approach.
- [TelePi](https://github.com/benedict2310/TelePi), which inspired several UX
  patterns.

## License

[MIT](./LICENSE)
