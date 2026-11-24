//! The rpc surface the host exposes to the renderer: `routines.list`, `routines.add`, `routines.delete`, `routines.history`.
//! `handle(method, args)` is the one entry; business errors are `{ok:false, error:<code>}`, never a panic and never a
//! partial write. A method name that is not one of the four is an `Err`, so the host can refuse it.
use crate::clock::due_ms;
use crate::runner::Routines;
use crate::store::{Reminder, Repeat, Rule, StoreError, LAST_DAY};
use serde_json::{json, Value};

pub const METHODS: [&str; 4] = ["routines.list", "routines.add", "routines.delete", "routines.history"];

const HISTORY_DEFAULT_LIMIT: u64 = 50;
const HISTORY_MAX_LIMIT: u64 = 200;

fn fail(code: &str) -> Value {
    json!({ "ok": false, "error": code })
}

/// A row as the renderer sees it. The fields a kind does not use are left out.
fn item_json(r: &Reminder, next: Option<i64>) -> Value {
    let mut v = json!({ "id": r.id, "text": r.text, "time": r.time, "repeat": r.repeat.as_str(), "done": r.done, "nextMs": next });
    let o = v.as_object_mut().expect("an object");
    if let Some(d) = r.rule.day {
        o.insert("day".into(), if d == LAST_DAY { json!("last") } else { json!(d) });
    }
    if let Some(m) = r.rule.month { o.insert("month".into(), json!(m)); }
    if let Some(e) = r.rule.every_min { o.insert("everyMin".into(), json!(e)); }
    if let Some(w) = &r.rule.weekdays { o.insert("weekdays".into(), json!(w)); }
    if let Some((a, b)) = &r.rule.window { o.insert("window".into(), json!({ "start": a, "end": b })); }
    if let Some(e) = r.rule.ends_ms { o.insert("endsMs".into(), json!(e)); }
    v
}

/// The rule fields of a form for its repeat kind. Any field that does not belong to the kind, or is out of shape, is `bad_rule`: a
/// form is never quietly read as a different schedule. Range checks (31st, Feb 30, 5..1440 minutes) are the store's.
fn rule_of(repeat: Repeat, form: &serde_json::Map<String, Value>) -> Result<Rule, ()> {
    let present = |k: &str| form.get(k).is_some_and(|v| !v.is_null());
    let uint = |k: &str| -> Result<Option<u32>, ()> {
        match form.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => v.as_u64().and_then(|n| u32::try_from(n).ok()).map(Some).ok_or(()),
        }
    };
    let own: &[&str] = match repeat {
        Repeat::None | Repeat::Daily => &[],
        Repeat::Monthly => &["day"],
        Repeat::Yearly => &["month", "day"],
        Repeat::Interval => &["everyMin", "weekdays", "window", "endsMs"],
    };
    if ["day", "month", "everyMin", "weekdays", "window", "endsMs"].iter().any(|k| present(k) && !own.contains(k)) {
        return Err(());
    }
    let mut rule = Rule::default();
    match repeat {
        Repeat::None | Repeat::Daily => {}
        Repeat::Monthly | Repeat::Yearly => {
            rule.day = match form.get("day") {
                Some(Value::String(s)) if repeat == Repeat::Monthly && s == "last" => Some(LAST_DAY),
                // 0 is the stored word for "last day"; a form must say "last", not 0.
                _ => match uint("day")? {
                    Some(0) | None => return Err(()),
                    d => d,
                },
            };
            if repeat == Repeat::Yearly {
                rule.month = uint("month")?;
            }
        }
        Repeat::Interval => {
            rule.every_min = uint("everyMin")?;
            if let Some(w) = form.get("weekdays").filter(|v| !v.is_null()) {
                rule.weekdays = Some(w.as_array().ok_or(())?.iter().map(|d| d.as_u64().and_then(|d| u32::try_from(d).ok()).ok_or(())).collect::<Result<Vec<u32>, ()>>()?);
            }
            if let Some(w) = form.get("window").filter(|v| !v.is_null()) {
                let o = w.as_object().ok_or(())?;
                rule.window = Some((o.get("start").and_then(Value::as_str).ok_or(())?.to_string(), o.get("end").and_then(Value::as_str).ok_or(())?.to_string()));
            }
            if let Some(e) = form.get("endsMs").filter(|v| !v.is_null()) {
                rule.ends_ms = Some(e.as_i64().ok_or(())?);
            }
        }
    }
    Ok(rule)
}

impl Routines {
    pub fn handle(&self, method: &str, args: &[Value]) -> Result<Value, String> {
        let inner = &self.inner;
        let now = (inner.now)();
        match method {
            "routines.list" => {
                let e = inner.engine.lock().unwrap_or_else(|p| p.into_inner());
                let mut items: Vec<(Option<i64>, Value)> = e
                    .store()
                    .list()
                    .iter()
                    .map(|r| {
                        let next = due_ms(inner.tz.as_ref(), r, now);
                        (next, item_json(r, next))
                    })
                    .collect();
                // Soonest first; finished one-shots (no next fire) last.
                items.sort_by_key(|(next, _)| next.unwrap_or(i64::MAX));
                Ok(json!({ "ok": true, "items": items.into_iter().map(|(_, v)| v).collect::<Vec<_>>() }))
            }
            "routines.add" => {
                let Some(form) = args.first().and_then(Value::as_object) else { return Ok(fail("bad_args")) };
                let (Some(text), Some(time)) = (form.get("text").and_then(Value::as_str), form.get("time").and_then(Value::as_str)) else {
                    return Ok(fail("bad_args"));
                };
                let Some(repeat) = form.get("repeat").and_then(Value::as_str).and_then(Repeat::parse) else { return Ok(fail("bad_repeat")) };
                let Ok(rule) = rule_of(repeat, form) else { return Ok(fail("bad_rule")) };
                // Any other field in the form (a `tool`, say) is ignored: a reminder made here always speaks.
                let mut e = inner.engine.lock().unwrap_or_else(|p| p.into_inner());
                match e.add_with_rule(text, time, repeat, rule, now, inner.tz.as_ref()) {
                    Ok(r) => {
                        let next = due_ms(inner.tz.as_ref(), &r, now);
                        Ok(json!({ "ok": true, "item": item_json(&r, next) }))
                    }
                    Err(err) => Ok(fail(&err.code())),
                }
            }
            "routines.delete" => {
                let Some(id) = args.first().and_then(Value::as_str) else { return Ok(fail("bad_args")) };
                let mut e = inner.engine.lock().unwrap_or_else(|p| p.into_inner());
                match e.delete(id) {
                    Ok(()) => Ok(json!({ "ok": true })),
                    Err(StoreError::NotFound) => Ok(fail("not_found")),
                    Err(err) => Ok(fail(&err.code())),
                }
            }
            "routines.history" => {
                // args[0] is optional: { id?: string, limit?: 1..=200 }
                let (mut id, mut limit) = (None, HISTORY_DEFAULT_LIMIT);
                // The generated shim sends `[null]` when the caller passes nothing.
                if let Some(a) = args.first().filter(|a| !a.is_null()) {
                    let Some(o) = a.as_object() else { return Ok(fail("bad_args")) };
                    match o.get("id") {
                        None | Some(Value::Null) => {}
                        Some(Value::String(s)) => id = Some(s.as_str()),
                        Some(_) => return Ok(fail("bad_args")),
                    }
                    match o.get("limit") {
                        None | Some(Value::Null) => {}
                        Some(v) => match v.as_u64() {
                            Some(n) if (1..=HISTORY_MAX_LIMIT).contains(&n) => limit = n,
                            _ => return Ok(fail("bad_args")),
                        },
                    }
                }
                let e = inner.engine.lock().unwrap_or_else(|p| p.into_inner());
                let items: Vec<Value> = e
                    .history()
                    .list(id, limit as usize)
                    .iter()
                    .map(|h| json!({ "atMs": h.at_ms, "id": h.id, "text": h.text, "scheduledMs": h.scheduled_ms, "status": h.status.as_str(), "missed": h.missed }))
                    .collect();
                Ok(json!({ "ok": true, "items": items }))
            }
            _ => Err(format!("unknown_method:{method}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::tests::{hcm, lt, quiet_off};
    use crate::runner::tests::bench;
    use std::time::Duration;

    #[test]
    fn add_list_delete_round_trip_with_the_form_fields() {
        let b = bench("api1", hcm(14, 0, 0), quiet_off(), Duration::from_secs(30));
        let r = &b.routines;
        let added = r.handle("routines.add", &[json!({"text": "drink water", "time": "15:00", "repeat": "daily"})]).unwrap();
        assert_eq!(added["ok"], true);
        assert_eq!(added["item"]["nextMs"], hcm(15, 0, 0));
        let id = added["item"]["id"].as_str().unwrap().to_string();
        r.handle("routines.add", &[json!({"text": "call mum", "time": "14:30", "repeat": "none"})]).unwrap();
        let list = r.handle("routines.list", &[]).unwrap();
        let items = list["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["text"], "call mum", "soonest first");
        assert_eq!(items[1]["id"], id.as_str());
        assert_eq!(r.handle("routines.delete", &[json!(id)]).unwrap()["ok"], true);
        assert_eq!(r.handle("routines.list", &[]).unwrap()["items"].as_array().unwrap().len(), 1);
        assert_eq!(r.handle("routines.delete", &[json!(id)]).unwrap(), json!({"ok": false, "error": "not_found"}));
        b.routines.stop();
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn a_bad_form_is_an_error_code_and_changes_nothing() {
        let b = bench("api2", hcm(14, 0, 0), quiet_off(), Duration::from_secs(30));
        let r = &b.routines;
        let code = |v: Value| r.handle("routines.add", &[v]).unwrap()["error"].as_str().unwrap().to_string();
        assert_eq!(code(json!({"text": "x", "time": "25:00", "repeat": "none"})), "bad_time");
        assert_eq!(code(json!({"text": "  ", "time": "10:00", "repeat": "none"})), "bad_text");
        assert_eq!(code(json!({"text": "x", "time": "10:00", "repeat": "weekly"})), "bad_repeat");
        assert_eq!(code(json!({"text": "x", "time": "10:00"})), "bad_repeat");
        assert_eq!(code(json!({"text": 5, "time": "10:00", "repeat": "none"})), "bad_args");
        assert_eq!(r.handle("routines.add", &[]).unwrap()["error"], "bad_args");
        assert_eq!(r.handle("routines.add", &[json!("text")]).unwrap()["error"], "bad_args");
        assert_eq!(r.handle("routines.delete", &[json!(7)]).unwrap()["error"], "bad_args");
        assert!(r.handle("routines.list", &[]).unwrap()["items"].as_array().unwrap().is_empty());
        assert!(r.handle("routines.exec", &[]).is_err());
        assert!(r.handle("hands.click", &[]).is_err());
        b.routines.stop();
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn the_form_takes_monthly_yearly_and_interval_with_their_fields() {
        let b = bench("api4", lt(2026, 11, 11, 7, 0), quiet_off(), Duration::from_secs(30));
        let r = &b.routines;
        let m = r.handle("routines.add", &[json!({"text": "rent", "time": "09:00", "repeat": "monthly", "day": 1})]).unwrap();
        assert_eq!((m["ok"].clone(), m["item"]["repeat"].clone(), m["item"]["day"].clone(), m["item"]["nextMs"].clone()), (json!(true), json!("monthly"), json!(1), json!(lt(2026, 12, 1, 9, 0))), "{m}");
        let l = r.handle("routines.add", &[json!({"text": "bills", "time": "09:00", "repeat": "monthly", "day": "last"})]).unwrap();
        assert_eq!((l["ok"].clone(), l["item"]["day"].clone(), l["item"]["nextMs"].clone()), (json!(true), json!("last"), json!(lt(2026, 11, 30, 9, 0))), "{l}");
        let y = r.handle("routines.add", &[json!({"text": "birthday", "time": "09:00", "repeat": "yearly", "month": 12, "day": 25})]).unwrap();
        assert_eq!((y["ok"].clone(), y["item"]["month"].clone(), y["item"]["nextMs"].clone()), (json!(true), json!(12), json!(lt(2026, 12, 25, 9, 0))), "{y}");
        let i = r.handle("routines.add", &[json!({"text": "stretch", "time": "08:00", "repeat": "interval", "everyMin": 90, "weekdays": [1, 2, 3, 4, 5], "window": {"start": "08:00", "end": "17:00"}, "endsMs": lt(2027, 1, 1, 0, 0)})]).unwrap();
        assert_eq!(i["ok"], true, "{i}");
        assert_eq!((i["item"]["everyMin"].clone(), i["item"]["weekdays"].clone(), i["item"]["window"].clone(), i["item"]["nextMs"].clone()),
            (json!(90), json!([1, 2, 3, 4, 5]), json!({"start": "08:00", "end": "17:00"}), json!(lt(2026, 11, 11, 8, 0))), "{i}");
        let list = r.handle("routines.list", &[]).unwrap();
        assert_eq!(list["items"].as_array().unwrap().len(), 4);
        b.routines.stop();
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn a_form_with_a_rule_out_of_range_is_bad_rule_and_changes_nothing() {
        let b = bench("api5", lt(2026, 11, 11, 7, 0), quiet_off(), Duration::from_secs(30));
        let r = &b.routines;
        let code = |v: Value| r.handle("routines.add", &[v]).unwrap()["error"].as_str().unwrap().to_string();
        assert_eq!(code(json!({"text": "x", "time": "09:00", "repeat": "monthly"})), "bad_rule");
        assert_eq!(code(json!({"text": "x", "time": "09:00", "repeat": "monthly", "day": 32})), "bad_rule");
        assert_eq!(code(json!({"text": "x", "time": "09:00", "repeat": "monthly", "day": "first"})), "bad_rule");
        assert_eq!(code(json!({"text": "x", "time": "09:00", "repeat": "yearly", "month": 2, "day": 30})), "bad_rule");
        assert_eq!(code(json!({"text": "x", "time": "09:00", "repeat": "yearly", "day": 3})), "bad_rule");
        assert_eq!(code(json!({"text": "x", "time": "09:00", "repeat": "interval"})), "bad_rule");
        assert_eq!(code(json!({"text": "x", "time": "09:00", "repeat": "interval", "everyMin": 4})), "bad_rule");
        assert_eq!(code(json!({"text": "x", "time": "09:00", "repeat": "interval", "everyMin": 60, "weekdays": [8]})), "bad_rule");
        assert_eq!(code(json!({"text": "x", "time": "09:00", "repeat": "interval", "everyMin": 60, "window": {"start": "17:00", "end": "09:00"}})), "bad_rule");
        assert_eq!(code(json!({"text": "x", "time": "09:00", "repeat": "interval", "everyMin": 60.5})), "bad_rule");
        // a daily form that carries a monthly field is not quietly accepted as monthly
        assert_eq!(code(json!({"text": "x", "time": "09:00", "repeat": "daily", "day": 3})), "bad_rule");
        assert!(r.handle("routines.list", &[]).unwrap()["items"].as_array().unwrap().is_empty());
        b.routines.stop();
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn history_lists_what_happened_newest_first_and_filters_by_routine() {
        let b = bench("api6", lt(2026, 11, 11, 14, 0), quiet_off(), Duration::from_secs(30));
        let r = &b.routines;
        let a = r.handle("routines.add", &[json!({"text": "first", "time": "15:00", "repeat": "none"})]).unwrap()["item"]["id"].as_str().unwrap().to_string();
        r.handle("routines.add", &[json!({"text": "second", "time": "15:30", "repeat": "none"})]).unwrap();
        assert_eq!(r.handle("routines.history", &[]).unwrap(), json!({"ok": true, "items": []}));
        b.clock.store(lt(2026, 11, 11, 15, 0), std::sync::atomic::Ordering::SeqCst);
        assert_eq!(r.tick_now().unwrap(), 1);
        b.clock.store(lt(2026, 11, 11, 15, 30), std::sync::atomic::Ordering::SeqCst);
        assert_eq!(r.tick_now().unwrap(), 1);
        let h = r.handle("routines.history", &[]).unwrap();
        let items = h["items"].as_array().unwrap();
        assert_eq!(items.iter().map(|i| i["text"].as_str().unwrap()).collect::<Vec<_>>(), ["second", "first"]);
        assert_eq!((items[0]["status"].clone(), items[0]["atMs"].clone(), items[0]["scheduledMs"].clone()), (json!("fired"), json!(lt(2026, 11, 11, 15, 30)), json!(lt(2026, 11, 11, 15, 30))));
        let only = r.handle("routines.history", &[json!({"id": a})]).unwrap();
        assert_eq!(only["items"].as_array().unwrap().len(), 1);
        assert_eq!(r.handle("routines.history", &[json!({"limit": 1})]).unwrap()["items"].as_array().unwrap().len(), 1);
        assert_eq!(r.handle("routines.history", &[json!({"limit": 0})]).unwrap()["error"], "bad_args");
        assert_eq!(r.handle("routines.history", &[json!("x")]).unwrap()["error"], "bad_args");
        assert_eq!(r.handle("routines.history", &[Value::Null]).unwrap()["items"].as_array().unwrap().len(), 2, "the shim sends [null] for no argument");
        b.routines.stop();
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn a_missed_run_shows_in_the_history_with_its_count() {
        let b = bench("api7", lt(2026, 11, 11, 14, 0), quiet_off(), Duration::from_secs(30));
        let r = &b.routines;
        r.handle("routines.add", &[json!({"text": "stretch", "time": "15:00", "repeat": "daily"})]).unwrap();
        b.clock.store(lt(2026, 11, 14, 20, 0), std::sync::atomic::Ordering::SeqCst); // woke three days and five hours later
        assert_eq!(r.tick_now().unwrap(), 1, "the newest one (14 Nov 15:00, five hours late) still runs");
        let items = r.handle("routines.history", &[]).unwrap()["items"].as_array().unwrap().clone();
        assert_eq!(items.iter().map(|i| (i["status"].as_str().unwrap().to_string(), i["missed"].as_u64().unwrap())).collect::<Vec<_>>(), [("fired".to_string(), 0), ("missed".to_string(), 3)]);
        b.routines.stop();
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn the_form_cannot_choose_the_tool_so_a_reminder_made_here_always_speaks() {
        let b = bench("api3", hcm(14, 0, 0), quiet_off(), Duration::from_secs(30));
        let r = &b.routines;
        r.handle("routines.add", &[json!({"text": "sneaky", "time": "15:00", "repeat": "none", "tool": "hands.click"})]).unwrap();
        assert_eq!(r.inner.engine.lock().unwrap().store().list()[0].tool, "speak");
        b.clock.store(hcm(15, 0, 0), std::sync::atomic::Ordering::SeqCst);
        assert_eq!(r.tick_now().unwrap(), 1);
        assert_eq!(b.spoken.lock().unwrap()[0].0, "sneaky");
        b.routines.stop();
        let _ = std::fs::remove_dir_all(&b.dir);
    }
}
