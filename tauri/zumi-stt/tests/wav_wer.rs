//! Audio in and the T58 measure: WAV parse / resample / silence, and word error rate.
mod common;
use common::*;
use zumi_stt::wav::{self, Pcm};
use zumi_stt::wer::{wer, words};

#[test]
fn a_22050_hz_clip_becomes_16000_hz_mono_with_the_same_length_in_seconds() {
    if held_clips_absent("a_22050_hz_clip_becomes_16000_hz_mono_with_the_same_length_in_seconds") {
        return;
    }
    let pcm = wav::parse(&fixture("vi-chon-phuong-an-mot.wav")).unwrap();
    assert_eq!(pcm.rate, 22_050);
    let out = wav::to_16k_mono(&pcm);
    assert_eq!(out.rate, 16_000);
    assert!((out.seconds() - pcm.seconds()).abs() < 0.001, "{} vs {}", out.seconds(), pcm.seconds());
    assert!(!wav::is_silent(&out), "a spoken phrase is not silence");
}

#[test]
fn encode_then_parse_gives_the_same_samples_and_a_44_byte_header() {
    let pcm = Pcm { rate: 16_000, samples: (0..1000).map(|i| (i * 7 % 2000) as i16 - 1000).collect() };
    let bytes = wav::encode(&pcm);
    assert_eq!(bytes.len(), 44 + 2000);
    assert_eq!(wav::parse(&bytes).unwrap(), pcm);
}

#[test]
fn stereo_is_averaged_to_mono() {
    let bytes = wav_bytes(16_000, 2, &[1000, 3000, -2000, -4000]);
    assert_eq!(wav::parse(&bytes).unwrap().samples, vec![2000, -3000]);
}

#[test]
fn what_is_not_a_16_bit_pcm_wav_is_refused_with_one_code_word() {
    assert_eq!(wav::parse(b"not a wav at all").unwrap_err().code(), "stt_audio_bad");
    let mut eight_bit = wav_bytes(16_000, 1, &[0; 10]);
    eight_bit[34] = 8; // bits per sample
    assert_eq!(wav::parse(&eight_bit).unwrap_err().code(), "stt_audio_bad");
    let mut float = wav_bytes(16_000, 1, &[0; 10]);
    float[20] = 3; // format tag: IEEE float
    assert_eq!(wav::parse(&float).unwrap_err().code(), "stt_audio_bad");
    let truncated = &wav_bytes(16_000, 1, &[0; 100])[..30];
    assert_eq!(wav::parse(truncated).unwrap_err().code(), "stt_audio_bad");
}

#[test]
fn silence_and_a_quiet_room_are_silent_a_tone_is_not() {
    assert!(wav::is_silent(&wav::parse(&silence(16_000, 1.0)).unwrap()));
    let hiss: Vec<i16> = (0..16_000).map(|i| if i % 2 == 0 { 20 } else { -20 }).collect();
    assert!(wav::is_silent(&wav::parse(&wav_bytes(16_000, 1, &hiss)).unwrap()), "a very quiet room");
    assert!(!wav::is_silent(&wav::parse(&tone(1.0)).unwrap()));
}

#[test]
fn word_error_rate_counts_substitutions_deletions_and_insertions() {
    assert_eq!(wer("one two three four", "one two three four"), 0.0);
    assert!((wer("one two three four", "one x three four") - 0.25).abs() < 1e-9, "one substitution");
    assert!((wer("one two three four", "one three four") - 0.25).abs() < 1e-9, "one deletion");
    assert!((wer("one two three four", "one two three four five") - 0.25).abs() < 1e-9, "one insertion");
    assert_eq!(wer("one two", ""), 1.0, "nothing heard");
}

#[test]
fn word_error_rate_ignores_case_and_punctuation_but_keeps_vietnamese_marks() {
    assert_eq!(words("Chọn phương án một."), vec!["chọn", "phương", "án", "một"]);
    assert_eq!(wer("Chọn phương án một", "chọn, phương án một!"), 0.0);
    assert!(wer("Chọn phương án một", "chon phuong an mot") > 0.9, "a stripped mark is a different word");
    assert_eq!(wer("", ""), 0.0);
}
