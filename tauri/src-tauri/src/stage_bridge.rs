// Room live B, P1 part 2 (ADR docs/decisions/2026-11-13-room-live-b.md, D3 D5 D8; schema docs/decisions/room-live-b/
// stage-contract.v1.schema.json, normative). The host side of the stage stream for a first-party room pack:
//   * `stage.poll`, `stage.ready`, `stage.stats` on the existing `POST /<id>/__zumi/bridge` (pack_host.rs routes them here);
//   * the per-pack outbound queue (64 messages / 64 KB), its drop policy and its rate limits;
//   * the producer API the director calls later (schedule / cancel / gaze / state, plus avatar.rev and quality);
//   * the fallback rule F1: bench, runtime triggers R1-R5, the `room.live3d` override, and "no retry in a session".
// Everything here is plain data in and out: no pack text, audio or path ever crosses. Every decision is made from the pack
// the WEBVIEW LABEL is bound to (pack_host.rs `handle_request`), never from anything the page sends. Time is a parameter
// (`now`, epoch ms) so the rules are testable without sleeping; the wiring passes the wall clock.
use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::pack_host::{log_line, LoadedPack, PackState};

/// The contract versions this host speaks. v2 (T-31-ROOM motion P4) adds the host message `motion` (t 6); a v1 guest never gets it.
pub const CONTRACT_MIN: u8 = 1;
pub const CONTRACT_MAX: u8 = 2;

// Limits (schema `limits` + ADR D3/D5).
const BODY_CAP_POLL: usize = 128;
const BODY_CAP_READY: usize = 512;
const BODY_CAP_STATS: usize = 128;
const QUEUE_MSGS: usize = 64;
const QUEUE_BYTES: usize = 64 * 1024;
const RESPONSE_MSGS: usize = 16;
const RESPONSE_BYTES: usize = 16 * 1024;
const MSG_BYTES: usize = 128;
const SCHEDULE_BYTES: usize = 4096;
/// `motion` (v2): an int program of 8..=640 values (src/renderer/reflex/seated-motion.js WIRE_MAX_INTS), wire version first.
const MOTION_BYTES: usize = 4096;
const MOTION_INTS: std::ops::RangeInclusive<usize> = 8..=640;
const MOTION_WIRE_VERSION: i16 = 1;
const PARK_MS: u64 = 25_000;
const LEAD_MS: u64 = 150;
const WINDOW_BEHIND_MS: u64 = 2_000;
const WINDOW_AHEAD_MS: u64 = 30_000;
/// F1 (ADR D8).
const REFUSALS_TO_CLOSE: usize = 20;
const REFUSAL_WINDOW_MS: u64 = 10_000;
const READY_DEADLINE_MS: u64 = 20_000;
const NO_POLL_MS: u64 = 30_000;
/// `stage.poll` limit per pack, sustained (CoS ruling 13-11: 8/s because of the 150 ms utterance lead; the single-parked-poll rule is
/// unchanged). The ONE place to change it; the guest's spacing is derived from the same number (`room/src/stage-client.js`).
pub const POLL_LIMIT_PER_S: u32 = 8;
const NO_STATS_MS: u64 = 10_000;
/// The shortest gap between two stage.ready of one session (a reload); a faster one is refused and counts toward R4.
const RE_READY_MIN_MS: u64 = 2_000;
const PERF_FPS10: u16 = 200;
const PERF_WINDOW_MS: u64 = 10_000;
const BENCH_MS: u64 = 6_000;
const BENCH_WARMUP_MS: u64 = 1_000;
/// B1 floors. 9.11 light (owner 19-11: one bad start-up bench locked the 3D room off for good): softer than before, median fps >= 25 (was 30)
/// and every second's frame p95 <= 50 ms (was 40). R5 (`PERF_FPS10`, 20 fps over 10 s) still closes a room that really cannot keep up.
const BENCH_FPS10_MIN: u16 = 250;
const BENCH_P95X10_MAX: u16 = 500;
/// B1 takes the best of this many windows in one launch when only the frame p95 failed: the seated room sits near its 40 ms budget,
/// so one slow second must not decide a whole version (alpha.9.2, owner's GTX 1660: 4 of 9 idle launches failed on one second).
const BENCH_WINDOWS: u8 = 3;
/// ADR D5: a wall-clock step over this, against the monotonic clock, moves the queue (it never cancels anything).
const CLOCK_STEP_MS: i64 = 1_000;

pub fn epoch_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---------------------------------------------------------------------------------------------------------------------
// Host to guest messages (schema `$defs/hostMessage`).

#[derive(Clone, Debug, PartialEq)]
pub enum HostMsg {
    Schedule { id: u32, start_at: u64, duration_ms: u32, emotion: u8, intensity: u8, vis: Vec<u8> },
    Cancel { id: u32, at: u64 },
    State { s: u8 },
    Gaze { target: u8, anchor_ix: u8 },
    AvatarRev { rev: u32 },
    Quality { tier: u8 },
    Motion { id: u32, prog: Vec<i16> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Schedule,
    Cancel,
    State,
    Gaze,
    Rev,
    Quality,
    Motion,
}

impl HostMsg {
    fn kind(&self) -> Kind {
        match self {
            HostMsg::Schedule { .. } => Kind::Schedule,
            HostMsg::Cancel { .. } => Kind::Cancel,
            HostMsg::State { .. } => Kind::State,
            HostMsg::Gaze { .. } => Kind::Gaze,
            HostMsg::AvatarRev { .. } => Kind::Rev,
            HostMsg::Quality { .. } => Kind::Quality,
            HostMsg::Motion { .. } => Kind::Motion,
        }
    }

    /// The wire object. Only integers and an integer array: no string field exists (ADR D2/D5).
    fn to_json(&self, seq: u32) -> Value {
        match self {
            HostMsg::Schedule { id, start_at, duration_ms, emotion, intensity, vis } => json!({
                "t": 0, "seq": seq, "id": id, "startAtEpochMs": start_at, "durationMs": duration_ms,
                "emotion": emotion, "intensity": intensity, "vis": vis,
            }),
            HostMsg::Cancel { id, at } => json!({ "t": 1, "seq": seq, "id": id, "atEpochMs": at }),
            HostMsg::State { s } => json!({ "t": 2, "seq": seq, "s": s }),
            HostMsg::Gaze { target, anchor_ix } => json!({ "t": 3, "seq": seq, "target": target, "anchorIx": anchor_ix }),
            HostMsg::AvatarRev { rev } => json!({ "t": 4, "seq": seq, "rev": rev }),
            HostMsg::Quality { tier } => json!({ "t": 5, "seq": seq, "tier": tier }),
            HostMsg::Motion { id, prog } => json!({ "t": 6, "seq": seq, "id": id, "prog": prog }),
        }
    }

    /// Serialized size with the widest `seq`: the number the queue bytes and the response cap count.
    fn wire_bytes(&self) -> usize {
        serde_json::to_vec(&self.to_json(u32::MAX)).map(|v| v.len()).unwrap_or(usize::MAX)
    }

    fn byte_limit(&self) -> usize {
        match self.kind() {
            Kind::Schedule => SCHEDULE_BYTES,
            Kind::Motion => MOTION_BYTES,
            _ => MSG_BYTES,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProduceError {
    /// A field out of its range (the code names the field).
    Invalid(&'static str),
    /// The producer is over its own rate limit: a bug signal, logged.
    RateLimited,
    /// No open session for that pack (not opened, or closed by F1).
    NoSession,
}

// ---------------------------------------------------------------------------------------------------------------------
// Guest to host requests: closed objects (`deny_unknown_fields` is the Rust half of `additionalProperties: false`).

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Version {
    min: u8,
    max: u8,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PollArgs {
    v: Version,
    ack: u32,
    max: u8,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadyArgs {
    v: Version,
    // Validated as a u8 by the schema; the host does not branch on the guest's capability bits in v1.
    #[allow(dead_code)]
    caps: u8,
    anchors: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StatsArgs {
    fps10: u16,
    #[serde(rename = "frameP95x10")]
    frame_p95x10: u16,
    tier: u8,
    gaps: u8,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope<T> {
    #[allow(dead_code)]
    method: String,
    args: T,
}

fn parse_args<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<T, Refusal> {
    serde_json::from_slice::<Envelope<T>>(body).map(|e| e.args).map_err(|_| Refusal::new(400, "schema_violation", "the request does not match the stage contract"))
}

fn anchor_ok(a: &str) -> bool {
    let b = a.as_bytes();
    (1..=24).contains(&b.len()) && b[0].is_ascii_lowercase() && b[1..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

/// The method name a log line may carry: a fixed stage name or `?`. A page cannot write text into the log (ADR N5, N6).
fn log_method(m: &str) -> &'static str {
    match m {
        "stage.poll" => "stage.poll",
        "stage.ready" => "stage.ready",
        "stage.stats" => "stage.stats",
        _ => "?",
    }
}

/// The highest contract version both sides speak, or `None` (ADR D5 "Version handshake").
fn negotiate(v: &Version) -> Option<u8> {
    let hi = v.max.min(CONTRACT_MAX);
    let lo = v.min.max(CONTRACT_MIN);
    (lo <= hi).then_some(hi)
}

struct Refusal {
    status: u16,
    code: &'static str,
    message: &'static str,
}

impl Refusal {
    fn new(status: u16, code: &'static str, message: &'static str) -> Self {
        Refusal { status, code, message }
    }
}

fn reply_ok(result: Value) -> (u16, Value) {
    (200, json!({ "ok": true, "result": result }))
}

fn reply_refusal(r: &Refusal) -> (u16, Value) {
    (r.status, json!({ "ok": false, "code": r.code, "message": r.message }))
}

// ---------------------------------------------------------------------------------------------------------------------
// Rate limits: a token bucket (`cap` tokens, `rate` per second). cap == rate is a plain "n per second"; the schedule's burst is 8.

struct Bucket {
    cap: f64,
    rate: f64,
    tokens: f64,
    last: Option<u64>,
}

impl Bucket {
    fn new(cap: u32, rate: u32) -> Self {
        Bucket { cap: cap as f64, rate: rate as f64, tokens: cap as f64, last: None }
    }

    fn take(&mut self, now: u64) -> bool {
        if let Some(last) = self.last {
            self.tokens = (self.tokens + now.saturating_sub(last) as f64 / 1000.0 * self.rate).min(self.cap);
        }
        self.last = Some(now);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The renderer's producer call (rpc `stage.produce`): closed objects of numbers, parsed the same strict way.

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProduceSchedule {
    id: u32,
    #[serde(rename = "startAtEpochMs")]
    start_at: u64,
    #[serde(rename = "durationMs")]
    duration_ms: u32,
    emotion: u8,
    intensity: u8,
    vis: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProduceCancel {
    id: u32,
    #[serde(rename = "atEpochMs")]
    at: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProduceGaze {
    target: u8,
    #[serde(rename = "anchorIx")]
    anchor_ix: u8,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProduceState {
    s: u8,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProduceRev {
    rev: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProduceMotion {
    id: u32,
    prog: Vec<i16>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProduceEmpty {}

fn produce_error(e: ProduceError) -> String {
    match e {
        ProduceError::Invalid(field) => format!("stage_invalid:{field}"),
        ProduceError::RateLimited => "stage_rate_limited".to_string(),
        ProduceError::NoSession => "stage_no_session".to_string(),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// One stage session (one first-party pack guest).

struct Ready {
    anchors: usize,
}

struct Bench {
    started: u64,
    key: String,
    samples: Vec<(u16, u16)>,
    /// Windows judged before this one.
    judged: u8,
}

struct Session {
    opened_ms: u64,
    seq_next: u32,
    /// Delivered (a seq assigned), not yet acked. Re-sent while unacked.
    inflight: Vec<(u32, HostMsg, usize)>,
    /// Not delivered yet: no seq. The drop policy works on these.
    pending: VecDeque<(HostMsg, usize)>,
    acked: u32,
    ready: Option<Ready>,
    ready_ms: Option<u64>,
    poll_gen: u64,
    parked: bool,
    last_poll_ms: u64,
    last_stats_ms: Option<u64>,
    low_fps_since: Option<u64>,
    last_gaps: u8,
    gap_reports: u32,
    refusals: VecDeque<u64>,
    dropped: u32,
    rl_poll: Bucket,
    rl_stats: Bucket,
    out_schedule: Bucket,
    out_gaze: Bucket,
    out_state: Bucket,
    out_cancel: Bucket,
    out_motion: Bucket,
    out_all: Bucket,
    /// The contract version the last poll negotiated (0 before the first poll): `motion` needs 2.
    version: u8,
    bench_armed: Option<String>,
    /// A "Try 3D anyway" attempt: the bench is skipped and the performance judgement (R5) is not applied; R1-R4 are.
    forced: bool,
    bench: Option<Bench>,
    scripted: bool,
    closed: Option<&'static str>,
}

impl Session {
    fn new(now: u64) -> Self {
        Session {
            opened_ms: now,
            seq_next: 1,
            inflight: Vec::new(),
            pending: VecDeque::new(),
            acked: 0,
            ready: None,
            ready_ms: None,
            poll_gen: 0,
            parked: false,
            last_poll_ms: now,
            last_stats_ms: None,
            low_fps_since: None,
            last_gaps: 0,
            gap_reports: 0,
            refusals: VecDeque::new(),
            dropped: 0,
            rl_poll: Bucket::new(POLL_LIMIT_PER_S, POLL_LIMIT_PER_S),
            rl_stats: Bucket::new(1, 1),
            out_schedule: Bucket::new(8, 4),
            out_gaze: Bucket::new(5, 5),
            out_state: Bucket::new(4, 4),
            out_cancel: Bucket::new(8, 8),
            out_motion: Bucket::new(4, 2),
            out_all: Bucket::new(20, 20),
            version: 0,
            bench_armed: None,
            forced: false,
            bench: None,
            scripted: false,
            closed: None,
        }
    }

    fn totals(&self) -> (usize, usize) {
        let n = self.inflight.len() + self.pending.len();
        let b = self.inflight.iter().map(|(_, _, b)| *b).sum::<usize>() + self.pending.iter().map(|(_, b)| *b).sum::<usize>();
        (n, b)
    }

    fn over_bound(&self) -> bool {
        let (n, b) = self.totals();
        n > QUEUE_MSGS || b > QUEUE_BYTES
    }

    fn drop_older_of_all(&mut self, kind: Kind) {
        let before = self.pending.len();
        self.pending.retain(|(m, _)| m.kind() != kind);
        self.dropped += (before - self.pending.len()) as u32;
    }

    fn drop_older_of(&mut self, kind: Kind) {
        if let Some(last) = self.pending.iter().rposition(|(m, _)| m.kind() == kind) {
            let mut i = 0usize;
            let before = self.pending.len();
            self.pending.retain(|(m, _)| {
                let idx = i;
                i += 1;
                !(m.kind() == kind && idx < last)
            });
            self.dropped += (before - self.pending.len()) as u32;
        }
    }

    /// The D3 drop policy, in order: (1) gaze older than the newest gaze; (2) state superseded by a newer state; (3) a schedule
    /// whose end has passed; (4) the oldest schedule, with an `utterance.cancel` for it. `utterance.cancel` and the latest
    /// `state` are never dropped. `Err` = still over the bound after step 4 (F1 trigger R3).
    fn enforce_bounds(&mut self, now: u64) -> Result<(), ()> {
        if !self.over_bound() {
            return Ok(());
        }
        self.drop_older_of(Kind::Gaze);
        if !self.over_bound() {
            return Ok(());
        }
        self.drop_older_of(Kind::State);
        if !self.over_bound() {
            return Ok(());
        }
        let before = self.pending.len();
        self.pending.retain(|(m, _)| !matches!(m, HostMsg::Schedule { start_at, duration_ms, .. } if start_at + (*duration_ms as u64) < now));
        self.dropped += (before - self.pending.len()) as u32;
        while self.over_bound() {
            let Some(ix) = self.pending.iter().position(|(m, _)| m.kind() == Kind::Schedule) else { return Err(()) };
            let (m, _) = self.pending.remove(ix).expect("position is in range");
            self.dropped += 1;
            if let HostMsg::Schedule { id, .. } = m {
                let cancel = HostMsg::Cancel { id, at: now };
                let bytes = cancel.wire_bytes();
                self.pending.push_back((cancel, bytes));
            }
        }
        Ok(())
    }

    /// Moves every queued and unacked schedule and cancel by a wall-clock step; returns how many moved. A re-sent one the guest
    /// already handled is skipped by its seq, so moving it is harmless.
    fn rebase(&mut self, step: i64) -> usize {
        let mut moved = 0;
        for m in self.pending.iter_mut().map(|(m, _)| m).chain(self.inflight.iter_mut().map(|(_, m, _)| m)) {
            match m {
                HostMsg::Schedule { start_at: t, .. } | HostMsg::Cancel { at: t, .. } => {
                    *t = t.saturating_add_signed(step);
                    moved += 1;
                }
                _ => {}
            }
        }
        moved
    }

    /// The next response body: unacked messages first, then pending ones (a seq is assigned on first delivery, so a message
    /// dropped before it is sent leaves no gap). A schedule whose start is already past is never sent (ADR D3).
    fn collect(&mut self, now: u64, max: usize) -> (u32, Vec<Value>) {
        let before = self.pending.len();
        self.pending.retain(|(m, _)| !matches!(m, HostMsg::Schedule { start_at, .. } if *start_at < now));
        self.dropped += (before - self.pending.len()) as u32;
        let mut out = Vec::new();
        let mut bytes = 0usize;
        let mut seq0 = None;
        for (seq, m, b) in &self.inflight {
            if out.len() >= max || bytes + b > RESPONSE_BYTES {
                return (seq0.unwrap_or(self.seq_next), out);
            }
            seq0.get_or_insert(*seq);
            bytes += b;
            out.push(m.to_json(*seq));
        }
        while out.len() < max {
            let Some((_, b)) = self.pending.front() else { break };
            if bytes + b > RESPONSE_BYTES || self.seq_next == u32::MAX {
                break;
            }
            let (m, b) = self.pending.pop_front().expect("front exists");
            let seq = self.seq_next;
            self.seq_next += 1;
            seq0.get_or_insert(seq);
            bytes += b;
            out.push(m.to_json(seq));
            self.inflight.push((seq, m, b));
        }
        (seq0.unwrap_or(self.seq_next), out)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// F1: the room override setting, the open plan, the bench memory.

/// `room.live3d` in the host's settings.json: `auto` (default) | `on` | `off`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Live3d {
    Auto,
    On,
    Off,
}

impl Live3d {
    /// Both `{"room":{"live3d":"on"}}` and `{"room.live3d":"on"}` are read; anything else is `auto`.
    pub fn from_settings(settings: &Value) -> Live3d {
        let v = settings.get("room").and_then(|r| r.get("live3d")).or_else(|| settings.get("room.live3d")).and_then(Value::as_str);
        match v {
            Some("on") => Live3d::On,
            Some("off") => Live3d::Off,
            _ => Live3d::Auto,
        }
    }

    pub fn from_settings_file(data_dir: Option<&Path>) -> Live3d {
        data_dir
            .and_then(|d| std::fs::read(d.join("settings.json")).ok())
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .map(|s| Live3d::from_settings(&s))
            .unwrap_or(Live3d::Auto)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenPlan {
    /// Show the video room; the reason code is the line shown.
    Video(&'static str),
    /// Open the 3D room and run the bench B1 on this open.
    Bench,
    /// Open the 3D room, no bench.
    Open,
}

/// What F1 remembers for one (GPU adapter, driver, app version): the start-up bench passed, or it failed (`Fell("bench")`). The owner's
/// decision (13-11, ask-11130717): a weak PC falls back automatically, the FIRST launch measures quickly and decides, and there is a
/// manual override. So only that first-launch bench verdict outlives the launch (ADR A11); a runtime fallback (watchdog, perf guard, a
/// sleep or a clock step) closes the 3D room for this launch only, and the next launch tries 3D again. A new app version, driver or
/// adapter has another key.
///
/// 9.11 light: the room is locked off only after two bad launches in a row. The first bad launch is `Strike` (the number 1 on disk): that launch shows
/// the video room, the next one runs the bench again. A second bad launch is `Fell("bench")`, the lock; a good launch writes `Pass` over a strike.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Remembered {
    Pass,
    Fell(&'static str),
    /// One bad start-up bench so far (never two in a row): benches again on the next launch.
    Strike,
}

/// What a tab open does (ADR D8). `fell_back` = the reason an earlier open in THIS app session fell back; `remembered` = the
/// verdict stored for this (adapter, driver, app version).
pub fn plan_open(mode: Live3d, fell_back: Option<&'static str>, remembered: Option<Remembered>) -> OpenPlan {
    match mode {
        Live3d::Off => OpenPlan::Video("off"),
        // `on` skips the bench and is also the "try the 3D room anyway" switch: it may reopen after a fallback.
        Live3d::On => OpenPlan::Open,
        Live3d::Auto => match (fell_back, remembered) {
            (Some(reason), _) => OpenPlan::Video(reason),
            (None, Some(Remembered::Fell(reason))) => OpenPlan::Video(reason),
            (None, Some(Remembered::Pass)) => OpenPlan::Open,
            (None, Some(Remembered::Strike)) => OpenPlan::Bench, // one bad launch is not a lock: measure again
            (None, None) => OpenPlan::Bench,
        },
    }
}

/// Bench B1 verdict over the measured `stage.stats` samples `(fps10, frameP95x10)`: median fps >= 30 and the worst per-second
/// frame p95 <= 40 ms. No samples = fail.
pub fn bench_passes(samples: &[(u16, u16)]) -> bool {
    bench_fps_ok(samples) && samples.iter().all(|s| s.1 <= BENCH_P95X10_MAX)
}

/// The median-fps half of B1. A window that fails it is final (a truly weak machine); one that fails only the frame p95 gets another
/// window, up to `BENCH_WINDOWS`.
fn bench_fps_ok(samples: &[(u16, u16)]) -> bool {
    let mut fps: Vec<u16> = samples.iter().map(|s| s.0).collect();
    fps.sort_unstable();
    fps.get(fps.len() / 2).is_some_and(|m| *m >= BENCH_FPS10_MIN)
}

/// A fallback the watchdog decided: the guest must close and the video room shows `reason`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fallback {
    pub pack_id: String,
    pub reason: &'static str,
}

/// What the shell shows for one pack: the 3D room (a live guest) or the video room with a reason.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StageView {
    pub three_d_active: bool,
    pub reason: Option<&'static str>,
}

struct Inner {
    sessions: BTreeMap<String, Session>,
    fallbacks: Vec<Fallback>,
    bench_memory: BTreeMap<String, Remembered>,
    /// The key of this machine and app version (set when the tab opens): "Test again" forgets the bench verdict under it.
    key: Option<String>,
    /// "Try 3D anyway": armed by the renderer, consumed by the next open (one guarded attempt).
    try_once: bool,
    mode: Live3d,
    data_dir: Option<PathBuf>,
    park_ms: u64,
    test_hook: bool,
    /// The last (wall, monotonic) reading, ms, and the sum of the wall-clock steps seen since (ADR D5).
    clock: Option<(u64, u64)>,
    stepped_ms: i64,
}

impl Inner {
    fn log(&self, line: &str) {
        log_line(self.data_dir.as_deref(), line);
    }

    /// Writes the remembered bench verdicts next to the app's other data. A failed write is logged, never fatal: the verdict still holds
    /// for this session.
    fn persist_bench(&self) {
        let Some(dir) = &self.data_dir else { return };
        let body = serde_json::to_string(&Value::Object(self.bench_memory.iter().map(|(k, v)| (k.clone(), remembered_to_json(v))).collect())).unwrap_or_default();
        if std::fs::create_dir_all(dir).and_then(|_| std::fs::write(dir.join(BENCH_FILE), body)).is_err() {
            self.log("bench_memory_write_failed");
        }
    }

    fn close(&mut self, pack_id: &str, reason: &'static str) {
        let Some(s) = self.sessions.get_mut(pack_id) else { return };
        if s.closed.is_some() {
            return;
        }
        s.closed = Some(reason);
        self.fallbacks.push(Fallback { pack_id: pack_id.to_string(), reason });
        // For this launch only: the bench verdict is saved by `tick`, a runtime fallback is never saved (ADR A11, CoS eb6abc98).
        self.log(&format!("fallback {reason} pack={pack_id}"));
    }

    /// Record one refusal (schema, size, rate, version, seq) and close the guest at 20 within 10 s (R4).
    fn refuse(&mut self, pack_id: &str, method: &str, now: u64, r: Refusal) -> (u16, Value) {
        self.log(&format!("refused {} pack={pack_id} method={}", r.code, log_method(method)));
        let mut close = false;
        if let Some(s) = self.sessions.get_mut(pack_id) {
            s.refusals.push_back(now);
            while s.refusals.front().is_some_and(|t| now.saturating_sub(*t) > REFUSAL_WINDOW_MS) {
                s.refusals.pop_front();
            }
            close = s.refusals.len() >= REFUSALS_TO_CLOSE;
        }
        if close {
            self.close(pack_id, "violations");
        }
        reply_refusal(&r)
    }
}

/// The first closing trigger that holds for a session right now (R1 no_ready, R3 no_poll, R5 perf), or `None`.
fn verdict(s: &Session, now: u64, mode: Live3d) -> Option<&'static str> {
    if s.ready.is_none() && now.saturating_sub(s.opened_ms) >= READY_DEADLINE_MS {
        return Some("no_ready");
    }
    let polled = if s.parked { now } else { s.last_poll_ms };
    if now.saturating_sub(polled) >= NO_POLL_MS {
        return Some("no_poll");
    }
    if mode != Live3d::On {
        if s.low_fps_since.is_some_and(|t| now.saturating_sub(t) >= PERF_WINDOW_MS) {
            return Some("perf");
        }
        if let Some(ready) = s.ready_ms {
            if now.saturating_sub(s.last_stats_ms.unwrap_or(ready)) >= NO_STATS_MS {
                return Some("perf");
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------------------------------------------------
// The hub.

pub struct StageHub {
    inner: Mutex<Inner>,
    cv: Condvar,
    mono0: Instant,
}

impl Default for StageHub {
    fn default() -> Self {
        StageHub {
            inner: Mutex::new(Inner {
                sessions: BTreeMap::new(),
                fallbacks: Vec::new(),
                bench_memory: BTreeMap::new(),
                key: None,
                try_once: false,
                mode: Live3d::Auto,
                data_dir: None,
                park_ms: PARK_MS,
                test_hook: false,
                clock: None,
                stepped_ms: 0,
            }),
            cv: Condvar::new(),
            mono0: Instant::now(),
        }
    }
}

impl StageHub {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_data_dir(&self, dir: Option<PathBuf>) {
        let mut g = self.lock();
        // The remembered bench verdicts come with the data dir (a result outlives the app session); what is already in memory wins.
        if let Some(d) = &dir {
            for (k, v) in read_bench_file(d) {
                g.bench_memory.entry(k).or_insert(v);
            }
        }
        g.data_dir = dir;
    }

    /// The parked-poll timeout. 25 s in the app; a test shortens it.
    pub fn set_park_ms(&self, ms: u64) {
        self.lock().park_ms = ms;
    }

    pub fn set_mode(&self, mode: Live3d) {
        self.lock().mode = mode;
    }

    /// `--stage-test-hook`: the ticker queues one scripted utterance when the guest is ready (a dev/test aid, not a feature).
    pub fn set_test_hook(&self, on: bool) {
        self.lock().test_hook = on;
    }

    /// A guest for `pack_id` is being opened. Refused when an earlier open in this app session fell back (no retry), unless the
    /// mode is `on` (the "try the 3D room anyway" switch) or `off` is set (no guest at all).
    pub fn open(&self, pack_id: &str, now: u64) -> Result<(), &'static str> {
        let mut g = self.lock();
        match g.mode {
            Live3d::Off => return Err("off"),
            Live3d::Auto => {
                if let Some(reason) = g.sessions.get(pack_id).and_then(|s| s.closed) {
                    return Err(reason);
                }
            }
            Live3d::On => {}
        }
        g.sessions.insert(pack_id.to_string(), Session::new(now));
        Ok(())
    }

    /// Arm bench B1 for this open: it starts at `stage.ready` and is judged by `tick` 6 s later (up to `BENCH_WINDOWS` windows when only the
    /// frame p95 fails); the verdict is stored under `key`.
    pub fn arm_bench(&self, pack_id: &str, key: &str) {
        if let Some(s) = self.lock().sessions.get_mut(pack_id) {
            s.bench_armed = Some(key.to_string());
        }
    }

    pub fn remembered(&self, key: &str) -> Option<Remembered> {
        self.lock().bench_memory.get(key).copied()
    }

    /// The key (adapter, driver, app version) of this app run: the one "Test again" forgets.
    pub fn set_key(&self, key: &str) {
        self.lock().key = Some(key.to_string());
    }

    /// The shell closed the guest on purpose (the user picked another room, left the tab, the pack was replaced): the session ends with no
    /// fallback. A guest that is simply not there any more is not a dead guest. (Only the start-up bench verdict persists: ask-11130717,
    /// ADR A11.)
    pub fn end(&self, pack_id: &str) {
        self.lock().sessions.remove(pack_id);
        self.cv.notify_all();
    }

    /// "Test again": forget the remembered verdict of this machine and app version and the fallback this session recorded, so the next open
    /// runs the bench B1 again (ADR D8).
    pub fn test_again(&self) {
        let mut g = self.lock();
        let key = g.key.clone().unwrap_or_else(bench_key);
        g.bench_memory.remove(&key);
        g.persist_bench();
        g.sessions.retain(|_, s| s.closed.is_none());
    }

    /// "Try 3D anyway" (the renderer's button): arm ONE guarded attempt for the next open.
    pub fn try_anyway(&self) {
        self.lock().try_once = true;
    }

    /// Consumes the armed attempt: true once.
    pub fn take_try_anyway(&self) -> bool {
        std::mem::take(&mut self.lock().try_once)
    }

    /// Opens the guarded attempt: a remembered bench failure and an earlier fallback of this session are not applied, there is no bench and
    /// no performance judgement (R5), but R1-R4 still close a dead or misbehaving guest (A10). `off` still wins.
    pub fn open_forced(&self, pack_id: &str, now: u64) -> Result<(), &'static str> {
        let mut g = self.lock();
        if g.mode == Live3d::Off {
            return Err("off");
        }
        let mut s = Session::new(now);
        s.forced = true;
        g.sessions.insert(pack_id.to_string(), s);
        Ok(())
    }

    /// "Test again": forget the remembered bench result for this key.
    pub fn forget_bench(&self, key: &str) {
        let mut g = self.lock();
        g.bench_memory.remove(key);
        g.persist_bench();
    }

    pub fn bench_memory_json(&self) -> Value {
        Value::Object(self.lock().bench_memory.iter().map(|(k, v)| (k.clone(), remembered_to_json(v))).collect())
    }

    pub fn load_bench_memory(&self, v: &Value) {
        if let Some(map) = v.as_object() {
            let mut g = self.lock();
            for (k, b) in map {
                if let Some(r) = remembered_from_json(b) {
                    g.bench_memory.insert(k.clone(), r);
                }
            }
        }
    }

    pub fn fallen_back(&self, pack_id: &str) -> Option<&'static str> {
        self.lock().sessions.get(pack_id).and_then(|s| s.closed)
    }

    pub fn view(&self, pack_id: &str) -> StageView {
        let g = self.lock();
        match g.sessions.get(pack_id) {
            Some(s) => StageView { three_d_active: s.closed.is_none(), reason: s.closed },
            None => StageView { three_d_active: false, reason: None },
        }
    }

    pub fn parked(&self, pack_id: &str) -> bool {
        self.lock().sessions.get(pack_id).is_some_and(|s| s.parked)
    }

    /// (messages, bytes) in the pack's outbound queue, and how many messages the drop policy has dropped.
    pub fn queue_stats(&self, pack_id: &str) -> (usize, usize, u32) {
        let g = self.lock();
        g.sessions.get(pack_id).map(|s| { let (n, b) = s.totals(); (n, b, s.dropped) }).unwrap_or((0, 0, 0))
    }

    pub fn take_fallbacks(&self) -> Vec<Fallback> {
        std::mem::take(&mut self.lock().fallbacks)
    }

    /// R1: the guest page failed to load, its process is gone, or its WebGL context was lost (reported by the shell).
    /// Applies in every `room.live3d` mode.
    pub fn report_guest_gone(&self, pack_id: &str) {
        let mut g = self.lock();
        g.close(pack_id, "guest_gone");
        drop(g);
        self.cv.notify_all();
    }

    /// The wall clock (epoch ms) the app passes to every hub call, checked against the monotonic clock on the way.
    pub fn now(&self) -> u64 {
        let wall = epoch_ms();
        self.observe_clock(wall, self.mono0.elapsed().as_millis() as u64);
        wall
    }

    /// ADR D5 clock step, CoS ruling 77581b74 (Zumi never drops an utterance; late is acceptable). When the wall clock moves more
    /// than 1 s off the monotonic one, every queued schedule and cancel moves with it, so it keeps its real time: unmoved, a forward
    /// step would make it stale (`collect` drops a schedule whose start has passed) and a backward one early. A parked poll's clock
    /// follows (see `poll`). Nothing is cancelled: the utterance playing runs to its end. `mono` is any monotonic ms count.
    pub fn observe_clock(&self, wall: u64, mono: u64) {
        let mut guard = self.lock();
        let g = &mut *guard;
        let Some((wall0, mono0)) = g.clock.replace((wall, mono)) else { return };
        let step = (wall as i64 - wall0 as i64) - (mono as i64 - mono0 as i64);
        if step.abs() <= CLOCK_STEP_MS {
            return;
        }
        g.stepped_ms += step;
        let moved: usize = g.sessions.values_mut().filter(|s| s.closed.is_none()).map(|s| s.rebase(step)).sum();
        g.log(&format!("clock_step ms={step} rebased={moved}"));
        drop(guard);
        self.cv.notify_all();
    }

    /// The watchdog clock: R1 no_ready, R3 no_poll, R5 perf, the bench verdict, the scripted test utterance.
    pub fn tick(&self, now: u64) {
        let mut guard = self.lock();
        let g = &mut *guard;
        let mode = g.mode;
        let ids: Vec<String> = g.sessions.iter().filter(|(_, s)| s.closed.is_none()).map(|(k, _)| k.clone()).collect();
        for id in ids {
            let (v, finished, script) = {
                let s = g.sessions.get_mut(&id).expect("listed above");
                let finished = match &s.bench {
                    Some(b) if now >= b.started + BENCH_MS => s.bench.take(),
                    _ => None,
                };
                let script = g.test_hook && s.ready.is_some() && !s.scripted;
                s.scripted |= script;
                (verdict(s, now, if s.forced { Live3d::On } else { mode }), finished, script)
            };
            if let Some(mut b) = finished {
                let pass = bench_passes(&b.samples);
                b.judged += 1;
                // Numbers only: what the verdict was made from, so a surprising fallback can be read off the log.
                let fps: Vec<u16> = b.samples.iter().map(|x| x.0).collect();
                let p95: Vec<u16> = b.samples.iter().map(|x| x.1).collect();
                g.log(&format!("bench_verdict pass={pass} window={} pack={id} fps10={fps:?} frameP95x10={p95:?}", b.judged));
                if !pass && b.judged < BENCH_WINDOWS && bench_fps_ok(&b.samples) {
                    // Only the frame p95 failed: measure another window in this launch, nothing is remembered yet.
                    (b.started, b.samples) = (now, Vec::new());
                    g.sessions.get_mut(&id).expect("listed above").bench = Some(b);
                } else {
                    // A pass clears any strike; a bad launch is a strike, and the second one in a row (the key already holds a strike) is the lock.
                    let verdict = if pass {
                        Remembered::Pass
                    } else if g.bench_memory.get(&b.key) == Some(&Remembered::Strike) {
                        Remembered::Fell("bench")
                    } else {
                        Remembered::Strike
                    };
                    g.log(&format!("bench_memory verdict={}", match verdict { Remembered::Pass => "pass", Remembered::Strike => "strike", Remembered::Fell(_) => "locked" }));
                    g.bench_memory.insert(b.key.clone(), verdict);
                    g.persist_bench();
                    if !pass {
                        g.close(&id, "bench");
                    }
                }
            }
            if let Some(reason) = v {
                g.close(&id, reason);
            }
            if script {
                let msgs = scripted_utterance(now);
                if let Some(s) = g.sessions.get_mut(&id) {
                    for m in msgs {
                        let bytes = m.wire_bytes();
                        s.pending.push_back((m, bytes));
                    }
                }
            }
        }
        drop(guard);
        self.cv.notify_all();
    }

    // ------------------------------------------------------------------------------------------------------------------
    // Guest to host: one bridge call whose method starts with `stage.` (or an unparsable one from a stage pack).

    pub fn call(&self, pack: &LoadedPack, method: &str, body: &[u8], now: u64) -> (u16, Value) {
        let mut g = self.lock();
        if !pack.stage {
            // N8: a pack without `stage` gets nothing from this channel: no session, no queue, one log line.
            g.log(&format!("refused permission_denied pack={} method={}", pack.id, log_method(method)));
            return reply_refusal(&Refusal::new(403, "permission_denied", "this pack has no stage permission"));
        }
        let id = pack.id.as_str();
        let session = g.sessions.entry(id.to_string()).or_insert_with(|| Session::new(now));
        if session.closed.is_some() {
            return reply_refusal(&Refusal::new(403, "stage_closed", "the stage channel is closed for this session"));
        }
        let cap = match method {
            "stage.poll" => BODY_CAP_POLL,
            "stage.ready" => BODY_CAP_READY,
            "stage.stats" => BODY_CAP_STATS,
            _ => 0,
        };
        let r = match method {
            "stage.poll" | "stage.ready" | "stage.stats" if body.len() > cap => Err(Refusal::new(413, "too_large", "the request is over the stage body cap")),
            "stage.poll" => return self.poll(g, id, body, now),
            "stage.ready" => ready(&mut g, id, body, now),
            "stage.stats" => stats(&mut g, id, body, now),
            "" => Err(Refusal::new(400, "bad_request", "the body is not a bridge request")),
            _ => Err(Refusal::new(404, "method_unknown", "not a stage method")),
        };
        let out = match r {
            Ok(result) => reply_ok(result),
            Err(refusal) => g.refuse(id, method, now, refusal),
        };
        drop(g);
        self.cv.notify_all();
        out
    }

    fn poll(&self, mut g: MutexGuard<'_, Inner>, id: &str, body: &[u8], now: u64) -> (u16, Value) {
        let (version, max, my_gen) = match poll_prepare(&mut g, id, body, now) {
            Ok(t) => t,
            Err(r) => {
                let out = g.refuse(id, "stage.poll", now, r);
                drop(g);
                self.cv.notify_all();
                return out;
            }
        };
        // The new poll replaced the parked one: wake it so it answers at once with an empty batch.
        self.cv.notify_all();
        let started = Instant::now();
        let mut waited = 0u64;
        let stepped0 = g.stepped_ms;
        loop {
            let park = g.park_ms;
            // `now` plus the monotonic wait, plus any wall-clock step seen meanwhile (the producer queues on the stepped clock).
            let now_w = (now + waited).saturating_add_signed(g.stepped_ms - stepped0);
            let s = g.sessions.get_mut(id).expect("created by call");
            if s.closed.is_some() {
                return reply_refusal(&Refusal::new(403, "stage_closed", "the stage channel is closed for this session"));
            }
            if s.poll_gen != my_gen {
                return reply_ok(json!({ "v": version, "seq0": s.seq_next, "hostNowEpochMs": now_w, "msgs": [] }));
            }
            let (seq0, msgs) = s.collect(now_w, max);
            if !msgs.is_empty() || waited >= park {
                s.parked = false;
                return reply_ok(json!({ "v": version, "seq0": seq0, "hostNowEpochMs": now_w, "msgs": msgs }));
            }
            s.parked = true;
            let (guard, _timeout) = self.cv.wait_timeout(g, Duration::from_millis(park - waited)).unwrap_or_else(|e| e.into_inner());
            g = guard;
            waited = started.elapsed().as_millis() as u64;
        }
    }

    // ------------------------------------------------------------------------------------------------------------------
    // Host to guest: the producer API the director calls later. All numbers and enums; no string ever.

    fn enqueue(&self, pack_id: &str, msg: HostMsg, now: u64) -> Result<(), ProduceError> {
        let mut g = self.lock();
        let Some(s) = g.sessions.get_mut(pack_id).filter(|s| s.closed.is_none()) else { return Err(ProduceError::NoSession) };
        let kind = msg.kind();
        let kind_ok = match kind {
            Kind::Schedule => s.out_schedule.take(now),
            Kind::Gaze => s.out_gaze.take(now),
            Kind::State => s.out_state.take(now),
            Kind::Cancel => s.out_cancel.take(now),
            Kind::Motion => s.out_motion.take(now),
            Kind::Rev | Kind::Quality => true,
        };
        if !(s.out_all.take(now) && kind_ok) {
            g.log(&format!("producer_rate_limited pack={pack_id} kind={kind:?}"));
            return Err(ProduceError::RateLimited);
        }
        let s = g.sessions.get_mut(pack_id).expect("checked above");
        if kind == Kind::Motion {
            s.drop_older_of_all(Kind::Motion); // the newest intent wins: one not yet delivered is replaced, never queued behind
        }
        let bytes = msg.wire_bytes();
        debug_assert!(bytes <= msg.byte_limit());
        s.pending.push_back((msg, bytes));
        if s.enforce_bounds(now).is_err() {
            g.close(pack_id, "queue_full");
        }
        drop(g);
        self.cv.notify_all();
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn schedule(&self, pack_id: &str, id: u32, start_at: u64, duration_ms: u32, emotion: u8, intensity: u8, vis: &[u8], now: u64) -> Result<(), ProduceError> {
        if !(100..=6000).contains(&duration_ms) {
            return Err(ProduceError::Invalid("durationMs"));
        }
        if emotion > 4 {
            return Err(ProduceError::Invalid("emotion"));
        }
        if intensity > 100 {
            return Err(ProduceError::Invalid("intensity"));
        }
        if start_at < now + LEAD_MS || start_at > now + WINDOW_AHEAD_MS {
            return Err(ProduceError::Invalid("startAtEpochMs"));
        }
        let frames = (duration_ms as usize * 30).div_ceil(1000);
        if vis.len() != 5 * frames || vis.iter().any(|v| *v > 100) {
            return Err(ProduceError::Invalid("vis"));
        }
        self.enqueue(pack_id, HostMsg::Schedule { id, start_at, duration_ms, emotion, intensity, vis: vis.to_vec() }, now)
    }

    pub fn cancel(&self, pack_id: &str, id: u32, at: u64, now: u64) -> Result<(), ProduceError> {
        if at + WINDOW_BEHIND_MS < now || at > now + WINDOW_AHEAD_MS {
            return Err(ProduceError::Invalid("atEpochMs"));
        }
        self.enqueue(pack_id, HostMsg::Cancel { id, at }, now)
    }

    pub fn gaze(&self, pack_id: &str, target: u8, anchor_ix: u8, now: u64) -> Result<(), ProduceError> {
        if target > 3 {
            return Err(ProduceError::Invalid("target"));
        }
        if target == 3 {
            let anchors = self.lock().sessions.get(pack_id).and_then(|s| s.ready.as_ref().map(|r| r.anchors)).unwrap_or(0);
            if anchor_ix as usize >= anchors {
                return Err(ProduceError::Invalid("anchorIx"));
            }
        } else if anchor_ix != 0 {
            return Err(ProduceError::Invalid("anchorIx"));
        }
        self.enqueue(pack_id, HostMsg::Gaze { target, anchor_ix }, now)
    }

    pub fn state(&self, pack_id: &str, s: u8, now: u64) -> Result<(), ProduceError> {
        if s > 3 {
            return Err(ProduceError::Invalid("s"));
        }
        self.enqueue(pack_id, HostMsg::State { s }, now)
    }

    pub fn avatar_rev(&self, pack_id: &str, rev: u32, now: u64) -> Result<(), ProduceError> {
        self.enqueue(pack_id, HostMsg::AvatarRev { rev }, now)
    }

    /// One seated-motion program (v2). The host checks the shape only (length, wire version, the guest's contract version); the guest
    /// decodes and validates every value again (room/src/stage-client.js, src/renderer/reflex/seated-motion.js decodeMotion).
    pub fn motion(&self, pack_id: &str, id: u32, prog: Vec<i16>, now: u64) -> Result<(), ProduceError> {
        if !MOTION_INTS.contains(&prog.len()) || prog[0] != MOTION_WIRE_VERSION {
            return Err(ProduceError::Invalid("prog"));
        }
        let version = self.lock().sessions.get(pack_id).map(|s| s.version).unwrap_or(0);
        if version < 2 {
            return Err(ProduceError::Invalid("version"));
        }
        self.enqueue(pack_id, HostMsg::Motion { id, prog }, now)
    }

    pub fn quality(&self, pack_id: &str, tier: u8, now: u64) -> Result<(), ProduceError> {
        if tier > 2 {
            return Err(ProduceError::Invalid("tier"));
        }
        self.enqueue(pack_id, HostMsg::Quality { tier }, now)
    }

    /// The renderer's producer call (rpc `stage.produce`, main webview only): the director's reply drives the 3D room with numbers
    /// and enums (ADR D2). The renderer never names a pack: the host picks the open, not fallen-back session, and with none open
    /// every op is a quiet `{active:false}` so a caller can send blindly. Text and audio never get here: the payloads are closed
    /// objects with no string field, and a refused payload queues nothing. Errors are short codes, never the payload.
    pub fn produce(&self, op: &str, payload: &Value, now: u64) -> Result<Value, String> {
        fn arg<T: serde::de::DeserializeOwned>(payload: &Value) -> Result<T, String> {
            serde_json::from_value(payload.clone()).map_err(|_| "stage_invalid:payload".to_string())
        }
        // Parse first so a malformed payload is refused the same whether or not a room is open.
        enum Op {
            Status,
            TryAnyway,
            TestAgain,
            Schedule(ProduceSchedule),
            Cancel(ProduceCancel),
            Gaze(ProduceGaze),
            State(ProduceState),
            Rev(ProduceRev),
            Motion(ProduceMotion),
        }
        let parsed = match op {
            "status" => { arg::<ProduceEmpty>(payload)?; Op::Status }
            "tryAnyway" => { arg::<ProduceEmpty>(payload)?; Op::TryAnyway }
            "testAgain" => { arg::<ProduceEmpty>(payload)?; Op::TestAgain }
            "schedule" => Op::Schedule(arg(payload)?),
            "cancel" => Op::Cancel(arg(payload)?),
            "gaze" => Op::Gaze(arg(payload)?),
            "state" => Op::State(arg(payload)?),
            "avatarRev" => Op::Rev(arg(payload)?),
            "motion" => Op::Motion(arg(payload)?),
            _ => return Err("stage_invalid:op".to_string()),
        };
        if matches!(parsed, Op::TryAnyway | Op::TestAgain) {
            // The switches next to the reason line: arm one guarded attempt, or forget the verdict. Neither needs an open room (there is none,
            // that is the point).
            if matches!(parsed, Op::TryAnyway) { self.try_anyway(); } else { self.test_again(); }
            let hook = self.lock().test_hook;
            return Ok(if hook { json!({ "active": false, "testHook": true }) } else { json!({ "active": false }) });
        }
        let pack_id = {
            let g = self.lock();
            g.sessions.iter().find(|(_, s)| s.closed.is_none() && s.ready.is_some()).map(|(k, _)| k.clone())
        };
        // `testHook` rides on the answer only when the host was started with --stage-test-hook (a test launch): the renderer then
        // exposes its dev/test handle (the info.packaged gate is always true in the Tauri build). Absent otherwise.
        let hook = self.lock().test_hook;
        let reply = |active: bool| if hook { json!({ "active": active, "testHook": true }) } else { json!({ "active": active }) };
        let Some(pack_id) = pack_id else { return Ok(reply(false)) };
        let done = match parsed {
            Op::Status | Op::TryAnyway | Op::TestAgain => Ok(()),
            Op::Schedule(m) => self.schedule(&pack_id, m.id, m.start_at, m.duration_ms, m.emotion, m.intensity, &m.vis, now),
            Op::Cancel(m) => self.cancel(&pack_id, m.id, m.at, now),
            Op::Gaze(m) => self.gaze(&pack_id, m.target, m.anchor_ix, now),
            Op::State(m) => self.state(&pack_id, m.s, now),
            Op::Rev(m) => self.avatar_rev(&pack_id, m.rev, now),
            Op::Motion(m) => self.motion(&pack_id, m.id, m.prog, now),
        };
        done.map(|_| reply(true)).map_err(produce_error)
    }

    /// Test hook (no pipeline exists yet): turn a reply text into one utterance the way the director will, from NUMBERS only.
    /// The text decides a length and a mouth pattern; it is never stored, sent or logged.
    pub fn schedule_from_reply_text(&self, pack_id: &str, reply: &str, now: u64) -> Result<(), ProduceError> {
        let duration_ms = (reply.chars().count() as u32 * 60).clamp(100, 6000);
        let frames = (duration_ms as usize * 30).div_ceil(1000);
        let vis: Vec<u8> = (0..frames * 5).map(|i| (reply.as_bytes().get(i % reply.len().max(1)).copied().unwrap_or(0) as usize * (i % 7 + 1) % 101) as u8).collect();
        self.schedule(pack_id, 1, now + LEAD_MS, duration_ms, 1, 60, &vis, now)
    }
}

/// The scripted utterance of `--stage-test-hook`: speaking, one 1 s utterance, idle.
fn scripted_utterance(now: u64) -> Vec<HostMsg> {
    let vis: Vec<u8> = (0..150).map(|i| if (i / 5) % 3 == 0 { 70 } else { 20 }).collect();
    vec![
        HostMsg::State { s: 3 },
        HostMsg::Schedule { id: 1, start_at: now + LEAD_MS, duration_ms: 1000, emotion: 1, intensity: 50, vis },
        HostMsg::State { s: 0 },
    ]
}

/// Validate one `stage.poll` and apply its ack; returns (chosen version, max messages, this poll's generation).
fn poll_prepare(g: &mut Inner, id: &str, body: &[u8], now: u64) -> Result<(u8, usize, u64), Refusal> {
    let args = parse_args::<PollArgs>(body)?;
    if !(1..=RESPONSE_MSGS as u8).contains(&args.max) || args.v.min > args.v.max {
        return Err(Refusal::new(400, "schema_violation", "a field is out of range"));
    }
    let s = g.sessions.get_mut(id).expect("created by call");
    if !s.rl_poll.take(now) {
        return Err(Refusal::new(429, "rate_limited", "stage.poll is limited to 8 per second"));
    }
    let Some(version) = negotiate(&args.v) else {
        g.close(id, "contract");
        return Err(Refusal::new(409, "contract_unsupported", "no common stage contract version"));
    };
    let s = g.sessions.get_mut(id).expect("created by call");
    s.version = version;
    if args.ack > s.seq_next - 1 || args.ack < s.acked {
        return Err(Refusal::new(400, "bad_seq", "ack is outside the sent range"));
    }
    s.acked = args.ack;
    s.inflight.retain(|(seq, _, _)| *seq > args.ack);
    s.last_poll_ms = now;
    // A new poll replaces the parked one (the older request is answered at once with an empty batch).
    s.poll_gen += 1;
    Ok((version, args.max as usize, s.poll_gen))
}

fn ready(g: &mut Inner, id: &str, body: &[u8], now: u64) -> Result<Value, Refusal> {
    let args = parse_args::<ReadyArgs>(body)?;
    if args.v.min > args.v.max || args.anchors.len() > 8 || !args.anchors.iter().all(|a| anchor_ok(a)) {
        return Err(Refusal::new(400, "schema_violation", "a field is out of range"));
    }
    let Some(version) = negotiate(&args.v) else {
        g.close(id, "contract");
        return Err(Refusal::new(409, "contract_unsupported", "no common stage contract version"));
    };
    let s = g.sessions.get_mut(id).expect("created by call");
    if s.ready.is_some() {
        // A second stage.ready from the same guest is a RELOAD (F5, a navigation): a new document with its own seq and ack. It starts the
        // session over (same attempt kind) instead of being refused, which used to leave a silent guest that the watchdog then read as
        // dead. Once per document.
        // Only the DOCUMENT starts over (seq, ack, queues, ready). The session's guards carry over, or a guest could call
        // stage.ready in a loop to clear R4 (refusals), R5 (the low-fps run and the stats clock) and every rate bucket
        // (GATE-OPUS-ALPHA7 should-fix 2). A re-ready is itself limited: one per RE_READY_MIN_MS, the excess is a refusal.
        if now.saturating_sub(s.ready_ms.unwrap_or(0)) < RE_READY_MIN_MS {
            return Err(Refusal::new(429, "rate_limited", "stage.ready again is limited to 1 per 2 seconds"));
        }
        let mut fresh = Session::new(now);
        fresh.forced = s.forced;
        fresh.opened_ms = s.opened_ms;
        fresh.refusals = std::mem::take(&mut s.refusals);
        fresh.low_fps_since = s.low_fps_since;
        // The no-stats clock runs from the last stats, or from the FIRST ready when none came yet.
        fresh.last_stats_ms = s.last_stats_ms.or(s.ready_ms);
        std::mem::swap(&mut fresh.rl_poll, &mut s.rl_poll);
        std::mem::swap(&mut fresh.rl_stats, &mut s.rl_stats);
        std::mem::swap(&mut fresh.out_schedule, &mut s.out_schedule);
        std::mem::swap(&mut fresh.out_gaze, &mut s.out_gaze);
        std::mem::swap(&mut fresh.out_state, &mut s.out_state);
        std::mem::swap(&mut fresh.out_cancel, &mut s.out_cancel);
        std::mem::swap(&mut fresh.out_all, &mut s.out_all);
        *s = fresh;
        g.log(&format!("stage_reload pack={id}"));
    }
    let s = g.sessions.get_mut(id).expect("created by call");
    s.ready = Some(Ready { anchors: args.anchors.len() });
    s.ready_ms = Some(now);
    let key = s.bench_armed.take();
    if let Some(key) = key {
        s.bench = Some(Bench { started: now, key, samples: Vec::new(), judged: 0 });
        // Bench B1 runs at tier Low (ADR D8).
        let low = HostMsg::Quality { tier: 0 };
        let bytes = low.wire_bytes();
        s.pending.push_back((low, bytes));
    }
    Ok(json!({ "v": version }))
}

fn stats(g: &mut Inner, id: &str, body: &[u8], now: u64) -> Result<Value, Refusal> {
    let args = parse_args::<StatsArgs>(body)?;
    if args.tier > 2 {
        return Err(Refusal::new(400, "schema_violation", "a field is out of range"));
    }
    let s = g.sessions.get_mut(id).expect("created by call");
    if !s.rl_stats.take(now) {
        return Err(Refusal::new(429, "rate_limited", "stage.stats is limited to 1 per second"));
    }
    if args.gaps > s.last_gaps {
        s.gap_reports += 1;
        s.last_gaps = args.gaps;
        if s.gap_reports >= 2 {
            return Err(Refusal::new(400, "bad_seq", "the guest reports sequence gaps again"));
        }
    }
    s.last_stats_ms = Some(now);
    if args.fps10 < PERF_FPS10 {
        s.low_fps_since.get_or_insert(now);
    } else {
        s.low_fps_since = None;
    }
    if let Some(b) = s.bench.as_mut() {
        if now >= b.started + BENCH_WARMUP_MS && now < b.started + BENCH_MS {
            b.samples.push((args.fps10, args.frame_p95x10));
        }
    }
    let mode = g.mode;
    let s = g.sessions.get(id).expect("created by call");
    if let Some(reason) = verdict(s, now, if s.forced { Live3d::On } else { mode }) {
        g.close(id, reason);
    }
    Ok(json!(true))
}

/// The key a bench result is remembered under: (adapter, driver, app minor). The adapter and driver are lower-cased and cleaned so the
/// separator, control characters or a very long name cannot forge or bloat a key; an unreadable part is `unknown`.
pub fn compose_bench_key(adapter: &str, driver: &str, minor: &str) -> String {
    fn part(s: &str, max: usize) -> String {
        let clean: String = s.chars().map(|c| if c == '|' || c.is_control() { ' ' } else { c }).collect::<String>().trim().to_lowercase();
        if clean.is_empty() { "unknown".to_string() } else { clean.chars().take(max).collect() }
    }
    format!("{}|{}|{minor}", part(adapter, 64), part(driver, 32))
}

/// The live key: the display adapter and driver of THIS machine (read once; `gpu_adapter`) and the full app version.
pub fn bench_key() -> String {
    static GPU: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
    let (adapter, driver) = GPU.get_or_init(crate::gpu_adapter::read);
    compose_bench_key(adapter, driver, env!("CARGO_PKG_VERSION"))
}

const BENCH_FILE: &str = "stage-bench.json";

/// `<data dir>/stage-bench.json`: `{ "<key>": true | false | 1 }`: the bench passed (`true`), failed twice in a row (`false`, the lock) or failed once
/// (`1`, a strike; 9.11 light: a build before it reads the number as nothing and benches again, which is the safe direction). A `"<reason>"` string
/// (a runtime fallback, saved by builds before alpha.9.4) is ignored. Nothing a page sent; a damaged file is ignored.
fn remembered_from_json(v: &Value) -> Option<Remembered> {
    match v {
        Value::Bool(true) => Some(Remembered::Pass),
        Value::Bool(false) => Some(Remembered::Fell("bench")), // the first format: a failed bench
        Value::Number(n) if n.as_u64() == Some(1) => Some(Remembered::Strike),
        Value::String(_) => None, // a runtime fallback an older build saved: not applied, 3D is tried again (alpha.9.4)
        _ => None,
    }
}

fn remembered_to_json(r: &Remembered) -> Value {
    match r {
        Remembered::Pass => json!(true),
        Remembered::Fell("bench") => json!(false),
        Remembered::Fell(reason) => json!(reason),
        Remembered::Strike => json!(1),
    }
}

fn read_bench_file(dir: &Path) -> BTreeMap<String, Remembered> {
    let Ok(text) = std::fs::read_to_string(dir.join(BENCH_FILE)) else { return BTreeMap::new() };
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&text) else { return BTreeMap::new() };
    map.into_iter().filter_map(|(k, v)| remembered_from_json(&v).map(|r| (k, r))).collect()
}

/// The watchdog thread: once a second the hub's clock runs, and every fallback it decides is applied to the live guests (the
/// webview is closed) and announced to the main webview as `stage:fallback {pack, reason}` (nothing listens yet).
pub fn start_watchdog(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let packs = app.state::<PackState>();
        packs.stage.tick(packs.stage.now());
        for (pack_id, reason, labels) in settle(&packs.stage, &packs) {
            let registry = app.state::<crate::guest::GuestRegistry>();
            for label in labels {
                if let Some(webview) = registry.take_by_label(&label) {
                    let _ = webview.close();
                }
            }
            let _ = app.emit_to(crate::guest::MAIN_LABEL, "stage:fallback", json!({ "pack": pack_id, "reason": reason }));
        }
    });
}

/// Apply the fallbacks the watchdog decided: unbind every guest label of that pack (its requests are 404 from then on) and
/// return `(pack id, reason, labels to close)` for the shell to close the webviews and tell the main webview.
pub fn settle(hub: &StageHub, packs: &PackState) -> Vec<(String, &'static str, Vec<String>)> {
    hub.take_fallbacks().into_iter().map(|f| { let labels = packs.unbind_pack(&f.pack_id); (f.pack_id, f.reason, labels) }).collect()
}
