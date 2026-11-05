// T-31 parity step 4 — the native file dialog for `openModelFile` / `rooms.openFile` (gate GATE-step4.md).
//
// The renderer never sees a path and never supplies one. The `rpc` command intercepts these two method names
// BEFORE the sidecar, drops whatever arguments the page sent, runs the OS dialog here and hands the picked path
// to the sidecar's host-only `__host.importModelPath` / `__host.importRoomPath` (conditions 1-2). The sidecar
// re-validates the file itself (condition 3); this module only refuses obviously malformed paths.
//
// Everything with a side effect is behind `FileDialog`, so the flow is unit-tested with a mock: nothing in the
// test suite opens a dialog.
//
// Backend: IFileOpenDialog through the direct `windows` dep (already in Cargo.lock via tauri/wry/tao), owner =
// the main window, FOS_FILEMUSTEXIST | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR, run on a blocking worker thread in
// its own COM apartment. tauri-plugin-dialog is deliberately not used: it hands raw paths to JavaScript.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;

/// Windows MAX_PATH-extended ceiling (32 767 UTF-16 units); a longer string cannot be a real path.
const MAX_PATH_CHARS: usize = 32_767;

/// Which dialog an intercepted method opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Model,
    Room,
}

/// What the dialog shows. Titles and filters are copied from src/main/main.js (`models:open-file` :740,
/// `rooms:open-file` :758).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Spec {
    pub title: &'static str,
    pub filter_name: &'static str,
    pub filter_pattern: &'static str,
}

impl Kind {
    /// The public rpc names that run a dialog. Any other name is not intercepted.
    pub fn from_method(method: &str) -> Option<Kind> {
        match method {
            "openModelFile" => Some(Kind::Model),
            "rooms.openFile" => Some(Kind::Room),
            _ => None,
        }
    }

    pub fn spec(self) -> Spec {
        match self {
            Kind::Model => Spec { title: "Open VRM file", filter_name: "VRM model", filter_pattern: "*.vrm" },
            Kind::Room => Spec { title: "Open room file", filter_name: "Zumi room", filter_pattern: "*.glb" },
        }
    }

    /// The sidecar's host-only importer for this dialog (not in the inventory, so the page can never call it).
    pub fn host_method(self) -> &'static str {
        match self {
            Kind::Model => "__host.importModelPath",
            Kind::Room => "__host.importRoomPath",
        }
    }
}

/// The OS dialog. `owner` is the main window's HWND as an integer (0 = none). `Ok(None)` is a cancel.
pub trait FileDialog {
    fn pick(&self, owner: isize, spec: &Spec) -> Result<Option<String>, String>;
}

/// Single flight (condition 1): while one dialog is open a second request gets `null` at once, so a double click
/// or a hostile page cannot stack dialogs. Cloning shares the flag.
#[derive(Clone, Default)]
pub struct SingleFlight(Arc<AtomicBool>);

pub struct FlightGuard(Arc<AtomicBool>);

impl SingleFlight {
    pub fn try_acquire(&self) -> Option<FlightGuard> {
        if self.0.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok() {
            Some(FlightGuard(self.0.clone()))
        } else {
            None
        }
    }
}

impl Drop for FlightGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// A picked path must be a plain absolute path of sane length. The sidecar still checks extension, file type and
/// content; this stops a malformed value from ever reaching it.
fn sane_path(p: &str) -> bool {
    !p.is_empty() && p.chars().count() <= MAX_PATH_CHARS && !p.contains('\0') && Path::new(p).is_absolute()
}

/// Run one dialog and import its pick. `call(method, args)` is the sidecar call. The renderer's own arguments are
/// not a parameter here: there is nothing to forward, by construction (condition 2).
pub fn run(
    kind: Kind,
    gate: &SingleFlight,
    dialog: &dyn FileDialog,
    owner: isize,
    call: impl FnOnce(&str, Vec<Value>) -> Result<Value, String>,
) -> Result<Value, String> {
    let Some(_open) = gate.try_acquire() else {
        return Ok(Value::Null);
    };
    let picked = dialog.pick(owner, &kind.spec())?;
    let Some(path) = picked else {
        return Ok(Value::Null);
    };
    if !sane_path(&path) {
        return Err("dialog_bad_path".to_string());
    }
    call(kind.host_method(), vec![Value::String(path)])
}

#[cfg(windows)]
pub use win::WinDialog;

#[cfg(windows)]
mod win {
    use super::{FileDialog, Spec};

    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, SIGDN_FILESYSPATH,
    };

    /// HRESULT_FROM_WIN32(ERROR_CANCELLED): the user closed the dialog.
    const CANCELLED: i32 = 0x8007_04C7_u32 as i32;

    /// The real IFileOpenDialog. Stateless; must be called from a thread that may enter an STA (the `rpc` command
    /// runs it on a `spawn_blocking` worker, never the UI thread).
    pub struct WinDialog;

    impl FileDialog for WinDialog {
        fn pick(&self, owner: isize, spec: &Spec) -> Result<Option<String>, String> {
            // SAFETY: plain COM calls on interfaces this function owns; CoUninitialize pairs with a successful
            // CoInitializeEx (S_OK / S_FALSE both need it). RPC_E_CHANGED_MODE means the thread is already in
            // another apartment: use it as is and do not uninitialize.
            unsafe {
                let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                let _com = ComScope(init.is_ok());
                let dialog: IFileOpenDialog =
                    CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).map_err(|e| format!("dialog_create:{e}"))?;

                let title = HSTRING::from(spec.title);
                let name = HSTRING::from(spec.filter_name);
                let pattern = HSTRING::from(spec.filter_pattern);
                let filters = [COMDLG_FILTERSPEC { pszName: PCWSTR(name.as_ptr()), pszSpec: PCWSTR(pattern.as_ptr()) }];
                dialog.SetTitle(&title).map_err(|e| format!("dialog_title:{e}"))?;
                dialog.SetFileTypes(&filters).map_err(|e| format!("dialog_filter:{e}"))?;
                dialog.SetFileTypeIndex(1).map_err(|e| format!("dialog_filter:{e}"))?;
                let options = dialog.GetOptions().map_err(|e| format!("dialog_options:{e}"))?;
                dialog
                    .SetOptions(options | FOS_FILEMUSTEXIST | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR)
                    .map_err(|e| format!("dialog_options:{e}"))?;

                let hwnd = if owner == 0 { None } else { Some(HWND(owner as *mut core::ffi::c_void)) };
                if let Err(e) = dialog.Show(hwnd) {
                    return if e.code().0 == CANCELLED { Ok(None) } else { Err(format!("dialog_show:{e}")) };
                }
                let item = dialog.GetResult().map_err(|e| format!("dialog_result:{e}"))?;
                let wide = item.GetDisplayName(SIGDN_FILESYSPATH).map_err(|e| format!("dialog_path:{e}"))?;
                let path = wide.to_string().map_err(|_| "dialog_path_utf16".to_string());
                CoTaskMemFree(Some(wide.0 as *const core::ffi::c_void));
                path.map(Some)
            }
        }
    }

    /// Uninitializes COM on drop when this call's CoInitializeEx succeeded.
    struct ComScope(bool);
    impl Drop for ComScope {
        fn drop(&mut self) {
            if self.0 {
                // SAFETY: balances the successful CoInitializeEx above on the same thread.
                unsafe { CoUninitialize() };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use serde_json::json;

    /// Scripted dialog: answers once, records the owner/spec it was given, never opens a window.
    struct Mock {
        answer: Result<Option<String>, String>,
        seen: RefCell<Vec<(isize, Spec)>>,
        before_answer: Option<Box<dyn Fn()>>,
    }
    impl Mock {
        fn new(answer: Result<Option<String>, String>) -> Self {
            Mock { answer, seen: RefCell::new(vec![]), before_answer: None }
        }
    }
    impl FileDialog for Mock {
        fn pick(&self, owner: isize, spec: &Spec) -> Result<Option<String>, String> {
            self.seen.borrow_mut().push((owner, *spec));
            if let Some(f) = &self.before_answer {
                f();
            }
            self.answer.clone()
        }
    }

    fn pick(path: &str) -> Mock {
        Mock::new(Ok(Some(path.to_string())))
    }

    #[test]
    fn only_the_two_dialog_methods_are_intercepted() {
        assert_eq!(Kind::from_method("openModelFile"), Some(Kind::Model));
        assert_eq!(Kind::from_method("rooms.openFile"), Some(Kind::Room));
        for other in ["rooms.select", "listModels", "openBoard", "__host.importModelPath", "openModelFile ", ""] {
            assert_eq!(Kind::from_method(other), None, "{other}");
        }
    }

    #[test]
    fn titles_and_filters_are_the_electron_ones() {
        let m = Kind::Model.spec();
        assert_eq!((m.title, m.filter_name, m.filter_pattern), ("Open VRM file", "VRM model", "*.vrm"));
        let r = Kind::Room.spec();
        assert_eq!((r.title, r.filter_name, r.filter_pattern), ("Open room file", "Zumi room", "*.glb"));
    }

    #[test]
    fn a_pick_goes_to_the_host_only_importer_as_the_only_argument() {
        let gate = SingleFlight::default();
        let dialog = pick("C:\\models\\hero.vrm");
        let mut got: Option<(String, Vec<Value>)> = None;
        let out = run(Kind::Model, &gate, &dialog, 77, |m, a| {
            got = Some((m.to_string(), a));
            Ok(json!({ "selected": "user" }))
        });
        assert_eq!(out, Ok(json!({ "selected": "user" })));
        assert_eq!(got, Some(("__host.importModelPath".to_string(), vec![json!("C:\\models\\hero.vrm")])));
        assert_eq!(dialog.seen.borrow().as_slice(), &[(77, Kind::Model.spec())]);
        let room = pick("C:\\r\\room.glb");
        let mut method = String::new();
        let _ = run(Kind::Room, &gate, &room, 0, |m, _| {
            method = m.to_string();
            Ok(Value::Null)
        });
        assert_eq!(method, "__host.importRoomPath");
    }

    #[test]
    fn a_cancel_is_null_and_never_reaches_the_sidecar() {
        let gate = SingleFlight::default();
        let dialog = Mock::new(Ok(None));
        let called = Cell::new(false);
        let out = run(Kind::Room, &gate, &dialog, 1, |_, _| {
            called.set(true);
            Ok(Value::Null)
        });
        assert_eq!(out, Ok(Value::Null));
        assert!(!called.get());
    }

    #[test]
    fn a_dialog_error_is_an_error_not_a_pick() {
        let gate = SingleFlight::default();
        let dialog = Mock::new(Err("dialog_show:boom".to_string()));
        let out = run(Kind::Model, &gate, &dialog, 1, |_, _| Ok(Value::Null));
        assert_eq!(out, Err("dialog_show:boom".to_string()));
        assert!(gate.try_acquire().is_some(), "an error releases the single-flight flag");
    }

    #[test]
    fn a_malformed_pick_is_refused_before_the_sidecar() {
        for bad in ["", "relative\\hero.vrm", "hero.vrm", "C:\\a\0b.vrm"] {
            let gate = SingleFlight::default();
            let called = Cell::new(false);
            let out = run(Kind::Model, &gate, &pick(bad), 1, |_, _| {
                called.set(true);
                Ok(Value::Null)
            });
            assert_eq!(out, Err("dialog_bad_path".to_string()), "{bad:?}");
            assert!(!called.get());
        }
        let long = format!("C:\\{}", "a".repeat(MAX_PATH_CHARS));
        assert!(!sane_path(&long));
    }

    #[test]
    fn a_second_call_while_a_dialog_is_open_returns_null_without_opening_another() {
        use std::rc::Rc;
        let gate = SingleFlight::default();
        let inner_dialog = Rc::new(Mock::new(Ok(Some("C:/b/other.vrm".to_string()))));
        let inner_result: Rc<RefCell<Option<Result<Value, String>>>> = Rc::new(RefCell::new(None));
        let inner_imports = Rc::new(Cell::new(0u32));
        let mut outer = pick("C:/a/hero.vrm");
        // While the first dialog is "open", a second request arrives.
        outer.before_answer = Some(Box::new({
            let (gate, dialog, result, imports) = (gate.clone(), inner_dialog.clone(), inner_result.clone(), inner_imports.clone());
            move || {
                let r = run(Kind::Model, &gate, &*dialog, 1, |_, _| {
                    imports.set(imports.get() + 1);
                    Ok(Value::Null)
                });
                *result.borrow_mut() = Some(r);
            }
        }));
        let first = run(Kind::Model, &gate, &outer, 1, |_, _| Ok(json!("imported")));
        assert_eq!(first, Ok(json!("imported")));
        assert_eq!(inner_result.borrow().clone(), Some(Ok(Value::Null)));
        assert!(inner_dialog.seen.borrow().is_empty(), "the second request never opened a dialog");
        assert_eq!(inner_imports.get(), 0);
        // After the first finishes, a new request works again.
        assert!(gate.try_acquire().is_some());
    }
}
