//! `zumi-hands`: the hands helper (T-31-MAUS). P0 verbs read UI Automation trees; P1 verbs act only on windows of processes it launched, behind rails (act.rs, rails.rs).
//!
//!   zumi-hands serve                              stdio line JSON (see proto.rs), one response line per request line
//!   zumi-hands ping
//!   zumi-hands windows  --pid P                   visible top-level windows of process P
//!   zumi-hands snapshot --pid P [--hwnd H] [--timeout-ms T] [--mode full|staged|watch|cached] [--raw true]
//!     watch: full read, then UIA events keep a cached copy (serve mode); cached: read that copy (no UIA call)
//!     result: window, ms (pick + walk + prune), phases_ms (that total split), nodes (control-view size), elements (pruned, stable ids),
//!     text (one line per element: what a model reads), tokens (estimate of text), tree (only with raw)
//!
//!   P1 (act.rs; refused unless armed, own pid, owned window, foreground for typing):
//!   arm --deadman-ms N --audit F [--policy F] [--capture-root D] | disarm | status | kill | freshness --hwnd H
//!   pack_warning --pack P (opt-in packs: explorer). Acceptance is not a stdio verb and not a CLI verb: only the host's
//!   native warning dialog records it (P3 HB-2); arm then reads the record
//!   launch --exe E [--args [..]] (arguments only as the policy's rule for E allows) | focus --pid P --hwnd H
//!   act --pid P --hwnd H --el E --do set_value|invoke|toggle|expand|collapse [--value V]
//!   type --pid P --hwnd H --text T [--el E] | key --pid P --hwnd H --chord C
//!   capture --pid P --hwnd H --out F.bmp [--screen true]
//!   pointer --pid P --hwnd H --do click|drag --x X --y Y [--x2 X --y2 Y]   (R5 pixel fallback: thousandths of the window, left button,
//!     only where the policy lists the Pointer control type and the place holds no named control)
//!
//! The one-shot CLI form turns `verb --name value ...` into one request and prints one response line.
//! The helper links no network crate and opens no socket.
#[cfg(windows)]
mod act;
mod proto;
mod rails;
mod hands_policy;
#[cfg(windows)]
mod hands_overlay;
#[cfg(windows)]
mod kill;
mod prune;
mod tree;
#[cfg(windows)]
mod uia;
#[cfg(windows)]
mod watch;

use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};
use std::process::ExitCode;
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_MS: u64 = 5000;

fn dispatch(cmd: &str, args: &Map<String, Value>) -> proto::VerbResult {
    match cmd {
        "ping" => Ok(json!("pong")),
        "windows" => {
            let pid = need_pid(args)?;
            Ok(json!(uia::windows_of(pid).iter().map(window_json).collect::<Vec<_>>()))
        }
        "snapshot" => snapshot(args),
        // P1 acting verbs (act.rs): every one passes the rails first.
        // Every acting verb's decision (allowed or refused) is one audit line (act::audited).
        "arm" => act::audited("arm", None, None, || act::arm(
            proto::arg_u64(args, "deadman-ms").ok_or(("bad_args", "deadman-ms is required".to_string()))?,
            args.get("capture-root").and_then(Value::as_str).map(std::path::PathBuf::from),
            args.get("policy").and_then(Value::as_str).map(std::path::Path::new),
            args.get("audit").and_then(Value::as_str).map(std::path::Path::new),
        )),
        "disarm" => act::audited("disarm", None, None, || Ok(act::disarm())),
        "status" => Ok(act::status()),
        "kill" => Ok(act::kill_now()), // kill() writes its own audit line (verb, hotkey form, time)
        "freshness" => Ok(act::freshness(need_hwnd(args)?)),
        // Opt-in packs (CoS E1): the warning to show, and the recorded acceptance (an audit line).
        "pack_warning" => act::pack_warning(need_str(args, "pack")?),
        // Not a stdio verb (review R4 E3): whoever drives the hands must not be able to accept a risk for the person.
        "accept_pack" => act::audited("accept_pack", None, None, || Err(("not_on_stdio", "a pack is accepted only through the host's warning dialog, clicked by a person".into()))),
        "launch" => act::audited("launch", None, None, || {
            let extra: Vec<String> = args.get("args").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
            act::launch(need_str(args, "exe")?, &extra)
        }),
        "focus" => act::audited("focus", pid_of(args), hwnd_of(args), || act::focus(need_pid(args)?, need_hwnd(args)?)),
        "act" => act::audited("act", pid_of(args), hwnd_of(args), || act::pattern(need_pid(args)?, need_hwnd(args)?, need_str(args, "el")?, need_str(args, "do")?, args.get("value").and_then(Value::as_str))),
        "type" => act::audited("type", pid_of(args), hwnd_of(args), || act::type_text(need_pid(args)?, need_hwnd(args)?, need_str(args, "text")?, args.get("el").and_then(Value::as_str))),
        "key" => act::audited("key", pid_of(args), hwnd_of(args), || act::key_chord(need_pid(args)?, need_hwnd(args)?, need_str(args, "chord")?)),
        "pointer" => act::audited("pointer", pid_of(args), hwnd_of(args), || {
            let coord = |k: &str| proto::arg_u64(args, k).and_then(|n| i64::try_from(n).ok());
            let a = (coord("x").ok_or(("bad_args", "x (0 to 1000) is required".to_string()))?, coord("y").ok_or(("bad_args", "y (0 to 1000) is required".to_string()))?);
            let b = match (args.contains_key("x2"), args.contains_key("y2")) {
                (false, false) => None,
                (true, true) => Some((coord("x2").ok_or(("bad_args", "x2 must be 0 to 1000".to_string()))?, coord("y2").ok_or(("bad_args", "y2 must be 0 to 1000".to_string()))?)),
                _ => return Err(("bad_args", "x2 and y2 go together".to_string())),
            };
            act::pointer(need_pid(args)?, need_hwnd(args)?, need_str(args, "do")?, a, b)
        }),
        "capture" => act::audited("capture", pid_of(args), hwnd_of(args), || act::capture(need_pid(args)?, need_hwnd(args)?, std::path::Path::new(need_str(args, "out")?), args.get("screen").is_some_and(|v| v == &json!(true) || v == &json!("true")))),
        _ => Err(("unknown_cmd", format!("unknown cmd {cmd:?}"))),
    }
}

fn need_pid(args: &Map<String, Value>) -> Result<u32, (&'static str, String)> {
    proto::arg_u64(args, "pid")
        .and_then(|p| u32::try_from(p).ok())
        .ok_or(("bad_args", "pid (a process id) is required".into()))
}

fn pid_of(args: &Map<String, Value>) -> Option<u32> {
    proto::arg_u64(args, "pid").and_then(|p| u32::try_from(p).ok())
}

fn hwnd_of(args: &Map<String, Value>) -> Option<u64> {
    proto::arg_u64(args, "hwnd")
}

fn need_hwnd(args: &Map<String, Value>) -> Result<u64, (&'static str, String)> {
    proto::arg_u64(args, "hwnd").ok_or(("bad_args", "hwnd is required".into()))
}

fn need_str<'a>(args: &'a Map<String, Value>, name: &str) -> Result<&'a str, (&'static str, String)> {
    args.get(name).and_then(Value::as_str).ok_or(("bad_args", format!("{name} (a string) is required")))
}

fn window_json(w: &uia::WindowInfo) -> Value {
    json!({ "hwnd": format!("0x{:X}", w.hwnd), "pid": w.pid, "title": w.title, "class": w.class_name, "rect": w.rect })
}

fn snapshot(args: &Map<String, Value>) -> proto::VerbResult {
    let t0 = Instant::now();
    let pid = need_pid(args)?;
    let win = uia::pick_window(pid, proto::arg_u64(args, "hwnd"))?;
    let pick_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let timeout = Duration::from_millis(proto::arg_u64(args, "timeout-ms").unwrap_or(DEFAULT_TIMEOUT_MS));
    let mode_name = args.get("mode").and_then(Value::as_str).unwrap_or("full");
    let mut cache = Value::Null;
    let (root, walk) = match mode_name {
        "full" => uia::snapshot_tree(win.hwnd, uia::Mode::Full, timeout)?,
        "staged" => uia::snapshot_tree(win.hwnd, uia::Mode::Staged, timeout)?,
        "watch" => uia::snapshot_tree(win.hwnd, uia::Mode::Watch, timeout)?,
        "cached" => {
            let w = watch::get(win.hwnd).ok_or(("not_watched", "no watch on this window: send mode watch first".to_string()))?;
            let (tree, st, age) = w.read();
            cache = json!({
                "structure_events": st.structure_events, "property_events": st.property_events, "applied": st.applied,
                "walked_up": st.walked_up, "full_rereads": st.full_rereads, "removed": st.removed,
                "ignored_property": st.ignored_property, "errors": st.errors,
                "apply_ms_max": (st.apply_ms_max * 10.0).round() / 10.0,
                "flushes": st.flushes, "flush_ms_max": (st.flush_ms_max * 10.0).round() / 10.0,
                "window_rereads": st.window_rereads, "reconciles": st.reconciles, "self_events": st.self_events, "followups": st.followups, "shrink_rejected": st.shrink_rejected, "pending": st.pending_at_snapshot,
                "last_event_ms_ago": age.map(|a| a.round()),
            });
            (tree, uia::WalkTimes::default())
        }
        other => return Err(("bad_args", format!("mode must be full, staged, watch or cached, not {other:?}"))),
    };
    let t_prune = Instant::now();
    let elements = prune::prune(&root);
    let text = prune::render(&elements);
    let prune_ms = t_prune.elapsed().as_secs_f64() * 1000.0;
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    let r1 = |x: f64| (x * 10.0).round() / 10.0;
    let mut r = json!({
        "window": window_json(&win),
        "ms": r1(ms),
        "mode": mode_name,
        "cache": cache,
        "new_client": walk.new_client,
        "expansions": walk.expansions,
        "branches_ms": walk.branches.iter().map(|(b, t)| json!([b, r1(*t)])).collect::<Vec<_>>(),
        "phases_ms": { "pick": r1(pick_ms), "setup": r1(walk.setup), "build": r1(walk.build), "expand": r1(walk.expand),
                       "read": r1(walk.read), "prune": r1(prune_ms) },
        "nodes": root.count(),
        "tokens": prune::token_estimate(&text),
        "elements": elements.iter().map(prune::Element::to_json).collect::<Vec<_>>(),
        "text": text,
    });
    if args.get("raw").is_some_and(|v| v == &json!(true) || v == &json!("true")) {
        r["tree"] = root.to_json();
    }
    Ok(r)
}

fn serve() -> ExitCode {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let resp = proto::handle_line(&line, &mut dispatch);
        if writeln!(out, "{resp}").and_then(|_| out.flush()).is_err() {
            break; // the parent closed our stdout: nothing left to answer
        }
    }
    #[cfg(windows)]
    watch::stop_all();
    ExitCode::SUCCESS
}

/// `accept-pack` is retired (P3 HB-2). A console proves a console, not a person: a bench script typed the words. A pack is
/// accepted only through the host's own native warning dialog (zumi-agent-loop `dialog.rs`), which writes the
/// record next to the policy file that `arm` reads. Nothing is written here.
fn accept_pack_retired() -> Value {
    json!({ "ok": false, "error": "use_host_dialog", "detail": "accept-pack is retired: a pack is accepted only through the host's warning dialog, clicked by a person" })
}

fn main() -> ExitCode {
    // Our stdio pipes (to the host or loop bin) must not be inherited by the app we launch (zumi-audit inherit.rs).
    zumi_audit::inherit::private_std_handles();
    // Read (and drop from the environment) the host's acceptance key before anything can start a child.
    let _ = hands_policy::host_key();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match argv.first().map(String::as_str) {
        Some("serve") => serve(),
        Some("accept-pack") => {
            println!("{}", accept_pack_retired());
            ExitCode::from(1)
        }
        Some(verb) => {
            let mut req = Map::new();
            req.insert("cmd".into(), json!(verb));
            let mut it = argv[1..].iter();
            while let Some(k) = it.next() {
                let Some(name) = k.strip_prefix("--") else {
                    eprintln!("bad argument {k:?}");
                    return ExitCode::from(2);
                };
                let v = it.next().cloned().unwrap_or_else(|| "true".into());
                req.insert(name.to_string(), json!(v));
            }
            let resp = proto::handle_line(&Value::Object(req).to_string(), &mut dispatch);
            let ok = resp["ok"] == json!(true);
            println!("{resp}");
            if ok { ExitCode::SUCCESS } else { ExitCode::from(1) }
        }
        None => {
            eprintln!("usage: zumi-hands serve | ping | windows --pid P | snapshot --pid P [--hwnd H] [--timeout-ms T] [--mode full|staged|watch|cached] [--raw true]");
            ExitCode::from(2)
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// Review R4 E3, bite: the acceptance is not a stdio verb. The request is refused (and, when armed, logged as a
    /// refusal by act::audited).
    #[test]
    fn accept_pack_is_not_a_stdio_verb() {
        let args = serde_json::json!({ "pack": "explorer", "warning-fnv": "x", "policy-version": "y" });
        let r = dispatch("accept_pack", args.as_object().unwrap());
        assert_eq!(r.unwrap_err().0, "not_on_stdio");
    }

    /// P3 HB-2, bite: the console route is gone. The CLI verb answers `use_host_dialog` and writes nothing.
    #[test]
    fn the_accept_pack_cli_is_retired() {
        let r = accept_pack_retired();
        assert_eq!((r["ok"].clone(), r["error"].as_str()), (json!(false), Some("use_host_dialog")));
    }
}
