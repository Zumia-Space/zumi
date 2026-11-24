//! R5 through the real runner: first-use consent, confirm for a final action, saved steps recorded and replayed with no model
//! call. The helper is `zumi-hands-fake` (no window, no SendInput); the model is a fixture. The desktop checks that need a
//! real window (T42, T44, Paint, on-screen injection) are scripts/maus-r5-desktop.mjs, run on the spare console.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use zumi_agent_loop::cancel::Cancel;
use zumi_agent_loop::hands_tools::Asker;
use zumi_agent_loop::loop_run::{Meter, Outcome, StopReason};
use zumi_agent_loop::runner::{run_task_with, HandsOpts, ModelSource, TaskExtras, TaskOpts};
use zumi_agent_loop::types::TurnResponse;

#[derive(Default)]
struct Count(u32);
impl Meter for Count {
    fn record_turn(&mut self, _r: &TurnResponse, _step: u32) -> Option<f64> {
        self.0 += 1;
        Some(0.0)
    }
}

struct Rig {
    root: PathBuf,
    store: PathBuf,
}

fn rig(name: &str) -> Rig {
    let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("r5-runner-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("files")).unwrap();
    Rig { store: root.join("saved-steps.json"), root }
}

fn fixture(rig: &Rig, name: &str, turns: Value) -> PathBuf {
    let p = rig.root.join(format!("{name}.json"));
    std::fs::write(&p, json!({ "name": name, "model": "mock/loop-v1", "turns": turns }).to_string()).unwrap();
    p
}

struct Done {
    out: Outcome,
    events: Vec<Value>,
    turns: u32,
    control: PathBuf,
}

impl Done {
    fn log(&self) -> Vec<Value> {
        std::fs::read_to_string(self.control.join("fake-hands.log")).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
    }
    fn verbs(&self) -> Vec<String> {
        self.log().iter().map(|v| v["cmd"].as_str().unwrap_or("").to_string()).filter(|c| !matches!(c.as_str(), "arm" | "status")).collect()
    }
    fn event(&self, ev: &str) -> Option<&Value> {
        self.events.iter().find(|e| e["ev"] == ev)
    }
}

#[allow(clippy::too_many_arguments)]
fn run(rig: &Rig, id: &str, sentence: &str, fixture: &Path, snapshot: Option<Value>, ask: Option<Asker>, consent_given: bool, saved: bool) -> Done {
    let control = rig.root.join("control").join(id);
    std::fs::create_dir_all(&control).unwrap();
    if let Some(s) = snapshot {
        std::fs::write(control.join("snapshot.json"), s.to_string()).unwrap();
    }
    let opts = TaskOpts {
        task_id: id.to_string(),
        sentence: sentence.to_string(),
        model: ModelSource::Mock { fixture: fixture.to_path_buf(), vars: Default::default() },
        hands: Some(HandsOpts { exe: PathBuf::from(env!("CARGO_BIN_EXE_zumi-hands-fake")), control_dir: control.clone(), workspace: rig.root.join("files"), deadman_ms: 60_000, accept_key: None }),
        notes: None,
        reminders: None,
        loop_audit: rig.root.join("audit").join(format!("{id}.jsonl")),
        prior_usd: Ok(0.0),
        max_total_usd: None,
        cancel: Cancel::new(),
    };
    std::fs::create_dir_all(rig.root.join("audit")).unwrap();
    let extras = TaskExtras { ask, consent_given, saved_steps: saved.then(|| rig.store.clone()), ..Default::default() };
    let mut meter = Count::default();
    let mut events = Vec::new();
    let out = run_task_with(opts, extras, &mut meter, &mut |e| events.push(e)).expect("the task ran");
    Done { out, events, turns: meter.0, control }
}

fn goal_turns() -> Value {
    json!([
        { "text": "Opening.", "tool_calls": [{ "name": "hands.launch", "args": { "app": "notepad", "file": "{{FILE}}" } }], "usage": { "in": 10, "out": 5 } },
        { "text": "Typing.", "tool_calls": [{ "name": "hands.type", "args": { "text": "xin chào Zumi" } }], "usage": { "in": 10, "out": 5 } },
        { "text": "Saving.", "tool_calls": [{ "name": "hands.key", "args": { "chord": "ctrl+s" } }], "usage": { "in": 10, "out": 5 } },
        { "text": "Done: saved.", "usage": { "in": 10, "out": 5 } }
    ])
}

fn goal_fixture(rig: &Rig, file: &str) -> PathBuf {
    let text = goal_turns().to_string().replace("{{FILE}}", file);
    let p = rig.root.join("goal.json");
    std::fs::write(&p, json!({ "name": "goal", "model": "mock/loop-v1", "turns": serde_json::from_str::<Value>(&text).unwrap() }).to_string()).unwrap();
    p
}

fn yes_no(answer: bool, asked: &Arc<Mutex<Vec<String>>>) -> Asker {
    let asked = asked.clone();
    Arc::new(move |text: &str, _c: &Cancel| {
        asked.lock().unwrap().push(text.to_string());
        answer
    })
}

fn calc_snapshot(with_seven: bool) -> Value {
    let mut els = vec![json!({ "id": "e2", "role": "Button", "name": "Plus" })];
    if with_seven {
        els.insert(0, json!({ "id": "e1", "role": "Button", "name": "Seven" }));
    }
    json!({ "text": "Seven Plus", "elements": els })
}

fn calc_fixture(rig: &Rig) -> PathBuf {
    fixture(
        rig,
        "calc",
        json!([
            { "text": "Opening.", "tool_calls": [{ "name": "hands.launch", "args": { "app": "calculator" } }], "usage": { "in": 10, "out": 5 } },
            { "text": "Looking.", "tool_calls": [{ "name": "hands.snapshot", "args": {} }], "usage": { "in": 10, "out": 5 } },
            { "text": "Seven.", "tool_calls": [{ "name": "hands.act", "args": { "name": "Seven", "do": "invoke" } }], "usage": { "in": 10, "out": 5 } },
            { "text": "Plus.", "tool_calls": [{ "name": "hands.act", "args": { "name": "Plus", "do": "invoke" } }], "usage": { "in": 10, "out": 5 } },
            { "text": "Done.", "usage": { "in": 10, "out": 5 } }
        ]),
    )
}

const CALC: &str = "open calculator then press Seven and Plus";

fn goal_sentence(rig: &Rig) -> (String, String) {
    let file = rig.root.join("files").join("p3-out.txt").to_string_lossy().replace('\\', "/");
    (format!("mở Notepad, gõ 'xin chào Zumi', lưu vào {file}"), file)
}

#[test]
fn r5_a_clean_task_is_saved_and_the_same_words_replay_with_no_model_call_through_the_same_gate() {
    let r = rig("replay");
    let (sentence, file) = goal_sentence(&r);
    let first = run(&r, "first", &sentence, &goal_fixture(&r, &file), None, None, true, true);
    assert_eq!(first.out.stop, StopReason::Done);
    assert_eq!(first.turns, 4);
    assert_eq!(first.event("saved_steps").map(|e| e["saved"].clone()), Some(json!(true)), "{:?}", first.events);
    // The second run's model has no turn at all: any model call would fail it.
    let nothing = fixture(&r, "nothing", json!([]));
    let second = run(&r, "second", &sentence, &nothing, None, None, true, true);
    assert_eq!(second.out.stop, StopReason::Done, "{:?}", second.events);
    assert_eq!(second.turns, 0, "no model turn, so nothing in the ledger");
    assert!(!second.events.iter().any(|e| e["ev"] == "turn"));
    assert!(second.out.final_text.starts_with("Done. I repeated 3 saved steps"), "{}", second.out.final_text);
    assert_eq!(second.event("replay").map(|e| e["state"].clone()), Some(json!("done")));
    assert_eq!(first.verbs().into_iter().filter(|v| matches!(v.as_str(), "launch" | "type" | "key")).collect::<Vec<_>>(), second.verbs().into_iter().filter(|v| matches!(v.as_str(), "launch" | "type" | "key")).collect::<Vec<_>>(), "the replay did what the model run did");
    assert_eq!(std::fs::read_to_string(second.control.join("typed.txt")).unwrap(), "xin chào Zumi");
    let tool_lines = std::fs::read_to_string(r.root.join("audit").join("second.jsonl")).unwrap();
    assert!(tool_lines.contains("tool:hands.type") && tool_lines.contains("tool_result:hands.key"), "every replayed step went through the gate and its audit");
}

#[test]
fn r5_bite_a_replay_whose_label_is_gone_hands_the_sentence_to_the_model_with_a_note_deletes_the_recipe_and_saves_nothing_new() {
    let r = rig("fallback");
    let first = run(&r, "first", CALC, &calc_fixture(&r), Some(calc_snapshot(true)), None, true, true);
    assert_eq!(first.event("saved_steps").map(|e| e["saved"].clone()), Some(json!(true)), "{:?}", first.events);
    let model = fixture(&r, "after", json!([{ "text": "The Seven key is not on the screen.", "usage": { "in": 10, "out": 5 } }]));
    let second = run(&r, "second", CALC, &model, Some(calc_snapshot(false)), None, true, true);
    assert_eq!(second.event("replay").map(|e| e["state"].clone()), Some(json!("failed")), "{:?}", second.events);
    assert_eq!(second.turns, 1, "the model took over");
    let user = second.out.messages[1]["content"].as_str().unwrap().to_string();
    assert!(user.starts_with(CALC), "the person's words come first: {user}");
    assert!(user.contains("A saved run of this request did steps") && user.contains("failed at step 3") && user.contains("look before acting"), "{user}");
    assert!(zumi_agent_loop::saved_steps::Store::new(r.store.clone()).load().is_empty(), "the recipe was deleted");
    assert_eq!(second.event("saved_steps").map(|e| (e["saved"].clone(), e["why"].clone())), Some((json!(false), json!("fell_back"))));
}

#[test]
fn r5_first_use_is_asked_in_every_run_a_replay_included_and_a_no_keeps_the_helper_idle() {
    let r = rig("consent");
    let (sentence, file) = goal_sentence(&r);
    let asked = Arc::new(Mutex::new(Vec::new()));
    let first = run(&r, "first", &sentence, &goal_fixture(&r, &file), None, Some(yes_no(true, &asked)), false, true);
    assert_eq!(first.out.stop, StopReason::Done);
    assert_eq!(asked.lock().unwrap().len(), 1, "one first-use question: {:?}", asked.lock().unwrap());
    assert!(asked.lock().unwrap()[0].contains("xin chào Zumi"), "it names the task in the person's words");
    let nothing = fixture(&r, "nothing", json!([]));
    let second = run(&r, "second", &sentence, &nothing, None, Some(yes_no(true, &asked)), false, true);
    assert_eq!(second.turns, 0);
    assert_eq!(asked.lock().unwrap().len(), 2, "a replay never skips the question the model run had to ask");
    // A no: nothing reaches the helper and nothing is saved.
    let r2 = rig("consent-no");
    let (s2, f2) = goal_sentence(&r2);
    let no = Arc::new(Mutex::new(Vec::new()));
    let denied = run(&r2, "denied", &s2, &goal_fixture(&r2, &f2), None, Some(yes_no(false, &no)), false, true);
    assert_eq!(no.lock().unwrap().len(), 1);
    assert!(denied.verbs().is_empty(), "the helper was never asked to do anything: {:?}", denied.verbs());
    assert_eq!(denied.event("saved_steps").map(|e| e["saved"].clone()), Some(json!(false)));
    assert!(!r2.store.exists() || zumi_agent_loop::saved_steps::Store::new(r2.store.clone()).load().is_empty());
}

#[test]
fn r5_bite_without_an_asker_and_without_prior_consent_no_hands_verb_runs() {
    let r = rig("noasker");
    let (sentence, file) = goal_sentence(&r);
    let d = run(&r, "d", &sentence, &goal_fixture(&r, &file), None, None, false, false);
    assert!(d.verbs().is_empty(), "{:?}", d.verbs());
    assert!(d.events.iter().any(|e| e["ev"] == "tool_end" && e["error"] == "consent_unavailable"), "{:?}", d.events);
}

fn delete_fixture(rig: &Rig) -> PathBuf {
    fixture(
        rig,
        "delete",
        json!([
            { "text": "Opening.", "tool_calls": [{ "name": "hands.launch", "args": { "app": "notepad" } }], "usage": { "in": 10, "out": 5 } },
            { "text": "Looking.", "tool_calls": [{ "name": "hands.snapshot", "args": {} }], "usage": { "in": 10, "out": 5 } },
            { "text": "Deleting.", "tool_calls": [{ "name": "hands.act", "args": { "name": "Delete", "do": "invoke" } }], "usage": { "in": 10, "out": 5 } },
            { "text": "Done.", "usage": { "in": 10, "out": 5 } }
        ]),
    )
}
const DELETE: &str = "open notepad and press Delete";
fn delete_snapshot() -> Value {
    json!({ "text": "Delete", "elements": [{ "id": "e1", "role": "MenuItem", "name": "Delete" }] })
}

#[test]
fn r5_a_final_action_asks_through_the_chat_question_a_no_does_nothing_and_a_yes_runs_it_but_is_never_saved() {
    let r = rig("delete-no");
    let asked = Arc::new(Mutex::new(Vec::new()));
    let no = Arc::new(Mutex::new(0u32));
    let n2 = no.clone();
    let a2 = asked.clone();
    // First question (first use) yes, the Delete question no.
    let ask: Asker = Arc::new(move |text: &str, _c: &Cancel| {
        a2.lock().unwrap().push(text.to_string());
        let mut n = n2.lock().unwrap();
        *n += 1;
        *n == 1
    });
    let d = run(&r, "no", DELETE, &delete_fixture(&r), Some(delete_snapshot()), Some(ask), false, true);
    assert_eq!(asked.lock().unwrap().len(), 2, "{:?}", asked.lock().unwrap());
    assert!(asked.lock().unwrap()[1].contains("Delete"));
    assert!(!d.verbs().contains(&"act".to_string()), "a no means nothing was invoked: {:?}", d.verbs());
    assert!(d.events.iter().any(|e| e["ev"] == "tool_end" && e["name"] == "hands.act" && e["error"] == "declined"), "{:?}", d.events);
    let r2 = rig("delete-yes");
    let asked2 = Arc::new(Mutex::new(Vec::new()));
    let y = run(&r2, "yes", DELETE, &delete_fixture(&r2), Some(delete_snapshot()), Some(yes_no(true, &asked2)), false, true);
    assert!(y.verbs().contains(&"act".to_string()));
    assert_eq!(y.event("saved_steps").map(|e| (e["saved"].clone(), e["why"].clone())), Some((json!(false), json!("answered_question"))));
    assert!(!r2.store.exists() || zumi_agent_loop::saved_steps::Store::new(r2.store.clone()).load().is_empty(), "a question the person answered is never replayed");
}

#[test]
fn r5g_a_no_during_a_replay_keeps_the_saved_steps_and_never_starts_the_model() {
    // GATE-OPUS-R5 should-fix 3, through the real runner. The first run is the person's own (saved); the second run's first-use
    // question gets a no.
    let r = rig("replay-no");
    let (sentence, file) = goal_sentence(&r);
    let first = run(&r, "first", &sentence, &goal_fixture(&r, &file), None, None, true, true);
    assert_eq!(first.event("saved_steps").map(|e| e["saved"].clone()), Some(json!(true)), "{:?}", first.events);
    let before = zumi_agent_loop::saved_steps::Store::new(r.store.clone()).load();
    assert_eq!(before.len(), 1);
    let asked = Arc::new(Mutex::new(Vec::new()));
    // A model with a turn it must never take: a model call would use it and the test fails on `turns`.
    let tempting = fixture(&r, "tempting", json!([{ "text": "I will do it myself.", "usage": { "in": 10, "out": 5 } }]));
    let second = run(&r, "second", &sentence, &tempting, None, Some(yes_no(false, &asked)), false, true);
    assert_eq!(asked.lock().unwrap().len(), 1, "the first-use question was asked once and answered no");
    assert_eq!(second.turns, 0, "no model call after a no: {:?}", second.events);
    assert!(!second.events.iter().any(|e| e["ev"] == "turn"), "{:?}", second.events);
    assert!(matches!(&second.out.stop, StopReason::Cancelled(why) if why == "declined"), "{:?}", second.out.stop);
    assert_eq!(second.event("replay").map(|e| e["state"].clone()), Some(json!("stopped")), "{:?}", second.events);
    assert!(second.verbs().is_empty(), "nothing reached the helper: {:?}", second.verbs());
    let after = zumi_agent_loop::saved_steps::Store::new(r.store.clone()).load();
    assert_eq!(after.len(), 1, "the recipe was not deleted");
    assert_eq!((&after[0].key, &after[0].request, after[0].exact, &after[0].steps), (&before[0].key, &before[0].request, before[0].exact, &before[0].steps), "the saved steps are exactly as they were (only the last-used time may move)");
}

// R4e (GATE-OPUS-R4D section 7, rule 3): through the real runner, a run in which the taint rule asked or refused is never saved as steps.
fn off_script_fixture(rig: &Rig) -> PathBuf {
    fixture(
        rig,
        "off-script",
        json!([
            { "text": "Opening.", "tool_calls": [{ "name": "hands.launch", "args": { "app": "notepad" } }], "usage": { "in": 10, "out": 5 } },
            { "text": "Typing.", "tool_calls": [{ "name": "hands.type", "args": { "text": "something the person never wrote" } }], "usage": { "in": 10, "out": 5 } },
            { "text": "Done.", "usage": { "in": 10, "out": 5 } }
        ]),
    )
}
/// No moment word (the saving rule `moment_words` would otherwise answer first: `it` is one).
const PLAIN_SCRIPT: &str = "open notepad and wait";

#[test]
fn r4e_a_run_that_typed_text_the_person_did_not_write_after_a_yes_is_not_saved_for_the_text_not_for_the_yes() {
    let r = rig("taint-yes");
    let asked = Arc::new(Mutex::new(Vec::new()));
    let d = run(&r, "yes", PLAIN_SCRIPT, &off_script_fixture(&r), None, Some(yes_no(true, &asked)), true, true);
    assert_eq!(d.out.stop, StopReason::Done, "{:?}", d.events);
    assert_eq!(asked.lock().unwrap().len(), 1, "one question, for the typed text: {:?}", asked.lock().unwrap());
    assert!(!asked.lock().unwrap()[0].contains("never wrote"), "the question never quotes the text");
    assert!(d.verbs().contains(&"type".to_string()), "a yes types it: {:?}", d.verbs());
    // R4f: a yes is not a denial. The run is judged by the ordinary saving rules, and typed text that is not in the request fails them.
    assert_eq!(d.event("saved_steps").map(|e| (e["saved"].clone(), e["why"].clone())), Some((json!(false), json!("typed_text_not_in_request"))), "{:?}", d.events);
    assert!(!r.store.exists() || zumi_agent_loop::saved_steps::Store::new(r.store.clone()).load().is_empty());
}

fn select_all_fixture(rig: &Rig) -> PathBuf {
    fixture(
        rig,
        "select-all",
        json!([
            { "text": "Opening.", "tool_calls": [{ "name": "hands.launch", "args": { "app": "notepad" } }], "usage": { "in": 10, "out": 5 } },
            { "text": "Selecting.", "tool_calls": [{ "name": "hands.key", "args": { "chord": "ctrl+a" } }], "usage": { "in": 10, "out": 5 } },
            { "text": "Done.", "usage": { "in": 10, "out": 5 } }
        ]),
    )
}

#[test]
fn r4f_a_run_the_person_approved_is_saved_like_upstream_and_a_no_or_a_refusal_is_not() {
    let r = rig("taint-key-yes");
    let asked = Arc::new(Mutex::new(Vec::new()));
    let y = run(&r, "yes", PLAIN_SCRIPT, &select_all_fixture(&r), None, Some(yes_no(true, &asked)), true, true);
    assert_eq!(y.out.stop, StopReason::Done, "{:?}", y.events);
    assert_eq!(asked.lock().unwrap().len(), 1, "select-all was not in the request: one question");
    assert!(y.verbs().contains(&"key".to_string()), "a yes sends it: {:?}", y.verbs());
    assert_eq!(y.event("saved_steps").map(|e| e["saved"].clone()), Some(json!(true)), "upstream saves a request whose approval was allowed: {:?}", y.events);
    assert_eq!(zumi_agent_loop::saved_steps::Store::new(r.store.clone()).load().len(), 1);
    // A no and nobody to ask stay unsaved.
    let r2 = rig("taint-key-no");
    let asked2 = Arc::new(Mutex::new(Vec::new()));
    let no = run(&r2, "no", PLAIN_SCRIPT, &select_all_fixture(&r2), None, Some(yes_no(false, &asked2)), true, true);
    assert!(!no.verbs().contains(&"key".to_string()), "{:?}", no.verbs());
    assert_eq!(no.event("saved_steps").map(|e| (e["saved"].clone(), e["why"].clone())), Some((json!(false), json!("tainted_run"))), "{:?}", no.events);
    let r3 = rig("taint-key-nobody");
    let none = run(&r3, "none", PLAIN_SCRIPT, &select_all_fixture(&r3), None, None, true, true);
    assert_eq!(none.event("saved_steps").map(|e| (e["saved"].clone(), e["why"].clone())), Some((json!(false), json!("tainted_run"))), "{:?}", none.events);
}

#[test]
fn r4e_a_run_in_which_the_taint_rule_refused_a_call_is_not_saved_as_tainted_and_a_no_types_nothing() {
    let r = rig("taint-no");
    let asked = Arc::new(Mutex::new(Vec::new()));
    let no = run(&r, "no", PLAIN_SCRIPT, &off_script_fixture(&r), None, Some(yes_no(false, &asked)), true, true);
    assert!(!no.verbs().contains(&"type".to_string()), "a no types nothing: {:?}", no.verbs());
    assert!(no.events.iter().any(|e| e["ev"] == "tool_end" && e["name"] == "hands.type" && e["error"] == "declined"), "{:?}", no.events);
    assert_eq!(no.event("saved_steps").map(|e| e["why"].clone()), Some(json!("tainted_run")), "{:?}", no.events);
    // Nobody to ask: the old hard refusal, and the same verdict.
    let r2 = rig("taint-nobody");
    let none = run(&r2, "none", PLAIN_SCRIPT, &off_script_fixture(&r2), None, None, true, true);
    assert!(none.events.iter().any(|e| e["ev"] == "tool_end" && e["name"] == "hands.type" && e["error"] == "tainted_arg"), "{:?}", none.events);
    assert_eq!(none.event("saved_steps").map(|e| e["why"].clone()), Some(json!("tainted_run")), "{:?}", none.events);
}
