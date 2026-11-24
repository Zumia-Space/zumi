//! Read-only UI Automation access through one persistent client thread per process. Full mode: one cache request
//! fetches the whole control-view subtree of a window in a single cross-process round trip. Staged mode: a
//! two-level first read, then one subtree read per on-screen branch. Only cached properties are read. Nothing here
//! invokes a pattern, sets a value, focuses or sends input.
use crate::tree::Node;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Com::SAFEARRAY;
use windows::Win32::System::Ole::{SafeArrayAccessData, SafeArrayGetLBound, SafeArrayGetUBound, SafeArrayUnaccessData};
use windows::Win32::System::Variant::{VariantClear, VT_ARRAY, VT_BOOL, VT_BSTR, VT_I4};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsWindow, IsWindowVisible,
};

/// Walk limits: a provider that reports a runaway tree must not take the helper down.
const MAX_DEPTH: usize = 64;
pub(crate) const MAX_NODES: usize = 20_000;

#[derive(Debug, Clone)]
pub struct WindowInfo {
    pub hwnd: u64,
    pub pid: u32,
    pub title: String,
    pub class_name: String,
    pub rect: [i32; 4],
}

impl WindowInfo {
    pub fn area(&self) -> i64 {
        (self.rect[2] - self.rect[0]).max(0) as i64 * (self.rect[3] - self.rect[1]).max(0) as i64
    }
}

fn window_info(hwnd: HWND) -> WindowInfo {
    let mut pid = 0u32;
    let mut title = [0u16; 512];
    let mut class = [0u16; 256];
    let mut rect = RECT::default();
    // SAFETY: plain Win32 reads on a window handle; buffers are sized and the lengths returned are clamped.
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let tn = GetWindowTextW(hwnd, &mut title).max(0) as usize;
        let cn = GetClassNameW(hwnd, &mut class).max(0) as usize;
        let _ = GetWindowRect(hwnd, &mut rect);
        WindowInfo {
            hwnd: hwnd.0 as usize as u64,
            pid,
            title: String::from_utf16_lossy(&title[..tn.min(title.len())]),
            class_name: String::from_utf16_lossy(&class[..cn.min(class.len())]),
            rect: [rect.left, rect.top, rect.right, rect.bottom],
        }
    }
}

/// Visible top-level windows owned by `pid`. This is the only way the helper picks a window, so it never reads a
/// window of a process the caller did not name.
pub fn windows_of(pid: u32) -> Vec<WindowInfo> {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: lparam is the &mut Vec<HWND> passed below, alive for the whole EnumWindows call.
        let out = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
        if unsafe { IsWindowVisible(hwnd) }.as_bool() {
            out.push(hwnd);
        }
        BOOL(1)
    }
    let mut all: Vec<HWND> = Vec::new();
    // SAFETY: the callback only pushes into `all`, which outlives the call.
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut all as *mut Vec<HWND> as isize));
    }
    // Owner pid first, text only for the target's windows: GetWindowTextW on a window of THIS process sends
    // WM_GETTEXT to its thread, and UIA's hidden windows here belong to threads that may not pump (that hung P0c).
    all.into_iter()
        .filter(|h| owner_pid(*h) == pid)
        .map(window_info)
        .filter(|w| w.area() > 0)
        .collect()
}

fn owner_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    // SAFETY: reads the owning process id of a window handle; no message is sent.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

/// The window to read for `pid`: `hwnd` if given and owned by `pid`, else the largest visible window of `pid`.
pub fn pick_window(pid: u32, hwnd: Option<u64>) -> Result<WindowInfo, (&'static str, String)> {
    let wins = windows_of(pid);
    match hwnd {
        Some(h) => {
            // SAFETY: IsWindow accepts any value and only reports whether it names a live window.
            let live = unsafe { IsWindow(Some(HWND(h as usize as *mut _))) }.as_bool();
            if !live {
                return Err(("no_window", format!("hwnd 0x{h:X} is not a window")));
            }
            wins.into_iter()
                .find(|w| w.hwnd == h)
                .ok_or(("not_owned", format!("hwnd 0x{h:X} is not a visible top-level window of pid {pid}")))
        }
        None => wins
            .into_iter()
            .max_by_key(WindowInfo::area)
            .ok_or(("no_window", format!("pid {pid} has no visible top-level window"))),
    }
}

/// Where the time of one snapshot went, in ms. `setup` = queueing + (first request only) COM init, CUIAutomation and
/// cache requests; `build` = the first cross-process read (staged: the two-level read); `expand` = the follow-up
/// subtree reads (staged only); `read` = reading cached copies into `Node`s (full mode; staged folds it into the rest).
#[derive(Debug, Clone, Default)]
pub struct WalkTimes {
    pub setup: f64,
    pub build: f64,
    pub expand: f64,
    pub read: f64,
    /// Follow-up cross-process subtree reads made (staged mode), 0 in full mode.
    pub expansions: u32,
    /// True when this request created the UIA client (first request of the process, or after a timeout).
    pub new_client: bool,
    /// Staged mode: (role "name", ms) of each expansion, slowest first; tells which branch costs the time.
    pub branches: Vec<(String, f64)>,
}

/// How to read a window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Mode {
    /// One subtree cache request from the window (the first P0 measurement).
    Full,
    /// Window + children + grandchildren first, then each on-screen grandchild is read as its own subtree
    /// ("expand on demand": off-screen or empty-rect branches are never fetched).
    Staged,
    /// Full read, then keep the tree current from UIA events (watch.rs); later snapshots read the cache.
    /// `build` = the first read, `expand` = handler registration, `read` = settle re-reads (incl. 300 ms waits).
    Watch,
}

fn ms_since(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

type Reply = mpsc::Sender<windows::core::Result<(Node, WalkTimes)>>;

struct Job {
    hwnd: u64,
    mode: Mode,
    queued: Instant,
    reply: Reply,
}

/// The one long-lived UIA thread of this process, kept across requests so the client (and its connections to
/// providers) is reused. Replaced after a timeout, because the old thread may be stuck inside a provider.
static WORKER: Mutex<Option<mpsc::Sender<Job>>> = Mutex::new(None);

/// UIA clients created so far in this process (test hook for client reuse).
pub static CLIENTS_CREATED: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

fn worker() -> mpsc::Sender<Job> {
    let mut slot = WORKER.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(tx) = slot.as_ref() {
        return tx.clone();
    }
    let (tx, rx) = mpsc::channel::<Job>();
    std::thread::spawn(move || uia_thread(rx));
    *slot = Some(tx.clone());
    tx
}

fn drop_worker() {
    *WORKER.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// Reads the control-view tree of `hwnd` on the persistent UIA thread. If the provider does not answer within
/// `timeout`, returns `timeout`; the stuck thread is abandoned and the next request starts a fresh one.
pub fn snapshot_tree(hwnd: u64, mode: Mode, timeout: Duration) -> Result<(Node, WalkTimes), (&'static str, String)> {
    let (reply, rx) = mpsc::channel();
    let job = Job { hwnd, mode, queued: Instant::now(), reply };
    if let Err(mpsc::SendError(job)) = worker().send(job) {
        drop_worker(); // the thread is gone (it never should be): start one more
        worker().send(job).map_err(|_| ("uia_error", "UIA thread unavailable".to_string()))?;
    }
    match rx.recv_timeout(timeout) {
        Ok(r) => r.map_err(|e| ("uia_error", e.to_string())),
        Err(_) => {
            drop_worker();
            Err(("timeout", format!("no UIA answer within {} ms", timeout.as_millis())))
        }
    }
}

pub(crate) struct Client {
    pub(crate) automation: IUIAutomation,
    /// Element + whole control-view subtree, no live references (full mode, and each staged expansion).
    pub(crate) subtree: IUIAutomationCacheRequest,
    /// Element + children with live references. TreeScope has no depth limit, so "two levels" is this request on
    /// the window and then on each child.
    children_live: IUIAutomationCacheRequest,
    /// Subtree and own properties with live references: what UIA events carry (watch.rs).
    pub(crate) subtree_live: IUIAutomationCacheRequest,
    pub(crate) own_live: IUIAutomationCacheRequest,
}

const PROPS: [UIA_PROPERTY_ID; 14] = [
    UIA_ControlTypePropertyId,
    UIA_NamePropertyId,
    UIA_AutomationIdPropertyId,
    UIA_ClassNamePropertyId,
    UIA_BoundingRectanglePropertyId,
    UIA_IsOffscreenPropertyId,
    UIA_IsEnabledPropertyId,
    UIA_IsKeyboardFocusablePropertyId,
    UIA_IsPasswordPropertyId,
    UIA_RuntimeIdPropertyId,
    // Pattern state, compared by rule (b) (tree::pattern_state). Elements without the pattern report "not supported".
    UIA_ToggleToggleStatePropertyId,
    UIA_ExpandCollapseExpandCollapseStatePropertyId,
    UIA_SelectionItemIsSelectedPropertyId,
    UIA_ValueValuePropertyId,
];

pub(crate) unsafe fn new_client() -> windows::core::Result<Client> {
    // SAFETY (whole fn): COM object creation on the calling MTA thread.
    unsafe {
        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
        let view = automation.ControlViewCondition()?;
        let make = |scope: TreeScope, mode: AutomationElementMode| -> windows::core::Result<IUIAutomationCacheRequest> {
            let c = automation.CreateCacheRequest()?;
            for p in PROPS {
                c.AddProperty(p)?;
            }
            c.SetTreeScope(scope)?;
            c.SetTreeFilter(&view)?;
            c.SetAutomationElementMode(mode)?;
            Ok(c)
        };
        let subtree = make(TreeScope_Subtree, AutomationElementMode_None)?;
        let children_live = make(TreeScope(TreeScope_Element.0 | TreeScope_Children.0), AutomationElementMode_Full)?;
        let subtree_live = make(TreeScope_Subtree, AutomationElementMode_Full)?;
        let own_live = make(TreeScope_Element, AutomationElementMode_Full)?;
        CLIENTS_CREATED.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(Client { automation, subtree, children_live, subtree_live, own_live })
    }
}

fn uia_thread(rx: mpsc::Receiver<Job>) {
    // SAFETY: COM stays initialised for the thread's life; the loop ends only when every sender is dropped.
    unsafe {
        if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
            return;
        }
        let mut client: Option<Client> = None;
        for job in rx {
            let created = client.is_none();
            if created {
                match new_client() {
                    Ok(c) => client = Some(c),
                    Err(e) => {
                        let _ = job.reply.send(Err(e));
                        continue;
                    }
                }
            }
            let Some(c) = client.as_ref() else { continue };
            let mut times = WalkTimes { setup: ms_since(job.queued), new_client: created, ..Default::default() };
            let r = match job.mode {
                Mode::Full => read_full(c, job.hwnd, &mut times),
                Mode::Staged => read_staged(c, job.hwnd, &mut times),
                Mode::Watch => crate::watch::start(&c.automation, &c.subtree, &c.subtree_live, &c.own_live, job.hwnd).map(|(n, first, reg, settle)| {
                    times.build = first;
                    times.expand = reg;
                    times.read = settle;
                    n
                }),
            };
            let _ = job.reply.send(r.map(|n| (n, times)));
        }
        drop(client);
        CoUninitialize();
    }
}

unsafe fn read_full(c: &Client, hwnd: u64, times: &mut WalkTimes) -> windows::core::Result<Node> {
    // SAFETY: UIA calls on this thread's client; an invalid HWND comes back as an error HRESULT.
    unsafe {
        let t = Instant::now();
        let root = c.automation.ElementFromHandleBuildCache(HWND(hwnd as usize as *mut _), &c.subtree)?;
        times.build = ms_since(t);
        let t = Instant::now();
        let mut budget = MAX_NODES;
        let node = read_cached(&root, 0, &mut budget);
        times.read = ms_since(t);
        Ok(node)
    }
}

pub(crate) fn worth_expanding(n: &Node, clip: [i32; 4]) -> bool {
    let [l, t, r, b] = n.rect;
    !n.offscreen && r > l && b > t && l < clip[2] && r > clip[0] && t < clip[3] && b > clip[1]
}

unsafe fn read_staged(c: &Client, hwnd: u64, times: &mut WalkTimes) -> windows::core::Result<Node> {
    // SAFETY (whole fn): UIA calls on this thread's client. Elements from `children_live` are live references
    // (mode Full), so they can start further cache requests.
    unsafe {
        let t = Instant::now();
        let root = c.automation.ElementFromHandleBuildCache(HWND(hwnd as usize as *mut _), &c.children_live)?;
        let mut budget = MAX_NODES;
        let mut node = read_cached(&root, 0, &mut budget);
        let clip = node.rect;
        // Level 2: one Children read per on-screen child, keeping the live grandchildren for the expansion step.
        let mut grand: Vec<Vec<Option<IUIAutomationElement>>> = Vec::new();
        if let Ok(kids) = root.GetCachedChildren() {
            for i in 0..kids.Length().unwrap_or(0) {
                let mut row = Vec::new();
                if let (Ok(k), Some(kn)) = (kids.GetElement(i), node.children.get_mut(i as usize)) {
                    if worth_expanding(kn, clip) {
                        if let Ok(k2) = k.BuildUpdatedCache(&c.children_live) {
                            *kn = read_cached(&k2, 1, &mut budget);
                            if let Ok(gk) = k2.GetCachedChildren() {
                                for j in 0..gk.Length().unwrap_or(0) {
                                    row.push(gk.GetElement(j).ok());
                                }
                            }
                        }
                    }
                }
                grand.push(row);
            }
        }
        times.build = ms_since(t);
        // Expand on demand: each on-screen grandchild gets its own subtree read; off-screen branches are skipped.
        let t = Instant::now();
        for (i, row) in grand.iter().enumerate() {
            for (j, ge) in row.iter().enumerate() {
                let Some(ge) = ge else { continue };
                let Some(gn) = node.children.get_mut(i).and_then(|k| k.children.get_mut(j)) else { continue };
                if !worth_expanding(gn, clip) {
                    continue;
                }
                times.expansions += 1;
                let tb = Instant::now();
                if let Ok(full) = ge.BuildUpdatedCache(&c.subtree) {
                    *gn = read_cached(&full, 2, &mut budget);
                }
                times.branches.push((format!("{} {:?}", gn.role(), gn.name), ms_since(tb)));
            }
        }
        times.expand = ms_since(t);
        times.branches.sort_by(|a, b| b.1.total_cmp(&a.1));
        Ok(node)
    }
}

/// Integers of a 1-D VT_I4 SAFEARRAY (a UIA runtime id). Empty for null or an unexpected shape.
pub(crate) unsafe fn ints_from_safearray(sa: *const SAFEARRAY) -> Vec<i32> {
    if sa.is_null() {
        return Vec::new();
    }
    // SAFETY: `sa` is a valid SAFEARRAY owned by the caller; the data pointer is used only between access/unaccess.
    unsafe {
        let (Ok(lo), Ok(hi)) = (SafeArrayGetLBound(sa, 1), SafeArrayGetUBound(sa, 1)) else { return Vec::new() };
        let n = (hi - lo + 1).max(0) as usize;
        let mut data: *mut core::ffi::c_void = core::ptr::null_mut();
        if n == 0 || SafeArrayAccessData(sa, &mut data).is_err() || data.is_null() {
            return Vec::new();
        }
        let out = std::slice::from_raw_parts(data as *const i32, n).to_vec();
        let _ = SafeArrayUnaccessData(sa);
        out
    }
}

/// Most characters of an Edit/Document's text read into the tree (what the model is shown is cut shorter, prune.rs).
const VALUE_READ_CHARS: usize = 4000;

/// The cached pattern state of `e` (requested in PROPS), as tree::pattern_state, and its Value text. A property the element does
/// not support comes back as the "not supported" object (VT_UNKNOWN) or empty, and is left out.
unsafe fn cached_pattern_state(e: &IUIAutomationElement) -> (String, Option<String>) {
    // SAFETY: each VARIANT comes from UIA and is cleared here; its union is read only for the type it carries.
    unsafe {
        let get = |id: UIA_PROPERTY_ID| -> (Option<i32>, Option<bool>, Option<String>) {
            let Ok(mut v) = e.GetCachedPropertyValue(id) else { return (None, None, None) };
            let inner = &v.Anonymous.Anonymous;
            let out = match inner.vt {
                VT_I4 => (Some(inner.Anonymous.lVal), None, None),
                VT_BOOL => (None, Some(inner.Anonymous.boolVal.as_bool()), None),
                VT_BSTR => (None, None, Some((*inner.Anonymous.bstrVal).to_string())),
                _ => (None, None, None),
            };
            let _ = VariantClear(&mut v);
            out
        };
        let toggle = get(UIA_ToggleToggleStatePropertyId).0;
        let expand = get(UIA_ExpandCollapseExpandCollapseStatePropertyId).0;
        let selected = get(UIA_SelectionItemIsSelectedPropertyId).1;
        let value = get(UIA_ValueValuePropertyId).2;
        (crate::tree::pattern_state(toggle, expand, selected, value.as_deref()), value)
    }
}

/// The cached RuntimeId of `e` (requested in PROPS). Empty if the provider gave none.
unsafe fn cached_runtime_id(e: &IUIAutomationElement) -> Vec<i32> {
    // SAFETY: the VARIANT comes from UIA and is cleared here; the array is read only while the VARIANT is alive.
    unsafe {
        let Ok(mut v) = e.GetCachedPropertyValue(UIA_RuntimeIdPropertyId) else { return Vec::new() };
        let vt = v.Anonymous.Anonymous.vt;
        let out = if vt.0 == (VT_ARRAY.0 | VT_I4.0) { ints_from_safearray(v.Anonymous.Anonymous.Anonymous.parray) } else { Vec::new() };
        let _ = VariantClear(&mut v);
        out
    }
}

pub(crate) unsafe fn read_cached(e: &IUIAutomationElement, depth: usize, budget: &mut usize) -> Node {
    *budget = budget.saturating_sub(1);
    // SAFETY (whole fn): cached-property getters on an element from the cache request; a getter that fails
    // (property not supported by this provider) falls back to the empty/false value.
    unsafe {
        let r = e.CachedBoundingRectangle().unwrap_or_default();
        let (state, value_text) = cached_pattern_state(e);
        let control_type = e.CachedControlType().map(|t| t.0).unwrap_or(0);
        let role = crate::tree::role_name(control_type);
        // IsPassword that gets no answer fails closed for a field that holds text (tree::password_flag).
        let password = crate::tree::password_flag(e.CachedIsPassword().ok().map(|b| b.as_bool()), role);
        let name = crate::tree::display_name(role, &e.CachedName().map(|b| b.to_string()).unwrap_or_default());
        let automation_id = e.CachedAutomationId().map(|b| b.to_string()).unwrap_or_default();
        // The text of an Edit or Document, never of a password field nor of one whose own name says it holds a secret.
        let value = match (password || crate::tree::sensitive_field(&name, &automation_id), role) {
            (false, "Edit" | "Document") => value_text.unwrap_or_default().chars().take(VALUE_READ_CHARS).collect(),
            _ => String::new(),
        };
        let mut node = Node {
            control_type,
            name,
            automation_id,
            class_name: e.CachedClassName().map(|b| b.to_string()).unwrap_or_default(),
            rect: [r.left, r.top, r.right, r.bottom],
            offscreen: e.CachedIsOffscreen().map(|b| b.as_bool()).unwrap_or(false),
            enabled: e.CachedIsEnabled().map(|b| b.as_bool()).unwrap_or(false),
            focusable: e.CachedIsKeyboardFocusable().map(|b| b.as_bool()).unwrap_or(false),
            password,
            value,
            runtime_id: cached_runtime_id(e),
            state,
            children: Vec::new(),
        };
        if depth >= MAX_DEPTH {
            return node;
        }
        // GetCachedChildren returns a null array (an Err here) when the element has no cached children.
        if let Ok(kids) = e.GetCachedChildren() {
            let n = kids.Length().unwrap_or(0);
            for i in 0..n {
                if *budget == 0 {
                    break;
                }
                if let Ok(k) = kids.GetElement(i) {
                    node.children.push(read_cached(&k, depth + 1, budget));
                }
            }
        }
        node
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::core::w;
    use windows::Win32::UI::WindowsAndMessaging::*;

    /// Builds a small window of OUR OWN process (a STATIC frame with a push button and a check box), reads it
    /// through the cached walk from another thread while this thread pumps its messages, then destroys it.
    #[test]
    fn cached_walk_reads_own_window_controls() {
        // SAFETY: window creation/destruction on this thread; the handles never leave the test.
        let frame = unsafe {
            let frame = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                w!("STATIC"),
                w!("zumi-hands P0 probe"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                40, 40, 320, 160, None, None, None, None,
            )
            .expect("create frame");
            CreateWindowExW(WINDOW_EX_STYLE(0), w!("BUTTON"), w!("Probe push"), WS_CHILD | WS_VISIBLE,
                10, 10, 120, 30, Some(frame), None, None, None).expect("button");
            CreateWindowExW(WINDOW_EX_STYLE(0), w!("BUTTON"), w!("Probe check"), WS_CHILD | WS_VISIBLE | WINDOW_STYLE(3),
                10, 50, 120, 30, Some(frame), None, None, None).expect("checkbox");
            frame
        };
        let h = frame.0 as usize as u64;
        // Full read, then a staged read through the SAME persistent client (no second CUIAutomation).
        let worker = std::thread::spawn(move || {
            let full = snapshot_tree(h, Mode::Full, Duration::from_secs(10));
            let made = CLIENTS_CREATED.load(std::sync::atomic::Ordering::SeqCst);
            let staged = snapshot_tree(h, Mode::Staged, Duration::from_secs(10));
            let made_after = CLIENTS_CREATED.load(std::sync::atomic::Ordering::SeqCst);
            (full, staged, made, made_after)
        });
        while !worker.is_finished() {
            // SAFETY: standard message pump for this thread's windows.
            unsafe {
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let (full, staged, made, made_after) = worker.join().unwrap();
        let (tree, t_full) = full.expect("full snapshot");
        let (tree2, t_staged) = staged.expect("staged snapshot");
        // Watch flushers create their own clients in parallel tests, so the global counter only bounds from below.
        assert!(made >= 1 && made_after >= made);
        assert!(!t_staged.new_client && t_full.expansions == 0);
        assert_eq!(tree2.count(), tree.count(), "staged read sees the same nodes as the full read");
        unsafe { let _ = DestroyWindow(frame); }

        fn find<'a>(n: &'a Node, role: &str, name: &str) -> Option<&'a Node> {
            if n.role() == role && n.name == name { return Some(n); }
            n.children.iter().find_map(|c| find(c, role, name))
        }
        assert_eq!(tree.name, "zumi-hands P0 probe");
        let b = find(&tree, "Button", "Probe push").expect("push button in tree");
        assert!(b.rect[2] > b.rect[0], "button has a rectangle");
        assert!(find(&tree, "CheckBox", "Probe check").is_some(), "check box in tree");
        assert!(tree.count() >= 3);
    }

    /// P0c: a watched window of OUR OWN process gains a button and has another renamed; the event-fed cache shows
    /// both without a new read. This thread pumps its messages while it waits.
    #[test]
    fn watch_cache_follows_added_child_and_rename() {
        fn pump() {
            // SAFETY: standard message pump for this thread's windows.
            unsafe {
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        }
        fn has(n: &Node, role: &str, name: &str) -> bool {
            (n.role() == role && n.name == name) || n.children.iter().any(|c| has(c, role, name))
        }
        // SAFETY: window creation on this thread; handles never leave the test.
        let (frame, first) = unsafe {
            let frame = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, w!("STATIC"), w!("zumi-hands P0c watch probe"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE, 60, 60, 320, 160, None, None, None, None).expect("frame");
            let first = CreateWindowExW(WINDOW_EX_STYLE(0), w!("BUTTON"), w!("Before"), WS_CHILD | WS_VISIBLE,
                10, 10, 120, 30, Some(frame), None, None, None).expect("button");
            (frame, first)
        };
        // SAFETY: as above. A check box (BS_AUTOCHECKBOX) for the toggle-state part (review R3 S1).
        let check = unsafe {
            CreateWindowExW(WINDOW_EX_STYLE(0), w!("BUTTON"), w!("Check me"), WS_CHILD | WS_VISIBLE | WINDOW_STYLE(0x0003),
                150, 10, 120, 30, Some(frame), None, None, None).expect("check box")
        };
        fn state_of(n: &Node, name: &str) -> Option<String> {
            if n.name == name {
                return Some(n.state.clone());
            }
            n.children.iter().find_map(|c| state_of(c, name))
        }
        let h = frame.0 as usize as u64;
        let watcher = std::thread::spawn(move || snapshot_tree(h, Mode::Watch, Duration::from_secs(10)).map(|_| ()));
        while !watcher.is_finished() {
            pump();
            std::thread::sleep(Duration::from_millis(5));
        }
        watcher.join().unwrap().expect("watch started");
        // SAFETY: as above.
        unsafe {
            CreateWindowExW(WINDOW_EX_STYLE(0), w!("BUTTON"), w!("Added later"), WS_CHILD | WS_VISIBLE,
                10, 50, 120, 30, Some(frame), None, None, None).expect("second button");
            let _ = SetWindowTextW(first, w!("Renamed"));
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut ok = false;
        while std::time::Instant::now() < deadline && !ok {
            pump();
            let w = crate::watch::get(h).expect("watch registered");
            // read() waits for pending re-reads, which need this thread to pump (the window is ours): only read
            // when nothing is pending.
            if w.pending() {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            let (tree, _, _) = w.read();
            ok = has(&tree, "Button", "Added later") && has(&tree, "Button", "Renamed") && !has(&tree, "Button", "Before");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(ok, "cache shows the added button and the rename");
        // Toggle state (review R3 S1): the check box is toggled the way the hands do it (UIA Toggle pattern, on a
        // thread of its own while this one pumps), then the hands' after-action refresh runs. The cache must show
        // toggle=1 without a new read of the window; the element (not the window) is marked as re-read.
        let w = crate::watch::get(h).expect("watch registered");
        let before = state_of(&w.read().0, "Check me");
        assert!(before.as_deref().is_some_and(|s| s.starts_with("toggle=0")), "starts unchecked: {before:?}");
        let as_of = w.as_of();
        let ch = check.0 as usize;
        let ww = w.clone();
        let toggler = std::thread::spawn(move || {
            // SAFETY: COM on this thread; UIA calls on our own check box; the window thread (the test) pumps.
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                let c = new_client().expect("client");
                let el = c.automation.ElementFromHandleBuildCache(HWND(ch as *mut _), &c.own_live).expect("check box element");
                let tp: IUIAutomationTogglePattern = el.GetCurrentPatternAs(UIA_TogglePatternId).expect("toggle pattern");
                tp.Toggle().expect("toggle");
                // As act.rs does: the proxy can apply the toggle a moment after Toggle returns, so look again for up
                // to 250 ms (review R6 S4: a single look failed 1 run in 4 at BelowNormal priority).
                let t0 = std::time::Instant::now();
                loop {
                    if ww.refresh_after_action(&el, &c.own_live) {
                        break true;
                    }
                    if t0.elapsed() >= Duration::from_millis(250) {
                        break false;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
        });
        while !toggler.is_finished() {
            pump();
            std::thread::sleep(Duration::from_millis(5));
        }
        let refreshed = toggler.join().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let mut toggled = false;
        while std::time::Instant::now() < deadline && !toggled {
            pump();
            if !w.pending() {
                // The element is marked refreshed; the window's time stamp stays (review R4 M1).
                let rid = w.cached_runtime_id_by_name("Check me");
                toggled = state_of(&w.read().0, "Check me").is_some_and(|s| s.starts_with("toggle=1"))
                    && rid.is_some_and(|r| w.element_refreshed_at(&r).is_some()) && w.as_of() == as_of;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        crate::watch::stop_all();
        unsafe { let _ = DestroyWindow(frame); }
        let (t, st, _) = w.read();
        assert!(toggled && refreshed, "cache follows the toggle: {:?} refreshed {refreshed} (property events {}, applied {}, ignored {})", state_of(&t, "Check me"), st.property_events, st.applied, st.ignored_property);
    }

    #[test]
    fn foreign_or_missing_window_is_refused() {
        // pid 0 owns no top-level window; a made-up handle is not a window.
        assert_eq!(pick_window(0, None).unwrap_err().0, "no_window");
        assert_eq!(pick_window(std::process::id(), Some(0x7FFF_FFF0)).unwrap_err().0, "no_window");
        // A live window of another process (the desktop window, owned by csrss) is refused for our pid.
        let desk = unsafe { GetDesktopWindow() }.0 as usize as u64;
        assert_eq!(pick_window(std::process::id(), Some(desk)).unwrap_err().0, "not_owned");
    }
}
