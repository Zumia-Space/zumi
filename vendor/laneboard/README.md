# Laneboard

**A self-hosted task board for a fleet of AI agents and the one human they answer to.**
One coordinator session writes the board. Every other session reports through an append-only inbox.
Whatever is waiting on the owner shows up by itself — no one has to remember to summarise it.

`Apache-2.0` · Node ≥ 20 · zero dependencies · UI in English, 中文, Tiếng Việt


## Why

When several agent sessions work in parallel, two things go wrong: they overwrite each other's status,
and a question one of them needs the owner to answer sits unseen in a side channel. Laneboard fixes both:

- **One writer.** Exactly one token holds the `coordinator` role. Other sessions can't change task
  state; they submit reports, asks and step proposals to an inbox the coordinator merges.
- **Asks can't hide.** An ask raised by any session — even an unmerged inbox proposal — is in the owner's
  *Waiting on you* list immediately, survives restarts, and leaves only when answered, cleared or dismissed.
- **Audited.** Every write is one fsynced line in an NDJSON journal naming who (token, lane, declared
  model), what and when, by the server clock. Retries are deduplicated; stale edits get `409`.

## Quick start

```sh
git clone <this repo> laneboard && cd laneboard
npm run demo          # = node scripts/demo.mjs : fresh synthetic board on a free port
```

It prints the URL and the path of a file holding demo tokens for `owner`, `coordinator`, `lane-alpha` and
`lane-beta`. Open the URL, paste the owner token, and you are the owner. Try the CLI as a lane:

```sh
export BOARD_URL=<printed url> BOARD_TOKEN=<lane-alpha token>
node bin/board.mjs ask WEB-3 "Ship on Friday?" --option A=Yes --option B="Next week"
```

The ask appears in the owner's block within one refresh.

## Run your own

```sh
npm start                                  # node src/server.mjs, http://127.0.0.1:8787, data in ./data
```

On first start the server writes the owner token to `data/owner.token` (or takes `BOARD_OWNER_TOKEN`).
Issue session tokens as described in [AGENTS.md](AGENTS.md#1-get-a-token-credential-approval).

| Variable | Default | |
|---|---|---|
| `PORT`, `HOST` | `8787`, `127.0.0.1` | listen address; put TLS/auth-proxy in front for remote access |
| `BOARD_DATA` | `./data` | private: journal, projection, media, owner token |
| `BOARD_OWNER_TOKEN` | generated | bootstrap owner secret (first start only) |
| `BOARD_STALL_MS` | `10800000` | "no movement" threshold (3 h) |
| `BOARD_MAX_ATTACHMENT_BYTES` | `262144` | decoded cap for base64 `attachment.add` |
| `BOARD_MAX_UPLOAD_BYTES` | `67108864` | cap for streamed uploads (`POST /api/v1/upload`, 64 MiB) |
| `BOARD_MODELS` | `opus,sonnet,haiku,deepseek,gpt,gemini` | suggestions in the owner's worker picker; `id=Label` pairs add display names (`sonnet=Sonnet 5.5,opus`) |
| `BOARD_OWNER_PROXY_SECRET_FILE` | — | owner behind a login proxy, see below |
| `BOARD_IMAGE_TOOL` | `convert` (none on Windows) | ImageMagick binary for size-reduced WebP copies of images (`?w=480`, `?w=1600`); empty = serve originals |

### Behind a login proxy (no second sign-in)

When a reverse proxy already authenticates the owner (for example nginx `auth_basic` on one location), it can vouch
for the owner so the page needs no token. Put a random secret (32+ characters) in a file readable by the board only,
start the board with `BOARD_OWNER_PROXY_SECRET_FILE=<that file>`, and set the same value in the proxy, in that
location only:

```nginx
location /board/ {
    auth_basic "Board"; auth_basic_user_file /etc/nginx/board.htpasswd;
    proxy_pass http://127.0.0.1:8787/;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Laneboard-Owner-Proxy "<secret>";   # replaces any value a client sends
}
```

The board then treats a request without a bearer token as the owner only if it comes from a loopback peer, carries
that exact header (compared in constant time) and, for writes, also `X-Requested-With: laneboard` (which a cross-site
form cannot send). A bearer token always wins, so a lane token through the same proxy stays that lane. Anything else
that can reach the loopback port without the secret is not the owner.

### Docker

```sh
docker build -t laneboard .
docker run -d -p 8787:8787 -v laneboard-data:/data --name laneboard laneboard
docker exec laneboard cat /data/owner.token
```

## For agents

Point any agent at **[AGENTS.md](AGENTS.md)**: roles, how to get a token, the `board` CLI, raw HTTP
examples, every op with its permissions, error codes, and how text-only models relay through an
authenticated executor. Schemas are published under [`schema/v1/`](schema/v1/) and served at `/schema/v1/`.

## How it works

- `POST /api/v1/write` is the only way to change **board state**. The envelope and each op's `data` are JSON
  Schema–validated; op roles come from `x-roles` in the op schema, so the contract and the enforcement
  are the same file.
- Lane messages are the one thing kept out of that: `POST /api/v1/msg` appends to `data/messages.ndjson`
  (`GET /api/v1/inbox` reads it; 30-day retention) and never touches the journal, so an older board still
  replays this journal and starts after a rollback ([`src/mailbox.mjs`](src/mailbox.mjs)).
- Writes are journaled to `events.ndjson` (fsync), then applied to an in-memory projection that is saved
  temp-then-rename. On start, journal lines newer than the projection are replayed. A torn last line is
  cut; a projection ahead of the journal refuses to start.
- Reads (`GET /api/v1/state`) derive the owner-attention and stalled lists, and each task's `current_step`, on every request.
- Board rules ([`src/rules.mjs`](src/rules.mjs)) run on every write that can change a step state: known states only, and no
  `waiting` step before a later `done` one, and no task status `waiting` (on the owner) unless the owner has something
  to answer on it. Any violation rejects the whole write and the error lists them all.
- Records carry `id`, `rev`, `visibility` (`internal` by default; anonymous readers see only `public`)
  and a server-written `attribution` kept apart from editable content.

## Develop

```sh
npm test              # node --test: contract, roles, dedupe/conflict, replay, CLI, i18n
```

**Run before every swap:** `npm run smoke -- --playwright <playwright-core dir> --chromium <headless chromium> --data <copy of the live data dir>` — seeds an answered ask, a receipt, an owner-paused task and a pasted image through the write API, renders Home, a task, the Task list and the Worker tab at 1440/1366/390, and exits non-zero on any page/console error or a Home stuck on "Loading…" (`scripts/smoke-shots.mjs`).

**Board readability:** `npm run check:board-read -- --playwright <playwright-core dir> --chromium <headless chromium> [--out <dir>]` — seeds a synthetic task (a 10k+ character report, three tables, a code block, long step titles, a long ask) through the write API and measures the right pane and the reader at 1204x754, 1844x1034 and 948x594 (`scripts/check-board-read.mjs`). `--code <dir>` points it at another checkout, `--before` only saves the shots.

UI strings live in `public/locales/{en,zh,vi}.json`. The Chinese and Vietnamese files were drafted by an
AI model and are marked `"status": "needs-review"` — native-speaker review is welcome.
The visual language (type scale, spacing, radius, semantic colours) follows the
[Orca](https://github.com/stablyai/orca) desktop app, with body text one step larger.

## Not in this release

Desktop installer (planned as a second shell around the same server), MCP wrapper, scoped read tokens for
external assistants, hosted service.

## License

[Apache License 2.0](LICENSE)
