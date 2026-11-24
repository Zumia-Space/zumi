//! First-use install of the local engine (T-31-MAUS R4c). The reference app ships no speech engine and installs its local
//! one on first use ("Setting up transcription (one-time...)" in its meeting-notes code); this does the same, but only when the
//! owner clicks, and with every download pinned:
//!   - nothing is bundled in the installer; the owner sees the size first;
//!   - each item has a pinned URL, size and sha256; a download that does not match is deleted and nothing is placed;
//!   - the bytes arrive in `<data dir>/whisper-dl` (NOT the allow-listed folder) and resume where a lost connection or a crash stopped
//!     them; the owner's cancel deletes them;
//!     only a verified file is moved into `<data dir>/whisper`, so a failure leaves no partial file where the program is looked up;
//!   - all traffic goes through zumi-egress; a redirect (the CDNs sign their own addresses) is followed here, hop by hop, only
//!     to https hosts the caller allows (`redirect_hosts_ok`: a short list);
//!   - the runtimes the program needs (Visual C++, a Vulkan driver) are never installed by this: the program is started once
//!     after the install, and a "cannot start" answer is reported as `stt_local_runtime_missing`.
//!
//! Every failure is one code word: `stt_install_network | _http | _redirect | _hash | _size | _write | _unpack`, the egress words
//! (`egress_*`), or `stt_cancelled`.
use crate::policy::WHISPER_EXE_NAME;
use crate::{local, SttError};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use url::{Host, Url};
use zumi_egress::{Egress, EgressError, Request};

/// The folder the program and the model are placed in (the policy's second known folder).
pub const WHISPER_DIR: &str = "whisper";
/// Where downloads wait until they are verified. Not on the policy's list: nothing here can be started.
pub const PART_DIR: &str = "whisper-dl";

/// The commit of ggerganov/whisper.cpp (Hugging Face) the models are read at: the URL cannot change under the pin.
const MODEL_COMMIT: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";

/// The default model (R4d, CoS option c of GATE-OPUS-R4C, 19-11): ggml-small q5_1, MIT. About 9 s a phrase at 4 threads on the CPU
/// build; large-v3-turbo took about 40 s (`stt-cpu-default-usable`). sha256 and size equal the LFS object the hub reports for that
/// commit (`x-linked-etag`, `x-linked-size`), checked by one real download 19-11.
const MODEL_FILE: &str = "ggml-small-q5_1.bin";
const MODEL_SHA256: &str = "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb";
const MODEL_BYTES: u64 = 190_085_487;

/// The optional model: large-v3-turbo q5_0. Better on Vietnamese but too slow for dictation without a GPU; the card warns before
/// the owner picks it. Same hub commit; sha256 equal to the hub's LFS hash and to the owner's own copy of the model.
const TURBO_FILE: &str = "ggml-large-v3-turbo-q5_0.bin";
const TURBO_SHA256: &str = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2";
const TURBO_BYTES: u64 = 574_041_195;

fn model_item(file: &str, sha256: &str, bytes: u64) -> Item {
    Item {
        id: "model",
        file: file.to_string(),
        url: format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/{MODEL_COMMIT}/{file}"),
        sha256: sha256.to_string(),
        bytes,
        disk: bytes,
        place: Place::File,
    }
}

/// The program: the official whisper.cpp release asset for Windows x64 (CPU build; CoS option B, 19-11, Vulkan acceleration is
/// deferred). Release `b5454` is the build of the commit tagged v1.9.5 (the stable tag has no assets), the version line of the local
/// build (its whisper.dll says 1.9.5). The sha256 and size are those of the zip downloaded 19-11 (also GitHub's own digest).
const PROGRAM_URL: &str = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip";
const PROGRAM_FILE: &str = "whisper-bin-x64.zip";
const PROGRAM_SHA256: &str = "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb";
const PROGRAM_BYTES: u64 = 8_928_640;
/// What the listed files take once unpacked.
const PROGRAM_DISK: u64 = 11_603_968;
/// The only files placed from the zip (it holds other programs, a llama dll and SDL2 that dictation does not use). ggml loads
/// every `ggml-cpu-*.dll` it finds beside the program and runs the best one for this PC, so all nine are listed.
const PROGRAM_FILES: [&str; 13] = [
    "Release/whisper-cli.exe",
    "Release/whisper.dll",
    "Release/ggml.dll",
    "Release/ggml-base.dll",
    "Release/ggml-cpu-x64.dll",
    "Release/ggml-cpu-sse42.dll",
    "Release/ggml-cpu-sandybridge.dll",
    "Release/ggml-cpu-haswell.dll",
    "Release/ggml-cpu-skylakex.dll",
    "Release/ggml-cpu-cannonlake.dll",
    "Release/ggml-cpu-cascadelake.dll",
    "Release/ggml-cpu-icelake.dll",
    "Release/ggml-cpu-alderlake.dll",
];

/// A download is sent on at most this many times (the CDNs use one hop; a loop ends).
const MAX_HOPS: usize = 4;
/// The whole of one request, connect to last byte (a 574 MB model on a slow line).
const REQUEST_LIMIT: Duration = Duration::from_secs(6 * 3600);
/// Progress is told to the page at most this often.
const REPORT_EVERY: Duration = Duration::from_millis(200);
const TAR_LIMIT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Place {
    /// The download is the file.
    File,
    /// The download is a zip; these paths inside it are placed, flat, in the folder (nothing else is unpacked into it).
    Zip(Vec<&'static str>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    /// `model` | `program`.
    pub id: &'static str,
    /// The file name of the download (and, for `Place::File`, of the placed file).
    pub file: String,
    pub url: String,
    pub sha256: String,
    /// Exact size of the download.
    pub bytes: u64,
    /// What it takes on disk once placed.
    pub disk: u64,
    pub place: Place,
}

impl Item {
    /// The file names this item leaves in the folder.
    fn outputs(&self) -> Vec<String> {
        match &self.place {
            Place::File => vec![self.file.clone()],
            Place::Zip(inner) => inner.iter().map(|p| p.rsplit('/').next().unwrap_or(p).to_string()).collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Manifest {
    /// What the install downloads by default.
    pub items: Vec<Item>,
    /// A larger speech model the owner may choose instead of the default one (same id `model`; it replaces that item).
    pub optional_model: Option<Item>,
}

impl Manifest {
    /// What the app downloads: the default model (Hugging Face, commit-pinned URL; turbo is the optional one) and the official CPU program (GitHub release asset).
    /// The Vulkan build the engine was first measured with is a local build with no public address; it is deferred (RESULT-R4C-1911.md).
    pub fn pinned() -> Manifest {
        Manifest {
            optional_model: Some(model_item(TURBO_FILE, TURBO_SHA256, TURBO_BYTES)),
            items: vec![
                model_item(MODEL_FILE, MODEL_SHA256, MODEL_BYTES),
                Item {
                    id: "program",
                    file: PROGRAM_FILE.to_string(),
                    url: PROGRAM_URL.to_string(),
                    sha256: PROGRAM_SHA256.to_string(),
                    bytes: PROGRAM_BYTES,
                    disk: PROGRAM_DISK,
                    place: Place::Zip(PROGRAM_FILES.to_vec()),
                },
            ],
        }
    }

    /// The manifest with the optional model in place of the default one (`None` when there is no optional model).
    pub fn with_optional_model(&self) -> Option<Manifest> {
        let optional = self.optional_model.clone()?;
        let items = self.items.iter().map(|i| if i.id == optional.id { optional.clone() } else { i.clone() }).collect();
        Some(Manifest { items, optional_model: None })
    }

    /// What is missing for the engine to work: `program` (nothing places `whisper-cli.exe`) and/or `model` (no `.bin`).
    pub fn unpublished(&self) -> Vec<&'static str> {
        let outputs: Vec<String> = self.items.iter().flat_map(Item::outputs).collect();
        let mut missing = Vec::new();
        if !outputs.iter().any(|o| o.eq_ignore_ascii_case(WHISPER_EXE_NAME)) {
            missing.push("program");
        }
        if !outputs.iter().any(|o| o.to_ascii_lowercase().ends_with(".bin")) {
            missing.push("model");
        }
        missing
    }

    pub fn download_bytes(&self) -> u64 {
        self.items.iter().map(|i| i.bytes).sum()
    }

    pub fn disk_bytes(&self) -> u64 {
        self.items.iter().map(|i| i.disk).sum()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Download,
    Verify,
    Unpack,
    Check,
}

impl Phase {
    pub fn id(self) -> &'static str {
        match self {
            Phase::Download => "download",
            Phase::Verify => "verify",
            Phase::Unpack => "unpack",
            Phase::Check => "check",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    pub item: &'static str,
    pub phase: Phase,
    pub done: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    /// The program was placed but cannot start here (Visual C++ runtime or a Vulkan driver is missing).
    pub runtime_missing: bool,
}

/// Is `url` a place a download may be sent on to?
pub type RedirectOk = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// The addresses the pinned downloads may be redirected to: https (default port, no user name) on Hugging Face and its CDN
/// (`hf.co`) for the model, GitHub and its release-asset host for the program.
pub fn redirect_hosts_ok(url: &str) -> bool {
    const HOSTS: [&str; 4] = ["huggingface.co", "hf.co", "github.com", "githubusercontent.com"];
    let Ok(u) = Url::parse(url) else { return false };
    let Some(Host::Domain(host)) = u.host() else { return false };
    let host = host.to_ascii_lowercase();
    u.scheme() == "https"
        && u.username().is_empty()
        && u.password().is_none()
        && u.port().is_none()
        && HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

pub struct Installer {
    pub data_dir: PathBuf,
    pub manifest: Manifest,
    pub audit: Arc<dyn Fn(&str) + Send + Sync>,
    pub redirect_ok: RedirectOk,
    /// Tries per item for a dropped connection (the bytes already received are kept between them).
    pub attempts: u32,
}

const WRITE: SttError = SttError("stt_install_write");
const NETWORK: SttError = SttError("stt_install_network");
const CANCELLED: SttError = SttError("stt_cancelled");

fn egress_word(e: EgressError) -> SttError {
    match e {
        EgressError::Cancelled => CANCELLED,
        EgressError::Refused(code) => SttError(code),
        EgressError::Timeout | EgressError::Network | EgressError::TooLarge => NETWORK,
    }
}

/// What one download request has received so far (shared by the head and chunk callbacks of one call).
#[derive(Default)]
struct Pull {
    file: Option<File>,
    /// The head let the body through (a file was opened for it).
    opened: bool,
    got: u64,
    oversize: bool,
    write_failed: bool,
    last_report: Option<Instant>,
}

impl Installer {
    pub fn whisper_dir(&self) -> PathBuf {
        self.data_dir.join(WHISPER_DIR)
    }

    fn part_dir(&self) -> PathBuf {
        self.data_dir.join(PART_DIR)
    }

    fn part_path(&self, item: &Item) -> PathBuf {
        self.part_dir().join(format!("{}.part", item.file))
    }

    /// The item's files are in the folder (a model at its exact size; a program's files all present).
    fn item_present(&self, item: &Item) -> bool {
        let w = self.whisper_dir();
        match &item.place {
            Place::File => std::fs::metadata(w.join(&item.file)).is_ok_and(|m| m.len() == item.bytes),
            Place::Zip(_) => item.outputs().iter().all(|o| w.join(o).is_file()),
        }
    }

    /// Every file of the manifest is in the folder.
    pub fn installed(&self) -> bool {
        !self.manifest.items.is_empty() && self.manifest.items.iter().all(|i| self.item_present(i))
    }

    /// Downloads, verifies and places what is not there yet, then starts the program once to see that it runs here.
    pub fn run(&self, progress: &dyn Fn(Progress), cancel: &dyn Fn() -> bool) -> Result<Outcome, SttError> {
        for item in &self.manifest.items {
            if self.item_present(item) {
                continue;
            }
            let done = self.fetch(item, progress, cancel).and_then(|part| self.place(item, &part, progress, cancel));
            if let Err(e) = done {
                // The owner's cancel discards what was downloaded (it can be 574 MB). A lost connection or a crash is not a cancel:
                // those keep the part, and the next start asks only for the rest.
                if e == CANCELLED {
                    let _ = std::fs::remove_file(self.part_path(item));
                }
                return Err(e);
            }
        }
        let exe = self.whisper_dir().join(WHISPER_EXE_NAME);
        let places_program = self.manifest.items.iter().flat_map(Item::outputs).any(|o| o.eq_ignore_ascii_case(WHISPER_EXE_NAME));
        let runtime_missing = places_program && exe.is_file() && {
            progress(Progress { item: "program", phase: Phase::Check, done: 0, total: 0 });
            local::probe(&exe).is_err_and(|e| e.code() == "stt_local_runtime_missing")
        };
        Ok(Outcome { runtime_missing })
    }

    /// The verified download, in `<data dir>/whisper-dl/<file>.part`.
    fn fetch(&self, item: &Item, progress: &dyn Fn(Progress), cancel: &dyn Fn() -> bool) -> Result<PathBuf, SttError> {
        std::fs::create_dir_all(self.part_dir()).map_err(|_| WRITE)?;
        let part = self.part_path(item);
        let mut last = NETWORK;
        for attempt in 0..self.attempts.max(1) {
            if attempt > 0 {
                // A dropped connection: wait a moment, then ask for the rest.
                let until = Instant::now() + Duration::from_secs(1);
                while Instant::now() < until {
                    if cancel() {
                        return Err(CANCELLED);
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
            match self.pull(item, &part, progress, cancel) {
                Ok(()) => return self.verify(item, &part, progress, cancel).map(|()| part),
                Err(e) if e == NETWORK => last = e,
                Err(e) => return Err(e),
            }
        }
        Err(last)
    }

    /// One pass at the download: the bytes after what `part` already holds are appended to it.
    fn pull(&self, item: &Item, part: &Path, progress: &dyn Fn(Progress), cancel: &dyn Fn() -> bool) -> Result<(), SttError> {
        let mut have = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
        if have > item.bytes {
            let _ = std::fs::remove_file(part);
            have = 0;
        }
        if have == item.bytes {
            return Ok(());
        }
        let mut egress = Egress::new(self.audit.clone());
        let mut url = item.url.clone();
        for hop in 0..=MAX_HOPS {
            egress.add_user_origin(&url).map_err(egress_word)?;
            let headers = if have > 0 { vec![("range".to_string(), format!("bytes={have}-"))] } else { Vec::new() };
            let mut req = Request::new("GET", &url);
            req.headers = &headers;
            req.timeout = REQUEST_LIMIT;
            req.hand_back_redirect = true;
            let pull = RefCell::new(Pull { got: have, ..Pull::default() });
            let head = egress
                .send_streaming_head(
                    &req,
                    cancel,
                    &mut |h| {
                        let mut p = pull.borrow_mut();
                        let opened = match h.status {
                            // The rest of the file, from where we asked: appended.
                            206 if have > 0 && h.header("content-range").is_some_and(|r| r.starts_with(&format!("bytes {have}-"))) => OpenOptions::new().append(true).open(part),
                            // A server that ignored the range sends everything: the old bytes are dropped, not glued to.
                            200 => {
                                p.got = 0;
                                File::create(part)
                            }
                            _ => return false,
                        };
                        match opened {
                            Ok(f) => {
                                p.file = Some(f);
                                p.opened = true;
                                true
                            }
                            Err(_) => {
                                p.write_failed = true;
                                false
                            }
                        }
                    },
                    &mut |chunk| {
                        let mut p = pull.borrow_mut();
                        let Some(file) = p.file.as_mut() else { return false };
                        if file.write_all(chunk).is_err() {
                            p.write_failed = true;
                            return false;
                        }
                        p.got += chunk.len() as u64;
                        if p.got > item.bytes {
                            p.oversize = true;
                            return false;
                        }
                        let due = p.last_report.is_none_or(|t| t.elapsed() >= REPORT_EVERY) || p.got == item.bytes;
                        if due {
                            p.last_report = Some(Instant::now());
                            progress(Progress { item: item.id, phase: Phase::Download, done: p.got, total: item.bytes });
                        }
                        true
                    },
                )
                .map_err(egress_word)?;
            let p = pull.into_inner();
            drop(p.file);
            if p.write_failed {
                return Err(WRITE);
            }
            if p.oversize {
                let _ = std::fs::remove_file(part);
                return Err(SttError("stt_install_size"));
            }
            match head.status {
                301 | 302 | 303 | 307 | 308 => {
                    let next = head
                        .header("location")
                        .and_then(|l| Url::parse(&url).ok()?.join(l).ok())
                        .map(String::from)
                        .filter(|n| (self.redirect_ok)(n))
                        .ok_or(SttError("stt_install_redirect"))?;
                    if hop == MAX_HOPS {
                        return Err(SttError("stt_install_redirect"));
                    }
                    url = next;
                }
                // The range does not fit what is kept: start that file over.
                416 if have > 0 => {
                    let _ = std::fs::remove_file(part);
                    have = 0;
                }
                200 | 206 if p.opened => {
                    return if p.got == item.bytes { Ok(()) } else { Err(NETWORK) };
                }
                _ => return Err(SttError("stt_install_http")),
            }
        }
        Err(SttError("stt_install_redirect"))
    }

    /// The part is the size and the sha256 that were pinned, or it is deleted.
    fn verify(&self, item: &Item, part: &Path, progress: &dyn Fn(Progress), cancel: &dyn Fn() -> bool) -> Result<(), SttError> {
        let size = std::fs::metadata(part).map_err(|_| WRITE)?.len();
        if size != item.bytes {
            let _ = std::fs::remove_file(part);
            return Err(SttError("stt_install_size"));
        }
        let mut file = File::open(part).map_err(|_| WRITE)?;
        let (mut hasher, mut buf, mut done, mut last) = (Sha256::new(), vec![0u8; 1 << 20], 0u64, Instant::now());
        loop {
            if cancel() {
                return Err(CANCELLED);
            }
            let n = file.read(&mut buf).map_err(|_| WRITE)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            done += n as u64;
            if last.elapsed() >= REPORT_EVERY {
                last = Instant::now();
                progress(Progress { item: item.id, phase: Phase::Verify, done, total: size });
            }
        }
        progress(Progress { item: item.id, phase: Phase::Verify, done: size, total: size });
        drop(file);
        let got: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if got != item.sha256.to_ascii_lowercase() {
            let _ = std::fs::remove_file(part);
            return Err(SttError("stt_install_hash"));
        }
        Ok(())
    }

    /// Moves a verified download into the folder (a zip: only its listed files, the program last).
    fn place(&self, item: &Item, part: &Path, progress: &dyn Fn(Progress), cancel: &dyn Fn() -> bool) -> Result<(), SttError> {
        let folder = self.whisper_dir();
        std::fs::create_dir_all(&folder).map_err(|_| WRITE)?;
        match &item.place {
            Place::File => {
                let dest = folder.join(&item.file);
                let _ = std::fs::remove_file(&dest);
                std::fs::rename(part, &dest).map_err(|_| WRITE)
            }
            Place::Zip(inner) => {
                let stage = self.part_dir().join(format!("stage-{}", item.id));
                let _ = std::fs::remove_dir_all(&stage);
                std::fs::create_dir_all(&stage).map_err(|_| WRITE)?;
                progress(Progress { item: item.id, phase: Phase::Unpack, done: 0, total: inner.len() as u64 });
                let placed = unzip(part, &stage, cancel).and_then(|()| {
                    // Everything listed must be there before anything is moved: no half-placed program.
                    let moves: Vec<(PathBuf, PathBuf)> = inner
                        .iter()
                        .map(|p| (stage.join(p), folder.join(p.rsplit('/').next().unwrap_or(p))))
                        .collect();
                    if moves.iter().any(|(from, _)| !from.is_file()) {
                        return Err(SttError("stt_install_unpack"));
                    }
                    // The program last: its presence means the files it loads are already there.
                    let (exe, rest): (Vec<_>, Vec<_>) = moves.into_iter().partition(|(_, to)| to.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(WHISPER_EXE_NAME)));
                    for (from, to) in rest.into_iter().chain(exe) {
                        let _ = std::fs::remove_file(&to);
                        std::fs::rename(&from, &to).map_err(|_| WRITE)?;
                    }
                    Ok(())
                });
                let _ = std::fs::remove_dir_all(&stage);
                placed?;
                let _ = std::fs::remove_file(part);
                progress(Progress { item: item.id, phase: Phase::Unpack, done: inner.len() as u64, total: inner.len() as u64 });
                Ok(())
            }
        }
    }
}

/// Windows ships `tar.exe` (bsdtar), which reads zip and refuses names that climb out of the folder.
fn unzip(zip: &Path, into: &Path, cancel: &dyn Fn() -> bool) -> Result<(), SttError> {
    const BAD: SttError = SttError("stt_install_unpack");
    let tar = match std::env::var_os("SystemRoot") {
        Some(root) if cfg!(windows) => PathBuf::from(root).join("System32").join("tar.exe"),
        _ => PathBuf::from("tar"),
    };
    let mut cmd = Command::new(tar);
    cmd.arg("-xf").arg(zip).arg("-C").arg(into).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|_| BAD)?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return if status.success() { Ok(()) } else { Err(BAD) },
            Ok(None) if cancel() => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CANCELLED);
            }
            Ok(None) if started.elapsed() > TAR_LIMIT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(BAD);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return Err(BAD),
        }
    }
}
