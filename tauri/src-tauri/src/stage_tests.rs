// Room live B, P1 part 2: the stage bridge (stage_bridge.rs), tests N5 N6 N8 N9 N13 N14 N15 and the F1 acceptance tests A1-A11
// of ADR docs/decisions/2026-11-13-room-live-b.md. Written before the implementation (red first); each has its mutation in
// scripts/check-stage-mutations.mjs. These run the host code the app runs (`handle_request` is the protocol handler body), with
// a synthetic clock where a rule is about time. The real-guest tests (N1-N4, N7) live in scripts/check-stage-guest.mjs.
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::pack_host::*;
use crate::pack_host_stage_tests::write_pack;
use crate::pack_host_tests::scratch;
use crate::stage_bridge::*;

const ROOM: &str = "plugin.room-preview";
const ROOM2: &str = "plugin.zumi-room-1";
const T0: u64 = 1_800_000_000_000;
const SCHEMA: &str = include_str!("../../../docs/decisions/room-live-b/stage-contract.v1.schema.json");

fn schema() -> Value {
    serde_json::from_str(SCHEMA).unwrap()
}

fn stage_pack(name: &str, id: &str) -> LoadedPack {
    let dir = write_pack(name, id, 2, json!({ "stage": "performance", "avatar": "read", "storage": true, "net": [] }));
    load_pack_dir(&dir, Some(id)).unwrap()
}

fn hub_with_log(name: &str) -> (StageHub, PathBuf) {
    let data = scratch(name);
    let hub = StageHub::default();
    hub.set_park_ms(30);
    hub.set_data_dir(Some(data.clone()));
    (hub, data)
}

fn log_text(data: &std::path::Path) -> String {
    std::fs::read_to_string(data.join("logs").join("pack-host.log")).unwrap_or_default()
}

fn env(method: &str, args: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({ "method": method, "args": args })).unwrap()
}

fn poll_args(ack: u64, max: u64) -> Value {
    json!({ "v": { "min": 1, "max": 1 }, "ack": ack, "max": max })
}

fn call(h: &StageHub, p: &LoadedPack, method: &str, args: Value, now: u64) -> (u16, Value) {
    h.call(p, method, &env(method, args), now)
}

fn poll(h: &StageHub, p: &LoadedPack, ack: u64, now: u64) -> (u16, Value) {
    call(h, p, "stage.poll", poll_args(ack, 16), now)
}

fn ready(h: &StageHub, p: &LoadedPack, now: u64) -> (u16, Value) {
    call(h, p, "stage.ready", json!({ "v": { "min": 1, "max": 1 }, "caps": 15, "anchors": ["desk", "window"] }), now)
}

fn stats(h: &StageHub, p: &LoadedPack, fps10: u32, p95x10: u32, now: u64) -> (u16, Value) {
    call(h, p, "stage.stats", json!({ "fps10": fps10, "frameP95x10": p95x10, "tier": 2, "gaps": 0 }), now)
}

fn msgs(v: &Value) -> Vec<Value> {
    v["result"]["msgs"].as_array().cloned().unwrap_or_default()
}

fn vis_for(duration_ms: u32) -> Vec<u8> {
    vec![40; 5 * (duration_ms as usize * 30).div_ceil(1000)]
}

fn open_ready(h: &StageHub, p: &LoadedPack, now: u64) {
    h.open(&p.id, now).unwrap();
    assert_eq!(ready(h, p, now).0, 200);
}

// ---------------------------------------------------------------------------------------------------------------------
// A mini JSON Schema checker for the subset the contract file uses (type, enum, const, minimum, maximum, required,
// properties, additionalProperties:false, items, maxItems, pattern for the anchors, oneOf, $ref). N5(c) feeds every captured
// poll item through it; the checker is itself proven by feeding it bad items.

fn resolve<'a>(root: &'a Value, r: &str) -> &'a Value {
    r.strip_prefix("#/").unwrap().split('/').fold(root, |n, k| &n[k])
}

fn anchor_regex(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=24).contains(&b.len()) && b[0].is_ascii_lowercase() && b[1..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

fn check(root: &Value, s: &Value, v: &Value, path: &str) -> Result<(), String> {
    if let Some(r) = s.get("$ref").and_then(Value::as_str) {
        return check(root, resolve(root, r), v, path);
    }
    if let Some(one) = s.get("oneOf").and_then(Value::as_array) {
        let n = one.iter().filter(|c| check(root, c, v, path).is_ok()).count();
        return if n == 1 { Ok(()) } else { Err(format!("{path}: matches {n} of oneOf")) };
    }
    if let Some(c) = s.get("const") {
        if v != c {
            return Err(format!("{path}: not the const {c}"));
        }
    }
    if let Some(e) = s.get("enum").and_then(Value::as_array) {
        if !e.contains(v) {
            return Err(format!("{path}: not in enum"));
        }
    }
    match s.get("type").and_then(Value::as_str) {
        Some("integer") => {
            if !(v.is_i64() || v.is_u64()) {
                return Err(format!("{path}: not an integer"));
            }
            let n = v.as_i64().unwrap_or(i64::MAX);
            if s.get("minimum").and_then(Value::as_i64).is_some_and(|m| n < m) || s.get("maximum").and_then(Value::as_i64).is_some_and(|m| n > m) {
                return Err(format!("{path}: out of range"));
            }
        }
        Some("object") => {
            let obj = v.as_object().ok_or(format!("{path}: not an object"))?;
            for req in s.get("required").and_then(Value::as_array).into_iter().flatten() {
                if !obj.contains_key(req.as_str().unwrap()) {
                    return Err(format!("{path}: missing {req}"));
                }
            }
            let props = s.get("properties").and_then(Value::as_object);
            for (k, val) in obj {
                match props.and_then(|p| p.get(k)) {
                    Some(ps) => check(root, ps, val, &format!("{path}/{k}"))?,
                    None if s.get("additionalProperties") == Some(&json!(false)) => return Err(format!("{path}: extra key {k}")),
                    None => {}
                }
            }
        }
        Some("array") => {
            let arr = v.as_array().ok_or(format!("{path}: not an array"))?;
            if s.get("maxItems").and_then(Value::as_u64).is_some_and(|m| arr.len() as u64 > m) {
                return Err(format!("{path}: too many items"));
            }
            if let Some(items) = s.get("items") {
                for (i, it) in arr.iter().enumerate() {
                    check(root, items, it, &format!("{path}[{i}]"))?;
                }
            }
        }
        Some("string") => {
            let st = v.as_str().ok_or(format!("{path}: not a string"))?;
            if let Some(p) = s.get("pattern").and_then(Value::as_str) {
                assert_eq!(p, "^[a-z][a-z0-9_]{0,23}$", "the checker only knows the anchor pattern");
                if !anchor_regex(st) {
                    return Err(format!("{path}: pattern"));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn valid_poll_response(v: &Value) -> Result<(), String> {
    let root = schema();
    check(&root, &root["poll_response"], &v["result"], "poll_response")?;
    for m in msgs(v) {
        if m["t"] == json!(0) {
            let frames = (m["durationMs"].as_u64().unwrap() * 30).div_ceil(1000) as usize;
            if m["vis"].as_array().unwrap().len() != 5 * frames {
                return Err("vis length".into());
            }
        }
    }
    Ok(())
}

/// Every string-typed node of the contract (the schema file's own typed nodes, not its descriptions).
fn string_nodes(root: &Value) -> Vec<String> {
    fn walk(v: &Value, path: &str, out: &mut Vec<String>) {
        match v {
            Value::Object(m) => {
                if m.get("type") == Some(&json!("string")) {
                    out.push(path.to_string());
                }
                for (k, c) in m {
                    if k != "description" && k != "title" && k != "const" && k != "enum" {
                        walk(c, &format!("{path}/{k}"), out);
                    }
                }
            }
            Value::Array(a) => a.iter().enumerate().for_each(|(i, c)| walk(c, &format!("{path}/{i}"), out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    for key in ["$defs", "host_to_guest", "poll_response", "guest_to_host"] {
        walk(&root[key], &format!("/{key}"), &mut out);
    }
    out
}

// ---------------------------------------------------------------------------------------------------------------------
// N5: no text or audio in the stream.

#[test]
fn n5b_no_message_field_is_a_string_and_only_the_anchor_names_are() {
    let nodes = string_nodes(&schema());
    assert_eq!(nodes, vec!["/guest_to_host/stage.ready/properties/anchors/items".to_string()], "the only string in the contract");
}

#[test]
fn n5c_every_item_of_every_poll_response_is_checked_against_the_closed_oneof() {
    let (h, _) = hub_with_log("n5c");
    let p = stage_pack("n5c-pack", ROOM);
    open_ready(&h, &p, T0);
    let now = T0 + 1000;
    h.state(ROOM, 3, now).unwrap();
    h.schedule(ROOM, 7, now + 300, 1000, 1, 60, &vis_for(1000), now).unwrap();
    h.gaze(ROOM, 3, 1, now).unwrap();
    h.cancel(ROOM, 6, now, now).unwrap();
    h.avatar_rev(ROOM, 4, now).unwrap();
    h.quality(ROOM, 0, now).unwrap();
    let (s, v) = poll(&h, &p, 0, now);
    assert_eq!(s, 200);
    assert_eq!(msgs(&v).len(), 6, "one of each type");
    valid_poll_response(&v).unwrap();
    let seqs: Vec<u64> = msgs(&v).iter().map(|m| m["seq"].as_u64().unwrap()).collect();
    assert_eq!(seqs, vec![1, 2, 3, 4, 5, 6], "seq starts at 1 and never skips");
    // The checker is itself proven: each deliberately bad item is rejected.
    let good = msgs(&v)[0].clone(); // state
    let bad: Vec<(&str, Value)> = vec![
        ("extra key", { let mut m = good.clone(); m["caption"] = json!("hi"); m }),
        ("string value", { let mut m = good.clone(); m["s"] = json!("3"); m }),
        ("out of range", { let mut m = good.clone(); m["s"] = json!(9); m }),
        ("missing key", { let mut m = good.clone(); m.as_object_mut().unwrap().remove("seq"); m }),
        ("unknown type", { let mut m = good.clone(); m["t"] = json!(9); m }),
        ("float", { let mut m = good.clone(); m["s"] = json!(1.5); m }),
    ];
    for (what, item) in bad {
        let mut resp = v.clone();
        resp["result"]["msgs"] = json!([item]);
        assert!(valid_poll_response(&resp).is_err(), "the validator must reject: {what}");
    }
}

#[test]
fn n5a_a_reply_marker_reaches_no_poll_response_and_no_log_line() {
    const MARKER: &str = "ZUMI-MARKER-7f3a91";
    let (h, data) = hub_with_log("n5a");
    let p = stage_pack("n5a-pack", ROOM);
    open_ready(&h, &p, T0);
    let reply = format!("hello {MARKER} world, this is the reply text that must never cross");
    h.schedule_from_reply_text(ROOM, &reply, T0 + 1000).unwrap();
    let mut all = String::new();
    let (_, v) = poll(&h, &p, 0, T0 + 1000);
    all.push_str(&v.to_string());
    assert!(!msgs(&v).is_empty(), "the reply produced an utterance (numbers only)");
    valid_poll_response(&v).unwrap();
    // Hostile guest calls that carry the marker: refused, and the marker is not echoed or logged.
    for (i, req) in [
        env("stage.poll", json!({ "v": { "min": 1, "max": 1 }, "ack": 0, "max": 1, "note": MARKER })),
        env(&format!("stage.{MARKER}"), json!({})),
        env("stage.stats", json!({ "fps10": MARKER, "frameP95x10": 1, "tier": 1, "gaps": 0 })),
        format!("{{\"method\":\"stage.poll\",\"args\":{{\"{MARKER}\":1}}}}").into_bytes(),
    ].iter().enumerate() {
        let method = if i == 1 { format!("stage.{MARKER}") } else if i == 2 { "stage.stats".to_string() } else { "stage.poll".to_string() };
        let (s, v) = h.call(&p, &method, req, T0 + 2000 + i as u64 * 1000);
        assert!(s >= 400, "case {i}");
        all.push_str(&v.to_string());
    }
    assert!(!all.contains(MARKER), "no response carries the marker");
    assert!(!log_text(&data).contains(MARKER), "no log line carries the marker: {}", log_text(&data));
    assert!(log_text(&data).contains(&format!("pack={ROOM}")), "refusals are still logged, with the pack id");
}

// ---------------------------------------------------------------------------------------------------------------------
// N6: schema, size, rate and seq enforcement.

#[test]
fn n6_unknown_field_wrong_type_and_out_of_range_are_refused_and_logged() {
    let (h, data) = hub_with_log("n6-schema");
    let p = stage_pack("n6-schema-pack", ROOM);
    open_ready(&h, &p, T0);
    let ok_v = json!({ "min": 1, "max": 1 });
    let cases: Vec<(&str, &str, Value)> = vec![
        ("stage.poll", "unknown field", json!({ "v": ok_v, "ack": 0, "max": 1, "flush": true })),
        ("stage.poll", "ack as a string", json!({ "v": ok_v, "ack": "0", "max": 1 })),
        ("stage.poll", "max as a float", json!({ "v": ok_v, "ack": 0, "max": 1.5 })),
        ("stage.poll", "max zero", json!({ "v": ok_v, "ack": 0, "max": 0 })),
        ("stage.poll", "max over 16", json!({ "v": ok_v, "ack": 0, "max": 17 })),
        ("stage.poll", "ack negative", json!({ "v": ok_v, "ack": -1, "max": 1 })),
        ("stage.poll", "ack over u32", json!({ "v": ok_v, "ack": 4294967296u64, "max": 1 })),
        ("stage.poll", "v min over max", json!({ "v": { "min": 3, "max": 2 }, "ack": 0, "max": 1 })),
        ("stage.poll", "v with an extra key", json!({ "v": { "min": 1, "max": 1, "x": 1 }, "ack": 0, "max": 1 })),
        ("stage.poll", "missing ack", json!({ "v": ok_v, "max": 1 })),
        ("stage.stats", "tier 3", json!({ "fps10": 600, "frameP95x10": 168, "tier": 3, "gaps": 0 })),
        ("stage.stats", "fps over u16", json!({ "fps10": 70000, "frameP95x10": 168, "tier": 1, "gaps": 0 })),
        ("stage.stats", "unknown field", json!({ "fps10": 600, "frameP95x10": 168, "tier": 1, "gaps": 0, "text": "x" })),
        ("stage.ready", "uppercase anchor", json!({ "v": ok_v, "caps": 1, "anchors": ["Desk"] })),
        ("stage.ready", "nine anchors", json!({ "v": ok_v, "caps": 1, "anchors": ["a","b","c","d","e","f","g","h","i"] })),
        ("stage.ready", "anchor too long", json!({ "v": ok_v, "caps": 1, "anchors": ["a".repeat(25)] })),
        ("stage.ready", "anchor not a string", json!({ "v": ok_v, "caps": 1, "anchors": [1] })),
    ];
    let mut refused = 0;
    for (i, (method, what, args)) in cases.into_iter().enumerate() {
        let now = T0 + 1000 * (i as u64 + 1); // spaced: the only refusal reason under test is the schema
        let (s, v) = call(&h, &p, method, args, now);
        assert_eq!((s, v["code"].clone()), (400, json!("schema_violation")), "{what}");
        refused += 1;
        assert_eq!(log_text(&data).matches("refused schema_violation").count(), refused, "{what}: one log line each");
    }
    assert!(h.view(ROOM).three_d_active, "a handful of refusals does not close the guest");
    // An envelope with an extra top-level key is refused too.
    let body = serde_json::to_vec(&json!({ "method": "stage.poll", "args": poll_args(0, 1), "also": 1 })).unwrap();
    assert_eq!(h.call(&p, "stage.poll", &body, T0 + 60_000).0, 400);
}

#[test]
fn n6_a_body_over_the_cap_is_refused_and_the_widest_legal_bodies_pass() {
    let (h, data) = hub_with_log("n6-size");
    let p = stage_pack("n6-size-pack", ROOM);
    open_ready(&h, &p, T0);
    let pad = |method: &str, args: Value, n: usize| serde_json::to_vec(&json!({ "method": method, "args": args, "pad": "x".repeat(n) })).unwrap();
    for (method, args, cap) in [
        ("stage.poll", poll_args(0, 1), 128usize),
        ("stage.stats", json!({ "fps10": 1, "frameP95x10": 1, "tier": 1, "gaps": 0 }), 128),
        ("stage.ready", json!({ "v": { "min": 1, "max": 1 }, "caps": 1, "anchors": [] }), 512),
    ] {
        let over = pad(method, args.clone(), cap);
        assert!(over.len() > cap);
        let (s, v) = h.call(&p, method, &over, T0 + 5000);
        assert_eq!((s, v["code"].clone()), (413, json!("too_large")), "{method}");
    }
    assert!(log_text(&data).contains("refused too_large"));
    // The widest legal requests are inside the caps (the caps are not tighter than the contract needs).
    let (h2, _) = hub_with_log("n6-size-ok");
    let p2 = stage_pack("n6-size-ok-pack", ROOM);
    h2.open(ROOM, T0).unwrap();
    let wide_poll = env("stage.poll", json!({ "v": { "min": 1, "max": 255 }, "ack": 0, "max": 16 }));
    assert!(wide_poll.len() <= 128);
    assert_eq!(h2.call(&p2, "stage.poll", &wide_poll, T0).0, 200);
    let anchors: Vec<String> = (0..8).map(|i| format!("a{}{}", i, "z".repeat(22))).collect();
    let wide_ready = env("stage.ready", json!({ "v": { "min": 1, "max": 255 }, "caps": 255, "anchors": anchors }));
    assert!(wide_ready.len() <= 512, "{}", wide_ready.len());
    assert_eq!(h2.call(&p2, "stage.ready", &wide_ready, T0).0, 200);
    let wide_stats = env("stage.stats", json!({ "fps10": 65535, "frameP95x10": 65535, "tier": 2, "gaps": 255 }));
    assert!(wide_stats.len() <= 128);
    assert_eq!(h2.call(&p2, "stage.stats", &wide_stats, T0).0, 200);
}

// CoS ruling 13-11: the poll limit is 8/s (the 150 ms utterance lead needs polls well under 500 ms apart); one named constant.
#[test]
fn n6_poll_limit_is_8_per_second_sustained_and_the_9th_in_a_second_is_429() {
    assert_eq!(POLL_LIMIT_PER_S, 8, "the named constant carries the ruling");
    let (h, data) = hub_with_log("n6-poll8");
    let p = stage_pack("n6-poll8-pack", ROOM);
    open_ready(&h, &p, T0);
    // 8 per second sustained: one poll every 125 ms for 5 s, none refused.
    let sustained: Vec<u16> = (0..40).map(|i| poll(&h, &p, 0, T0 + 125 * i).0).collect();
    assert!(sustained.iter().all(|c| *c == 200), "8 polls/s sustained must pass: {sustained:?}");
    // a fresh session: 9 polls inside one second (1 ms apart), the 9th is refused with rate_limited (bucket cap == rate == 8).
    let h2 = StageHub::default();
    h2.set_park_ms(30);
    h2.set_data_dir(Some(data.clone()));
    let p2 = stage_pack("n6-poll8-pack-b", ROOM);
    open_ready(&h2, &p2, T0);
    let nine: Vec<(u16, Value)> = (0..9).map(|i| poll(&h2, &p2, 0, T0 + i)).collect();
    assert!(nine[..8].iter().all(|(c, _)| *c == 200), "the first 8 pass: {:?}", nine.iter().map(|(c, _)| *c).collect::<Vec<_>>());
    assert_eq!(nine[8].0, 429, "the 9th within 1 s is refused");
    assert_eq!(nine[8].1["code"], "rate_limited");
    assert!(log_text(&data).contains(&format!("refused rate_limited pack={ROOM}")));
}

#[test]
fn n6_a_flood_over_the_rate_cap_is_answered_429_and_logged() {
    let (h, data) = hub_with_log("n6-rate");
    let p = stage_pack("n6-rate-pack", ROOM);
    open_ready(&h, &p, T0);
    h.state(ROOM, 1, T0).unwrap();
    let codes: Vec<u16> = (0..12).map(|_| poll(&h, &p, 0, T0 + 100).0).collect();
    let limit = POLL_LIMIT_PER_S as usize;
    assert!(codes[..limit].iter().all(|c| *c == 200), "{limit} polls per second are allowed: {codes:?}");
    assert!(codes[limit..].iter().all(|c| *c == 429), "the rest of the flood is 429: {codes:?}");
    assert!(log_text(&data).contains(&format!("refused rate_limited pack={ROOM}")));
    let (s, _) = poll(&h, &p, 0, T0 + 1500);
    assert_eq!(s, 200, "the limit is per second, not forever");
    let st: Vec<u16> = (0..3).map(|_| stats(&h, &p, 600, 168, T0 + 3000).0).collect();
    assert_eq!(st, vec![200, 429, 429], "stage.stats is 1 per second");
    assert!(h.view(ROOM).three_d_active, "fewer than 20 refusals: the guest stays");
}

#[test]
fn n6_an_ack_outside_the_sent_range_and_repeated_gap_reports_are_seq_violations() {
    let (h, data) = hub_with_log("n6-seq");
    let p = stage_pack("n6-seq-pack", ROOM);
    open_ready(&h, &p, T0);
    let (s, v) = poll(&h, &p, 5, T0 + 1000);
    assert_eq!((s, v["code"].clone()), (400, json!("bad_seq")), "an ack for a seq never sent");
    h.state(ROOM, 1, T0 + 1000).unwrap();
    h.state(ROOM, 2, T0 + 1500).unwrap();
    let (_, v) = poll(&h, &p, 0, T0 + 2000);
    assert_eq!(msgs(&v).len(), 2);
    assert_eq!(poll(&h, &p, 2, T0 + 3000).0, 200);
    let (s, v) = poll(&h, &p, 1, T0 + 4000);
    assert_eq!((s, v["code"].clone()), (400, json!("bad_seq")), "an ack that goes backwards");
    let gap = |gaps: u32, now: u64| call(&h, &p, "stage.stats", json!({ "fps10": 600, "frameP95x10": 168, "tier": 2, "gaps": gaps }), now);
    assert_eq!(gap(1, T0 + 5000).0, 200, "one reported gap is tolerated");
    let (s, v) = gap(2, T0 + 6000);
    assert_eq!((s, v["code"].clone()), (400, json!("bad_seq")), "a repeated gap is a contract violation");
    assert!(log_text(&data).contains("refused bad_seq"));
}

// ---------------------------------------------------------------------------------------------------------------------
// N8 N9 through the real request handler (label decides the pack).

fn http(state: &PackState, label: &str, url_id: &str, body: Value) -> (u16, Value) {
    let req = tauri::http::Request::builder()
        .method("POST")
        .uri(format!("http://zumipack.localhost/{url_id}/__zumi/bridge"))
        .body(serde_json::to_vec(&body).unwrap())
        .unwrap();
    let resp = handle_request(state, label, &req, &|| None, &mut |_| Ok(()));
    (resp.status().as_u16(), serde_json::from_slice(resp.body()).unwrap_or(Value::Null))
}

fn state_with(name: &str) -> (PackState, PathBuf) {
    let data = scratch(name);
    let state = PackState::default();
    *state.data_dir.lock().unwrap() = Some(data.clone());
    state.stage.set_data_dir(Some(data.clone()));
    state.stage.set_park_ms(30);
    (state, data)
}

#[test]
fn n8_a_pack_without_stage_gets_403_zero_messages_and_one_log_line() {
    let (state, data) = state_with("n8");
    let room = Arc::new(stage_pack("n8-room", ROOM));
    let dir = write_pack("n8-plain", "plugin.plain", 2, json!({ "avatar": "read", "net": [] }));
    let plain = Arc::new(load_pack_dir(&dir, Some("plugin.plain")).unwrap());
    assert!(plain.avatar && !plain.stage, "the room's other permission is granted, stage is not");
    state.bind("guest-pack-1", room.clone());
    state.bind("guest-pack-2", plain.clone());
    state.stage.open(ROOM, T0).unwrap();
    state.stage.state(ROOM, 3, T0).unwrap();
    let (s, v) = http(&state, "guest-pack-2", "plugin.plain", json!({ "method": "stage.poll", "args": poll_args(0, 16) }));
    assert_eq!((s, v["code"].clone()), (403, json!("permission_denied")));
    assert!(v.get("result").is_none(), "zero messages");
    let n = log_text(&data).lines().filter(|l| l.contains("permission_denied pack=plugin.plain")).count();
    assert_eq!(n, 1, "one log line");
    for m in ["stage.ready", "stage.stats"] {
        assert_eq!(http(&state, "guest-pack-2", "plugin.plain", json!({ "method": m, "args": {} })).0, 403, "{m}");
    }
    let (s, _) = http(&state, "guest-pack-1", ROOM, json!({ "method": "stage.poll", "args": poll_args(0, 16) }));
    assert_eq!(s, 200, "control: the stage pack is served");
}

#[test]
fn n9_pack_a_cannot_read_pack_bs_stream_or_storage() {
    let (state, _data) = state_with("n9");
    let a = Arc::new(stage_pack("n9-a", ROOM));
    let b = Arc::new(stage_pack("n9-b", ROOM2));
    state.bind("guest-pack-1", a.clone());
    state.bind("guest-pack-2", b.clone());
    state.stage.open(ROOM, T0).unwrap();
    state.stage.open(ROOM2, T0).unwrap();
    state.stage.state(ROOM, 3, T0).unwrap(); // A's marker: state 3
    state.stage.state(ROOM2, 1, T0).unwrap(); // B's: state 1
    let (s, v) = http(&state, "guest-pack-2", ROOM2, json!({ "method": "stage.poll", "args": poll_args(0, 16) }));
    assert_eq!(s, 200);
    let got: Vec<Value> = msgs(&v);
    assert_eq!(got.len(), 1, "B's queue only: {got:?}");
    assert_eq!(got[0]["s"], json!(1), "not A's state");
    let (s, v) = http(&state, "guest-pack-1", ROOM, json!({ "method": "stage.poll", "args": poll_args(0, 16) }));
    assert_eq!((s, msgs(&v)[0]["s"].clone()), (200, json!(3)));
    // B asking for A's bridge path is a 404, and so is the mirror.
    assert_eq!(http(&state, "guest-pack-2", ROOM, json!({ "method": "stage.poll", "args": poll_args(0, 16) })).0, 404);
    assert_eq!(http(&state, "guest-pack-1", ROOM2, json!({ "method": "host.info", "args": {} })).0, 404);
    // Storage: A writes a marker; B cannot reach A's folder by `..` nor by a made-up path.
    assert_eq!(http(&state, "guest-pack-1", ROOM, json!({ "method": "storage.write", "args": { "path": "marker.txt", "text": "A-SECRET" } })).0, 200);
    let (s, v) = http(&state, "guest-pack-2", ROOM2, json!({ "method": "storage.read", "args": { "path": format!("../{ROOM}/marker.txt") } }));
    assert_eq!((s, v["code"].clone()), (400, json!("path_escape")));
    let (s, v) = http(&state, "guest-pack-2", ROOM2, json!({ "method": "storage.read", "args": { "path": format!("plugin-data/{ROOM}/marker.txt") } }));
    assert_eq!((s, v["code"].clone()), (404, json!("not_found")));
    assert!(!v.to_string().contains("A-SECRET"));
}

// ---------------------------------------------------------------------------------------------------------------------
// N13 version handshake.

#[test]
fn n13_the_version_handshake_picks_the_highest_common_version_or_answers_409() {
    let (h, data) = hub_with_log("n13-a");
    let p = stage_pack("n13-pack-a", ROOM);
    h.open(ROOM, T0).unwrap();
    h.state(ROOM, 1, T0).unwrap();
    let (s, v) = call(&h, &p, "stage.poll", json!({ "v": { "min": 9, "max": 9 }, "ack": 0, "max": 16 }), T0 + 100);
    assert_eq!((s, v["code"].clone()), (409, json!("contract_unsupported")));
    assert!(v.get("result").is_none(), "zero messages");
    assert!(log_text(&data).contains(&format!("refused contract_unsupported pack={ROOM}")));
    assert_eq!(h.fallen_back(ROOM), Some("contract"), "R2: the pack falls under F1");
    let (h2, _) = hub_with_log("n13-b");
    let p2 = stage_pack("n13-pack-b", ROOM);
    h2.open(ROOM, T0).unwrap();
    let (s, v) = call(&h2, &p2, "stage.poll", json!({ "v": { "min": 1, "max": 5 }, "ack": 0, "max": 16 }), T0 + 100);
    // v2 (T-31-ROOM motion P4) is the host's highest: {1..5} gets 2, and a range above it (3..4) has nothing in common
    assert_eq!((s, v["result"]["v"].clone()), (200, json!(2)), "{{min:1,max:5}} gets v:2");
    for (min, max) in [(0, 0), (3, 4)] {
        let (h4, _) = hub_with_log("n13-d");
        h4.open(ROOM, T0).unwrap();
        assert_eq!(call(&h4, &p2, "stage.poll", json!({ "v": { "min": min, "max": max }, "ack": 0, "max": 1 }), T0).0, 409, "{min}..{max}");
    }
    let (h3, _) = hub_with_log("n13-c");
    h3.open(ROOM, T0).unwrap();
    assert_eq!(call(&h3, &p2, "stage.ready", json!({ "v": { "min": 9, "max": 9 }, "caps": 1, "anchors": [] }), T0).0, 409, "stage.ready is checked too");
}

// ---------------------------------------------------------------------------------------------------------------------
// N14 poll rules.

#[test]
fn n14_a_second_poll_replaces_the_parked_one_and_a_message_wakes_the_survivor() {
    let hub = Arc::new(StageHub::default());
    hub.set_park_ms(5000);
    let p = Arc::new(stage_pack("n14-park", ROOM));
    hub.open(ROOM, epoch_ms()).unwrap();
    let t = std::time::Instant::now();
    let (h1, p1) = (hub.clone(), p.clone());
    let first = std::thread::spawn(move || poll(&h1, &p1, 0, epoch_ms()));
    for _ in 0..200 {
        if hub.parked(ROOM) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(hub.parked(ROOM), "the first poll is parked");
    let (h2, p2) = (hub.clone(), p.clone());
    std::thread::sleep(std::time::Duration::from_millis(50));
    let second = std::thread::spawn(move || poll(&h2, &p2, 0, epoch_ms()));
    let (s, v) = first.join().unwrap();
    assert!(t.elapsed() < std::time::Duration::from_millis(4000), "the older request is answered at once, not at the park timeout");
    assert_eq!((s, msgs(&v).len()), (200, 0), "answered with an empty batch");
    std::thread::sleep(std::time::Duration::from_millis(100));
    assert!(hub.parked(ROOM), "the second poll is the parked one");
    hub.state(ROOM, 2, epoch_ms()).unwrap();
    let (s, v) = second.join().unwrap();
    assert_eq!((s, msgs(&v).len()), (200, 1), "the survivor is woken by the message");
    assert!(!hub.parked(ROOM));
}

#[test]
fn n14_the_queue_is_bounded_at_64_messages_and_64_kb() {
    let (h, _) = hub_with_log("n14-bound");
    let p = stage_pack("n14-bound-pack", ROOM);
    open_ready(&h, &p, T0);
    // 64 messages that no policy step may drop (avatar.rev): the 65th makes the queue unbounded, so F1 closes the guest (R3).
    let mut now = T0;
    for i in 0..64 {
        now += 60;
        h.avatar_rev(ROOM, i, now).unwrap();
    }
    assert_eq!(h.queue_stats(ROOM).0, 64);
    now += 60;
    h.avatar_rev(ROOM, 99, now).unwrap();
    assert_eq!(h.fallen_back(ROOM), Some("queue_full"), "still full after the drop policy: R3");
    // 64 KB: big schedules fill the bytes first; the policy drops the oldest schedule and sends a cancel for it.
    let (h, _) = hub_with_log("n14-bytes");
    let p = stage_pack("n14-bytes-pack", ROOM);
    open_ready(&h, &p, T0);
    let mut now = T0;
    for i in 0..40 {
        now += 260;
        h.schedule(ROOM, i, now + 200, 6000, 1, 50, &vis_for(6000), now).unwrap();
        let (n, bytes, _) = h.queue_stats(ROOM);
        assert!(n <= 64 && bytes <= 65536, "bounded at every step: {n} msgs {bytes} bytes");
    }
    assert!(h.queue_stats(ROOM).2 > 0, "schedules were dropped");
    assert!(h.view(ROOM).three_d_active, "dropping is enough: the guest stays");
    let (_, v) = poll(&h, &p, 0, now);
    let cancels: Vec<Value> = msgs(&v).into_iter().filter(|m| m["t"] == json!(1)).collect();
    assert!(cancels.is_empty() || cancels.iter().all(|c| c["id"].as_u64().unwrap() < 40), "a cancel names a dropped schedule");
}

#[test]
fn n14_cancel_and_the_latest_state_survive_a_flood() {
    let (h, _) = hub_with_log("n14-flood");
    let p = stage_pack("n14-flood-pack", ROOM);
    open_ready(&h, &p, T0);
    let mut now = T0;
    h.cancel(ROOM, 7, now, now).unwrap();
    for i in 0..70u8 {
        now += 260;
        h.state(ROOM, i % 4, now).unwrap();
    }
    let last_state = 69 % 4;
    let (_, v) = poll(&h, &p, 0, now);
    let got = msgs(&v);
    assert!(got.iter().any(|m| m["t"] == json!(1) && m["id"] == json!(7)), "the cancel survives the state flood");
    assert_eq!(got.iter().rev().find(|m| m["t"] == json!(2)).unwrap()["s"], json!(last_state), "the latest state is delivered");
    // Schedules flood: the cancel at the head of the queue is never the one dropped.
    let (h, _) = hub_with_log("n14-flood2");
    let p = stage_pack("n14-flood2-pack", ROOM);
    open_ready(&h, &p, T0);
    let mut now = T0;
    h.cancel(ROOM, 7, now, now).unwrap();
    for i in 0..30u32 {
        now += 260;
        h.schedule(ROOM, 100 + i, now + 200, 6000, 1, 50, &vis_for(6000), now).unwrap();
    }
    assert!(h.queue_stats(ROOM).2 > 0, "schedules were dropped");
    let (_, v) = poll(&h, &p, 0, now);
    assert!(msgs(&v).iter().any(|m| m["t"] == json!(1) && m["id"] == json!(7)), "the older cancel survives the schedule flood");
}

#[test]
fn n14_a_stale_schedule_is_dropped_and_a_live_one_is_sent() {
    let (h, _) = hub_with_log("n14-stale");
    let p = stage_pack("n14-stale-pack", ROOM);
    open_ready(&h, &p, T0);
    h.schedule(ROOM, 1, T0 + 200, 500, 1, 50, &vis_for(500), T0).unwrap();
    h.schedule(ROOM, 2, T0 + 2000, 500, 1, 50, &vis_for(500), T0 + 400).unwrap();
    let (_, v) = poll(&h, &p, 0, T0 + 600); // schedule 1 started at +200: already in the past when the host would send it
    let ids: Vec<u64> = msgs(&v).iter().map(|m| m["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, vec![2], "only the live schedule goes out; the stale one leaves no seq gap");
    assert_eq!(msgs(&v)[0]["seq"], json!(1));
    assert_eq!(h.queue_stats(ROOM).2, 1);
}

#[test]
fn unacked_messages_are_sent_again_and_acked_ones_are_freed() {
    let (h, _) = hub_with_log("redeliver");
    let p = stage_pack("redeliver-pack", ROOM);
    open_ready(&h, &p, T0);
    h.state(ROOM, 1, T0).unwrap();
    h.state(ROOM, 2, T0 + 300).unwrap();
    let (_, v) = poll(&h, &p, 0, T0 + 1000);
    assert_eq!((v["result"]["seq0"].clone(), msgs(&v).len()), (json!(1), 2));
    assert_eq!(v["result"]["hostNowEpochMs"], json!(T0 + 1000));
    let (_, again) = poll(&h, &p, 0, T0 + 2000); // the response was lost: same seqs again
    assert_eq!(msgs(&again).iter().map(|m| m["seq"].clone()).collect::<Vec<_>>(), vec![json!(1), json!(2)]);
    h.state(ROOM, 3, T0 + 2100).unwrap();
    let (_, next) = poll(&h, &p, 1, T0 + 3000);
    assert_eq!(msgs(&next).iter().map(|m| m["seq"].clone()).collect::<Vec<_>>(), vec![json!(2), json!(3)], "seq 1 acked and freed");
    assert_eq!(h.queue_stats(ROOM).0, 2);
    let (_, none) = poll(&h, &p, 3, T0 + 4000);
    assert_eq!((msgs(&none).len(), none["result"]["seq0"].clone()), (0, json!(4)), "an empty batch names the next seq");
}

// ---------------------------------------------------------------------------------------------------------------------
// N15: the guest cannot change what the host sends.

#[test]
fn n15_a_guest_field_the_host_could_read_as_a_command_is_refused_and_changes_nothing() {
    let (h, _) = hub_with_log("n15");
    let p = stage_pack("n15-pack", ROOM);
    open_ready(&h, &p, T0);
    h.state(ROOM, 1, T0).unwrap();
    h.gaze(ROOM, 0, 0, T0).unwrap();
    let before = h.queue_stats(ROOM);
    let mut now = T0 + 1000;
    for extra in [json!({ "flush": true }), json!({ "gaze": 1 }), json!({ "state": 3 }), json!({ "cmd": "x" }), json!({ "t": 0 }), json!({ "seq": 9 })] {
        let mut args = poll_args(0, 16);
        args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        now += 1000;
        let (s, v) = call(&h, &p, "stage.poll", args, now);
        assert_eq!((s, v["code"].clone()), (400, json!("schema_violation")), "{extra}");
    }
    assert_eq!(h.queue_stats(ROOM), before, "nothing the guest sent changed the queue");
    now += 1000;
    let (s, _) = call(&h, &p, "stage.stats", json!({ "fps10": 600, "frameP95x10": 168, "tier": 2, "gaps": 0, "state": 3 }), now);
    assert_eq!(s, 400);
    now += 1000;
    let (_, v) = poll(&h, &p, 0, now);
    let kinds: Vec<(Value, Value)> = msgs(&v).iter().map(|m| (m["t"].clone(), m["s"].clone())).collect();
    assert_eq!(kinds[0], (json!(2), json!(1)), "the host's own state, not the guest's: {kinds:?}");
    assert_eq!(msgs(&v).len(), 2);
}

// ---------------------------------------------------------------------------------------------------------------------
// Producer API: ranges, lead, anchors, rate.

#[test]
fn the_producer_checks_every_range_before_it_queues() {
    let (h, _) = hub_with_log("producer");
    let p = stage_pack("producer-pack", ROOM);
    open_ready(&h, &p, T0);
    let now = T0;
    let ok = |dur: u32| vis_for(dur);
    use ProduceError::Invalid;
    assert_eq!(h.schedule(ROOM, 1, now + 200, 99, 1, 50, &ok(99), now), Err(Invalid("durationMs")));
    assert_eq!(h.schedule(ROOM, 1, now + 200, 6001, 1, 50, &ok(6001), now), Err(Invalid("durationMs")));
    assert_eq!(h.schedule(ROOM, 1, now + 200, 1000, 5, 50, &ok(1000), now), Err(Invalid("emotion")));
    assert_eq!(h.schedule(ROOM, 1, now + 200, 1000, 1, 101, &ok(1000), now), Err(Invalid("intensity")));
    assert_eq!(h.schedule(ROOM, 1, now + 149, 1000, 1, 50, &ok(1000), now), Err(Invalid("startAtEpochMs")), "lead is at least 150 ms");
    assert_eq!(h.schedule(ROOM, 1, now + 30_001, 1000, 1, 50, &ok(1000), now), Err(Invalid("startAtEpochMs")));
    assert_eq!(h.schedule(ROOM, 1, now + 200, 1000, 1, 50, &ok(900), now), Err(Invalid("vis")), "vis length must be 5*ceil(durationMs*30/1000)");
    let mut bad = ok(1000);
    bad[3] = 101;
    assert_eq!(h.schedule(ROOM, 1, now + 200, 1000, 1, 50, &bad, now), Err(Invalid("vis")));
    assert_eq!(h.cancel(ROOM, 1, now - 2001, now), Err(Invalid("atEpochMs")));
    assert_eq!(h.cancel(ROOM, 1, now + 30_001, now), Err(Invalid("atEpochMs")));
    assert_eq!(h.gaze(ROOM, 4, 0, now), Err(Invalid("target")));
    assert_eq!(h.gaze(ROOM, 3, 2, now), Err(Invalid("anchorIx")), "the guest declared 2 anchors: index 2 is out of range");
    assert_eq!(h.gaze(ROOM, 1, 1, now), Err(Invalid("anchorIx")), "anchorIx is 0 unless the target is an anchor");
    assert_eq!(h.state(ROOM, 4, now), Err(Invalid("s")));
    assert_eq!(h.quality(ROOM, 3, now), Err(Invalid("tier")));
    assert_eq!(h.queue_stats(ROOM).0, 0, "a refused call queues nothing");
    assert_eq!(h.gaze(ROOM, 3, 1, now), Ok(()));
    assert_eq!(h.state("plugin.nobody", 1, now), Err(ProduceError::NoSession));
    assert_eq!(h.schedule(ROOM, 9, now + 150, 100, 0, 0, &ok(100), now), Ok(()), "the narrowest legal schedule");
}

#[test]
fn the_producer_is_rate_limited_per_kind_and_in_total() {
    let (h, data) = hub_with_log("producer-rate");
    let p = stage_pack("producer-rate-pack", ROOM);
    open_ready(&h, &p, T0);
    let now = T0;
    let mut sched_ok = 0;
    for i in 0..12 {
        if h.schedule(ROOM, i, now + 200, 100, 1, 50, &vis_for(100), now).is_ok() {
            sched_ok += 1;
        }
    }
    assert_eq!(sched_ok, 8, "utterance.schedule: burst 8");
    assert_eq!(h.schedule(ROOM, 99, now + 200, 100, 1, 50, &vis_for(100), now), Err(ProduceError::RateLimited));
    assert!(log_text(&data).contains("producer_rate_limited"), "the producer's own over-rate is logged as a bug signal");
    let later = now + 1000;
    assert_eq!(h.schedule(ROOM, 100, later + 200, 100, 1, 50, &vis_for(100), later), Ok(()), "refilled after a second");
    let mut gaze_ok = 0;
    for _ in 0..10 {
        if h.gaze(ROOM, 0, 0, later + 5000).is_ok() {
            gaze_ok += 1;
        }
    }
    assert_eq!(gaze_ok, 5, "gaze: 5 per second");
}

#[test]
fn live3d_settings_and_the_bench_verdict() {
    assert_eq!(Live3d::from_settings(&json!({})), Live3d::Auto);
    assert_eq!(Live3d::from_settings(&json!({ "room": { "live3d": "on" } })), Live3d::On);
    assert_eq!(Live3d::from_settings(&json!({ "room.live3d": "off" })), Live3d::Off);
    assert_eq!(Live3d::from_settings(&json!({ "room": { "live3d": "banana" } })), Live3d::Auto);
    assert!(bench_passes(&[(580, 168); 5]));
    assert!(!bench_passes(&[]));
    // 9.11 light: the bench is softer (was median fps >= 30 and every second's frame p95 <= 40 ms; now >= 25 and <= 50 ms).
    assert!(!bench_passes(&[(240, 168); 5]), "fps p50 under 25");
    assert!(bench_passes(&[(260, 168); 5]), "26 fps passes (it failed at the old 30 fps floor)");
    assert!(!bench_passes(&[(580, 501), (580, 168), (580, 168)]), "a frame p95 over 50 ms");
    assert!(bench_passes(&[(580, 450), (580, 500), (580, 168)]), "45 and 50 ms frames pass (they failed at the old 40 ms ceiling)");
    assert!(bench_passes(&[(100, 168), (580, 168), (600, 168)]), "median, not minimum");
}

// ---------------------------------------------------------------------------------------------------------------------
// F1 acceptance tests A1-A11. Each asserts the four things of the ADR: the video room is visible, the reason line carries the
// expected code, the main webview's Zumi renderer is running (it runs whenever the 3D room is not shown), and no 3D guest
// label is registered and none is reopened in the session. `now` is a synthetic clock; the signals are the real ones the
// guest sends (`stage.*` calls) or the shell reports.

fn bound_session(name: &str) -> (PackState, PathBuf, Arc<LoadedPack>) {
    let (state, data) = state_with(name);
    let pack = Arc::new(stage_pack(&format!("{name}-pack"), ROOM));
    state.bind("guest-pack-1", pack.clone());
    (state, data, pack)
}

/// Another app launch on the same data folder (a fresh hub that reads `stage-bench.json`), with the room pack bound.
fn second_launch(data: &std::path::Path, name: &str) -> (PackState, Arc<LoadedPack>) {
    let state = PackState::default();
    *state.data_dir.lock().unwrap() = Some(data.to_path_buf());
    state.stage.set_data_dir(Some(data.to_path_buf()));
    state.stage.set_park_ms(30);
    let pack = Arc::new(stage_pack(&format!("{name}-pack"), ROOM));
    state.bind("guest-pack-1", pack.clone());
    (state, pack)
}

fn assert_video_room(state: &PackState, reason: &str, check_reopen: bool, now: u64) {
    let settled = settle(&state.stage, state);
    let ours: Vec<_> = settled.iter().filter(|(id, _, _)| id == ROOM).collect();
    assert_eq!(ours.len(), 1, "exactly one fallback decided: {settled:?}");
    assert_eq!(ours[0].1, reason, "the reason code");
    assert_eq!(ours[0].2, vec!["guest-pack-1".to_string()], "the guest label is closed");
    let view = state.stage.view(ROOM);
    assert!(!view.three_d_active, "1. the video room is visible");
    assert_eq!(view.reason, Some(reason), "2. the reason line carries the code");
    let main_zumi_renderer_running = !view.three_d_active;
    assert!(main_zumi_renderer_running, "3. the main webview's Zumi renderer runs while the 3D room is not shown");
    assert!(state.pack_for("guest-pack-1").is_none(), "4. no 3D guest label is registered");
    if check_reopen {
        assert_eq!(state.stage.open(ROOM, now + 1), Err(reason), "4. and the guest is not reopened in this session");
        assert!(state.pack_for("guest-pack-1").is_none());
    }
}

fn run_bench(state: &PackState, pack: &LoadedPack, fps10: u32, p95x10: u32) -> u64 {
    // The bench starts at stage.ready; 1 s warm-up, 5 s measured, one stage.stats per second, judged by tick at +6 s.
    let h = &state.stage;
    h.open(ROOM, T0).unwrap();
    h.arm_bench(ROOM, "gpu-a|drv-1|0.3");
    assert_eq!(ready(h, pack, T0).0, 200);
    for sec in 1..=6u64 {
        let now = T0 + sec * 1000;
        assert_eq!(poll(h, pack, if sec == 1 { 0 } else { 1 }, now).0, 200); // seq 1 is the Low quality message
        assert_eq!(stats(h, pack, fps10, p95x10, now).0, 200);
        h.tick(now);
    }
    T0 + 6000
}

#[test]
fn a1_a_weak_machine_fails_the_bench_and_shows_the_video_room() {
    let (state, _data, pack) = bound_session("a1");
    assert_eq!(plan_open(Live3d::Auto, None, state.stage.remembered("gpu-a|drv-1|0.3")), OpenPlan::Bench, "first open: bench");
    let end = run_bench(&state, &pack, 90, 700); // a software renderer: 9 fps, 70 ms frames
    // 9.11 light: one bad launch is a strike (the number 1 on disk), not a lock: this launch shows the video room, the next one benches again.
    assert_eq!(state.stage.bench_memory_json(), json!({ "gpu-a|drv-1|0.3": 1 }), "one strike, per (adapter, driver, app minor)");
    assert_video_room(&state, "bench", true, end);
    assert_eq!(plan_open(Live3d::Auto, None, state.stage.remembered("gpu-a|drv-1|0.3")), OpenPlan::Bench, "one strike does not lock the room off");
}

#[test]
fn a1f_two_bad_launches_in_a_row_lock_the_room_off_and_test_again_unlocks() {
    let key = "gpu-a|drv-1|0.3";
    // launch 1: bad
    let (state, data, pack) = bound_session("a1f");
    let end = run_bench(&state, &pack, 90, 700);
    assert_video_room(&state, "bench", true, end);
    // launch 2 (a fresh hub on the same data folder): bad again -> locked
    let (second, pack2) = second_launch(&data, "a1f-2");
    assert_eq!(plan_open(Live3d::Auto, None, second.stage.remembered(key)), OpenPlan::Bench, "the strike carries over the restart, the bench runs");
    let end2 = run_bench(&second, &pack2, 90, 700);
    assert_video_room(&second, "bench", true, end2);
    assert_eq!(second.stage.bench_memory_json(), json!({ key: false }), "two bad launches in a row: locked (false on disk, the pre-9.11 format)");
    assert_eq!(plan_open(Live3d::Auto, None, second.stage.remembered(key)), OpenPlan::Video("bench"));
    // a locked room still comes back through "Test again"
    second.stage.forget_bench(key);
    assert_eq!(plan_open(Live3d::Auto, None, second.stage.remembered(key)), OpenPlan::Bench);
}

#[test]
fn a1g_a_good_launch_after_a_strike_clears_it() {
    let key = "gpu-a|drv-1|0.3";
    let (state, data, pack) = bound_session("a1g");
    let end = run_bench(&state, &pack, 90, 700); // launch 1: bad
    assert_video_room(&state, "bench", true, end);
    let (second, pack2) = second_launch(&data, "a1g-2");
    run_bench(&second, &pack2, 580, 168); // launch 2: good
    assert_eq!(second.stage.bench_memory_json(), json!({ key: true }), "the pass replaces the strike");
    assert!(second.stage.view(ROOM).three_d_active, "3D room shown");
    let (third, _pack3) = second_launch(&data, "a1g-3");
    assert_eq!(plan_open(Live3d::Auto, None, third.stage.remembered(key)), OpenPlan::Open, "the strike is gone: a pass skips the bench");
}

#[test]
fn a1c_control_a_strong_machine_passes_the_bench_and_keeps_the_3d_room() {
    let (state, _data, pack) = bound_session("a1c");
    run_bench(&state, &pack, 580, 168); // the spare's measured 56-60 fps
    assert_eq!(state.stage.remembered("gpu-a|drv-1|0.3"), Some(Remembered::Pass));
    assert!(state.stage.view(ROOM).three_d_active && state.stage.view(ROOM).reason.is_none(), "3D room shown, no reason line");
    assert!(settle(&state.stage, &state).is_empty());
    assert!(state.pack_for("guest-pack-1").is_some());
    assert_eq!(plan_open(Live3d::Auto, None, Some(Remembered::Pass)), OpenPlan::Open, "a remembered pass skips the bench");
}

/// One second of a bench run started by `open_bench_room`: a poll, one `stage.stats`, the watchdog tick.
fn bench_second(state: &PackState, pack: &LoadedPack, sec: u64, fps10: u32, p95x10: u32) {
    let (h, now) = (&state.stage, T0 + sec * 1000);
    assert_eq!(poll(h, pack, if sec == 1 { 0 } else { 1 }, now).0, 200, "second {sec}");
    assert_eq!(stats(h, pack, fps10, p95x10, now).0, 200, "second {sec}");
    h.tick(now);
}

fn open_bench_room(state: &PackState, pack: &LoadedPack) {
    state.stage.open(ROOM, T0).unwrap();
    state.stage.arm_bench(ROOM, "gpu-a|drv-1|0.3");
    assert_eq!(ready(&state.stage, pack, T0).0, 200);
}

#[test]
fn a1d_one_slow_second_in_the_bench_does_not_leave_the_version_on_the_video_room() {
    // alpha.9.2 on the owner's GTX 1660: the seated room sits at p95 33 ms of its 40 ms budget, and one 50 ms second failed the
    // bench (fps10 [600,561,590,502,393], one p95x10 500). B1 takes the best of 3 windows in the same launch.
    let (state, _data, pack) = bound_session("a1d");
    open_bench_room(&state, &pack);
    for (sec, (fps10, p95x10)) in (1..=6u64).zip([(600, 330), (561, 330), (590, 330), (502, 330), (393, 650), (580, 330)]) {
        bench_second(&state, &pack, sec, fps10, p95x10);
    }
    assert!(state.stage.view(ROOM).three_d_active, "a window failed by one slow second does not close the 3D room");
    assert_eq!(state.stage.remembered("gpu-a|drv-1|0.3"), None, "and nothing is remembered yet");
    for sec in 7..=12u64 {
        bench_second(&state, &pack, sec, 580, 330);
    }
    assert_eq!(state.stage.remembered("gpu-a|drv-1|0.3"), Some(Remembered::Pass), "the next window passes: 3D on the next start too");
    assert!(state.stage.view(ROOM).three_d_active && state.stage.view(ROOM).reason.is_none(), "3D room shown in this launch");
    assert!(settle(&state.stage, &state).is_empty(), "no fallback");
}

#[test]
fn a1e_a_machine_slow_in_all_three_bench_windows_still_falls_back() {
    // F1 holds: frames over 40 ms in every window (the median fps is fine, so R5 perf never fires) = the bench fails after window 3.
    let (state, _data, pack) = bound_session("a1e");
    open_bench_room(&state, &pack);
    for sec in 1..=17u64 {
        bench_second(&state, &pack, sec, 580, 650);
    }
    assert!(state.stage.view(ROOM).three_d_active, "windows 1 and 2 failed: still benching");
    assert_eq!(state.stage.remembered("gpu-a|drv-1|0.3"), None);
    bench_second(&state, &pack, 18, 580, 650);
    assert_eq!(state.stage.bench_memory_json(), json!({ "gpu-a|drv-1|0.3": 1 }), "all three windows slow = one bad launch = one strike (9.11 light)");
    assert_video_room(&state, "bench", true, T0 + 18_000);
}

#[test]
fn a2_an_engine_that_never_says_ready_falls_back_at_20_seconds() {
    let (state, _data, _pack) = bound_session("a2");
    state.stage.open(ROOM, T0).unwrap();
    state.stage.tick(T0 + 19_999);
    assert!(state.stage.view(ROOM).three_d_active, "not before the deadline");
    state.stage.tick(T0 + 20_000);
    assert_video_room(&state, "no_ready", true, T0 + 20_000);
}

#[test]
fn a3_a_dead_guest_falls_back_at_once() {
    let (state, _data, pack) = bound_session("a3");
    open_ready_state(&state, &pack);
    state.stage.report_guest_gone(ROOM);
    assert_video_room(&state, "guest_gone", true, T0 + 1);
}

fn open_ready_state(state: &PackState, pack: &LoadedPack) {
    state.stage.open(ROOM, T0).unwrap();
    assert_eq!(ready(&state.stage, pack, T0).0, 200);
}

#[test]
fn a4_a_guest_that_stops_polling_falls_back_at_30_seconds() {
    let (state, _data, pack) = bound_session("a4");
    open_ready_state(&state, &pack);
    assert_eq!(poll(&state.stage, &pack, 0, T0).0, 200);
    for sec in 1..30u64 {
        // stage.stats keeps coming and is healthy (a forged heartbeat), so only the poll cadence is wrong.
        assert_eq!(stats(&state.stage, &pack, 600, 168, T0 + sec * 1000).0, 200);
        state.stage.tick(T0 + sec * 1000);
        assert!(state.stage.view(ROOM).three_d_active, "still within 30 s at +{sec} s");
    }
    state.stage.tick(T0 + 30_000);
    assert_video_room(&state, "no_poll", true, T0 + 30_000);
}

#[test]
fn a5_a_contract_the_host_cannot_speak_falls_back() {
    let (state, _data, pack) = bound_session("a5");
    open_ready_state(&state, &pack);
    let (s, _) = call(&state.stage, &pack, "stage.poll", json!({ "v": { "min": 9, "max": 9 }, "ack": 0, "max": 16 }), T0 + 100);
    assert_eq!(s, 409);
    assert_video_room(&state, "contract", true, T0 + 100);
}

#[test]
fn a6_twenty_one_malformed_calls_in_ten_seconds_fall_back() {
    let (state, _data, pack) = bound_session("a6");
    open_ready_state(&state, &pack);
    let mut codes = Vec::new();
    for i in 0..21u64 {
        let (s, _) = call(&state.stage, &pack, "stage.stats", json!({ "fps10": 1, "frameP95x10": 1, "tier": 1, "gaps": 0, "bad": i }), T0 + 100 + i * 400);
        codes.push(s);
    }
    assert!(codes[..20].iter().all(|c| *c == 400), "{codes:?}");
    assert_eq!(codes[20], 403, "the 21st finds the channel closed");
    assert_video_room(&state, "violations", true, T0 + 9000);
    // 19 refusals in 10 s, then a quiet minute, then 19 more: never 20 within a window.
    let (state, _d, pack) = bound_session("a6b");
    open_ready_state(&state, &pack);
    for i in 0..38u64 {
        let gap = if i < 19 { i * 400 } else { 60_000 + (i - 19) * 400 };
        call(&state.stage, &pack, "stage.stats", json!({ "fps10": 1, "frameP95x10": 1, "tier": 1, "gaps": 0, "bad": i }), T0 + 100 + gap);
    }
    assert!(state.stage.view(ROOM).three_d_active, "the refusal window slides");
}

#[test]
fn a7_a_performance_collapse_falls_back_after_ten_seconds_below_20_fps() {
    let (state, _data, pack) = bound_session("a7");
    // Bench bypassed by a prior stored pass for the key.
    state.stage.load_bench_memory(&json!({ "gpu-a|drv-1|0.3": true }));
    assert_eq!(plan_open(Live3d::Auto, None, state.stage.remembered("gpu-a|drv-1|0.3")), OpenPlan::Open);
    open_ready_state(&state, &pack);
    for sec in 1..=10u64 {
        assert_eq!(poll(&state.stage, &pack, 0, T0 + sec * 1000 - 500).0, 200);
        assert_eq!(stats(&state.stage, &pack, 150, 500, T0 + sec * 1000).0, 200); // 15 fps, the run starts at +1 s
        assert!(state.stage.view(ROOM).three_d_active, "under 10 s of low fps is not yet the trigger (+{sec} s)");
    }
    assert_eq!(stats(&state.stage, &pack, 150, 500, T0 + 11_000).0, 200);
    assert_video_room(&state, "perf", true, T0 + 11_000);
    // Recovery resets the run: a healthy second in the middle means no fallback.
    let (state, _d, pack) = bound_session("a7b");
    open_ready_state(&state, &pack);
    for sec in 1..=30u64 {
        poll(&state.stage, &pack, 0, T0 + sec * 1000 - 500);
        let fps = if sec % 5 == 0 { 600 } else { 150 };
        assert_eq!(stats(&state.stage, &pack, fps, 168, T0 + sec * 1000).0, 200);
    }
    assert!(state.stage.view(ROOM).three_d_active, "a run broken by a healthy second does not count");
    // No stats for 10 s is the same trigger (advisory: the poll cadence stays authoritative for liveness).
    let (state, _d, pack) = bound_session("a7c");
    open_ready_state(&state, &pack);
    state.stage.tick(T0 + 9_999);
    assert!(state.stage.view(ROOM).three_d_active);
    state.stage.tick(T0 + 10_000);
    assert_video_room(&state, "perf", true, T0 + 10_000);
    let _ = pack;
}

#[test]
fn a8_override_off_shows_the_video_room_at_once_with_no_bench_and_no_guest() {
    let (state, _data, _pack) = bound_session("a8");
    state.stage.set_mode(Live3d::Off);
    assert_eq!(plan_open(Live3d::Off, None, Some(Remembered::Pass)), OpenPlan::Video("off"), "even after a remembered pass");
    assert_eq!(plan_open(Live3d::Off, None, None), OpenPlan::Video("off"), "and with no bench to run");
    assert_eq!(state.stage.open(ROOM, T0), Err("off"), "no guest session is opened");
    let view = state.stage.view(ROOM);
    assert!(!view.three_d_active, "the video room is visible");
    assert_eq!(state.stage.queue_stats(ROOM), (0, 0, 0));
    assert!(state.stage.take_fallbacks().is_empty(), "nothing to close: no guest was opened");
}

#[test]
fn a9_override_on_skips_the_bench_and_ignores_the_performance_triggers() {
    let (state, _data, pack) = bound_session("a9");
    state.stage.set_mode(Live3d::On);
    assert_eq!(plan_open(Live3d::On, None, Some(Remembered::Fell("bench"))), OpenPlan::Open, "a remembered bench failure is not applied under on");
    assert_eq!(plan_open(Live3d::On, None, None), OpenPlan::Open, "no bench under on");
    open_ready_state(&state, &pack);
    for sec in 1..=40u64 {
        poll(&state.stage, &pack, 0, T0 + sec * 1000 - 500);
        assert_eq!(stats(&state.stage, &pack, 90, 700, T0 + sec * 1000).0, 200); // software-renderer numbers
        state.stage.tick(T0 + sec * 1000);
    }
    assert!(state.stage.view(ROOM).three_d_active, "3D room shown despite low fps (R5 ignored)");
    assert!(settle(&state.stage, &state).is_empty(), "no fallback");
    // No stats at all for a long time is also performance, so it is ignored too (the polls keep the guest alive).
    let (state, _d, pack) = bound_session("a9b");
    state.stage.set_mode(Live3d::On);
    open_ready_state(&state, &pack);
    for sec in 1..=40u64 {
        poll(&state.stage, &pack, 0, T0 + sec * 1000 - 500);
        state.stage.tick(T0 + sec * 1000);
    }
    assert!(state.stage.view(ROOM).three_d_active);
}

#[test]
fn a10_the_override_does_not_hide_a_dead_or_misbehaving_guest() {
    for (name, kill) in [("a10-gone", 0), ("a10-ready", 1), ("a10-poll", 2), ("a10-contract", 3), ("a10-violations", 4)] {
        let (state, _data, pack) = bound_session(name);
        state.stage.set_mode(Live3d::On);
        state.stage.open(ROOM, T0).unwrap();
        let reason = match kill {
            0 => { ready(&state.stage, &pack, T0); state.stage.report_guest_gone(ROOM); "guest_gone" }
            1 => { state.stage.tick(T0 + 20_000); "no_ready" }
            2 => { ready(&state.stage, &pack, T0); for s in 1..=30u64 { stats(&state.stage, &pack, 600, 168, T0 + s * 1000); state.stage.tick(T0 + s * 1000); } "no_poll" }
            3 => { call(&state.stage, &pack, "stage.poll", json!({ "v": { "min": 9, "max": 9 }, "ack": 0, "max": 1 }), T0 + 10); "contract" }
            _ => { ready(&state.stage, &pack, T0); for i in 0..20u64 { call(&state.stage, &pack, "stage.stats", json!({ "x": i }), T0 + 100 + i * 100); } "violations" }
        };
        assert_video_room(&state, reason, false, T0 + 40_000);
    }
}

#[test]
fn a11_a_fallback_is_not_retried_in_the_session_and_only_a_bench_failure_is_remembered_across_starts() {
    // After a fallback the room tab stays on the video room for the rest of the session.
    let (state, _data, pack) = bound_session("a11");
    open_ready_state(&state, &pack);
    state.stage.report_guest_gone(ROOM);
    assert_video_room(&state, "guest_gone", true, T0 + 1);
    assert_eq!(plan_open(Live3d::Auto, state.stage.fallen_back(ROOM), None), OpenPlan::Video("guest_gone"));
    assert_eq!(state.stage.open(ROOM, T0 + 5), Err("guest_gone"), "reopening the tab does not retry");
    // The "try the 3D room anyway" switch is the one way back: it sets `on` for the session.
    state.stage.set_mode(Live3d::On);
    assert_eq!(state.stage.open(ROOM, T0 + 6), Ok(()));
    // A new app start (a fresh hub) with the stored memory: a bench failure is not re-benched; any other reason is.
    let fresh = StageHub::default();
    fresh.load_bench_memory(&json!({ "gpu-a|drv-1|0.3": false }));
    assert_eq!(plan_open(Live3d::Auto, fresh.fallen_back(ROOM), fresh.remembered("gpu-a|drv-1|0.3")), OpenPlan::Video("bench"));
    assert_eq!(plan_open(Live3d::Auto, fresh.fallen_back(ROOM), fresh.remembered("gpu-b|drv-1|0.3")), OpenPlan::Bench, "a different adapter benches again");
    assert_eq!(plan_open(Live3d::Auto, None, None), OpenPlan::Bench, "a perf or crash fallback left no memory: bench on the next start");
    // "Test again" forgets the stored failure.
    fresh.forget_bench("gpu-a|drv-1|0.3");
    assert_eq!(plan_open(Live3d::Auto, fresh.fallen_back(ROOM), fresh.remembered("gpu-a|drv-1|0.3")), OpenPlan::Bench);
    assert_eq!(fresh.bench_memory_json(), json!({}));
}

// ---------------------------------------------------------------------------------------------------------------------
// P1 merge, item 3: the renderer's producer call (`rpc stage.produce`) reaches the same producer API the director will use.
// Numbers and enums only; the room is found by the host (the open session), never named by the renderer.

#[test]
fn produce_status_follows_the_open_session_and_never_names_a_pack() {
    let (h, _data) = hub_with_log("produce-status");
    let p = stage_pack("produce-status-pack", ROOM);
    assert_eq!(h.produce("status", &json!({}), T0).unwrap(), json!({ "active": false }), "no 3D room open: not active, not an error");
    assert_eq!(h.produce("state", &json!({ "s": 2 }), T0).unwrap(), json!({ "active": false }), "a state op with no room is a quiet no-op, nothing queued");
    open_ready(&h, &p, T0);
    assert_eq!(h.produce("status", &json!({}), T0).unwrap(), json!({ "active": true }));
    h.report_guest_gone(ROOM);
    assert_eq!(h.produce("status", &json!({}), T0).unwrap(), json!({ "active": false }), "a fallen-back room is not active");
}

#[test]
fn produce_status_reports_the_test_hook_only_when_the_host_was_started_with_it() {
    let (h, _data) = hub_with_log("produce-hook");
    assert_eq!(h.produce("status", &json!({}), T0).unwrap(), json!({ "active": false }), "off: the answer has no testHook key at all");
    h.set_test_hook(true);
    assert_eq!(h.produce("status", &json!({}), T0).unwrap(), json!({ "active": false, "testHook": true }));
}

#[test]
fn produce_carries_schedule_cancel_gaze_state_as_the_plain_numbers_the_guest_receives() {
    let (h, _data) = hub_with_log("produce-ops");
    let p = stage_pack("produce-ops-pack", ROOM);
    open_ready(&h, &p, T0);
    let vis = vis_for(500);
    assert_eq!(h.produce("state", &json!({ "s": 3 }), T0).unwrap()["active"], true);
    assert!(h.produce("schedule", &json!({ "id": 7, "startAtEpochMs": T0 + 200, "durationMs": 500, "emotion": 1, "intensity": 80, "vis": vis }), T0).is_ok());
    assert!(h.produce("gaze", &json!({ "target": 3, "anchorIx": 1 }), T0).is_ok());
    assert!(h.produce("cancel", &json!({ "id": 7, "atEpochMs": T0 + 50 }), T0).is_ok());
    let (s, body) = poll(&h, &p, 0, T0 + 10);
    assert_eq!(s, 200);
    let m = msgs(&body);
    let types: Vec<u64> = m.iter().map(|x| x["t"].as_u64().unwrap()).collect();
    assert_eq!(types, vec![2, 0, 3, 1], "state, schedule, gaze, cancel, in order: {m:?}");
    assert_eq!(m[1]["id"], 7);
    assert_eq!(m[1]["durationMs"], 500);
    assert_eq!(m[1]["emotion"], 1);
    assert_eq!(m[1]["vis"].as_array().unwrap().len(), 5 * 15);
    assert_eq!(m[3]["id"], 7);
    assert!(m.iter().all(|x| x.as_object().unwrap().values().all(|v| !v.is_string())), "no string anywhere in what the guest receives");
}

#[test]
fn produce_is_closed_unknown_fields_text_and_out_of_range_values_are_refused() {
    let (h, _data) = hub_with_log("produce-closed");
    let p = stage_pack("produce-closed-pack", ROOM);
    open_ready(&h, &p, T0);
    let marker = "MARKER-reply-text-must-never-cross";
    let bad = [
        ("state", json!({ "s": 3, "caption": marker })),
        ("state", json!({ "s": 9 })),
        ("state", json!({ "s": marker })),
        ("schedule", json!({ "id": 1, "startAtEpochMs": T0 + 200, "durationMs": 100, "emotion": 1, "intensity": 50, "vis": vis_for(100), "text": marker })),
        ("schedule", json!({ "id": 1, "startAtEpochMs": T0 + 100, "durationMs": 100, "emotion": 1, "intensity": 50, "vis": vis_for(100) })), // under the 150 ms lead
        ("schedule", json!({ "id": 1, "startAtEpochMs": T0 + 200, "durationMs": 100, "emotion": 7, "intensity": 50, "vis": vis_for(100) })),
        ("cancel", json!({ "id": 1 })),
        ("gaze", json!({ "target": 3, "anchorIx": 99 })),
        ("nonsense", json!({})),
    ];
    for (op, payload) in bad {
        assert!(h.produce(op, &payload, T0).is_err(), "{op} {payload} must be refused");
    }
    let (_, body) = poll(&h, &p, 0, T0 + 5);
    assert!(msgs(&body).is_empty(), "nothing a refused call carried was queued: {body}");
    assert!(!body.to_string().contains(marker));
}

#[test]
fn produce_cancel_wakes_the_parked_poll_at_once_barge_in_does_not_wait_for_the_park_timeout() {
    let hub = std::sync::Arc::new(StageHub::default());
    hub.set_park_ms(5_000);
    let p = stage_pack("produce-wake-pack", ROOM);
    open_ready(&hub, &p, T0);
    let (h2, p2) = (hub.clone(), p.clone());
    let waiter = std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let r = poll(&h2, &p2, 0, T0 + 1);
        (r, started.elapsed())
    });
    while !hub.parked(ROOM) {
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    let queued = std::time::Instant::now();
    hub.produce("cancel", &json!({ "id": 3, "atEpochMs": T0 + 1 }), T0 + 1).unwrap();
    let ((s, body), _) = waiter.join().unwrap();
    assert_eq!(s, 200);
    assert_eq!(msgs(&body)[0]["t"], 1, "the cancel came back on the parked poll");
    assert!(queued.elapsed() < std::time::Duration::from_millis(250), "delivered within {:?}, not at the 5 s park timeout", queued.elapsed());
}

// ---------------------------------------------------------------------------------------------------------------------
// P1 merge, item 5 (F1 pieces the bridge left open): the GPU adapter key and a bench result that outlives the app session.

#[test]
fn the_bench_key_names_the_adapter_and_the_driver_not_just_the_app_minor() {
    assert_eq!(compose_bench_key("NVIDIA GeForce GTX 1660 SUPER", "31.0.15.3623", "0.3"), "nvidia geforce gtx 1660 super|31.0.15.3623|0.3");
    assert_eq!(compose_bench_key("Microsoft Basic Render Driver", "10.0.19041.1", "0.3"), "microsoft basic render driver|10.0.19041.1|0.3");
    assert_ne!(compose_bench_key("gpu-a", "1", "0.3"), compose_bench_key("gpu-a", "2", "0.3"), "a new driver version benches again");
    assert_ne!(compose_bench_key("gpu-a", "1", "0.3"), compose_bench_key("gpu-b", "1", "0.3"), "a different adapter benches again");
    assert_ne!(compose_bench_key("gpu-a", "1", "0.3"), compose_bench_key("gpu-a", "1", "0.4"), "a new app minor benches again");
    assert_eq!(compose_bench_key("a|b", "1\n2", "0.3"), "a b|1 2|0.3", "the separator and control characters cannot forge a key");
    assert_eq!(compose_bench_key("", "", "0.3"), "unknown|unknown|0.3", "an unreadable adapter is `unknown`, still a stable key");
    assert_eq!(compose_bench_key(&"x".repeat(200), "1", "0.3").split('|').next().unwrap().len(), 64, "the adapter part is capped");
    let live = bench_key();
    assert_eq!(live.split('|').count(), 3, "the live key has three parts: {live}");
    assert!(live.ends_with(&format!("|{}", env!("CARGO_PKG_VERSION"))), "the key carries the full app version: {live}");
    if cfg!(windows) && std::env::var_os("ZUMI_NO_GPU_EXPECTED").is_none() {
        assert!(!live.starts_with("unknown|"), "on Windows the display adapter is readable: {live}");
    }
}

#[test]
fn a_bench_result_survives_an_app_restart_and_test_again_forgets_it_on_disk() {
    let (state, data, pack) = bound_session("bench-persist");
    run_bench(&state, &pack, 90, 700); // fails: 9 fps (strike 1)
    let file = data.join("stage-bench.json");
    assert!(file.exists(), "the verdict is written to the data dir the moment it is decided");
    let text = std::fs::read_to_string(&file).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["gpu-a|drv-1|0.3"], 1, "{text}");
    assert!(v.as_object().unwrap().values().all(|x| x.is_boolean() || x == &json!(1)), "booleans and the strike number only, nothing a page sent");
    // a new app start: one strike benches again; the second bad launch locks and is remembered across the restart
    let fresh = StageHub::default();
    fresh.set_data_dir(Some(data.clone()));
    assert_eq!(plan_open(Live3d::Auto, None, fresh.remembered("gpu-a|drv-1|0.3")), OpenPlan::Bench, "one strike: benches again");
    let (second, pack2) = second_launch(&data, "bench-persist-2");
    run_bench(&second, &pack2, 90, 700);
    let v2: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(v2["gpu-a|drv-1|0.3"], false, "the second bad launch writes the lock");
    let fresh = StageHub::default();
    fresh.set_data_dir(Some(data.clone()));
    assert_eq!(fresh.remembered("gpu-a|drv-1|0.3"), Some(Remembered::Fell("bench")), "remembered across the restart");
    assert_eq!(plan_open(Live3d::Auto, None, fresh.remembered("gpu-a|drv-1|0.3")), OpenPlan::Video("bench"), "so the video room opens without benching again");
    assert_eq!(fresh.remembered("gpu-b|drv-1|0.3"), None, "another adapter is not remembered");
    // "Test again" removes it from the disk too
    fresh.forget_bench("gpu-a|drv-1|0.3");
    let again = StageHub::default();
    again.set_data_dir(Some(data.clone()));
    assert_eq!(again.remembered("gpu-a|drv-1|0.3"), None, "forgotten for good");
    // a damaged file is ignored, never fatal
    std::fs::write(&file, "{ not json").unwrap();
    let broken = StageHub::default();
    broken.set_data_dir(Some(data));
    assert_eq!(broken.remembered("gpu-a|drv-1|0.3"), None);
}

// ---------------------------------------------------------------------------------------------------------------------
// The owner's decision (13-11, ask-11130717): a weak PC falls back automatically, the first launch measures and decides, and there is a
// manual override. ADR A11, alpha.9.4:
// (a) only the start-up bench verdict persists per (GPU adapter, driver, app version); a runtime fallback is for this launch only, and the
//     next start tries 3D again;
// (b) the "Try 3D anyway" switch is one guarded attempt: F1 still applies (a dead guest is never hidden), the performance judgement does not.

const KEY_A: &str = "gpu-a|drv-1|0.3.5-alpha.6";

#[test]
fn f1_a_runtime_fallback_is_not_remembered_and_the_next_start_benches_again() {
    // CoS eb6abc98 (alpha.9.4) and ADR A11: only the bench verdict outlives the launch.
    let (state, data, _pack) = bound_session("f1-remember");
    state.stage.set_key(KEY_A);
    state.stage.open(ROOM, T0).unwrap();
    state.stage.tick(T0 + 20_000); // `stage.ready` never came: R1 no_ready, not a bench failure
    assert_video_room(&state, "no_ready", true, T0 + 20_001);
    assert_eq!(state.stage.remembered(KEY_A), None, "no_ready is not remembered");
    let text = std::fs::read_to_string(data.join("stage-bench.json")).unwrap_or_default();
    assert!(!text.contains(KEY_A), "{text}");
    // a new app start, same adapter and version: 3D is tried again (the bench runs)
    let fresh = StageHub::default();
    fresh.set_data_dir(Some(data.clone()));
    assert_eq!(plan_open(Live3d::Auto, fresh.fallen_back(ROOM), fresh.remembered(KEY_A)), OpenPlan::Bench);
}

#[test]
fn f1_no_runtime_fallback_reason_is_remembered() {
    let (_state, data, _pack) = bound_session("f1-reasons");
    for (i, reason) in ["guest_gone", "no_poll", "contract", "violations", "perf", "queue_full"].iter().enumerate() {
        let key = format!("gpu-r{i}|drv-1|0.3.5-alpha.6");
        let hub = StageHub::default();
        hub.set_park_ms(30);
        hub.set_data_dir(Some(data.clone()));
        hub.set_key(&key);
        hub.open(ROOM, T0).unwrap();
        let p = stage_pack(&format!("f1-r{i}"), ROOM);
        match *reason {
            "guest_gone" => hub.report_guest_gone(ROOM),
            "no_poll" => { ready(&hub, &p, T0); hub.tick(T0 + 30_000) }
            "contract" => {
                ready(&hub, &p, T0);
                call(&hub, &p, "stage.poll", json!({ "v": { "min": 9, "max": 9 }, "ack": 0, "max": 16 }), T0 + 1);
            }
            "violations" => {
                ready(&hub, &p, T0);
                for k in 0..20u64 {
                    call(&hub, &p, "stage.poll", json!({ "bogus": k }), T0 + 10 + k);
                }
            }
            "perf" => {
                ready(&hub, &p, T0);
                for s in 1..=12u64 {
                    stats(&hub, &p, 100, 200, T0 + s * 1000);
                    poll(&hub, &p, 0, T0 + s * 1000);
                    hub.tick(T0 + s * 1000);
                }
            }
            _ => {
                ready(&hub, &p, T0);
                for k in 0..200u32 {
                    let _ = hub.schedule(ROOM, k, T0 + 300 + (k as u64) * 200, 6000, 1, 50, &vec![50u8; 900], T0 + (k as u64) * 200);
                }
            }
        }
        assert_eq!(hub.fallen_back(ROOM), Some(*reason), "{reason} fell back");
        assert_eq!(hub.remembered(&key), None, "{reason} is not remembered");
    }
}

#[test]
fn f1_try_3d_anyway_is_one_guarded_attempt_a_dead_guest_is_never_hidden() {
    let (state, data, pack) = bound_session("f1-try");
    let h = &state.stage;
    h.set_key(KEY_A);
    h.load_bench_memory(&json!({ KEY_A: false })); // the bench failed on an earlier launch
    assert_eq!(plan_open(Live3d::Auto, None, h.remembered(KEY_A)), OpenPlan::Video("bench"));
    assert!(!h.take_try_anyway(), "nothing is armed yet");
    assert_eq!(h.produce("tryAnyway", &json!({}), T0).unwrap()["active"], false, "arming needs no open room");
    assert!(h.take_try_anyway(), "armed");
    assert!(!h.take_try_anyway(), "and consumed: one attempt, not a standing override");
    // the attempt: the saved bench failure is not applied, no bench, performance is not judged
    assert_eq!(h.open_forced(ROOM, T0), Ok(()));
    assert_eq!(ready(h, &pack, T0).0, 200);
    for sec in 1..=15u64 {
        let now = T0 + sec * 1000;
        let (code, _) = poll(h, &pack, 0, now);
        assert_eq!(code, 200, "sec {sec}: {}", log_text(&data));
        assert_eq!(stats(h, &pack, 50, 200, now).0, 200); // 5 fps
        h.tick(now);
    }
    assert!(h.view(ROOM).three_d_active, "R5 (performance) is not applied to a forced attempt");
    // but R1-R4 are: the guest stops polling and the host sees it itself (R3); `stats` cannot hide it
    h.tick(T0 + 15_000 + 31_000);
    assert_video_room(&state, "no_poll", true, T0 + 47_000);
    assert_eq!(h.remembered(KEY_A), Some(Remembered::Fell("bench")), "a failed attempt is a runtime fallback: the saved verdict stays");
    let text = std::fs::read_to_string(data.join("stage-bench.json")).unwrap_or_default();
    assert!(!text.contains("no_poll"), "{text}");
    // A11: no automatic retry in the session; only another explicit attempt gets one
    assert_eq!(h.open(ROOM, T0 + 50_000), Err("no_poll"));
    assert!(!h.take_try_anyway());
    h.produce("tryAnyway", &json!({}), T0 + 50_000).unwrap();
    assert!(h.take_try_anyway());
    assert_eq!(h.open_forced(ROOM, T0 + 50_001), Ok(()), "a second explicit attempt is allowed");
    // `off` still wins over the switch
    h.set_mode(Live3d::Off);
    assert_eq!(h.open_forced(ROOM, T0 + 60_000), Err("off"));
}

// ---------------------------------------------------------------------------------------------------------------------
// P1 merge fix round 2 (Opus gate): only a REAL F1 trigger may set the memory. A room closed or reloaded on purpose is not a dead guest.

#[test]
fn f2_a_clean_close_is_not_a_fallback_and_remembers_nothing() {
    let (state, data, pack) = bound_session("f2-close");
    let h = &state.stage;
    h.set_key(KEY_A);
    open_ready_state(&state, &pack);
    assert_eq!(poll(h, &pack, 0, T0 + 1000).0, 200);
    // the user picked a video room: the shell closes the guest on purpose
    h.end(ROOM);
    h.tick(T0 + 40_000); // long past the 30 s no-poll limit
    h.tick(T0 + 90_000);
    assert!(settle(h, &state).is_empty(), "nothing is decided for a guest that was closed on purpose");
    assert_eq!(h.remembered(KEY_A), None, "and nothing is remembered");
    assert!(!data.join("stage-bench.json").exists() || !std::fs::read_to_string(data.join("stage-bench.json")).unwrap().contains(KEY_A));
    assert!(!h.view(ROOM).three_d_active, "the room is simply not open");
    // opening again is a fresh open, not a retry after a fallback
    assert_eq!(h.open(ROOM, T0 + 100_000), Ok(()));
    assert_eq!(plan_open(Live3d::Auto, h.fallen_back(ROOM), h.remembered(KEY_A)), OpenPlan::Bench);
}

#[test]
fn f2_a_reload_is_a_new_document_not_a_dead_guest() {
    let (state, _data, pack) = bound_session("f2-reload");
    let h = &state.stage;
    h.set_key(KEY_A);
    open_ready_state(&state, &pack);
    h.state(ROOM, 1, T0).unwrap();
    assert_eq!(poll(h, &pack, 0, T0 + 500).0, 200);
    // F5 in the guest: the page reloads and announces itself again, its seq and ack start over
    assert_eq!(ready(h, &pack, T0 + 2000).0, 200, "a second stage.ready is a reload, not a refusal");
    assert_eq!(poll(h, &pack, 0, T0 + 2100).0, 200, "the new document polls with ack 0");
    // it keeps polling normally for a minute: no fallback, nothing remembered
    for sec in 3..=60u64 {
        assert_eq!(poll(h, &pack, 0, T0 + sec * 1000).0, 200);
        assert_eq!(stats(h, &pack, 600, 168, T0 + sec * 1000).0, 200);
        h.tick(T0 + sec * 1000);
    }
    assert!(h.view(ROOM).three_d_active);
    assert!(settle(h, &state).is_empty());
    assert_eq!(h.remembered(KEY_A), None);
    // a guest that really stops polling after the reload is still a dead guest (R3 applies to the new document)
    h.tick(T0 + 60_000 + 31_000);
    assert_video_room(&state, "no_poll", true, T0 + 91_001);
    assert_eq!(h.remembered(KEY_A), None, "for this launch only");
}

#[test]
fn f2_test_again_forgets_the_verdict_and_the_session_fallback_so_the_next_open_benches() {
    let (state, data, _pack) = bound_session("f2-again");
    let h = &state.stage;
    h.set_key(KEY_A);
    h.load_bench_memory(&json!({ KEY_A: false })); // a bench failure saved on an earlier launch
    h.open(ROOM, T0).unwrap();
    h.tick(T0 + 20_000); // no_ready
    assert_video_room(&state, "no_ready", true, T0 + 20_001);
    assert_eq!(h.remembered(KEY_A), Some(Remembered::Fell("bench")), "the runtime fallback does not replace the saved verdict");
    assert_eq!(h.open(ROOM, T0 + 21_000), Err("no_ready"));
    assert_eq!(h.produce("testAgain", &json!({}), T0 + 22_000).unwrap()["active"], false, "arming needs no open room");
    assert_eq!(h.remembered(bench_key().as_str()), None);
    // the key under test is KEY_A (set_key); testAgain forgets the key of this run
    assert_eq!(h.remembered(KEY_A), None, "the remembered verdict is gone");
    let text = std::fs::read_to_string(data.join("stage-bench.json")).unwrap_or_default();
    assert!(!text.contains(KEY_A), "and gone from the disk: {text}");
    assert_eq!(plan_open(Live3d::Auto, h.fallen_back(ROOM), h.remembered(KEY_A)), OpenPlan::Bench, "so the next open runs the bench again");
    assert_eq!(h.open(ROOM, T0 + 23_000), Ok(()), "the closed session no longer blocks a new open");
}

// ---------------------------------------------------------------------------------------------------------------------
// alpha.7 fix (GATE-OPUS-ALPHA7 should-fix 2): a repeated stage.ready is a reload of the DOCUMENT only. The guards of the
// session (R4 refusals, R5 low-fps run and stats clock, every rate bucket) carry over, and a re-ready is itself limited.

#[test]
fn r1_a_repeated_ready_keeps_the_poll_rate_bucket() {
    let (h, data) = hub_with_log("r1-bucket");
    let p = stage_pack("r1-bucket-pack", ROOM);
    open_ready(&h, &p, T0);
    let burst: Vec<u16> = (0..8).map(|i| poll(&h, &p, 0, T0 + 2000 + i).0).collect();
    assert!(burst.iter().all(|c| *c == 200), "{burst:?}");
    assert_eq!(ready(&h, &p, T0 + 2010).0, 200, "a reload 2 s after the first ready is allowed");
    let (code, body) = poll(&h, &p, 0, T0 + 2011);
    assert_eq!(code, 429, "the drained poll bucket survives the reload: {body}");
    assert!(log_text(&data).contains(&format!("stage_reload pack={ROOM}")));
}

#[test]
fn r2_a_repeated_ready_keeps_the_refusal_count() {
    let (state, _data, pack) = bound_session("r2-refusals");
    open_ready_state(&state, &pack);
    for i in 0..19u64 {
        let (c, _) = call(&state.stage, &pack, "stage.stats", json!({ "bad": i }), T0 + 100 + i * 10);
        assert_eq!(c, 400);
    }
    assert_eq!(ready(&state.stage, &pack, T0 + 2000).0, 200, "the reload itself is accepted");
    assert!(state.stage.view(ROOM).three_d_active);
    let (c, _) = call(&state.stage, &pack, "stage.stats", json!({ "bad": 99 }), T0 + 2100);
    assert_eq!(c, 400);
    assert_video_room(&state, "violations", true, T0 + 2100);
}

#[test]
fn r3_a_repeated_ready_keeps_the_low_fps_run() {
    let (state, _data, pack) = bound_session("r3-perf");
    state.stage.load_bench_memory(&json!({ "gpu-a|drv-1|0.3": true }));
    open_ready_state(&state, &pack);
    for sec in 1..=11u64 {
        if sec == 5 {
            assert_eq!(ready(&state.stage, &pack, T0 + 4600).0, 200, "a reload in the middle of the low-fps run");
        }
        assert_eq!(poll(&state.stage, &pack, 0, T0 + sec * 1000 - 300).0, 200);
        assert_eq!(stats(&state.stage, &pack, 150, 500, T0 + sec * 1000).0, 200);
    }
    assert_video_room(&state, "perf", true, T0 + 11_000);
}

#[test]
fn r4_a_repeated_ready_keeps_the_stats_clock() {
    let (state, _data, pack) = bound_session("r4-nostats");
    open_ready_state(&state, &pack);
    // no stats ever; a reload every 2 s must not move the 10 s no-stats deadline
    for k in 1..=4u64 {
        assert_eq!(poll(&state.stage, &pack, 0, T0 + k * 2000).0, 200);
        assert_eq!(ready(&state.stage, &pack, T0 + k * 2000).0, 200);
        state.stage.tick(T0 + k * 2000);
    }
    state.stage.tick(T0 + 10_000);
    assert_video_room(&state, "perf", true, T0 + 10_000);
}

#[test]
fn r5_a_ready_loop_is_refused_logged_and_counted() {
    let (state, data, pack) = bound_session("r5-loop");
    open_ready_state(&state, &pack);
    let (c, body) = ready(&state.stage, &pack, T0 + 500);
    assert_eq!(c, 429, "a second ready within 2 s is refused: {body}");
    assert_eq!(body["code"], "rate_limited");
    assert!(log_text(&data).contains(&format!("refused rate_limited pack={ROOM} method=stage.ready")));
    for i in 1..20u64 {
        ready(&state.stage, &pack, T0 + 500 + i * 50);
    }
    assert_video_room(&state, "violations", true, T0 + 1500);
}

// GATE-OPUS-ALPHA7-DELTA S2: every one of the 7 rate buckets carries over a re-ready (r1 pins rl_poll; this pins the other six). Each case
// drains one bucket at T, reloads at T (2 s after the first ready, so the reload is allowed), and the next call at T is still refused.
#[test]
fn r6_a_repeated_ready_keeps_every_rate_bucket() {
    const T: u64 = T0 + 2000;
    let rig = |name: &str| {
        let (h, _data) = hub_with_log(name);
        let p = stage_pack(&format!("{name}-pack"), ROOM);
        open_ready(&h, &p, T0);
        (h, p)
    };
    let sched = |h: &StageHub, id: u32| h.schedule(ROOM, id, T + 200, 100, 1, 50, &vis_for(100), T);
    // rl_stats (1 per second)
    let (h, p) = rig("r6-stats");
    assert_eq!(stats(&h, &p, 600, 168, T).0, 200);
    assert_eq!(ready(&h, &p, T).0, 200);
    assert_eq!(stats(&h, &p, 600, 168, T).0, 429, "rl_stats survives the reload");
    // out_schedule (burst 8)
    let (h, p) = rig("r6-sched");
    for i in 0..8 { assert_eq!(sched(&h, i), Ok(())); }
    assert_eq!(ready(&h, &p, T).0, 200);
    assert_eq!(sched(&h, 99), Err(ProduceError::RateLimited), "out_schedule survives the reload");
    // out_gaze (5)
    let (h, p) = rig("r6-gaze");
    for _ in 0..5 { assert_eq!(h.gaze(ROOM, 0, 0, T), Ok(())); }
    assert_eq!(ready(&h, &p, T).0, 200);
    assert_eq!(h.gaze(ROOM, 0, 0, T), Err(ProduceError::RateLimited), "out_gaze survives the reload");
    // out_state (4)
    let (h, p) = rig("r6-state");
    for _ in 0..4 { assert_eq!(h.state(ROOM, 1, T), Ok(())); }
    assert_eq!(ready(&h, &p, T).0, 200);
    assert_eq!(h.state(ROOM, 1, T), Err(ProduceError::RateLimited), "out_state survives the reload");
    // out_cancel (8)
    let (h, p) = rig("r6-cancel");
    for i in 0..8 { assert_eq!(h.cancel(ROOM, i, T, T), Ok(())); }
    assert_eq!(ready(&h, &p, T).0, 200);
    assert_eq!(h.cancel(ROOM, 99, T, T), Err(ProduceError::RateLimited), "out_cancel survives the reload");
    // out_all (20 in total): 8 schedule + 5 gaze + 4 state + 3 cancel drain it while the cancel bucket keeps 5
    let (h, p) = rig("r6-all");
    for i in 0..8 { assert_eq!(sched(&h, i), Ok(())); }
    for _ in 0..5 { assert_eq!(h.gaze(ROOM, 0, 0, T), Ok(())); }
    for _ in 0..4 { assert_eq!(h.state(ROOM, 1, T), Ok(())); }
    for i in 0..3 { assert_eq!(h.cancel(ROOM, i, T, T), Ok(())); }
    assert_eq!(h.cancel(ROOM, 50, T, T), Err(ProduceError::RateLimited), "the aggregate cap is reached before the reload");
    assert_eq!(ready(&h, &p, T).0, 200);
    assert_eq!(h.cancel(ROOM, 51, T, T), Err(ProduceError::RateLimited), "out_all survives the reload");
}

// ---------------------------------------------------------------------------------------------------------------------
// T-31 alpha.9.4 (CoS ruling 77581b74: Zumi never drops an utterance; late is acceptable). The wall clock steps by 1.5 s or 5 s,
// forward or back, against the monotonic clock while an utterance plays. The host sends no cancel, the playing utterance runs to
// its end, and every utterance queued behind it still goes out, moved by the step so it keeps its real time (unmoved, a forward
// step makes it stale and a backward one makes it early).

const CLOCK_STEPS: [i64; 4] = [1_500, -1_500, 5_000, -5_000];

fn stepped(t: u64, step: i64) -> u64 {
    t.saturating_add_signed(step)
}

fn ids_of_type(v: &Value, t: u64) -> Vec<u64> {
    msgs(v).iter().filter(|m| m["t"] == json!(t)).map(|m| m["id"].as_u64().unwrap()).collect()
}

#[test]
fn a_clock_step_cancels_nothing_and_every_queued_utterance_goes_out_on_its_moved_time() {
    for step in CLOCK_STEPS {
        let (h, data) = hub_with_log(&format!("clock-step-q{step}"));
        let p = stage_pack(&format!("clock-step-q-pack{step}"), ROOM);
        h.observe_clock(T0, 0);
        open_ready(&h, &p, T0);
        h.schedule(ROOM, 1, T0 + 200, 1000, 1, 60, &vis_for(1000), T0).unwrap();
        let (_, v) = poll(&h, &p, 0, T0 + 10);
        assert_eq!(ids_of_type(&v, 0), vec![1], "step {step}: u1 is out and plays from +200");
        // u2 and u3 follow u1 back to back and are still queued when the clock steps (no poll between)
        h.schedule(ROOM, 2, T0 + 1200, 1000, 1, 60, &vis_for(1000), T0 + 20).unwrap();
        h.schedule(ROOM, 3, T0 + 2200, 1000, 1, 60, &vis_for(1000), T0 + 20).unwrap();
        h.observe_clock(stepped(T0 + 30, step), 30);
        let now = stepped(T0 + 40, step);
        let (_, v) = poll(&h, &p, 1, now);
        assert!(ids_of_type(&v, 1).is_empty(), "step {step}: the host sends no cancel: {v}");
        let got: Vec<(u64, u64)> = msgs(&v).iter().filter(|m| m["t"] == json!(0)).map(|m| (m["id"].as_u64().unwrap(), m["startAtEpochMs"].as_u64().unwrap())).collect();
        assert_eq!(got, vec![(2, stepped(T0 + 1200, step)), (3, stepped(T0 + 2200, step))], "step {step}: u2 and u3 go out, moved by the step");
        // u1 runs to its end: the watchdog keeps the 3D room and no later answer cancels anything.
        h.tick(now);
        assert!(h.view(ROOM).three_d_active, "step {step}: the room stays live");
        let (_, v) = poll(&h, &p, 3, stepped(T0 + 3300, step));
        assert!(msgs(&v).is_empty(), "step {step}: nothing after the queue, no cancel: {v}");
        assert!(log_text(&data).contains(&format!("clock_step ms={step}")), "step {step}: the step is logged");
    }
}

#[test]
fn a_clock_step_during_a_parked_poll_delivers_what_the_producer_queues_after_it() {
    for step in CLOCK_STEPS {
        let (h, _) = hub_with_log(&format!("clock-step-park{step}"));
        let h = Arc::new(h);
        let p = stage_pack(&format!("clock-step-park-pack{step}"), ROOM);
        h.observe_clock(T0, 0);
        open_ready(&h, &p, T0);
        h.schedule(ROOM, 1, T0 + 200, 1000, 1, 60, &vis_for(1000), T0).unwrap();
        let (_, v) = poll(&h, &p, 0, T0 + 10);
        assert_eq!(ids_of_type(&v, 0), vec![1], "step {step}: u1 is out");
        h.set_park_ms(5_000);
        let (h2, p2) = (h.clone(), p.clone());
        let parked = std::thread::spawn(move || poll(&h2, &p2, 1, T0 + 20));
        while !h.parked(ROOM) {
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        h.observe_clock(stepped(T0 + 30, step), 30);
        let w = stepped(T0 + 40, step); // the producer reads the stepped wall clock
        h.schedule(ROOM, 2, w + 200, 1000, 1, 60, &vis_for(1000), w).unwrap();
        let (_, v) = parked.join().unwrap();
        assert!(ids_of_type(&v, 1).is_empty(), "step {step}: no cancel: {v}");
        assert_eq!(ids_of_type(&v, 0), vec![2], "step {step}: u2, queued after the step, comes back on the parked poll");
        let host_now = v["result"]["hostNowEpochMs"].as_u64().unwrap();
        assert!(host_now.abs_diff(w) < 1_000, "step {step}: the parked poll's clock follows the step ({host_now} vs {w})");
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// T-31 alpha.9.4 (CoS eb6abc98, ADR A11): only the start-up bench verdict outlives the launch. A RUNTIME fallback (watchdog, perf
// guard, a sleep or a forward clock step) closes the 3D room for this launch only; the next launch tries 3D again.

/// The bench passed on an earlier launch: `{KEY_A: true}` on disk, loaded by this launch.
fn bench_pass_on_disk(state: &PackState, data: &std::path::Path) {
    std::fs::write(data.join("stage-bench.json"), json!({ KEY_A: true }).to_string()).unwrap();
    state.stage.set_data_dir(Some(data.to_path_buf()));
    state.stage.set_key(KEY_A);
    assert_eq!(plan_open(Live3d::Auto, None, state.stage.remembered(KEY_A)), OpenPlan::Open);
}

/// The next app launch: a fresh hub on the same data folder.
fn next_launch(data: &std::path::Path) -> StageHub {
    let fresh = StageHub::default();
    fresh.set_data_dir(Some(data.to_path_buf()));
    fresh
}

#[test]
fn a_sleep_or_a_forward_step_of_10_s_or_more_falls_back_for_this_launch_only() {
    for (gap, reason) in [(10_000u64, "perf"), (30_000, "no_poll"), (8 * 3_600_000, "no_poll")] {
        let (state, data, pack) = bound_session(&format!("rt-sleep{gap}"));
        let h = &state.stage;
        bench_pass_on_disk(&state, &data);
        open_ready_state(&state, &pack);
        assert_eq!(poll(h, &pack, 0, T0 + 1000).0, 200);
        assert_eq!(stats(h, &pack, 600, 168, T0 + 1000).0, 200);
        h.tick(T0 + 1000);
        assert!(h.view(ROOM).three_d_active);
        // the PC sleeps (or the wall clock steps forward): the next watchdog tick comes `gap` later with nothing in between
        h.tick(T0 + 1000 + gap);
        assert_video_room(&state, reason, true, T0 + 1001 + gap);
        assert_eq!(h.remembered(KEY_A), Some(Remembered::Pass), "gap {gap}: the {reason} fallback is not saved over the bench pass");
        let next = next_launch(&data);
        assert_eq!(plan_open(Live3d::Auto, next.fallen_back(ROOM), next.remembered(KEY_A)), OpenPlan::Open, "gap {gap}: the next launch opens 3D");
    }
}

#[test]
fn a_perf_guard_fallback_is_for_this_launch_only() {
    let (state, data, pack) = bound_session("rt-perf");
    let h = &state.stage;
    bench_pass_on_disk(&state, &data);
    open_ready_state(&state, &pack);
    for sec in 1..=11u64 {
        assert_eq!(poll(h, &pack, 0, T0 + sec * 1000 - 500).0, 200);
        assert_eq!(stats(h, &pack, 150, 500, T0 + sec * 1000).0, 200); // 15 fps from +1 s: R5 fires after 10 s
    }
    assert_video_room(&state, "perf", true, T0 + 11_000);
    assert_eq!(h.remembered(KEY_A), Some(Remembered::Pass), "the perf fallback is not saved over the bench pass");
    let next = next_launch(&data);
    assert_eq!(plan_open(Live3d::Auto, next.fallen_back(ROOM), next.remembered(KEY_A)), OpenPlan::Open, "the next launch opens 3D");
}

#[test]
fn a_bench_that_fails_all_three_windows_is_still_saved_for_the_next_launch() {
    let (state, data, pack) = bound_session("rt-bench");
    open_bench_room(&state, &pack);
    for sec in 1..=18u64 {
        bench_second(&state, &pack, sec, 580, 650);
    }
    assert_video_room(&state, "bench", true, T0 + 18_000);
    let next = next_launch(&data);
    assert_eq!(next.bench_memory_json(), json!({ "gpu-a|drv-1|0.3": 1 }), "one bad launch is saved as one strike");
    assert_eq!(plan_open(Live3d::Auto, None, next.remembered("gpu-a|drv-1|0.3")), OpenPlan::Bench, "the next launch benches again, it does not lock");
}

#[test]
fn a_runtime_fallback_saved_by_an_older_build_is_not_applied() {
    let (_state, data, _pack) = bound_session("rt-old-file");
    std::fs::write(data.join("stage-bench.json"), json!({ KEY_A: "perf", "gpu-a|drv-1|0.3": false }).to_string()).unwrap();
    let next = next_launch(&data);
    assert_eq!(next.remembered(KEY_A), None, "a saved runtime reason is ignored");
    assert_eq!(plan_open(Live3d::Auto, None, next.remembered(KEY_A)), OpenPlan::Bench, "so 3D is tried again");
    assert_eq!(next.remembered("gpu-a|drv-1|0.3"), Some(Remembered::Fell("bench")), "a saved bench failure still holds");
}

// ---------------------------------------------------------------------------------------------------------------------
// 9.11 light round 2: the room brightness in EV, per room. The Settings slider saves settings.json `roomEv` { <pack id>: ev } (the sidecar); the 3D room guest
// (Zumi tab and Room tab are the same page) asks `GET /<id>/__zumi/light.json` and applies 2^ev to its exposure (and 2^-ev to the character's light).
// Rust reads settings.json itself, picks the entry of the label's own pack, and clamps.

fn get_light(state: &PackState, label: &str, url_id: &str) -> (u16, Value) {
    let req = tauri::http::Request::builder().method("GET").uri(format!("http://zumipack.localhost/{url_id}/__zumi/light.json")).body(Vec::new()).unwrap();
    let resp = handle_request(state, label, &req, &|| None, &mut |_| Ok(()));
    (resp.status().as_u16(), serde_json::from_slice(resp.body()).unwrap_or(Value::Null))
}

#[test]
fn light_json_serves_the_saved_room_ev_of_this_room_clamped_and_only_to_the_stage_pack() {
    let (state, data, _pack) = bound_session("light-json");
    let (s, v) = get_light(&state, "guest-pack-1", ROOM);
    assert_eq!((s, v["ev"].as_f64()), (200, Some(0.0)), "no settings.json: EV 0, no visual change");
    assert!(v.get("brightness").is_none(), "the first draft's key is gone");
    let set = |text: &str| std::fs::write(data.join("settings.json"), text).unwrap();
    let room = |ev: &str| format!(r#"{{"roomEv":{{"{ROOM}":{ev},"plugin.other-room":-0.9}},"other":1}}"#);
    for (text, want) in [
        (room("0.5"), 0.5),
        (room("-0.3"), -0.3),
        (room("9"), 1.0),
        (room("-9"), -1.0),
        (room("\"bright\""), 0.0),
        (room("null"), 0.0),
        (r#"{"roomEv":{"plugin.other-room":0.7}}"#.to_string(), 0.0),
        (r#"{"roomEv":"nope"}"#.to_string(), 0.0),
        (r#"{"roomBrightness":1.3}"#.to_string(), 0.0),
        ("{ not json".to_string(), 0.0),
    ] {
        set(&text);
        let (s, v) = get_light(&state, "guest-pack-1", ROOM);
        assert_eq!((s, v["ev"].as_f64()), (200, Some(want)), "{text}");
    }
    // a pack without the stage permission gets nothing from it
    let dir = write_pack("light-plain", "plugin.plain", 2, json!({ "avatar": "read", "net": [] }));
    let plain = Arc::new(load_pack_dir(&dir, Some("plugin.plain")).unwrap());
    state.bind("guest-pack-2", plain);
    assert_eq!(get_light(&state, "guest-pack-2", "plugin.plain").0, 404, "no stage permission: not served");
    // the request is decided from the label's own pack, never from the URL
    assert_eq!(get_light(&state, "guest-pack-1", "plugin.plain").0, 404);
}

// Integration 9.11 (GATE-OPUS-911-R3 section 3 item 3): Room 2 is the same stage pack opened with `?room=2`, so the pack id alone would give Room 1 and
// Room 2 one EV. Room 2's key is `<pack id>.room2` (no other stage pack exists: FIRST_PARTY_STAGE_IDS), Room 1 keeps the plain pack id (saved values stay).
fn get_light_q(state: &PackState, label: &str, url_id: &str, query: &str) -> (u16, Value) {
    let req = tauri::http::Request::builder().method("GET").uri(format!("http://zumipack.localhost/{url_id}/__zumi/light.json{query}")).body(Vec::new()).unwrap();
    let resp = handle_request(state, label, &req, &|| None, &mut |_| Ok(()));
    (resp.status().as_u16(), serde_json::from_slice(resp.body()).unwrap_or(Value::Null))
}

#[test]
fn light_json_gives_room_2_its_own_ev() {
    let (state, data, _pack) = bound_session("light-json-room2");
    let set = |text: &str| std::fs::write(data.join("settings.json"), text).unwrap();
    set(&format!(r#"{{"roomEv":{{"{ROOM}":0.5,"{ROOM}.room2":-0.75}}}}"#));
    assert_eq!(get_light_q(&state, "guest-pack-1", ROOM, "").1["ev"].as_f64(), Some(0.5), "Room 1: the pack id's own entry");
    assert_eq!(get_light_q(&state, "guest-pack-1", ROOM, "?room=2").1["ev"].as_f64(), Some(-0.75), "Room 2: the .room2 entry");
    set(&format!(r#"{{"roomEv":{{"{ROOM}":0.5}}}}"#));
    assert_eq!(get_light_q(&state, "guest-pack-1", ROOM, "?room=2").1["ev"].as_f64(), Some(0.0), "Room 2 with nothing saved: 0, never Room 1's value");
    assert_eq!(get_light_q(&state, "guest-pack-1", ROOM, "?room=3").1["ev"].as_f64(), Some(0.5), "any other query is Room 1");
    assert_eq!(get_light_q(&state, "guest-pack-1", ROOM, "?room=2&x=1").1["ev"].as_f64(), Some(0.5), "only the exact Room 2 query picks Room 2");
}

// ---------------------------------------------------------------------------------------------------------------------
// Contract v2 (T-31-ROOM motion P4): the `motion` message (t 6), an int program the guest decodes and validates again.

fn poll_v(h: &StageHub, p: &LoadedPack, ack: u64, max_v: u64, now: u64) -> (u16, Value) {
    call(h, p, "stage.poll", json!({ "v": { "min": 1, "max": max_v }, "ack": ack, "max": 16 }), now)
}

fn prog(n: usize) -> Vec<i16> {
    let mut p = vec![1i16, 1, 70, 2, 0, 0, 0, 0];
    p.resize(n, 0);
    p
}

#[test]
fn v2_motion_reaches_a_v2_guest_as_a_closed_integer_message() {
    let (h, _) = hub_with_log("v2m");
    let p = stage_pack("v2m-pack", ROOM);
    open_ready(&h, &p, T0);
    let (s, v) = poll_v(&h, &p, 0, 2, T0 + 10);
    assert_eq!((s, v["result"]["v"].as_u64()), (200, Some(2)), "the host speaks v2 with a v2 guest");
    h.motion(ROOM, 9, prog(40), T0 + 20).unwrap();
    let (s, v) = poll_v(&h, &p, 0, 2, T0 + 30);
    assert_eq!(s, 200);
    let m = msgs(&v);
    assert_eq!(m.len(), 1);
    assert_eq!(m[0]["t"], json!(6));
    assert_eq!(m[0]["id"], json!(9));
    assert_eq!(m[0]["prog"].as_array().unwrap().len(), 40);
    valid_poll_response(&v).unwrap();
    let mut bad = v.clone();
    bad["result"]["msgs"][0]["prog"][3] = json!("x");
    assert!(valid_poll_response(&bad).is_err(), "a string inside prog is not the contract");
    bad["result"]["msgs"][0]["prog"][3] = json!(40000);
    assert!(valid_poll_response(&bad).is_err(), "a value over i16 is not the contract");
}

#[test]
fn v2_motion_is_refused_for_a_v1_guest_and_for_a_bad_program() {
    let (h, _) = hub_with_log("v2m1");
    let p = stage_pack("v2m1-pack", ROOM);
    open_ready(&h, &p, T0);
    assert_eq!(poll(&h, &p, 0, T0 + 10).0, 200); // the v1 guest of poll_args
    assert_eq!(h.motion(ROOM, 1, prog(20), T0 + 20), Err(ProduceError::Invalid("version")));
    assert_eq!(poll_v(&h, &p, 0, 2, T0 + 30).0, 200);
    assert_eq!(h.motion(ROOM, 1, prog(7), T0 + 40), Err(ProduceError::Invalid("prog")), "shorter than the header");
    assert_eq!(h.motion(ROOM, 1, prog(641), T0 + 40), Err(ProduceError::Invalid("prog")), "over 640 ints");
    let mut wrong = prog(20);
    wrong[0] = 2;
    assert_eq!(h.motion(ROOM, 1, wrong, T0 + 40), Err(ProduceError::Invalid("prog")), "an unknown wire version");
    // the renderer's rpc: closed payload, the same refusals
    assert!(h.produce("motion", &json!({ "id": 1, "prog": prog(20), "caption": "hi" }), T0 + 50).is_err(), "unknown field");
    assert!(h.produce("motion", &json!({ "id": 1, "prog": [1, 2, "3", 4, 5, 6, 7, 8] }), T0 + 50).is_err(), "a string in prog");
    assert!(h.produce("motion", &json!({ "id": 1, "prog": [1, 0, 0, 0, 0, 0, 0, 40000] }), T0 + 50).is_err(), "over i16");
    assert_eq!(h.produce("motion", &json!({ "id": 1, "prog": prog(20) }), T0 + 50).unwrap()["active"], json!(true));
}

#[test]
fn v2_the_newest_motion_replaces_one_not_yet_delivered_and_the_rate_is_bounded() {
    let (h, _) = hub_with_log("v2m2");
    let p = stage_pack("v2m2-pack", ROOM);
    open_ready(&h, &p, T0);
    assert_eq!(poll_v(&h, &p, 0, 2, T0 + 10).0, 200);
    h.motion(ROOM, 1, prog(20), T0 + 20).unwrap();
    h.motion(ROOM, 2, prog(20), T0 + 20).unwrap();
    let (_, v) = poll_v(&h, &p, 0, 2, T0 + 30);
    let ids: Vec<u64> = msgs(&v).iter().map(|m| m["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, vec![2], "only the newest pending motion is delivered");
    let sent = (0..20).filter(|i| h.motion(ROOM, 10 + i, prog(20), T0 + 2000).is_ok()).count();
    assert_eq!(sent, 4, "burst 4, then rate limited");
}
