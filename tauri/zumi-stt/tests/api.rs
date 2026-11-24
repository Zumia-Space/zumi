//! The API engines against a local mock server (no live API, no key of anyone's): the request each upstream provider takes,
//! the reply it gives, and the refusals. Every API call goes through `zumi-egress`.
mod common;
use common::*;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zumi_egress::fixture::{FixtureReq, FixtureResp, Server};
use zumi_stt::api::{ApiKind, ApiProvider};
use zumi_stt::{Provider, Stt};

type Lines = Arc<Mutex<Vec<String>>>;
const KEY: &str = "test-key-7f3a91c2d8e04b65";

fn audit() -> (Arc<dyn Fn(&str) + Send + Sync>, Lines) {
    let lines: Lines = Arc::default();
    let l = lines.clone();
    (Arc::new(move |s: &str| l.lock().unwrap().push(s.to_string())), lines)
}

/// A server that records each request and answers `reply`.
fn recording(reply: FixtureResp_) -> (Server, Arc<Mutex<Vec<FixtureReq>>>) {
    let seen: Arc<Mutex<Vec<FixtureReq>>> = Arc::default();
    let s = seen.clone();
    let server = Server::start(move |req| {
        s.lock().unwrap().push(req.clone());
        reply(req)
    });
    (server, seen)
}
type FixtureResp_ = fn(&FixtureReq) -> FixtureResp;
fn heard_hello(_: &FixtureReq) -> FixtureResp {
    FixtureResp::json(200, r#"{"text":"  hello there \n"}"#)
}

fn provider(kind: ApiKind, server: &Server, language: Option<&str>) -> (ApiProvider, Lines) {
    let (a, lines) = audit();
    let base = match kind {
        ApiKind::Fish => server.origin(),
        _ => format!("{}/v1", server.origin()),
    };
    (ApiProvider::new(kind, Some(&base), KEY, language, None, a).expect("provider"), lines)
}

fn clip() -> zumi_stt::Clip {
    let wav = tone(1.0);
    zumi_stt::Clip { wav, seconds: 1.0 }
}

#[test]
fn each_upstream_provider_gets_the_request_it_documents_and_its_reply_is_trimmed() {
    // (kind, path, how the key travels, the upload field, a field the provider needs)
    let table: [(ApiKind, &str, &str, &str, (&str, &str)); 5] = [
        (ApiKind::Fish, "/v1/asr", "authorization", "audio", ("ignore_timestamps", "true")),
        (ApiKind::ElevenLabs, "/v1/speech-to-text", "xi-api-key", "file", ("model_id", "scribe_v2")),
        (ApiKind::DeepSeek, "/v1/tools/asr", "authorization", "file", ("-", "-")),
        (ApiKind::OpenAi, "/v1/audio/transcriptions", "authorization", "file", ("model", "whisper-1")),
        (ApiKind::Groq, "/v1/audio/transcriptions", "authorization", "file", ("model", "whisper-large-v3-turbo")),
    ];
    for (kind, path, key_header, file_field, (field, value)) in table {
        let (server, seen) = recording(heard_hello);
        let (p, _) = provider(kind, &server, None);
        let c = clip();
        assert_eq!(p.transcribe(&c, &never), Ok("hello there".to_string()), "{kind:?}");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "{kind:?}: one request");
        let req = &seen[0];
        assert_eq!((req.method.as_str(), req.path.as_str()), ("POST", path), "{kind:?}");
        let sent = req.header(key_header).unwrap_or_else(|| panic!("{kind:?}: no {key_header}"));
        assert!(sent == KEY || sent == format!("Bearer {KEY}"), "{kind:?}: the key travels in {key_header}");
        assert!(req.header("content-type").unwrap().starts_with("multipart/form-data; boundary="), "{kind:?}");
        assert_eq!(multipart_file(&req.body, file_field).as_deref(), Some(&c.wav[..]), "{kind:?}: the whole clip in `{file_field}`");
        if field != "-" {
            assert_eq!(multipart_field(&req.body, field).as_deref(), Some(value), "{kind:?}: {field}");
        }
        if kind == ApiKind::Fish {
            assert_eq!(req.header("model"), Some("transcribe-1-pro"), "Fish takes its model in a header");
        }
        assert!(!String::from_utf8_lossy(&req.path.as_bytes()).contains(KEY), "the key is never in the address");
    }
}

#[test]
fn the_language_the_user_set_is_passed_where_the_provider_takes_one() {
    for (kind, field) in [(ApiKind::OpenAi, "language"), (ApiKind::Groq, "language"), (ApiKind::ElevenLabs, "language_code")] {
        let (server, seen) = recording(heard_hello);
        let (p, _) = provider(kind, &server, Some("vi"));
        p.transcribe(&clip(), &never).unwrap();
        assert_eq!(multipart_field(&seen.lock().unwrap()[0].body, field).as_deref(), Some("vi"), "{kind:?}");
    }
}

#[test]
fn a_refusal_is_one_code_word_and_the_key_is_in_no_audit_line() {
    let table = [(401, "stt_key_rejected"), (403, "stt_key_rejected"), (402, "stt_balance"), (429, "stt_rate_limited"), (400, "stt_audio_refused"), (413, "stt_audio_refused"), (500, "stt_unavailable"), (503, "stt_unavailable")];
    for (status, code) in table {
        let server = Server::start(move |_| FixtureResp::json(status, &format!(r#"{{"message":"echo {KEY}"}}"#)));
        let (p, lines) = provider(ApiKind::OpenAi, &server, None);
        let err = p.transcribe(&clip(), &never).unwrap_err();
        assert_eq!(err.code(), code, "HTTP {status}");
        assert!(!format!("{err:?}{err}").contains(KEY), "an error never carries the remote body");
        assert!(lines.lock().unwrap().iter().all(|l| !l.contains(KEY)), "no audit line carries the key");
    }
}

#[test]
fn a_reply_without_text_is_a_bad_reply_not_an_empty_dictation() {
    for body in ["not json", r#"{"nope":1}"#, r#"{"text":5}"#] {
        let server = Server::start(move |_| FixtureResp::json(200, body));
        let (p, _) = provider(ApiKind::Groq, &server, None);
        assert_eq!(p.transcribe(&clip(), &never).unwrap_err().code(), "stt_bad_reply", "{body}");
    }
}

#[test]
fn an_engine_reaches_only_the_origin_the_user_chose_and_never_follows_a_redirect() {
    let elsewhere = Server::start(|_| FixtureResp::json(200, r#"{"text":"stolen"}"#));
    let to = format!("{}/v1/audio/transcriptions", elsewhere.origin());
    let server = Server::start(move |_| FixtureResp::Full { status: 302, headers: vec![("location".into(), to.clone())], body: Vec::new() });
    let (p, _) = provider(ApiKind::OpenAi, &server, None);
    assert_eq!(p.transcribe(&clip(), &never).unwrap_err().code(), "egress_redirect");
    assert_eq!(elsewhere.hits(), 0, "the audio and the key did not travel to another host");
}

#[test]
fn a_public_engine_needs_https_and_a_key_is_required() {
    let (a, _) = audit();
    let plain = ApiProvider::new(ApiKind::OpenAi, Some("http://example.com/v1"), KEY, None, None, a.clone());
    assert_eq!(plain.err().map(|e| e.code()), Some("egress_scheme"), "plain http only for an address on this PC");
    let nokey = ApiProvider::new(ApiKind::Fish, None, "", None, None, a.clone());
    assert_eq!(nokey.err().map(|e| e.code()), Some("stt_key_missing"));
    assert!(ApiProvider::new(ApiKind::Fish, None, KEY, None, None, a).is_ok(), "the public API address is the default");
}

#[test]
fn cancel_ends_a_slow_call_quickly() {
    let server = Server::start(|_| {
        std::thread::sleep(Duration::from_secs(3));
        FixtureResp::json(200, r#"{"text":"late"}"#)
    });
    let (p, _) = provider(ApiKind::OpenAi, &server, None);
    let t0 = Instant::now();
    let err = p.transcribe(&clip(), &|| t0.elapsed() > Duration::from_millis(150)).unwrap_err();
    assert_eq!(err.code(), "stt_cancelled");
    assert!(t0.elapsed() < Duration::from_secs(2), "{:?}", t0.elapsed());
}

#[test]
fn deepseek_hears_at_most_120_seconds_and_8_mib_and_asks_nothing_when_over() {
    let (server, seen) = recording(heard_hello);
    let (p, _) = provider(ApiKind::DeepSeek, &server, None);
    let long = zumi_stt::Clip { wav: vec![0; 100], seconds: 121.0 };
    assert_eq!(p.transcribe(&long, &never).unwrap_err().code(), "stt_audio_too_long");
    let big = zumi_stt::Clip { wav: vec![0; 8 * 1024 * 1024 + 1], seconds: 10.0 };
    assert_eq!(p.transcribe(&big, &never).unwrap_err().code(), "stt_audio_too_large");
    assert!(seen.lock().unwrap().is_empty(), "nothing was sent");
}

#[test]
fn a_silent_clip_is_never_sent_and_a_spoken_one_is() {
    let (server, seen) = recording(heard_hello);
    let (p, _) = provider(ApiKind::OpenAi, &server, None);
    let stt = Stt::new(Box::new(p));
    assert_eq!(stt.engine(), "openai");
    assert_eq!(stt.transcribe(&silence(44_100, 2.0), &never), Ok(String::new()));
    assert_eq!(server.hits(), 0, "silence costs nothing and leaves nowhere");
    assert_eq!(stt.transcribe(&tone(1.0), &never), Ok("hello there".to_string()));
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[test]
fn the_front_door_refuses_what_is_too_big_or_not_a_wav_before_any_engine() {
    let (server, _) = recording(heard_hello);
    let (p, _) = provider(ApiKind::OpenAi, &server, None);
    let stt = Stt::new(Box::new(p));
    assert_eq!(stt.transcribe(&vec![0u8; zumi_stt::MAX_WAV_BYTES + 1], &never).unwrap_err().code(), "stt_audio_too_large");
    assert_eq!(stt.transcribe(b"RIFF....", &never).unwrap_err().code(), "stt_audio_bad");
    let six_minutes = silence(8_000, 360.0);
    assert_eq!(stt.transcribe(&six_minutes, &never).unwrap_err().code(), "stt_audio_too_long");
    assert_eq!(server.hits(), 0);
}
