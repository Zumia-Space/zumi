# zumi-routines

Form-based reminders for Zumi (T-31-MAUS phase A2). A standalone crate: no `tauri` dependency, next to `zumi-hands` and
`zumi-audit`. The host wires it with a thin call (`tauri/src-tauri/src/routines_host.rs`). A later workspace move is a path
change only.

Check command: `cargo test --manifest-path tauri/zumi-routines/Cargo.toml` and
`node scripts/check-zumi-hands-lock.mjs tauri/zumi-routines/Cargo.lock` (rule 3.7: no crate outside the app lock).

## Files it owns

All in one directory that the host passes in (`<data dir>/routines/`). The crate never resolves the data dir itself.

| File | What |
| --- | --- |
| `reminders.json` | the store (format below) |
| `reminders.json.corrupt-<unix ms>` | an unreadable store, moved aside, never deleted |
| `audit.jsonl` | one line per routine tool decision, written through `zumi-audit` (allowed and refused) |

## `reminders.json` format (version 2; version 1 files are still read)

```json
{
  "v": 1,
  "reminders": [
    {
      "id": "r-1700000000000-1",
      "text": "drink water",
      "time": "15:00",
      "repeat": "daily",
      "at_ms": null,
      "created_ms": 1700000000000,
      "last_fired_ms": null,
      "done": false,
      "tool": "speak"
    }
  ]
}
```

| Field | Rule |
| --- | --- |
| `v` | `1` (read) or `2` (written: the rows may carry the rule fields below); any other value makes the file unreadable |
| `id` | non-empty string, unique in the file |
| `text` | 1 to 200 characters after trimming, no control characters |
| `time` | local wall clock, `HH:MM`, 24 hour, zero padded |
| `repeat` | `none`, `daily`, `monthly`, `yearly` or `interval` |
| `at_ms` | `repeat: none` only: the absolute due instant, unix milliseconds. Required for `none`, null for `daily` |
| `created_ms` | unix milliseconds |
| `last_fired_ms` | when the last fire was decided; the daily next-fire is computed after it. null before the first fire |
| `done` | `repeat: none` only: it fired (or was refused) once and never fires again. Fired one-shots are removed 24 hours later |
| `tool` | what the routine does when due. Always `speak` for a reminder made through the form. A routine may not name a hands or pack tool: the gate refuses it (step 5) |

Rule fields (R6, all optional, present only for the kind that uses them; any other combination makes the file unreadable):

| Kind | Fields |
| --- | --- |
| `monthly` | `day`: 1 to 31, or `0` = last day of every month. A month without that day is skipped |
| `yearly` | `month` 1 to 12 and `day` valid for it (`2`/`29` is allowed and runs in leap years only; `2`/`30` is refused) |
| `interval` | `every_min` 5 to 1440 and `anchor_ms` (the first slot; the form makes it the next `time`). Optional `weekdays` (0 = Sunday, no repeats, not all seven), `window_start` and `window_end` (`HH:MM`, same day, at least as long as the interval; start inclusive, end exclusive), `ends_ms` (inclusive, not before the anchor) |

Rules:

- At most 100 rows. A row that does not parse makes the whole file unreadable: it is moved aside and the store starts
  empty. No half-trusted file.
- Writes are atomic (temp file then rename).
- On-disk format does not change during a later port to a different host; both read the same file.

## Next-fire rules (`clock.rs`)

Pure functions over an injected time zone, tested with fixed New York and Ho Chi Minh zones (no real clock).

- A daily reminder is a local wall-clock time. Its next fire is the first instant strictly after its anchor (the last fire,
  or the creation time before the first fire) whose local time reads `HH:MM`.
- A local time that does not exist (spring-forward gap) fires just after the gap: 02:30 becomes 03:30 that one day.
- A local time that happens twice (fall-back fold) fires at its first occurrence only. One day never fires twice.
- A one-shot stores the absolute instant; a later zone or DST change does not move it.
- An anchor more than 36 h in the future (clock set back a lot, or a wrong file) is replaced by "now". A smaller step back
  keeps the anchor, so a clock set back an hour cannot fire the same day twice.
- The local zone on Windows comes from `SystemTimeToTzSpecificLocalTime`, so the OS rules decide the offset.

- Monthly (R6): the first instant strictly after the anchor on that day of a month at `HH:MM`. A day the month lacks is skipped (the
  31st skips shorter months); `last` is every month's own last day. Gap and fold behave as for a daily one.
- Yearly (R6): once a year on month/day at `HH:MM`; Feb 29 waits for the next leap year.
- Interval (R6, upstream's interval schedule): slots are `anchor + k * every` in elapsed time, so DST does not move them. A slot must
  fall on an allowed local weekday and inside the window (read on the local wall clock) and not after `ends_ms`. The search for an
  allowed slot is bounded to nine days; none found is "no next fire", not a hang.

## Catch-up and run history (R6, `engine.rs`, `history.rs`)

Upstream's catch-up rule: an occurrence is run only if it is at most 12 hours late (hours inside quiet hours are not counted: they
are held on purpose). After a long absence the NEWEST passed occurrence is the one that may run; every older one is folded into one
"Missed N" row. More than 12 hours late nothing is spoken: one `missed` row, and the routine moves on to its next occurrence (a
one-shot is finished). Not measured in upstream's snapshot: its newer "Missed N" wording (v0.1.169, not in the local snapshot) is
taken from the parity matrix note.

`history.jsonl` (same directory) holds one JSON line per decision, newest first when read through `routines.history`:

| status | When it is written |
| --- | --- |
| `fired` | the speaker took the fire (after the hand-over; a fire taken back and retried is logged once, with its folded "Missed N" row just before it) |
| `missed` | `missed` = how many occurrences the row stands for: 1 = one run over 12 h late, N = older occurrences folded behind a fire or a late run |
| `refused` | the tool gate refused the routine |

Lines for missed and refused are written only after the store save stuck (a failed save is retried and must not log twice). A log line
that cannot be written is logged to stderr by the runner and does not undo the decision. The file is cut back to its newest 400 lines
past 500; a line that does not parse is skipped and counted.

## Quiet hours (`engine.rs`)

The window is `talkQuietHours` from settings.json, the same one the speech scheduler reads (default on, 22:30 to 07:30,
start inclusive, end exclusive, wraps midnight, invalid value = default). A reminder that is due inside the window is left
untouched: no fire, nothing recorded. On the first tick after the window ends it is still due, so it fires, once.
Several held reminders each fire once. Quiet hours follow the local wall clock, so DST moves them with it.
`Engine::tick` records every fire in the store before it returns, so a crash or restart after a fire never repeats it.

## Wake after suspend (`runner.rs`)

`Routines::start` runs one thread that ticks the engine every second and hands each fire to the host's sink. The thread
sleeps with the PC. The host calls `Routines::on_resume()` when Windows reports a resume (`os_signals.rs`), which wakes the
thread at once. What makes it safe:

- The engine records a fire in the store before it returns it. An overdue reminder fires on the first tick after the wake,
  once. A daily reminder missed for several days is one fire, then the next 15:00 (not a repeat).
- Windows sends two resume messages (automatic and by-user) and the periodic tick races with them: still one fire.
- A resume inside quiet hours changes nothing: the reminder stays silent until they end.
- A restart over the same directory does not repeat a fire; one that came due while the app was closed fires once at the
  first tick.
- The sink returns `Err` when the speaker is not ready (the sidecar is still starting). The fire is taken back and the
  reminder is due again on the next tick; it is never lost and never spoken twice.

## Routine tool refusal (`gate.rs`)

A routine runs only through one door. Default deny: the allowed tools are exactly `speak` and `chat.say` (exact match, no
prefix, no case folding). A name like `hands.click`, `pack.shell` or `power.browser-hands`, or anything else, is refused
with the code `routine_tool_refused`. Owner ruling O7: routines speak and chat only; hands never run unattended.

- Every decision, allowed or refused, is one line in `audit.jsonl` through `zumi-audit` (verb `routine.tool`, detail
  `routine=<id> tool=<name> [kind=hands|pack|other]`). Control characters in a stored name are shown as `?`.
- A refused routine is finished at once (a one-shot is marked done, a daily one advances), so it is not asked again every
  second and writes one audit line, not one per tick. Nothing reaches the speaker.
- If the audit line cannot be written the routine does not run and is retried on the next tick.
- The form cannot set `tool`; a reminder added through `routines.add` is always `speak`. The gate is for a hand-edited or
  future-written store.

## Host wiring and the rpc surface

The host (`tauri/src-tauri/src/routines_host.rs`) is a thin call:

| What | How |
| --- | --- |
| Start | once per process, beside the first sidecar of a real launch: `Routines::start(Config::system(<data dir>/routines, quiet, sink))` |
| Quiet hours | `quiet` reads `talkQuietHours` from `<data dir>/settings.json` per due reminder (`Quiet::from_settings`) |
| Speaking | `sink` calls the host-only sidecar method `__host.reminderSay(text)`. It goes through the existing speech scheduler as the `reminder` kind (no TTS path of its own). It fails before the renderer listens, so the fire is taken back and retried |
| Renderer calls | `routines.list`, `routines.add`, `routines.delete`, `routines.history` (inventory entries, `tauriOnly`), answered by `Routines::handle` without a sidecar call |
| Resume | `os_signals.rs` sees `WM_POWERBROADCAST` with `PBT_APMRESUMEAUTOMATIC` (0x12) or `PBT_APMRESUMESUSPEND` (0x07) and calls `Routines::on_resume()` |

`routines.add({ text, time, repeat, ...rule })` returns `{ ok:true, item }` or `{ ok:false, error }` with `bad_args`, `bad_text`,
`bad_time`, `bad_repeat`, `bad_rule` or `too_many`. The rule fields by kind: monthly `day` (1-31 or `"last"`); yearly `month`, `day`;
interval `everyMin` (starts at `time`), optional `weekdays`, `window: {start,end}`, `endsMs`. A field that does not belong to the kind
is `bad_rule` (a form is never read as a different schedule). `routines.history({ id?, limit? })` (limit 1-200, default 50) returns
`{ ok:true, items:[{ atMs, id, text, scheduledMs, status, missed }] }`, newest first. `routines.delete(id)` returns `{ ok:true }` or `{ ok:false, error:'not_found' }`.
`routines.list()` returns `{ ok:true, items }`, soonest first, each `{ id, text, time, repeat, done, nextMs }`.

The scheduler's `reminder` kind skips the chatter gap, the daily cap, away and typing holds and the hidden-window rule (the
user asked for it). At level Off or while muted it is shown as a subtitle, not spoken. If the renderer answers busy (a reply is
speaking) it is re-issued on the next ticks, up to 30 times, then shown as a subtitle.

## One scheduler per directory (`lock.rs`)

`Routines::start` first takes an exclusive OS lock on `routines.lock` in the routines directory and keeps it until `stop()` or
the end of the process (the OS releases it after a crash too). A second process over the same directory gets
`StoreError::Locked` (`locked`): no scheduler, it neither fires nor writes the store or the audit, and the host logs it once.
This does not rely on the app's single-instance rule, which owner and self-test builds skip on purpose. Without it two
processes spoke every reminder twice, overwrote each other's `reminders.json` and interleaved the audit lines.
