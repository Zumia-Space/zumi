//! Hold the hotkey, speak, release: the words go to the chat input. The flow of upstream's `talk-session`, minus the panel:
//!   press while listening or hearing  -> ignored (upstream `UNDER_WAY`)
//!   hold longer than `max_listen`     -> finishes by itself (upstream `maxListenMs`, 60 s)
//!   nothing said                      -> nothing typed, no notice (upstream closes the box)
//!   a failure                         -> one code word to `Sink::notice`, nothing typed
//!   cancelled while hearing           -> `dictation_cancelled` to `Sink::notice`, nothing typed
//! The hotkey thread never waits for the recorder or the engine: `on_hotkey` returns at once and a worker thread hears.
use crate::hotkey::HotkeyEvent;
use crate::{Stt, SttError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Records while the hotkey is held. In the app the page records (the webview owns the microphone); tests use a fixture.
pub trait Recorder: Send + Sync {
    fn start(&self) -> Result<(), SttError>;
    /// Stops and returns the WAV recorded since `start`.
    fn finish(&self) -> Result<Vec<u8>, SttError>;
    /// Stops and throws the recording away.
    fn cancel(&self);
}

pub trait Sink: Send + Sync {
    /// The words heard (never empty).
    fn text(&self, text: &str);
    /// A fixed code word: why nothing was typed.
    fn notice(&self, code: &'static str);
}

enum State {
    Idle,
    Listening(u64),
    Hearing(u64, Arc<AtomicBool>),
}

struct Inner {
    stt: Arc<Stt>,
    recorder: Arc<dyn Recorder>,
    sink: Arc<dyn Sink>,
    max_listen: Duration,
    state: Mutex<(u64, State)>,
}

pub struct Dictation {
    inner: Arc<Inner>,
}

impl Inner {
    fn lock(&self) -> std::sync::MutexGuard<'_, (u64, State)> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn press(self: &Arc<Self>) {
        let id = {
            let mut s = self.lock();
            if !matches!(s.1, State::Idle) {
                return;
            }
            s.0 += 1;
            let id = s.0;
            s.1 = State::Listening(id);
            id
        };
        if let Err(e) = self.recorder.start() {
            let mut s = self.lock();
            if matches!(s.1, State::Listening(now) if now == id) {
                s.1 = State::Idle;
                drop(s);
                self.sink.notice(e.code());
            }
            return;
        }
        // The cap: a hold that is never released ends by itself.
        let inner = self.clone();
        std::thread::spawn(move || {
            let t0 = Instant::now();
            while t0.elapsed() < inner.max_listen {
                if !matches!(inner.lock().1, State::Listening(now) if now == id) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            inner.finish(id);
        });
    }

    /// Listening -> hearing, on a worker thread. Does nothing if this recording is no longer the one listening.
    fn finish(self: &Arc<Self>, id: u64) {
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut s = self.lock();
            if !matches!(s.1, State::Listening(now) if now == id) {
                return;
            }
            s.1 = State::Hearing(id, cancel.clone());
        }
        let inner = self.clone();
        std::thread::spawn(move || {
            let heard = inner.recorder.finish().and_then(|wav| inner.stt.transcribe(&wav, &|| cancel.load(Ordering::SeqCst)));
            {
                // Dismissed while hearing: the answer, or the failure, is dropped.
                let mut s = inner.lock();
                if !matches!(&s.1, State::Hearing(now, _) if *now == id) {
                    return;
                }
                s.1 = State::Idle;
            }
            match heard {
                Ok(text) if text.is_empty() => {}
                Ok(text) => inner.sink.text(&text),
                Err(e) if e.code() == "stt_cancelled" => {}
                Err(e) => inner.sink.notice(e.code()),
            }
        });
    }

    fn release(self: &Arc<Self>) {
        let id = match self.lock().1 {
            State::Listening(id) => id,
            _ => return,
        };
        self.finish(id);
    }

    /// `say`: a person's cancel while the engine works shows `dictation_cancelled`, so the words do not vanish without a word.
    /// Dropping the owner (app exit) says nothing.
    fn dismiss(&self, say: bool) {
        let (was_listening, was_hearing) = {
            let mut s = self.lock();
            match std::mem::replace(&mut s.1, State::Idle) {
                State::Listening(_) => (true, false),
                State::Hearing(_, cancel) => {
                    cancel.store(true, Ordering::SeqCst);
                    (false, true)
                }
                State::Idle => (false, false),
            }
        };
        if was_listening {
            self.recorder.cancel();
        }
        if say && was_hearing {
            self.sink.notice("dictation_cancelled");
        }
    }
}

impl Dictation {
    pub fn new(stt: Arc<Stt>, recorder: Arc<dyn Recorder>, sink: Arc<dyn Sink>, max_listen: Duration) -> Dictation {
        Dictation { inner: Arc::new(Inner { stt, recorder, sink, max_listen, state: Mutex::new((0, State::Idle)) }) }
    }

    /// Wire this to `Hotkey::register`'s callback.
    pub fn on_hotkey(&self, event: HotkeyEvent) {
        match event {
            HotkeyEvent::Press => self.inner.press(),
            HotkeyEvent::Release => self.inner.release(),
        }
    }

    /// True while listening or hearing.
    pub fn busy(&self) -> bool {
        !matches!(self.inner.lock().1, State::Idle)
    }

    /// Drops the recording (silently) or the transcript in flight (with the `dictation_cancelled` notice).
    pub fn dismiss(&self) {
        self.inner.dismiss(true);
    }
}

impl Drop for Dictation {
    fn drop(&mut self) {
        self.inner.dismiss(false);
    }
}
