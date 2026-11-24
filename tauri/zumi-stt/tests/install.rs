//! R4c: first-use install of the local engine. Every download in these tests comes from a fake server on this PC (the egress
//! fixture); the 574 MB model is never fetched here. One ignored test downloads the small official whisper.cpp zip for real.
//! Needs `--features fixture` (the fake whisper CLI goes into the zip).
mod common;
use common::*;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use zumi_egress::fixture::{FixtureResp, Server};
use zumi_stt::install::{redirect_hosts_ok, Installer, Item, Manifest, Phase, Place, Progress, PART_DIR, WHISPER_DIR};

const FAKE: &str = env!("CARGO_BIN_EXE_fake-whisper-cli");

fn model_item(url: String, data: &[u8]) -> Item {
    Item { id: "model", file: "ggml-test.bin".into(), url, sha256: sha256_hex(data), bytes: data.len() as u64, disk: data.len() as u64, place: Place::File }
}

fn program_item(url: String, zip: &[u8], files: Vec<&'static str>) -> Item {
    Item { id: "program", file: "prog.zip".into(), url, sha256: sha256_hex(zip), bytes: zip.len() as u64, disk: 0, place: Place::Zip(files) }
}

fn installer(dir: &Path, items: Vec<Item>) -> Installer {
    Installer {
        data_dir: dir.join("data"),
        manifest: Manifest { items, ..Manifest::default() },
        audit: Arc::new(|_| {}),
        redirect_ok: Arc::new(|u| u.starts_with("http://127.0.0.1:")),
        attempts: 2,
    }
}

fn never() -> bool {
    false
}

fn names(dir: &Path) -> Vec<String> {
    let mut n: Vec<String> = std::fs::read_dir(dir).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default();
    n.sort();
    n
}

fn run_ok(i: &Installer) -> (Result<zumi_stt::install::Outcome, zumi_stt::SttError>, Vec<Progress>) {
    let log = Mutex::new(Vec::new());
    let r = i.run(&|p| log.lock().unwrap().push(p), &never);
    (r, log.into_inner().unwrap())
}

#[test]
fn it_downloads_checks_and_places_the_model_and_the_program() {
    let dir = temp_dir("inst-ok");
    let model = blob(300_000, 1);
    let zip = make_zip(&dir, FAKE, &[]);
    let (m, _) = serve(model.clone());
    let (z, _) = serve(zip.clone());
    let i = installer(&dir, vec![model_item(format!("{}/m", m.origin()), &model), program_item(format!("{}/p", z.origin()), &zip, vec!["whisper-cli.exe", "ggml.dll"])]);
    assert!(!i.installed());
    let (r, progress) = run_ok(&i);
    assert_eq!(r.unwrap().runtime_missing, false, "the program started once after the install");
    let w = i.whisper_dir();
    assert_eq!(w, dir.join("data").join(WHISPER_DIR));
    assert_eq!(names(&w), ["ggml-test.bin", "ggml.dll", "whisper-cli.exe"]);
    assert_eq!(std::fs::read(w.join("ggml-test.bin")).unwrap(), model);
    assert_eq!(std::fs::read(w.join("whisper-cli.exe")).unwrap(), std::fs::read(FAKE).unwrap());
    assert!(names(&dir.join("data").join(PART_DIR)).is_empty(), "no download or staging leftover: {:?}", names(&dir.join("data").join(PART_DIR)));
    assert!(i.installed());
    let last_download = progress.iter().rev().find(|p| p.item == "model" && p.phase == Phase::Download).expect("download progress");
    assert_eq!((last_download.done, last_download.total), (300_000, 300_000));
    for phase in [Phase::Verify, Phase::Unpack, Phase::Check] {
        assert!(progress.iter().any(|p| p.phase == phase), "{phase:?} was reported: {progress:?}");
    }
}

#[test]
fn a_download_that_does_not_match_its_hash_places_nothing_and_is_deleted() {
    let dir = temp_dir("inst-hash");
    let model = blob(100_000, 2);
    let mut other = model.clone();
    other[500] ^= 1;
    let (s, _) = serve(other);
    let i = installer(&dir, vec![model_item(format!("{}/m", s.origin()), &model)]);
    assert_eq!(i.run(&|_| {}, &never).unwrap_err().code(), "stt_install_hash");
    assert!(names(&i.whisper_dir()).is_empty(), "nothing in the allow-listed folder");
    assert!(names(&dir.join("data").join(PART_DIR)).is_empty(), "the bad bytes are not kept");
}

#[test]
fn more_bytes_than_pinned_is_refused_and_deleted() {
    let dir = temp_dir("inst-size");
    let model = blob(100_000, 3);
    let mut more = model.clone();
    more.extend_from_slice(&[1; 1000]);
    let (s, _) = serve(more);
    let i = installer(&dir, vec![model_item(format!("{}/m", s.origin()), &model)]);
    assert_eq!(i.run(&|_| {}, &never).unwrap_err().code(), "stt_install_size");
    assert!(names(&i.whisper_dir()).is_empty());
    assert!(names(&dir.join("data").join(PART_DIR)).is_empty());
}

#[test]
fn a_download_that_stopped_halfway_resumes_from_the_bytes_it_has() {
    let dir = temp_dir("inst-resume");
    let model = blob(300_000, 4);
    let (s, seen) = serve(model.clone());
    let i = installer(&dir, vec![model_item(format!("{}/m", s.origin()), &model)]);
    let part = dir.join("data").join(PART_DIR);
    std::fs::create_dir_all(&part).unwrap();
    std::fs::write(part.join("ggml-test.bin.part"), &model[..120_000]).unwrap();
    i.run(&|_| {}, &never).unwrap();
    assert_eq!(seen.lock().unwrap().as_slice(), [Some("bytes=120000-".to_string())], "only the rest was asked for");
    assert_eq!(std::fs::read(i.whisper_dir().join("ggml-test.bin")).unwrap(), model);
}

/// A slow server: four chunks, the first at once, the rest 400 ms apart.
fn slow_server(model: &[u8]) -> Server {
    let data = model.to_vec();
    Server::start(move |_| FixtureResp::Chunked {
        status: 200,
        headers: Vec::new(),
        chunks: data.chunks(100_000).enumerate().map(|(n, c)| (if n == 0 { 0 } else { 400 }, c.to_vec())).collect(),
    })
}

#[test]
fn cancel_deletes_the_part_file_so_nothing_is_left_on_disk() {
    // R4d (gate should-fix 3): a cancel used to keep up to 574 MB in whisper-dl with no way to discard it.
    let dir = temp_dir("inst-cancel");
    let model = blob(400_000, 5);
    let slow = slow_server(&model);
    let i = installer(&dir, vec![model_item(format!("{}/m", slow.origin()), &model)]);
    let stop = Arc::new(AtomicBool::new(false));
    let s2 = stop.clone();
    let r = i.run(&move |p| if p.phase == Phase::Download && p.done > 0 { s2.store(true, Ordering::SeqCst) }, &move || stop.load(Ordering::SeqCst));
    assert_eq!(r.unwrap_err().code(), "stt_cancelled");
    assert_eq!(names(&dir.join("data").join(PART_DIR)), Vec::<String>::new(), "the part is gone after a cancel");
    assert!(names(&i.whisper_dir()).is_empty(), "nothing in the allow-listed folder after a cancel");
    // The next start is a fresh download: no range is asked for.
    let (fast, seen) = serve(model.clone());
    let again = installer(&dir, vec![model_item(format!("{}/m", fast.origin()), &model)]);
    again.run(&|_| {}, &never).unwrap();
    assert_eq!(seen.lock().unwrap().as_slice(), [None], "a whole file was asked for, not a rest");
    assert_eq!(std::fs::read(again.whisper_dir().join("ggml-test.bin")).unwrap(), model);
}

#[test]
fn a_download_that_ends_early_without_a_cancel_keeps_its_bytes_and_the_next_run_resumes() {
    // A lost connection (or a crash) is not a cancel: the bytes received stay and the next start asks only for the rest.
    let dir = temp_dir("inst-lost");
    let model = blob(400_000, 16);
    let first = model[..150_000].to_vec();
    // A chunked answer that stops after 150 kB: the body ends cleanly but short of the pinned size.
    let short = Server::start(move |_| FixtureResp::Chunked { status: 200, headers: Vec::new(), chunks: vec![(0, first.clone())] });
    let mut i = installer(&dir, vec![model_item(format!("{}/m", short.origin()), &model)]);
    i.attempts = 1;
    assert_eq!(i.run(&|_| {}, &never).unwrap_err().code(), "stt_install_network");
    let part = dir.join("data").join(PART_DIR).join("ggml-test.bin.part");
    assert_eq!(std::fs::metadata(&part).expect("the received bytes are kept").len(), 150_000);
    assert!(names(&i.whisper_dir()).is_empty());
    let (fast, seen) = serve(model.clone());
    let again = installer(&dir, vec![model_item(format!("{}/m", fast.origin()), &model)]);
    again.run(&|_| {}, &never).unwrap();
    assert_eq!(seen.lock().unwrap().as_slice(), [Some("bytes=150000-".to_string())], "only the rest was asked for");
    assert_eq!(std::fs::read(again.whisper_dir().join("ggml-test.bin")).unwrap(), model);
}

#[test]
fn a_server_that_ignores_the_range_starts_over_instead_of_gluing_the_answer_on() {
    let dir = temp_dir("inst-norange");
    let model = blob(200_000, 6);
    let data = model.clone();
    let hits = Arc::new(AtomicU64::new(0));
    let h = hits.clone();
    let s = Server::start(move |_| {
        h.fetch_add(1, Ordering::SeqCst);
        FixtureResp::Full { status: 200, headers: Vec::new(), body: data.clone() }
    });
    let i = installer(&dir, vec![model_item(format!("{}/m", s.origin()), &model)]);
    let part = dir.join("data").join(PART_DIR);
    std::fs::create_dir_all(&part).unwrap();
    std::fs::write(part.join("ggml-test.bin.part"), vec![0xAA; 50_000]).unwrap();
    i.run(&|_| {}, &never).unwrap();
    assert_eq!(std::fs::read(i.whisper_dir().join("ggml-test.bin")).unwrap(), model, "the old bytes were dropped, the whole file came");
}

#[test]
fn a_redirect_is_followed_to_an_address_the_caller_allows_and_to_no_other() {
    let dir = temp_dir("inst-redirect");
    let model = blob(100_000, 8);
    let (cdn, cdn_seen) = serve(model.clone());
    let target = format!("{}/signed?sig=1", cdn.origin());
    let hop = Server::start({
        let target = target.clone();
        move |_| FixtureResp::Full { status: 302, headers: vec![("location".into(), target.clone())], body: Vec::new() }
    });
    let i = installer(&dir, vec![model_item(format!("{}/m", hop.origin()), &model)]);
    i.run(&|_| {}, &never).unwrap();
    assert_eq!(std::fs::read(i.whisper_dir().join("ggml-test.bin")).unwrap(), model);
    assert_eq!(cdn_seen.lock().unwrap().len(), 1);

    // The same redirect when the caller does not allow that address: refused, and nothing reached it.
    let dir2 = temp_dir("inst-redirect-no");
    let mut no = installer(&dir2, vec![model_item(format!("{}/m", hop.origin()), &model)]);
    no.redirect_ok = Arc::new(|_| false);
    let hits_before = cdn_seen.lock().unwrap().len();
    assert_eq!(no.run(&|_| {}, &never).unwrap_err().code(), "stt_install_redirect");
    assert_eq!(cdn_seen.lock().unwrap().len(), hits_before, "the refused address was never contacted");
    assert!(names(&no.whisper_dir()).is_empty());
}

#[test]
fn a_redirect_loop_ends() {
    let dir = temp_dir("inst-loop");
    let model = blob(1000, 9);
    let origin = Arc::new(Mutex::new(String::new()));
    let o = origin.clone();
    let s = Server::start(move |_| FixtureResp::Full { status: 302, headers: vec![("location".into(), format!("{}/again", o.lock().unwrap()))], body: Vec::new() });
    *origin.lock().unwrap() = s.origin();
    let i = installer(&dir, vec![model_item(format!("{}/m", s.origin()), &model)]);
    assert_eq!(i.run(&|_| {}, &never).unwrap_err().code(), "stt_install_redirect");
    assert!(s.hits() <= 8, "bounded: {}", s.hits());
}

#[test]
fn an_http_error_is_one_code_word_and_keeps_nothing() {
    let dir = temp_dir("inst-404");
    let model = blob(1000, 10);
    let s = Server::start(|_| FixtureResp::empty(404));
    let i = installer(&dir, vec![model_item(format!("{}/m", s.origin()), &model)]);
    assert_eq!(i.run(&|_| {}, &never).unwrap_err().code(), "stt_install_http");
    assert!(names(&i.whisper_dir()).is_empty());
}

#[test]
fn what_is_already_installed_is_not_downloaded_again() {
    let dir = temp_dir("inst-again");
    let model = blob(100_000, 11);
    let (s, seen) = serve(model.clone());
    let i = installer(&dir, vec![model_item(format!("{}/m", s.origin()), &model)]);
    i.run(&|_| {}, &never).unwrap();
    assert_eq!(seen.lock().unwrap().len(), 1);
    i.run(&|_| {}, &never).unwrap();
    assert_eq!(seen.lock().unwrap().len(), 1, "the second run made no request");
}

#[test]
fn a_program_that_cannot_start_is_reported_not_papered_over() {
    // The zip carries the fake CLI plus the flag the fake reads as "the Visual C++ runtime or the Vulkan driver is missing"
    // (it then exits with Windows' loader error 0xC0000135, as a real program does when a dll is not found).
    let dir = temp_dir("inst-runtime");
    let zip = make_zip(&dir, FAKE, &[("runtime-missing.flag", b"x")]);
    let (z, _) = serve(zip.clone());
    let i = installer(&dir, vec![program_item(format!("{}/p", z.origin()), &zip, vec!["whisper-cli.exe", "ggml.dll", "runtime-missing.flag"])]);
    let out = i.run(&|_| {}, &never).unwrap();
    assert!(out.runtime_missing);
    assert!(i.whisper_dir().join("whisper-cli.exe").is_file(), "the files are still placed: the person installs the runtime and tries again");
}

#[test]
fn a_zip_that_lacks_a_listed_file_places_nothing() {
    let dir = temp_dir("inst-zipmiss");
    let zip = make_zip(&dir, FAKE, &[]);
    let (z, _) = serve(zip.clone());
    let i = installer(&dir, vec![program_item(format!("{}/p", z.origin()), &zip, vec!["whisper-cli.exe", "ggml.dll", "not-in-the-zip.dll"])]);
    assert_eq!(i.run(&|_| {}, &never).unwrap_err().code(), "stt_install_unpack");
    assert!(names(&i.whisper_dir()).is_empty(), "no half-placed program");
}

#[test]
fn only_the_listed_names_leave_the_zip_whatever_else_is_in_it() {
    let dir = temp_dir("inst-zipextra");
    let zip = make_zip(&dir, FAKE, &[("extra.exe", b"not listed")]);
    let (z, _) = serve(zip.clone());
    let i = installer(&dir, vec![program_item(format!("{}/p", z.origin()), &zip, vec!["whisper-cli.exe", "ggml.dll"])]);
    i.run(&|_| {}, &never).unwrap();
    assert_eq!(names(&i.whisper_dir()), ["ggml.dll", "whisper-cli.exe"]);
}

#[test]
fn the_default_model_is_small_q5_1_and_turbo_is_the_optional_one() {
    // R4d (CoS option c, 19-11): large-v3-turbo on CPU took about 40 s per phrase at 4 threads (GATE-OPUS-R4C), so the default is
    // ggml-small q5_1 (MIT). Its sha256 and size are those of one real download made 19-11, equal to the hub's LFS hash (x-linked-etag).
    let m = Manifest::pinned();
    let model = m.items.iter().find(|i| i.id == "model").expect("the model is pinned");
    assert_eq!(model.file, "ggml-small-q5_1.bin");
    assert_eq!(model.bytes, 190_085_487);
    assert_eq!(model.sha256, "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb");
    assert!(model.url.starts_with("https://huggingface.co/ggerganov/whisper.cpp/resolve/"), "{}", model.url);
    let commit = model.url.trim_start_matches("https://huggingface.co/ggerganov/whisper.cpp/resolve/").split('/').next().unwrap();
    assert!(commit.len() == 40 && commit.chars().all(|c| c.is_ascii_hexdigit()), "the URL is pinned to a commit, not a branch: {commit}");
    assert!(model.url.ends_with("/ggml-small-q5_1.bin"));
    // The optional model: large-v3-turbo, same commit, same pins as before R4d. It replaces the model item, never adds a second one.
    let turbo = m.optional_model.as_ref().expect("turbo is offered as an optional download");
    assert_eq!((turbo.id, turbo.file.as_str(), turbo.bytes), ("model", "ggml-large-v3-turbo-q5_0.bin", 574_041_195));
    assert_eq!(turbo.sha256, "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2");
    assert!(turbo.url.starts_with("https://huggingface.co/ggerganov/whisper.cpp/resolve/") && turbo.url.ends_with("/ggml-large-v3-turbo-q5_0.bin"));
    let big = m.with_optional_model().expect("a manifest with turbo in place of small");
    assert_eq!(big.items.iter().filter(|i| i.id == "model").count(), 1);
    assert_eq!(big.items.iter().find(|i| i.id == "model").unwrap().file, "ggml-large-v3-turbo-q5_0.bin");
    assert!(big.items.iter().any(|i| i.id == "program"), "the program is kept");
    assert_eq!(big.download_bytes(), 574_041_195 + 8_928_640);
    assert_eq!(Manifest::default().with_optional_model(), None);
}

#[test]
fn what_the_app_pins_is_the_model_and_the_official_cpu_program() {
    let m = Manifest::pinned();
    // CoS option B (19-11): the official whisper.cpp release CPU zip for Windows x64, the same version line as the local build
    // (whisper.dll says 1.9.5; release tag b5454 is v1.9.5's commit d1be6fd, the one that carries the Windows assets). Vulkan is deferred.
    let program = m.items.iter().find(|i| i.id == "program").expect("the program is pinned");
    assert_eq!(program.url, "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip");
    assert_eq!(program.sha256, "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb", "the sha256 of the zip downloaded 19-11, equal to GitHub's own digest");
    assert_eq!(program.bytes, 8_928_640);
    let Place::Zip(files) = &program.place else { panic!("the program is a zip") };
    assert!(files.contains(&"Release/whisper-cli.exe") && files.contains(&"Release/whisper.dll") && files.contains(&"Release/ggml.dll") && files.contains(&"Release/ggml-base.dll"));
    assert_eq!(files.iter().filter(|f| f.starts_with("Release/ggml-cpu-")).count(), 9, "every CPU backend: ggml picks the best one for this PC at start");
    assert!(files.iter().all(|f| f.starts_with("Release/") && !f.contains("..")), "only listed names inside the folder of the zip");
    assert!(files.iter().all(|f| !f.ends_with(".exe") || f.ends_with("whisper-cli.exe")), "no other program leaves the zip");
    assert_eq!(program.disk, 11_603_968);
    assert_eq!(m.download_bytes(), 190_085_487 + 8_928_640);
    assert_eq!(m.unpublished(), Vec::<&str>::new(), "the pinned manifest places a program and a model");
    assert!(Manifest::default().unpublished().contains(&"model"));
}

#[test]
fn a_redirect_may_go_only_to_https_on_the_hosts_the_pins_use() {
    for ok in ["https://us.aws.cdn.hf.co/xet-bridge-us/x?y=1", "https://cas-bridge.xethub.hf.co/a", "https://huggingface.co/a", "https://release-assets.githubusercontent.com/a", "https://objects.githubusercontent.com/a"] {
        assert!(redirect_hosts_ok(ok), "{ok}");
    }
    for bad in ["http://us.aws.cdn.hf.co/a", "https://evilhf.co/a", "https://hf.co.evil.com/a", "https://huggingface.co@evil.com/a", "https://127.0.0.1/a", "https://localhost/a", "https://evil.com/?https://hf.co/", "file:///C:/x", "not a url"] {
        assert!(!redirect_hosts_ok(bad), "{bad}");
    }
}

/// One real download: the PINNED program (the official whisper.cpp CPU zip, 8.9 MB) through the installer, GitHub's redirect included,
/// then the real `whisper-cli.exe` is started once. The model is not downloaded (574 MB).
/// `cargo test --features fixture --test install -- --ignored --nocapture`.
#[test]
#[ignore = "real network: downloads 8.9 MB from github.com"]
fn real_small_download_of_the_pinned_program() {
    let dir = temp_dir("inst-real");
    let program: Vec<Item> = Manifest::pinned().items.into_iter().filter(|i| i.id == "program").collect();
    assert_eq!(program.len(), 1);
    let i = Installer { data_dir: dir.join("data"), manifest: Manifest { items: program, ..Manifest::default() }, audit: Arc::new(|l| println!("{l}")), redirect_ok: Arc::new(redirect_hosts_ok), attempts: 3 };
    let (r, progress) = run_ok(&i);
    let out = r.expect("the pinned download installs: its sha256 and size match");
    println!("runtime_missing={} progress_reports={}", out.runtime_missing, progress.len());
    assert!(!out.runtime_missing);
    let placed = names(&i.whisper_dir());
    assert_eq!(placed.len(), 13, "{placed:?}");
    assert!(placed.contains(&"whisper-cli.exe".to_string()) && placed.contains(&"ggml-cpu-x64.dll".to_string()));
    let disk: u64 = placed.iter().map(|n| std::fs::metadata(i.whisper_dir().join(n)).unwrap().len()).sum();
    assert_eq!(disk, Manifest::pinned().items.iter().find(|i| i.id == "program").unwrap().disk, "the pinned disk size is what was placed");
}
