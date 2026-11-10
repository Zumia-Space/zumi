// T-31 voice-persist re-gate: a remembered data dir (guest_cdp::resolve_data_dir) that cannot be used must not be
// silent. A release build has no stderr (main.rs windows_subsystem), so `eprintln!` alone would reopen the app data dir
// with no trace: the 06-11 incident again. Instead, for each launch that hits a PointerProblem:
//   - one line goes to <chosen data dir>/logs/data-dir.log (reason code + the remembered folder only when it was a
//     valid path; a rejected pointer's text is never written);
//   - the owner sees ONE native notice per distinct problem (the existing host notice path: MessageBoxW, as the Node
//     consent and phone-pair boxes), so an unplugged drive is told once, not at every start.
use std::path::{Path, PathBuf};

use crate::guest_cdp::PointerProblem;

/// Under `<data dir>/logs/`.
pub const LOG_FILE: &str = "data-dir.log";
/// Under `<data dir>/logs/`: the last problem the owner was shown.
const NOTICED_FILE: &str = "data-dir-notice.txt";

/// Short form for the log and the "already shown" key: the reason code, plus the folder when it was a valid path.
fn describe(problem: &PointerProblem) -> String {
    match &problem.previous {
        Some(previous) => format!("{} {}", problem.reason, previous.display()),
        None => problem.reason.to_string(),
    }
}

/// Log the problem in `data_dir` and return whether the owner must be told (false when this exact problem was shown).
/// If the logs folder cannot be written, the owner is told every time: a notice too many beats a silent switch.
pub fn record(data_dir: &Path, problem: &PointerProblem) -> bool {
    use std::io::Write as _;
    let logs = data_dir.join("logs");
    let key = describe(problem);
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let logged = std::fs::create_dir_all(&logs).is_ok()
        && std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs.join(LOG_FILE))
            .and_then(|mut out| writeln!(out, "{secs} remembered data dir not used: {key}"))
            .is_ok();
    let noticed = logs.join(NOTICED_FILE);
    if logged && std::fs::read_to_string(&noticed).is_ok_and(|shown| shown == key) {
        return false;
    }
    let _ = std::fs::write(&noticed, &key); // a failed write only means the notice comes again next launch
    true
}

/// The notice text (vi + en, like the other host boxes).
pub fn message(current: &Path, problem: &PointerProblem) -> String {
    let pointer = crate::guest_cdp::DATA_DIR_POINTER;
    let (vi_why, en_why) = match &problem.previous {
        Some(previous) => (
            format!("thư mục lần trước {} không tìm thấy", previous.display()),
            format!("your previous folder {} was not found", previous.display()),
        ),
        None => (
            format!("không dùng được thư mục đã nhớ ({})", problem.reason),
            format!("the remembered folder could not be used ({})", problem.reason),
        ),
    };
    format!(
        concat!(
            "Zumi đang dùng thư mục dữ liệu khác lần trước: {cur}; {vi_why}.\n\n",
            "Cắm lại ổ đĩa rồi mở lại Zumi để dùng thư mục cũ, hoặc xoá {pointer} cạnh file .exe của Zumi để giữ thư mục này.",
            "\n\n----\n\n",
            "Zumi is using a different data folder than last time: {cur}; {en_why}.\n\n",
            "Reconnect the drive and restart Zumi to use it again, or delete {pointer} beside the Zumi .exe to keep this folder."
        ),
        cur = current.display(),
        vi_why = vi_why,
        en_why = en_why,
        pointer = pointer,
    )
}

/// Show the notice without blocking start-up (its own thread; the app window may not exist yet).
#[cfg(windows)]
pub fn show(text: String) {
    std::thread::spawn(move || {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONWARNING, MB_OK, MB_TOPMOST};
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (text, title) = (wide(&text), wide("Zumi - thư mục dữ liệu / data folder"));
        // SAFETY: both buffers are NUL-terminated and live across the call; a null owner window is allowed.
        unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONWARNING | MB_TOPMOST) };
    });
}
#[cfg(not(windows))]
pub fn show(text: String) {
    eprintln!("zumi: {text}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_unusable_pointer_is_logged_in_the_chosen_data_dir_and_shown_once() {
        let data = scratch("zumi-notice");
        let gone = PointerProblem { reason: "folder_not_found", previous: Some(PathBuf::from("E:/old-zumi/data")) };
        assert!(record(&data, &gone), "the first launch tells the owner");
        let log = std::fs::read_to_string(data.join("logs").join(LOG_FILE)).unwrap_or_default();
        assert_eq!(log.lines().count(), 1, "one line per launch: {log:?}");
        assert!(log.contains("folder_not_found") && log.contains("E:/old-zumi/data"), "{log:?}");
        assert!(!record(&data, &gone), "the same problem is not shown again");
        assert_eq!(std::fs::read_to_string(data.join("logs").join(LOG_FILE)).unwrap().lines().count(), 2, "but every launch is logged");

        let rejected = PointerProblem { reason: "pointer_rejected", previous: None };
        assert!(record(&data, &rejected), "a different problem is shown");
        let last = std::fs::read_to_string(data.join("logs").join(LOG_FILE)).unwrap();
        assert!(last.lines().last().unwrap().ends_with("pointer_rejected"), "a rejected pointer logs its reason code only: {last:?}");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn the_notice_names_both_folders() {
        let gone = PointerProblem { reason: "folder_not_found", previous: Some(PathBuf::from("D:/kit/data")) };
        let text = message(Path::new("E:/ZumiData/space.zumia.preview"), &gone);
        assert!(text.contains("Zumi is using a different data folder than last time: E:/ZumiData/space.zumia.preview"), "{text}");
        assert!(text.contains("your previous folder D:/kit/data was not found"), "{text}");
        assert!(text.contains(crate::guest_cdp::DATA_DIR_POINTER), "the notice says how to keep this folder: {text}");
        let rejected = message(Path::new("C:/x"), &PointerProblem { reason: "pointer_rejected", previous: None });
        assert!(rejected.contains("C:/x") && rejected.contains("pointer_rejected"), "{rejected}");
    }
}
