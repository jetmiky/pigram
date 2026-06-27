# Pigram — Domain Glossary (CONTEXT.md)

This is the ubiquitous language for Pigram. Module names, type names, function
names, and test names use these terms. This file is a **glossary only** — it
contains no implementation detail, no file paths, and no configuration shapes.

When a term here proves wrong or fuzzy during design, update this file in the
same change that resolves it. Architectural decisions belong in `docs/adr/`,
not here.

---

## Core terms

### Bridge
The live link between exactly one Telegram bot and exactly one pi **Session**.
A Bridge exists only while it is connected; closing the pi Session ends the
Bridge. Pigram is session-local: there is no daemon and no Bridge that outlives
its Session.

### Session
The underlying pi coding-agent session that the Bridge drives. The Session owns
the working directory, model, thinking level, conversation history, usage, and
cost. Pigram does not create a Session type of its own — it adapts pi's.

### Pairing
The one-time handshake that binds a Bridge to a single allowed Telegram user.
The first user to message the bot becomes the **paired user**; afterwards the
Bridge accepts messages only from that user. Pigram is single-user by design.

### Turn
One **Prompt** → assistant reply cycle. A Turn covers the inbound Prompt, any
follow-up Prompts queued while pi is busy, the streaming **Preview**, the final
reply, and any outbound **Attachments**.

### Prompt
A Telegram message mapped into pi input. A Prompt may carry text, inbound
images (as image inputs), and local file paths for inbound documents. Inbound
text is marked so pi can tell it arrived over Telegram.

### Preview
The partial assistant text streamed back to Telegram while pi is still
generating. A Preview is provisional and is replaced by the final reply. The
user can disable Previews, leaving only a typing indicator until the reply is
ready.

### Dialog
A native Telegram interaction driven by inline-keyboard buttons that a pi
command can request in the middle of a Turn. Three kinds: a **select** (choose
one of several options), a **confirm** (yes/no), and a **text input** (free-form
reply). A Dialog pauses the command until the paired user answers or it times
out.

### Attachment
An outbound file that pi sends back through the Bridge to Telegram. pi requests
an Attachment with a dedicated tool; queued Attachments are delivered with the
next reply.

---

## Configuration terms

### Config
The user-edited settings for a Bridge: the bot token and UX preferences
(rich text on/off, Previews on/off). Config is meant to be read and edited by a
human. It is distinct from **State**.

### State
The machine-managed runtime data a Bridge needs to resume cleanly: the Telegram
update cursor, the paired user, and the cached bot identity. State is never
hand-edited and is not committed to version control. Keeping State out of Config
is a deliberate decision (see ADR-0003).

### Scope
Where Config lives. **Project scope** stores Config alongside a specific
repository; **global scope** stores it for the user account and is used as a
fallback when a project has no Config of its own.

---

## Roles at seams (architecture vocabulary)

These name the swappable adapters at Pigram's three seams. The architecture
vocabulary itself (module, interface, depth, seam, adapter) lives in the
`codebase-design` skill; these are the concrete role names in this project.

### TelegramTransport
The seam to the Telegram Bot API. Knows how to fetch updates, send and edit
messages, upload files, and download inbound files. The real adapter talks to
Telegram over HTTP; a fake adapter drives tests.

### AgentSession
The seam to the pi coding agent. Exposes starting a fresh Session with context,
switching model and thinking level, compacting, reading usage and status, and
whether pi is idle or busy.

### ConfigStore
The seam to persistence. Resolves Config by Scope, reads and writes Config and
State separately, and migrates legacy configuration into the current shape.
