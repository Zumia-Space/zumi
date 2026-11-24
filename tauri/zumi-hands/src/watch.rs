//! Event-fed cache of one window's control-view tree (P0c). One full read when the watch starts, then UIA
//! StructureChanged and PropertyChanged events keep the copy current; a per-step snapshot is a read of this copy,
//! with no cross-process call. Read-only: events are only listened to, nothing is invoked or sent.
//!
//! Two paths, chosen once when the watch starts. Re-read path: window class Chrome_WidgetWin_1, FrameworkId "Chrome",
//! or a Windows Ribbon (class UIRibbonCommandBarDock: Paint, Explorer). Everything else: native path.
//!   Native windows (Win32, DirectUI, XAML...): each event is applied at once from the subtree it carries
//!     * ChildRemoved: drop the node with the removed child's runtime id, then refresh the sender (its parent)
//!     * ChildAdded: refresh the sender's parent; any other kind: refresh the sender
//!     (measured: Explorer, 20 file changes, 0 missing/stale; the debounced path below left Explorer's sorted list
//!     out of order, 11-11 run)
//!   Chromium and Electron (FrameworkId "Chrome"): the data an event carried, and a re-read from an inner element,
//!     came back truncated or without new tabs (VS Code fell to 3 elements, Chrome missed every new tab: 11-11 runs),
//!     while a read from the window handle was complete. So an event only marks the window dirty; a flusher thread
//!     re-reads the whole window once it has been quiet for QUIET_MS (or dirty for DIRTY_MAX_MS).
//!   Both: property events (Name, Value, IsOffscreen, IsEnabled) update that node's own properties at once; on the
//!   re-read path they also mark the window dirty.
//! "Refresh" = replace the cached node with the same runtime id; if the cache does not hold it, walk up to the
//! nearest ancestor it holds; after 8 steps, re-read the whole window.
//! Dropped self-events allow one follow-up settled re-read per flush (a real change inside the window is not lost).
//! A cached snapshot never waits: it returns the copy as it is and says whether re-reads were still pending.
//! First read: read, register, then re-read every SETTLE_MS until two reads agree, names included (Chromium builds its tree only
//! after the first UIA query). Chromium window re-reads settle the same way.
use crate::tree::Node;
use crate::uia::{read_cached, MAX_NODES};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
use windows::core::{implement, Ref, Result as WinResult};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::SAFEARRAY;
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::*;

const WALK_UP_LIMIT: usize = 8;
/// Quiet time before dirty branches are re-read; a branch dirty for DIRTY_MAX_MS is re-read even if events go on.
const QUIET_MS: f64 = 150.0;
const DIRTY_MAX_MS: f64 = 500.0;
/// Settle re-reads (first read and Chromium window re-reads): interval and most reads.
const SETTLE_MS: u64 = 300;
const SETTLE_READS: usize = 6;
/// Chromium windows only: re-read the window when nothing was flushed for this long and the window is quiet. Chrome
/// changes some names without any event (a tab's name gains "Memory usage - N MB": 11-11 run), so events alone
/// leave such a name stale forever.
const RECONCILE_MS: u64 = 5000;
/// Chromium windows only: structure events that arrive while we re-read the window, or this long after, are ours
/// (Chromium builds accessibility nodes when queried and announces them), not the app's. Without this, VS Code and
/// the helper re-read each other forever (11-11 run: events and flushes grew every step). A real change in that
/// window is still caught by the next RECONCILE_MS re-read.
const SELF_EVENT_MS: u64 = 300;
/// A whole-window re-read smaller than this fraction of the cached tree is treated as a half-built answer: it is
/// re-read again after SETTLE_MS and accepted only if it repeats SHRINK_CONFIRM times (VS Code answered with its
/// 14-node shell between full answers, 11-11 runs).
const SHRINK_CONFIRM: usize = 3;

#[derive(Debug, Clone, Default)]
pub struct Stats {
    pub structure_events: u64,
    pub property_events: u64,
    /// Events whose node (or an ancestor within WALK_UP_LIMIT) was found and refreshed.
    pub applied: u64,
    /// Refreshes that had to walk up at least one level to find a cached ancestor.
    pub walked_up: u64,
    /// Whole-window re-reads (no cached ancestor found).
    pub full_rereads: u64,
    pub removed: u64,
    /// Property events for an element the cache does not hold (ignored; see on_property).
    pub ignored_property: u64,
    /// UIA calls inside a handler that failed (element gone, provider error).
    pub errors: u64,
    /// Longest time one event took to apply since the last snapshot, ms.
    pub apply_ms_max: f64,
    /// Flushes of dirty branches, and the longest background re-read (flush, follow-up or reconcile) since the last
    /// snapshot (ms). This is update work off the snapshot path, not snapshot time.
    pub flushes: u64,
    pub flush_ms_max: f64,
    /// Flushes that re-read the whole window because a dirty branch belonged to Chromium/Electron.
    pub window_rereads: u64,
    /// Periodic Chromium re-reads with no event (RECONCILE_MS).
    pub reconciles: u64,
    /// Structure events dropped as self-caused (SELF_EVENT_MS), and shrunken answers set aside.
    pub self_events: u64,
    /// Follow-up re-reads made because self-events were dropped (at most one per flush).
    pub followups: u64,
    pub shrink_rejected: u64,
    /// Whether re-reads were queued or running when the last cached snapshot was taken.
    pub pending_at_snapshot: bool,
}

pub struct Watch {
    pub hwnd: u64,
    tree: Mutex<Node>,
    /// When the cached tree last changed (the freshness rule compares it with the last action).
    changed_at: Mutex<Option<Instant>>,
    /// Elements the hands re-read after acting on them (runtime id, when): each vouches for itself only (R4 M1).
    refreshed: Mutex<Vec<(Vec<i32>, Instant)>>,
    stats: Mutex<Stats>,
    last_event: Mutex<Option<Instant>>,
    automation: IUIAutomation,
    walker: IUIAutomationTreeWalker,
    /// Subtree, live references: parents fetched by the walker can be walked further.
    subtree: IUIAutomationCacheRequest,
    /// Subtree without live references: whole-window re-reads (the same request as the first read).
    subtree_none: IUIAutomationCacheRequest,
    /// One event is applied at a time: UIA may call the handlers on several threads at once, and the walker and cache
    /// request are shared.
    serial: Mutex<()>,
    /// Live elements whose branch must be re-read (filled by structure events, emptied by the flusher).
    dirty: Mutex<Vec<IUIAutomationElement>>,
    dirty_since: Mutex<Option<Instant>>,
    flushing: AtomicBool,
    /// Re-read path (Chromium/Electron or Windows Ribbon): events mark dirty, the flusher re-reads the window.
    chromium: AtomicBool,
    /// Re-read path: a flush or reconcile allows one follow-up; a dropped self-event uses it.
    followup_armed: AtomicBool,
    followup_due: AtomicBool,
    /// Native path: handlers currently applying an event.
    applying: std::sync::atomic::AtomicUsize,
    last_flush: Mutex<Instant>,
}

// SAFETY: the COM objects held here (CUIAutomation, its tree walker and cache requests) are free-threaded MTA
// objects; UIA itself calls our handlers on its own MTA threads. The plain data is behind mutexes.
unsafe impl Send for Watch {}
unsafe impl Sync for Watch {}

static WATCHES: Mutex<Option<HashMap<u64, Arc<Watch>>>> = Mutex::new(None);

/// Whether a cached snapshot should be reported as still updating (`pending`).
pub fn pending_state(chromium: bool, dirty: bool, flushing: bool, applying: bool, last_event_age_ms: Option<f64>) -> bool {
    if chromium {
        flushing || dirty
    } else {
        // Native path: events are applied inside the handler, so "still updating" = a handler is running, or an
        // event arrived less than QUIET_MS ago (more of the same burst is likely on its way).
        applying || last_event_age_ms.is_some_and(|a| a < QUIET_MS)
    }
}

pub fn get(hwnd: u64) -> Option<Arc<Watch>> {
    WATCHES.lock().unwrap_or_else(|p| p.into_inner()).as_ref()?.get(&hwnd).cloned()
}

/// Unregisters every event handler and forgets every watch (serve exit, tests). Handlers must be gone before the
/// process tears COM down, or UIA may call into freed objects.
pub fn stop_all() {
    let watches: Vec<Arc<Watch>> = WATCHES.lock().unwrap_or_else(|p| p.into_inner()).take().map(|m| m.into_values().collect()).unwrap_or_default();
    if let Some(w) = watches.first() {
        // SAFETY: one call on the free-threaded client; all watches share it.
        let _ = unsafe { w.automation.RemoveAllEventHandlers() };
    }
}

impl Watch {
    fn event_age_ms(&self) -> Option<f64> {
        self.last_event.lock().unwrap_or_else(|p| p.into_inner()).map(|t| t.elapsed().as_secs_f64() * 1000.0)
    }

    /// True while branches are queued or being re-read.
    /// When the cached tree last changed.
    pub fn as_of(&self) -> Option<Instant> {
        *self.changed_at.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn touch(&self) {
        *self.changed_at.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
    }

    /// After an action of ours on `el` (review R3 S1): re-read its own properties live and, when they differ from the
    /// cache, apply them and note when for that element only: the window's time stamp does not move (review R4 M1:
    /// moving it made every other element of the window count as current, skipping rule (b)). A Win32 check box raises no property event for its toggle (11-11:
    /// 0 events with ToggleState watched), so without this the cache never shows our own toggle. When nothing differs
    /// (no change, or a provider that applies it later) the cache is left as it is: still stale, rule (b) decides.
    /// True if the cache was updated.
    pub unsafe fn refresh_after_action(&self, el: &IUIAutomationElement, own: &IUIAutomationCacheRequest) -> bool {
        // SAFETY: a fresh own-properties read of a live element of the watched window, on the caller's client.
        unsafe {
            let Ok(live) = el.BuildUpdatedCache(own) else { return false };
            let mut budget = 1;
            let mut fresh = read_cached(&live, 0, &mut budget);
            fresh.children.clear();
            let _one = self.serial.lock().unwrap_or_else(|p| p.into_inner());
            let mut tree = self.tree.lock().unwrap_or_else(|p| p.into_inner());
            let differs = tree.find(&fresh.runtime_id).is_some_and(|n| {
                n.state != fresh.state || n.name != fresh.name || n.enabled != fresh.enabled || n.offscreen != fresh.offscreen
            });
            if !(differs && tree.update_own(&fresh)) {
                return false;
            }
            drop(tree);
            let mut r = self.refreshed.lock().unwrap_or_else(|p| p.into_inner());
            r.retain(|(rid, _)| *rid != fresh.runtime_id);
            r.push((fresh.runtime_id.clone(), Instant::now()));
            self.stat(|s| s.applied += 1);
            true
        }
    }

    /// When the hands last re-read the element with this runtime id after acting on it (None: never).
    pub fn element_refreshed_at(&self, rid: &[i32]) -> Option<Instant> {
        self.refreshed.lock().unwrap_or_else(|p| p.into_inner()).iter().find(|(r, _)| r.as_slice() == rid).map(|(_, t)| *t)
    }

    /// Test helper: the runtime id of the first cached node with this name.
    #[cfg(test)]
    pub fn cached_runtime_id_by_name(&self, name: &str) -> Option<Vec<i32>> {
        fn walk(n: &Node, name: &str) -> Option<Vec<i32>> {
            if n.name == name {
                return Some(n.runtime_id.clone());
            }
            n.children.iter().find_map(|c| walk(c, name))
        }
        walk(&self.tree.lock().unwrap_or_else(|p| p.into_inner()), name)
    }

    /// The runtime id of the element with prune id `id` in the cached tree.
    pub fn cached_runtime_id(&self, id: &str) -> Option<Vec<i32>> {
        let tree = self.tree.lock().unwrap_or_else(|p| p.into_inner());
        let el = crate::prune::prune(&tree).into_iter().find(|e| e.id == id)?;
        let mut n: &Node = &tree;
        for &i in &el.path {
            n = n.children.get(i)?;
        }
        Some(n.runtime_id.clone()).filter(|r| !r.is_empty())
    }

    pub fn pending(&self) -> bool {
        pending_state(
            self.chromium.load(Ordering::SeqCst),
            !self.dirty.lock().unwrap_or_else(|p| p.into_inner()).is_empty(),
            self.flushing.load(Ordering::SeqCst) || self.followup_due.load(Ordering::SeqCst),
            self.applying.load(Ordering::SeqCst) > 0,
            self.event_age_ms(),
        )
    }

    /// A copy of the cached tree, the counters (per-snapshot maxima reset), and ms since the last event. No wait.
    pub fn read(&self) -> (Node, Stats, Option<f64>) {
        let pending = self.pending();
        self.stat(|s| s.pending_at_snapshot = pending);
        let tree = self.tree.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let mut st = self.stats.lock().unwrap_or_else(|p| p.into_inner());
        let out = st.clone();
        st.apply_ms_max = 0.0;
        st.flush_ms_max = 0.0;
        drop(st);
        (tree, out, self.event_age_ms())
    }

    fn stat(&self, f: impl FnOnce(&mut Stats)) {
        f(&mut self.stats.lock().unwrap_or_else(|p| p.into_inner()));
    }

    fn mark_event(&self, t0: Instant) {
        *self.last_event.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        self.stat(|s| s.apply_ms_max = s.apply_ms_max.max(ms));
    }

    /// Replace the cached copy of `el` with the subtree `el` carries (an event sender, or a parent fetched with the
    /// subtree request), walking up to a cached ancestor if needed.
    unsafe fn refresh(&self, el: &IUIAutomationElement) {
        // SAFETY (whole fn): UIA calls on free-threaded client objects from an MTA thread.
        unsafe {
            let mut cur = el.clone();
            for level in 0..=WALK_UP_LIMIT {
                let mut budget = MAX_NODES;
                let fresh = read_cached(&cur, 0, &mut budget);
                let rid = fresh.runtime_id.clone();
                let mut tree = self.tree.lock().unwrap_or_else(|p| p.into_inner());
                if !rid.is_empty() && tree.contains(&rid) {
                    tree.replace_subtree(fresh);
                    self.touch();
                    drop(tree);
                    self.stat(|s| {
                        s.applied += 1;
                        if level > 0 {
                            s.walked_up += 1;
                        }
                    });
                    return;
                }
                drop(tree);
                match self.walker.GetParentElementBuildCache(&cur, &self.subtree) {
                    Ok(p) => cur = p,
                    Err(_) => break,
                }
            }
            self.full_reread();
        }
    }

    unsafe fn full_reread(&self) {
        // SAFETY: as in `refresh`.
        unsafe {
            let old_count = self.tree.lock().unwrap_or_else(|p| p.into_inner()).count();
            // On the flusher thread, read through that thread's own client (see spawn_flusher).
            let own = FLUSH_CLIENT.with(|c| c.borrow().as_ref().map(|c| (c.automation.clone(), c.subtree.clone())));
            let (automation, request) = own.unwrap_or_else(|| (self.automation.clone(), self.subtree_none.clone()));
            match automation.ElementFromHandleBuildCache(HWND(self.hwnd as usize as *mut _), &request) {
                Ok(root) => {
                    let mut budget = MAX_NODES;
                    let mut fresh = read_cached(&root, 0, &mut budget);
                    let mut tries = 1;
                    while fresh.count() * 4 < old_count && tries < SHRINK_CONFIRM {
                        self.stat(|s| s.shrink_rejected += 1);
                        std::thread::sleep(Duration::from_millis(SETTLE_MS));
                        let Ok(again) = automation.ElementFromHandleBuildCache(HWND(self.hwnd as usize as *mut _), &request) else { break };
                        let mut budget = MAX_NODES;
                        fresh = read_cached(&again, 0, &mut budget);
                        tries += 1;
                    }
                    *self.tree.lock().unwrap_or_else(|p| p.into_inner()) = fresh;
                    self.touch();
                    self.stat(|s| s.full_rereads += 1);
                }
                Err(_) => self.stat(|s| s.errors += 1),
            }
        }
    }

    /// Whole-window re-read, repeated every SETTLE_MS until two reads agree (same names in the same tree order; at
    /// most SETTLE_READS):
    /// right after a change Chromium can answer with a half-built tree and then raise no further event.
    unsafe fn settled_reread(&self) {
        // Two reads agree when they have the same nodes with the same names (a renamed title counts as a change).
        let count = || {
            fn sig(n: &Node, h: &mut u64) {
                for b in n.name.bytes().chain([0xff]) {
                    *h = (*h ^ b as u64).wrapping_mul(0x0000_0100_0000_01B3);
                }
                n.children.iter().for_each(|c| sig(c, h));
            }
            let mut h = 0xcbf2_9ce4_8422_2325u64;
            sig(&self.tree.lock().unwrap_or_else(|p| p.into_inner()), &mut h);
            h
        };
        // SAFETY: as in `refresh`.
        unsafe { self.full_reread() };
        let mut prev = count();
        for _ in 1..SETTLE_READS {
            std::thread::sleep(Duration::from_millis(SETTLE_MS));
            // SAFETY: as above.
            unsafe { self.full_reread() };
            let now = count();
            if now == prev {
                break;
            }
            prev = now;
        }
    }

    fn mark_dirty(&self, el: IUIAutomationElement) {
        let mut d = self.dirty.lock().unwrap_or_else(|p| p.into_inner());
        if d.is_empty() {
            *self.dirty_since.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
        }
        d.push(el);
    }

    fn due(&self) -> bool {
        if self.dirty.lock().unwrap_or_else(|p| p.into_inner()).is_empty() {
            return false;
        }
        let quiet = self.event_age_ms().is_none_or(|a| a >= QUIET_MS);
        let old = self.dirty_since.lock().unwrap_or_else(|p| p.into_inner()).is_some_and(|t| t.elapsed().as_secs_f64() * 1000.0 >= DIRTY_MAX_MS);
        quiet || old
    }

    /// Re-read path only: an event during our own re-read, or SELF_EVENT_MS after it, is ours. Counted, and it may
    /// use the one follow-up re-read the last flush allowed.
    fn self_event(&self) -> bool {
        if !(self.chromium.load(Ordering::SeqCst)
            && (self.flushing.load(Ordering::SeqCst)
                || self.last_flush.lock().unwrap_or_else(|p| p.into_inner()).elapsed() < Duration::from_millis(SELF_EVENT_MS)))
        {
            return false;
        }
        self.stat(|s| s.self_events += 1);
        // A real change can land inside that window too: allow one follow-up re-read per flush (not per event,
        // so the follow-up's own self-events cannot start the loop again).
        if self.followup_armed.swap(false, Ordering::SeqCst) {
            self.followup_due.store(true, Ordering::SeqCst);
        }
        true
    }

    unsafe fn on_structure(&self, sender: &IUIAutomationElement, change: StructureChangeType, removed: *const SAFEARRAY) {
        if self.self_event() {
            return;
        }
        self.applying.fetch_add(1, Ordering::SeqCst);
        let _busy = Busy(&self.applying);
        let _one = self.serial.lock().unwrap_or_else(|p| p.into_inner());
        let t0 = Instant::now();
        self.stat(|s| s.structure_events += 1);
        // SAFETY: UIA calls as in `refresh`; `removed` is the runtime-id array UIA passes for ChildRemoved.
        unsafe {
            if self.chromium.load(Ordering::SeqCst) {
                self.mark_dirty(sender.clone());
            } else if change == StructureChangeType_ChildRemoved {
                let rid = runtime_id_from_array(removed);
                if self.tree.lock().unwrap_or_else(|p| p.into_inner()).remove(&rid) {
                    self.touch();
                    self.stat(|s| s.removed += 1);
                }
                self.refresh(sender);
            } else if change == StructureChangeType_ChildAdded {
                match self.walker.GetParentElementBuildCache(sender, &self.subtree) {
                    Ok(parent) => self.refresh(&parent),
                    Err(_) => self.stat(|s| s.errors += 1),
                }
            } else {
                self.refresh(sender);
            }
        }
        self.mark_event(t0);
    }

    /// Chromium path: one settled whole-window re-read for everything marked dirty. Called by the flusher.
    unsafe fn flush(&self) {
        let _one = self.serial.lock().unwrap_or_else(|p| p.into_inner());
        self.flushing.store(true, Ordering::SeqCst);
        let t0 = Instant::now();
        drop(std::mem::take(&mut *self.dirty.lock().unwrap_or_else(|p| p.into_inner())));
        *self.dirty_since.lock().unwrap_or_else(|p| p.into_inner()) = None;
        // SAFETY: UIA calls on the flusher's own client (MTA).
        unsafe { self.settled_reread() };
        self.stat(|s| s.window_rereads += 1);
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        self.stat(|s| {
            s.flushes += 1;
            s.flush_ms_max = s.flush_ms_max.max(ms);
        });
        *self.last_flush.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
        self.followup_armed.store(true, Ordering::SeqCst);
        self.flushing.store(false, Ordering::SeqCst);
    }

    fn followup_ready(&self) -> bool {
        self.followup_due.load(Ordering::SeqCst)
            && self.last_flush.lock().unwrap_or_else(|p| p.into_inner()).elapsed() >= Duration::from_millis(SELF_EVENT_MS)
            && self.event_age_ms().is_none_or(|a| a >= QUIET_MS)
    }

    /// The one follow-up re-read after self-events were dropped; it does not re-arm itself.
    unsafe fn followup(&self) {
        let _one = self.serial.lock().unwrap_or_else(|p| p.into_inner());
        self.flushing.store(true, Ordering::SeqCst);
        self.followup_due.store(false, Ordering::SeqCst);
        let t0 = Instant::now();
        // SAFETY: as in `refresh`.
        unsafe { self.settled_reread() };
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        self.stat(|s| {
            s.followups += 1;
            s.flush_ms_max = s.flush_ms_max.max(ms);
        });
        *self.last_flush.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
        self.flushing.store(false, Ordering::SeqCst);
    }

    fn reconcile_due(&self) -> bool {
        self.chromium.load(Ordering::SeqCst)
            && self.last_flush.lock().unwrap_or_else(|p| p.into_inner()).elapsed() >= Duration::from_millis(RECONCILE_MS)
            && self.event_age_ms().is_none_or(|a| a >= QUIET_MS)
    }

    unsafe fn reconcile(&self) {
        let _one = self.serial.lock().unwrap_or_else(|p| p.into_inner());
        self.flushing.store(true, Ordering::SeqCst);
        let t0 = Instant::now();
        // SAFETY: as in `refresh`.
        unsafe { self.settled_reread() };
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        self.stat(|s| {
            s.reconciles += 1;
            s.flush_ms_max = s.flush_ms_max.max(ms);
        });
        *self.last_flush.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
        self.followup_armed.store(true, Ordering::SeqCst);
        self.flushing.store(false, Ordering::SeqCst);
    }

    unsafe fn on_property(&self, sender: &IUIAutomationElement, _prop: UIA_PROPERTY_ID) {
        if self.self_event() {
            return;
        }
        // Re-read path: Paint's ribbon re-layout raised only property events (IsOffscreen/IsEnabled), no structure
        // event (11-11 run), so a property event marks the window dirty there as well.
        if self.chromium.load(Ordering::SeqCst) {
            self.mark_dirty(sender.clone());
        }
        self.applying.fetch_add(1, Ordering::SeqCst);
        let _busy = Busy(&self.applying);
        let _one = self.serial.lock().unwrap_or_else(|p| p.into_inner());
        let t0 = Instant::now();
        self.stat(|s| s.property_events += 1);
        // SAFETY: as in `refresh`; the sender carries the own-properties cache request.
        unsafe {
            let mut budget = 1;
            let mut fresh = read_cached(sender, 0, &mut budget);
            fresh.children.clear();
            let updated = self.tree.lock().unwrap_or_else(|p| p.into_inner()).update_own(&fresh);
            if updated {
                self.touch();
            }
            if updated {
                self.stat(|s| s.applied += 1);
            } else {
                // Not walked up to a parent: walking from a property-event sender, then walking again on the next
                // event, ended the helper with STATUS_HEAP_CORRUPTION in the own-window test (11-11). New elements
                // reach the cache through structure events instead.
                self.stat(|s| s.ignored_property += 1);
            }
        }
        self.mark_event(t0);
    }
}

thread_local! {
    /// The flusher thread's own UIA client for whole-window re-reads. Through the shared client (created on the
    /// request thread), whole-window re-reads of VS Code from the flusher thread came back as a 3-element shell
    /// about half the time while a fresh process read the full tree (11-11 runs).
    static FLUSH_CLIENT: std::cell::RefCell<Option<crate::uia::Client>> = const { std::cell::RefCell::new(None) };
}

/// The flusher: one MTA thread per watch; ends when the watch is dropped.
fn spawn_flusher(w: Weak<Watch>) {
    std::thread::spawn(move || {
        // SAFETY: COM initialised for this thread's life; only free-threaded UIA objects are used.
        unsafe {
            if windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED).is_err() {
                return;
            }
            if let Ok(c) = crate::uia::new_client() {
                FLUSH_CLIENT.with(|slot| *slot.borrow_mut() = Some(c));
            }
        }
        loop {
            std::thread::sleep(Duration::from_millis(20));
            let Some(w) = w.upgrade() else { break };
            if w.due() {
                // SAFETY: see above.
                unsafe { w.flush() };
            } else if w.followup_ready() {
                // SAFETY: see above.
                unsafe { w.followup() };
            } else if w.reconcile_due() {
                // SAFETY: see above.
                unsafe { w.reconcile() };
            }
        }
        FLUSH_CLIENT.with(|slot| *slot.borrow_mut() = None);
        // SAFETY: matches the CoInitializeEx above.
        unsafe { windows::Win32::System::Com::CoUninitialize() };
    });
}

/// Decrements the applying counter when a handler returns (also on early return).
struct Busy<'a>(&'a std::sync::atomic::AtomicUsize);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

unsafe fn runtime_id_from_array(sa: *const SAFEARRAY) -> Vec<i32> {
    // SAFETY: delegated; `sa` is null or a valid 1-D VT_I4 SAFEARRAY owned by the caller.
    unsafe { crate::uia::ints_from_safearray(sa) }
}

#[implement(IUIAutomationStructureChangedEventHandler)]
struct OnStructure(Arc<Watch>);

impl IUIAutomationStructureChangedEventHandler_Impl for OnStructure_Impl {
    fn HandleStructureChangedEvent(&self, sender: Ref<IUIAutomationElement>, changetype: StructureChangeType, runtimeid: *const SAFEARRAY) -> WinResult<()> {
        if let Ok(sender) = sender.ok() {
            // SAFETY: called by UIA on its MTA event thread with a live sender.
            unsafe { self.0.on_structure(sender, changetype, runtimeid) };
        }
        Ok(())
    }
}

#[implement(IUIAutomationPropertyChangedEventHandler)]
struct OnProperty(Arc<Watch>);

impl IUIAutomationPropertyChangedEventHandler_Impl for OnProperty_Impl {
    fn HandlePropertyChangedEvent(&self, sender: Ref<IUIAutomationElement>, propertyid: UIA_PROPERTY_ID, _newvalue: &VARIANT) -> WinResult<()> {
        if let Ok(sender) = sender.ok() {
            // SAFETY: as above.
            unsafe { self.0.on_property(sender, propertyid) };
        }
        Ok(())
    }
}

/// Properties whose change can alter what a snapshot shows (names, visibility, enabled state). Value is listened to
/// as asked by CoS; the cache does not store values, so a Value event only refreshes own properties.
/// BoundingRectangle is NOT watched: with it registered, the first rect-change burst in Explorer ended the helper with
/// STATUS_HEAP_CORRUPTION (0xC0000374) even with an empty handler body; Name, Value, IsOffscreen and IsEnabled ran
/// clean (measured 11-11, tmp probe). Cause inside the VARIANT(array) delivery path: not established. Consequence:
/// a moved element keeps its old rect until a structure event refreshes its branch.
/// The pattern states (toggle, expand/collapse, selected) are watched too (review R3 S1): without them a toggle
/// never moved the cache, so the window stayed stale and rule (b) refused the next action on that element.
const WATCHED: [UIA_PROPERTY_ID; 7] = [
    UIA_NamePropertyId,
    UIA_ValueValuePropertyId,
    UIA_IsOffscreenPropertyId,
    UIA_IsEnabledPropertyId,
    UIA_ToggleToggleStatePropertyId,
    UIA_ExpandCollapseExpandCollapseStatePropertyId,
    UIA_SelectionItemIsSelectedPropertyId,
];

/// Starts watching `hwnd`: first full read, handler registration on the window's subtree, then settle re-reads.
/// Replaces an earlier watch of the same window. Returns the settled tree and (first read, register, settle) ms.
/// `subtree` (no live refs) is for the first read; `subtree_live` and `own_live` (live refs) are what events carry,
/// so the sender can be walked to its parent.
pub unsafe fn start(
    automation: &IUIAutomation,
    subtree: &IUIAutomationCacheRequest,
    subtree_live: &IUIAutomationCacheRequest,
    own_live: &IUIAutomationCacheRequest,
    hwnd: u64,
) -> WinResult<(Node, f64, f64, f64)> {
    // SAFETY (whole fn): UIA calls on the client thread's objects.
    unsafe {
        let t_first = Instant::now();
        let root = automation.ElementFromHandleBuildCache(HWND(hwnd as usize as *mut _), subtree)?;
        let mut budget = MAX_NODES;
        let tree = read_cached(&root, 0, &mut budget);
        let first_read_ms = t_first.elapsed().as_secs_f64() * 1000.0;
        let t = Instant::now();
        let live = automation.ElementFromHandle(HWND(hwnd as usize as *mut _))?;
        let w = Arc::new(Watch {
            hwnd,
            tree: Mutex::new(tree.clone()),
            changed_at: Mutex::new(Some(Instant::now())),
            refreshed: Mutex::new(Vec::new()),
            stats: Mutex::new(Stats::default()),
            last_event: Mutex::new(None),
            automation: automation.clone(),
            walker: automation.ControlViewWalker()?,
            subtree: subtree_live.clone(),
            subtree_none: subtree.clone(),
            serial: Mutex::new(()),
            dirty: Mutex::new(Vec::new()),
            dirty_since: Mutex::new(None),
            flushing: AtomicBool::new(false),
            chromium: AtomicBool::new(false),
            applying: std::sync::atomic::AtomicUsize::new(0),
            followup_armed: AtomicBool::new(true),
            followup_due: AtomicBool::new(false),
            last_flush: Mutex::new(Instant::now()),
        });
        let sh: IUIAutomationStructureChangedEventHandler = OnStructure(w.clone()).into();
        automation.AddStructureChangedEventHandler(&live, TreeScope_Subtree, subtree_live, &sh)?;
        let ph: IUIAutomationPropertyChangedEventHandler = OnProperty(w.clone()).into();
        automation.AddPropertyChangedEventHandlerNativeArray(&live, TreeScope_Subtree, own_live, &ph, &WATCHED)?;
        let register_ms = t.elapsed().as_secs_f64() * 1000.0;
        // Path choice: Chromium if the window has Chromium's window class (Chrome and Electron both use
        // Chrome_WidgetWin_1; VS Code's window and children report FrameworkId "Win32", 11-11 run), or the window or
        // a direct child reports FrameworkId "Chrome".
        let is_chrome = |e: &IUIAutomationElement| e.CurrentFrameworkId().map(|f| f.to_string() == "Chrome").unwrap_or(false);
        let mut chromium = live.CurrentClassName().map(|c| c.to_string() == "Chrome_WidgetWin_1").unwrap_or(false) || is_chrome(&live);
        if !chromium {
            if let Ok(kids) = live.FindAll(TreeScope_Children, &automation.CreateTrueCondition()?) {
                for i in 0..kids.Length().unwrap_or(0) {
                    if kids.GetElement(i).map(|k| is_chrome(&k)).unwrap_or(false) {
                        chromium = true;
                        break;
                    }
                }
            }
        }
        // Windows Ribbon (UIRibbonCommandBarDock: Paint, Explorer) re-lays out on resize without structure events
        // and the subtree an event carried was truncated (Paint cache fell from 74 to 24 elements, 11-11 run), so it
        // takes the re-read path too.
        fn has_class(n: &Node, c: &str) -> bool {
            n.class_name == c || n.children.iter().any(|k| has_class(k, c))
        }
        let ribbon = has_class(&tree, "UIRibbonCommandBarDock");
        let chromium = chromium || ribbon;
        w.chromium.store(chromium, Ordering::SeqCst);
        let t_settle = Instant::now();
        // Settle: re-read until two reads agree (counts), so a tree that grows after the first query is caught.
        std::thread::sleep(Duration::from_millis(SETTLE_MS));
        w.settled_reread();
        w.stat(|s| s.full_rereads = 0);
        let tree = w.tree.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let settle_ms = t_settle.elapsed().as_secs_f64() * 1000.0;
        spawn_flusher(Arc::downgrade(&w));
        let mut map = WATCHES.lock().unwrap_or_else(|p| p.into_inner());
        map.get_or_insert_with(HashMap::new).insert(hwnd, w);
        Ok((tree, first_read_ms, register_ms, settle_ms))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_pending_follows_handlers_and_recent_events() {
        assert!(pending_state(false, false, false, true, None), "a handler is applying an event");
        assert!(pending_state(false, false, false, false, Some(40.0)), "an event 40 ms ago: burst still arriving");
        assert!(!pending_state(false, false, false, false, Some(500.0)), "quiet for 500 ms: settled");
        assert!(!pending_state(false, false, false, false, None), "no event yet: settled");
    }

    #[test]
    fn chromium_pending_follows_dirty_and_flush() {
        assert!(pending_state(true, true, false, false, None));
        assert!(pending_state(true, false, true, false, None));
        assert!(!pending_state(true, false, false, false, Some(10.0)), "Chromium: dropped self-events do not count");
    }
}
