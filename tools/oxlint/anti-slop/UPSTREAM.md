# Vendored anti-slop plugin

## Source identity

Copied verbatim from the local `install-anti-slop` skill's
`assets/anti-slop/` directory at `/home/jetmiky/.agents/skills/install-anti-slop/`.

The source repository and exact upstream revision are **unknown**. The local
skill checkout has remote `git@github.com:jetmiky/agent-skills.git` and HEAD
`5452b59fc2e98b610f7cc26c85efcf5b60a6484d`, but these assets are untracked
there. That commit does not identify the copied assets.

The recoverable pristine snapshot is every file in this directory except this
installation record. Its aggregate SHA-256 is:

```text
24f771967ed0c6595fcac4adb93086b4996ccb06a570146f059e720bbf807acf
```

Reproduce it from this directory with GNU tools:

```sh
find . -type f ! -path './UPSTREAM.md' -print0 |
  LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum
```

The installed snapshot was compared recursively with the skill assets and had
no differences before this record was added. Preserve this snapshot when
updating so local and upstream changes can be compared separately.

## Installation

- Generic entry point: `tools/oxlint/anti-slop/index.ts`.
- Optional Effect entry point: `tools/oxlint/anti-slop/effect/index.ts`.
- Generic rules and native `oxc/no-accumulating-spread` are errors in
  `.oxlintrc.json`; `bun run lint` runs Oxlint.
- Effect rules are not enabled: no package manifest declares Effect.
- `oxlint` and `@oxlint/plugins` are pinned together at `1.90.0` as development
  dependencies. No separate Stylistic dependency is needed.
- Intentional code deviations: none. This installation record is the only
  added file inside the copied directory.

Keep `vendor/eslint-stylistic/LICENSE` and its adjacent `UPSTREAM.md`. They
record the nested rule's license, source revision, and existing adaptations.
