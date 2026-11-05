// The self-test network log (Electron's `net` in selftest:board-log, a session webRequest log): every network request
// a GUEST webview makes, as `scheme://host[:port]/path` (no query, no fragment). Off unless a self-test launch turned
// it on, so a normal launch records nothing. The sidecar reads it through `__sidecarHost.netLog`; the selftest's
// network check needs it to tell "no request left loopback" from "nothing was observed" (box re-probe 2ef16d1).
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::Url;

/// Far above one run's traffic; the oldest entries stay (a bound, not a ring).
const CAP: usize = 5000;
static ON: AtomicBool = AtomicBool::new(false);
static ENTRIES: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn enable() {
    ON.store(true, Ordering::SeqCst);
}

pub fn record(uri: &str) {
    if !ON.load(Ordering::SeqCst) {
        return;
    }
    let Ok(url) = Url::parse(uri) else { return };
    if !crate::guest_guard::is_network_scheme(url.scheme()) {
        return;
    }
    let mut entry = format!("{}://{}", url.scheme(), url.host_str().unwrap_or(""));
    if let Some(port) = url.port() {
        entry.push_str(&format!(":{port}"));
    }
    entry.push_str(url.path());
    let mut entries = ENTRIES.lock().unwrap();
    if entries.len() < CAP {
        entries.push(entry);
    }
}

pub fn snapshot() -> Vec<String> {
    ENTRIES.lock().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_records_only_when_on_and_only_network_urls_without_query() {
        ON.store(false, Ordering::SeqCst);
        ENTRIES.lock().unwrap().clear();
        record("http://127.0.0.1:4212/a");
        assert!(snapshot().is_empty(), "a normal launch records nothing");
        enable();
        record("http://127.0.0.1:4212/api/tasks?token=secret#x");
        record("https://example.com/");
        record("data:text/plain,hi");
        record("about:blank");
        record("not a url");
        assert_eq!(snapshot(), vec!["http://127.0.0.1:4212/api/tasks".to_string(), "https://example.com/".to_string()]);
        ON.store(false, Ordering::SeqCst);
        ENTRIES.lock().unwrap().clear();
    }
}
