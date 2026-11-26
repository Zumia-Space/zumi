//! 16-bit PCM WAV: parse, downmix, resample to 16 kHz mono (what whisper.cpp and the APIs are given), encode.
use crate::SttError;

pub const TARGET_RATE: u32 = 16_000;

/// A 20 ms window whose RMS is below this (of 32768) is a quiet room. Upstream's endpointer uses 0.015 of full scale to END a
/// turn; this one only decides whether the clip holds anything worth asking an engine, so it sits far lower (~0.0037).
const SPEECH_RMS: f64 = 120.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pcm {
    pub rate: u32,
    /// Mono.
    pub samples: Vec<i16>,
}

impl Pcm {
    pub fn seconds(&self) -> f64 {
        self.samples.len() as f64 / self.rate.max(1) as f64
    }
}

const BAD: SttError = SttError("stt_audio_bad");

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}
fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// RIFF/WAVE, 16-bit PCM, one or two channels (two are averaged). A data chunk that claims more than the file holds (a
/// recording cut short, a streamed header) is read as far as it goes.
pub fn parse(bytes: &[u8]) -> Result<Pcm, SttError> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(BAD);
    }
    let mut format: Option<(u16, u32)> = None; // channels, rate
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32_at(bytes, at + 4).ok_or(BAD)? as usize;
        let body = at + 8;
        if id == b"fmt " {
            let tag = u16_at(bytes, body).ok_or(BAD)?;
            let channels = u16_at(bytes, body + 2).ok_or(BAD)?;
            let rate = u32_at(bytes, body + 4).ok_or(BAD)?;
            let bits = u16_at(bytes, body + 14).ok_or(BAD)?;
            // 0xFFFE (extensible) is PCM when its sub-format begins with 1.
            let pcm = tag == 1 || (tag == 0xFFFE && size >= 26 && u16_at(bytes, body + 24) == Some(1));
            if !pcm || bits != 16 || !(1..=2).contains(&channels) || rate == 0 {
                return Err(BAD);
            }
            format = Some((channels, rate));
        } else if id == b"data" {
            let (channels, rate) = format.ok_or(BAD)?;
            let end = body.saturating_add(size).min(bytes.len());
            let raw = &bytes[body..end];
            let frame = 2 * channels as usize;
            let samples = raw
                .chunks_exact(frame)
                .map(|f| {
                    let s: i32 = f.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as i32).sum();
                    (s / channels as i32) as i16
                })
                .collect();
            return Ok(Pcm { rate, samples });
        }
        at = body.saturating_add(size).saturating_add(size & 1);
    }
    Err(BAD)
}

/// 16 kHz: a longer rate is averaged down (each output sample is the mean of the source span it covers, which also keeps
/// what is above 8 kHz from folding into the band), a shorter one is interpolated.
pub fn to_16k_mono(pcm: &Pcm) -> Pcm {
    if pcm.rate == TARGET_RATE || pcm.samples.is_empty() {
        return Pcm { rate: TARGET_RATE, samples: pcm.samples.clone() };
    }
    let ratio = pcm.rate as f64 / TARGET_RATE as f64;
    let n_out = (pcm.samples.len() as f64 / ratio).round() as usize;
    let src = &pcm.samples;
    let last = src.len() - 1;
    let mut out = Vec::with_capacity(n_out);
    for i in 0..n_out {
        let (from, to) = (i as f64 * ratio, (i as f64 + 1.0) * ratio);
        let v = if ratio > 1.0 {
            let (mut sum, mut weight) = (0.0, 0.0);
            let mut j = from.floor() as usize;
            while (j as f64) < to && j <= last {
                let w = (to.min(j as f64 + 1.0) - from.max(j as f64)).max(0.0);
                sum += src[j] as f64 * w;
                weight += w;
                j += 1;
            }
            if weight > 0.0 { sum / weight } else { 0.0 }
        } else {
            let pos = from.min(last as f64);
            let (a, frac) = (pos.floor() as usize, pos - pos.floor());
            let b = (a + 1).min(last);
            src[a] as f64 * (1.0 - frac) + src[b] as f64 * frac
        };
        out.push(v.round().clamp(-32768.0, 32767.0) as i16);
    }
    Pcm { rate: TARGET_RATE, samples: out }
}

/// A canonical 44-byte header and the samples.
pub fn encode(pcm: &Pcm) -> Vec<u8> {
    let data_len = (pcm.samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&pcm.rate.to_le_bytes());
    out.extend_from_slice(&(pcm.rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in &pcm.samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// True when no 20 ms window of the clip is louder than a quiet room.
pub fn is_silent(pcm: &Pcm) -> bool {
    let window = (pcm.rate as usize / 50).max(1);
    !pcm.samples.chunks(window).any(|w| {
        let mean_square = w.iter().map(|s| (*s as f64) * (*s as f64)).sum::<f64>() / w.len() as f64;
        mean_square.sqrt() >= SPEECH_RMS
    })
}
