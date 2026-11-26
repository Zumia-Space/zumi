//! Hold, speak, release: the flow from the hotkey to the text, with a fake recorder, a fake engine and a recording sink.
mod common;
use common::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zumi_stt::dictation::{Dictation, Recorder, Sink};
use zumi_stt::hotkey::HotkeyEvent::{Press, Release};
use zumi_stt::{Clip, Provider, Stt, SttError};

struct Mic {
    wav: Vec<u8>,
    fail_start: Option<&'static str>,
    starts: AtomicUsize,
    finishes: AtomicUsize,
    cancels: AtomicUsize,
}
impl Recorder for Mic {
    fn start(&self) -> Result<(), SttError> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        self.fail_start.map_or(Ok(()), |c| Err(SttError(c)))
    }
    fn finish(&self) -> Result<Vec<u8>, SttError> {
        self.finishes.fetch_add(1, Ordering::SeqCst);
        Ok(self.wav.clone())
    }
    fn cancel(&self) {
        self.cancels.fetch_add(1, Ordering::SeqCst);
    }
}

struct Engine {
    answer: Result<&'static str, &'static str>,
    delay: Duration,
    calls: AtomicUsize,
}
impl Provider for Engine {
    fn id(&self) -> &'static str {
        "fake"
    }
    fn transcribe(&self, _: &Clip, cancel: &dyn Fn() -> bool) -> Result<String, SttError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let t0 = Instant::now();
        while t0.elapsed() < self.delay {
            if cancel() {
                return Err(SttError("stt_cancelled"));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        self.answer.map(str::to_string).map_err(SttError)
    }
}

#[derive(Default)]
struct Words {
    texts: Mutex<Vec<String>>,
    notices: Mutex<Vec<&'static str>>,
}
impl Sink for Words {
    fn text(&self, t: &str) {
        self.texts.lock().unwrap().push(t.to_string());
    }
    fn notice(&self, c: &'static str) {
        self.notices.lock().unwrap().push(c);
    }
}

struct Rig {
    d: Dictation,
    mic: Arc<Mic>,
    engine: Arc<Engine>,
    out: Arc<Words>,
}

struct Shared(Arc<Engine>);
impl Provider for Shared {
    fn id(&self) -> &'static str {
        "fake"
    }
    fn transcribe(&self, c: &Clip, cancel: &dyn Fn() -> bool) -> Result<String, SttError> {
        self.0.transcribe(c, cancel)
    }
}

fn rig(wav: Vec<u8>, answer: Result<&'static str, &'static str>, delay_ms: u64, fail_start: Option<&'static str>, max_listen_ms: u64) -> Rig {
    let mic = Arc::new(Mic { wav, fail_start, starts: 0.into(), finishes: 0.into(), cancels: 0.into() });
    let engine = Arc::new(Engine { answer, delay: Duration::from_millis(delay_ms), calls: 0.into() });
    let out = Arc::new(Words::default());
    let d = Dictation::new(Arc::new(Stt::new(Box::new(Shared(engine.clone())))), mic.clone(), out.clone(), Duration::from_millis(max_listen_ms));
    Rig { d, mic, engine, out }
}

fn wait_for(what: &str, ok: impl Fn() -> bool) {
    let t0 = Instant::now();
    while !ok() {
        assert!(t0.elapsed() < Duration::from_secs(5), "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn press_speak_release_puts_the_words_in_the_input_once() {
    let r = rig(tone(1.0), Ok("open the board"), 0, None, 60_000);
    r.d.on_hotkey(Press);
    assert!(r.d.busy());
    assert_eq!((r.mic.starts.load(Ordering::SeqCst), r.mic.finishes.load(Ordering::SeqCst)), (1, 0), "recording while held");
    r.d.on_hotkey(Release);
    wait_for("the text", || !r.out.texts.lock().unwrap().is_empty());
    wait_for("idle", || !r.d.busy());
    assert_eq!(*r.out.texts.lock().unwrap(), vec!["open the board".to_string()]);
    assert!(r.out.notices.lock().unwrap().is_empty());
    assert_eq!((r.mic.starts.load(Ordering::SeqCst), r.mic.finishes.load(Ordering::SeqCst)), (1, 1));
}

#[test]
fn the_hotkey_thread_is_not_held_while_the_engine_works() {
    let r = rig(tone(1.0), Ok("slow words"), 400, None, 60_000);
    r.d.on_hotkey(Press);
    let t0 = Instant::now();
    r.d.on_hotkey(Release);
    assert!(t0.elapsed() < Duration::from_millis(200), "Release returned after {:?}", t0.elapsed());
    wait_for("the text", || !r.out.texts.lock().unwrap().is_empty());
}

#[test]
fn a_press_while_listening_or_transcribing_is_ignored_and_a_release_with_no_press_too() {
    let r = rig(tone(1.0), Ok("one"), 300, None, 60_000);
    r.d.on_hotkey(Release); // no press before
    assert_eq!(r.mic.finishes.load(Ordering::SeqCst), 0);
    r.d.on_hotkey(Press);
    r.d.on_hotkey(Press); // while listening
    assert_eq!(r.mic.starts.load(Ordering::SeqCst), 1);
    r.d.on_hotkey(Release);
    r.d.on_hotkey(Press); // while transcribing
    assert_eq!(r.mic.starts.load(Ordering::SeqCst), 1, "no second recording while the first is being heard");
    wait_for("the text", || !r.out.texts.lock().unwrap().is_empty());
    wait_for("idle", || !r.d.busy());
    assert_eq!(r.out.texts.lock().unwrap().len(), 1);
    r.d.on_hotkey(Press); // idle again: works
    assert_eq!(r.mic.starts.load(Ordering::SeqCst), 2);
    r.d.dismiss();
}

#[test]
fn a_hold_longer_than_the_cap_ends_by_itself() {
    let r = rig(tone(1.0), Ok("long hold"), 0, None, 150);
    r.d.on_hotkey(Press);
    wait_for("the text without a release", || !r.out.texts.lock().unwrap().is_empty());
    r.d.on_hotkey(Release); // the late release changes nothing
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(r.mic.finishes.load(Ordering::SeqCst), 1);
    assert_eq!(r.out.texts.lock().unwrap().len(), 1);
}

#[test]
fn a_silent_recording_types_nothing_and_asks_no_engine() {
    let r = rig(silence(16_000, 2.0), Ok("ghost"), 0, None, 60_000);
    r.d.on_hotkey(Press);
    r.d.on_hotkey(Release);
    wait_for("idle", || !r.d.busy() && r.mic.finishes.load(Ordering::SeqCst) == 1);
    std::thread::sleep(Duration::from_millis(100));
    assert!(r.out.texts.lock().unwrap().is_empty());
    assert!(r.out.notices.lock().unwrap().is_empty(), "upstream closes the box quietly when nothing was said");
    assert_eq!(r.engine.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn a_microphone_that_will_not_start_says_why_with_a_code_word_and_the_next_press_works() {
    let r = rig(tone(1.0), Ok("x"), 0, Some("stt_mic_denied"), 60_000);
    r.d.on_hotkey(Press);
    assert!(!r.d.busy());
    assert_eq!(*r.out.notices.lock().unwrap(), vec!["stt_mic_denied"]);
    r.d.on_hotkey(Release);
    r.d.on_hotkey(Press);
    assert_eq!(r.mic.starts.load(Ordering::SeqCst), 2, "a failed start is not a stuck state");
}

#[test]
fn an_engine_that_fails_says_why_with_its_code_word_and_types_nothing() {
    let r = rig(tone(1.0), Err("stt_key_rejected"), 0, None, 60_000);
    r.d.on_hotkey(Press);
    r.d.on_hotkey(Release);
    wait_for("the notice", || !r.out.notices.lock().unwrap().is_empty());
    assert_eq!(*r.out.notices.lock().unwrap(), vec!["stt_key_rejected"]);
    assert!(r.out.texts.lock().unwrap().is_empty());
    wait_for("idle", || !r.d.busy());
}

#[test]
fn dismiss_drops_the_recording_without_a_notice_and_a_transcript_in_flight_with_the_cancel_word() {
    // while listening
    let r = rig(tone(1.0), Ok("never"), 0, None, 60_000);
    r.d.on_hotkey(Press);
    r.d.dismiss();
    assert!(!r.d.busy());
    assert_eq!(r.mic.cancels.load(Ordering::SeqCst), 1);
    // while the engine works
    let r = rig(tone(1.0), Ok("never"), 2000, None, 60_000);
    r.d.on_hotkey(Press);
    r.d.on_hotkey(Release);
    wait_for("the engine to start", || r.engine.calls.load(Ordering::SeqCst) == 1);
    let t0 = Instant::now();
    r.d.dismiss();
    wait_for("idle", || !r.d.busy());
    assert!(t0.elapsed() < Duration::from_secs(1), "the engine was cancelled, not waited for: {:?}", t0.elapsed());
    std::thread::sleep(Duration::from_millis(200));
    // cancelling while the engine works says so (it used to drop silently); nothing is typed
    assert!(r.out.texts.lock().unwrap().is_empty());
    assert_eq!(*r.out.notices.lock().unwrap(), vec!["dictation_cancelled"]);
}

#[test]
fn dismiss_while_listening_or_idle_and_dropping_say_nothing() {
    let r = rig(tone(1.0), Ok("never"), 0, None, 60_000);
    r.d.on_hotkey(Press);
    r.d.dismiss();
    r.d.dismiss(); // idle now
    std::thread::sleep(Duration::from_millis(100));
    assert!(r.out.notices.lock().unwrap().is_empty());
    // a finished transcript is not a cancel
    let r = rig(tone(1.0), Ok("done"), 0, None, 60_000);
    r.d.on_hotkey(Press);
    r.d.on_hotkey(Release);
    wait_for("the text", || !r.out.texts.lock().unwrap().is_empty());
    r.d.dismiss();
    assert!(r.out.notices.lock().unwrap().is_empty());
}
