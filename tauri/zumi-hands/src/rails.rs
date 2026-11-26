//! P1 rails: the pure decisions every acting verb goes through before it touches a window. No Win32 here, so each
//! refusal has a test that shows it biting and a twin that shows it passing.
//!
//!   * gate: acting is allowed only while armed (a dead-man deadline set by `arm`) and not killed (the hotkey)
//!   * foreground: a SendInput batch goes out only while the foreground window belongs to the target pid
//!   * own pid: acting verbs touch only processes this helper launched
//!   (the app allowlist moved to hands_policy.rs in P2)
//!   * chord: only the closed list CHORDS; no system chord, no Windows key
//!   * capture path: only a .bmp inside the capture root
use std::path::Path;
use std::time::Instant;

/// Refusal codes (stable words; the harness and the JSONL log match on them).
pub type Refusal = (&'static str, String);

#[derive(Debug, Default)]
pub struct Gate {
    /// Dead-man deadline; None = not armed.
    pub armed_until: Option<Instant>,
    pub killed: bool,
}

impl Gate {
    pub fn check(&self, now: Instant) -> Result<(), Refusal> {
        if self.killed {
            return Err(("killed", "the stop hotkey was pressed; nothing acts until the helper restarts".into()));
        }
        match self.armed_until {
            None => Err(("not_armed", "send `arm` (dead-man deadline) before any acting verb".into())),
            Some(t) if now >= t => Err(("deadman_expired", "the dead-man deadline passed; arm again".into())),
            Some(_) => Ok(()),
        }
    }
}

pub fn foreground_ok(target_pid: u32, foreground_pid: u32) -> Result<(), Refusal> {
    if target_pid != 0 && foreground_pid == target_pid {
        Ok(())
    } else {
        Err(("not_foreground", format!("foreground window belongs to pid {foreground_pid}, not the target {target_pid}")))
    }
}

/// One process this helper started or adopted: its pid and its creation time (FILETIME, 100 ns units). The pair
/// names the process; a pid alone can be reused by a later process (review R4 S3).
pub type OwnProcess = (u32, u64);

/// Acting verbs touch only processes this helper started with `launch` (own PIDs only). `created`: the creation time
/// of the process that has `pid` now (None: no such process).
pub fn own_pid(own: &[OwnProcess], pid: u32, created: Option<u64>) -> Result<(), Refusal> {
    match (own.iter().find(|(p, _)| *p == pid), created) {
        (Some((_, c)), Some(now)) if *c == now && now != 0 => Ok(()),
        (Some(_), _) => Err(("not_own_pid", format!("pid {pid} is now another process (or none) than the one this helper started"))),
        (None, _) => Err(("not_own_pid", format!("pid {pid} was not started by this helper"))),
    }
}

/// The element a pattern call targets must belong to the target process (a window of ours can host another
/// process's content, e.g. a common-dialog shell view).
pub fn element_owner(element_pid: u32, pid: u32) -> Result<(), Refusal> {
    if pid != 0 && element_pid == pid {
        Ok(())
    } else {
        Err(("not_owned", format!("element belongs to pid {element_pid}, not the target {pid}")))
    }
}

/// The closed set of chords `key` may send (review R3 M1): editing and window keys of the target app only. Anything
/// else is refused, in particular the system chords (ctrl+esc, ctrl+shift+esc, alt+tab, alt+esc, ctrl+alt+...), the
/// Windows key, F1 (opens a browser in many apps) and print.
/// No ctrl+v: pasting would put the owner's clipboard (maybe a copied password) into a window the model reads
/// (review R4 S1).
/// No alt+f4 or ctrl+w: the focus check runs before SendInput but not with it, so a closing chord could land in the
/// owner's window (review R4 S2).
pub const CHORDS: [&str; 17] = [
    "enter", "tab", "shift+tab", "esc", "ctrl+a", "ctrl+c", "ctrl+x", "ctrl+z", "ctrl+y", "ctrl+s",
    "ctrl+shift+s", "ctrl+f", "ctrl+n", "ctrl+o", "f2", "f3", "f5",
];

/// A key chord such as "ctrl+s": (modifier virtual keys, key virtual key). Only a chord on the CHORDS list, in any
/// modifier order and case; everything else is `bad_chord`.
pub fn parse_chord(chord: &str) -> Result<(Vec<u16>, u16), Refusal> {
    let bad = || ("bad_chord", format!("{chord:?} is not one of the allowed chords: {}", CHORDS.join(", ")));
    let parts: Vec<String> = chord.split('+').map(|p| p.trim().to_ascii_lowercase()).collect();
    let (key, mods) = parts.split_last().ok_or_else(bad)?;
    // Canonical order ctrl, shift, alt; a repeated or unknown modifier is refused.
    let mut canon = Vec::new();
    for (name, vk) in [("ctrl", 0x11u16), ("shift", 0x10), ("alt", 0x12)] {
        match mods.iter().filter(|m| m.as_str() == name).count() {
            0 => {}
            1 => canon.push((name, vk)),
            _ => return Err(bad()),
        }
    }
    if canon.len() != mods.len() {
        return Err(bad());
    }
    let name = canon.iter().map(|(n, _)| *n).chain([key.as_str()]).collect::<Vec<_>>().join("+");
    if !CHORDS.contains(&name.as_str()) {
        return Err(bad());
    }
    let k = key.as_bytes();
    let vk = match key.as_str() {
        "enter" => 0x0D,
        "tab" => 0x09,
        "esc" => 0x1B,
        _ if k.len() == 1 && k[0].is_ascii_lowercase() => k[0].to_ascii_uppercase() as u16,
        _ if k.len() >= 2 && k[0] == b'f' => match key[1..].parse::<u16>() {
            Ok(n @ 1..=12) => 0x70 + n - 1,
            _ => return Err(bad()),
        },
        _ => return Err(bad()),
    };
    Ok((canon.into_iter().map(|(_, v)| v).collect(), vk))
}

pub fn capture_path_ok(root: &Path, out: &Path) -> Result<(), Refusal> {
    let bad = || ("bad_capture_path", format!("{} must be a .bmp under {}", out.display(), root.display()));
    let is_bmp = out.extension().is_some_and(|e| e.eq_ignore_ascii_case("bmp"));
    let climbs = out.components().any(|c| matches!(c, std::path::Component::ParentDir));
    if is_bmp && !climbs && out.starts_with(root) { Ok(()) } else { Err(bad()) }
}

/// Text split into SendInput batches of at most `n` chars (the foreground is re-checked between batches).
pub fn batches(text: &str, n: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    chars.chunks(n.max(1)).map(|c| c.iter().collect()).collect()
}

/// R5 pixel fallback: where the pointer goes, in thousandths of the target window's own rectangle (never a screen
/// coordinate: a point can only land in the window the rails already passed). `click` has one point; `drag` has two and the
/// path between them is cut into steps so the target sees a drag, not a jump. Left button only.
pub const POINTER_MAX: i64 = 1000;
pub const DRAG_STEPS: usize = 16;
/// A window smaller than this (in pixels, each way) is too small to aim in.
const MIN_AIM_PX: i64 = 50;

pub fn pointer_plan(verb: &str, rect: [i32; 4], a: (i64, i64), b: Option<(i64, i64)>) -> Result<Vec<(i32, i32)>, Refusal> {
    let bad = |why: &str| ("bad_args", why.to_string());
    let (left, top) = (rect[0] as i64, rect[1] as i64);
    let (w, h) = (rect[2] as i64 - left, rect[3] as i64 - top);
    if w < MIN_AIM_PX || h < MIN_AIM_PX {
        return Err(("bad_window", format!("the window is {w} x {h} px: too small to aim in")));
    }
    let inside = |p: (i64, i64)| (0..=POINTER_MAX).contains(&p.0) && (0..=POINTER_MAX).contains(&p.1);
    if !inside(a) {
        return Err(bad("x and y are thousandths of the window: 0 to 1000"));
    }
    // The far edge maps one pixel in: a window's right and bottom are exclusive.
    let screen = |p: (i64, i64)| ((left + (p.0 * w / POINTER_MAX).min(w - 1)) as i32, (top + (p.1 * h / POINTER_MAX).min(h - 1)) as i32);
    match (verb, b) {
        ("click", None) => Ok(vec![screen(a)]),
        ("click", Some(_)) => Err(bad("a click has one point")),
        ("drag", Some(b)) if inside(b) && b != a => {
            let (p, q) = (screen(a), screen(b));
            Ok((0..=DRAG_STEPS as i64).map(|i| (p.0 + ((q.0 - p.0) as i64 * i / DRAG_STEPS as i64) as i32, p.1 + ((q.1 - p.1) as i64 * i / DRAG_STEPS as i64) as i32)).collect())
        }
        ("drag", Some(_)) => Err(bad("a drag goes between two different points, both 0 to 1000")),
        ("drag", None) => Err(bad("a drag needs x2 and y2")),
        _ => Err(bad("the pointer verbs are click and drag (left button)")),
    }
}

/// The pixel fallback is for places with NO accessibility label: when the element under the point is one the model can act on
/// by name, the pointer is refused and the answer says to use `act`.
pub fn label_blocks_pointer(role: &str, name: &str) -> Result<(), Refusal> {
    if crate::prune::is_acting_role(role) && !name.trim().is_empty() {
        Err(("has_label", format!("the place has a named {role}: use act with its name instead of a pixel")))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn gate_refuses_unarmed_expired_and_killed_allows_armed() {
        let now = Instant::now();
        assert_eq!(Gate::default().check(now).unwrap_err().0, "not_armed");
        let expired = Gate { armed_until: Some(now), killed: false };
        assert_eq!(expired.check(now + Duration::from_millis(1)).unwrap_err().0, "deadman_expired");
        let killed = Gate { armed_until: Some(now + Duration::from_secs(60)), killed: true };
        assert_eq!(killed.check(now).unwrap_err().0, "killed");
        let armed = Gate { armed_until: Some(now + Duration::from_secs(60)), killed: false };
        assert!(armed.check(now).is_ok());
    }

    #[test]
    fn foreground_must_be_the_target() {
        assert_eq!(foreground_ok(100, 200).unwrap_err().0, "not_foreground");
        assert_eq!(foreground_ok(100, 0).unwrap_err().0, "not_foreground");
        assert!(foreground_ok(100, 100).is_ok());
    }

    #[test]
    fn only_pids_we_launched() {
        let own = [(10, 1000), (20, 2000)];
        assert_eq!(own_pid(&own, 30, Some(3000)).unwrap_err().0, "not_own_pid");
        assert_eq!(own_pid(&[], 10, Some(1000)).unwrap_err().0, "not_own_pid");
        assert!(own_pid(&own, 20, Some(2000)).is_ok(), "pass: same pid, same creation time");
        // Review R4 S3, bites: the pid now belongs to a later process (another creation time), or to none.
        assert_eq!(own_pid(&own, 20, Some(2500)).unwrap_err().0, "not_own_pid", "pid reused");
        assert_eq!(own_pid(&own, 20, None).unwrap_err().0, "not_own_pid", "process gone");
    }

    #[test]
    fn element_must_belong_to_the_target() {
        assert_eq!(element_owner(200, 100).unwrap_err().0, "not_owned");
        assert_eq!(element_owner(0, 100).unwrap_err().0, "not_owned");
        assert!(element_owner(100, 100).is_ok());
    }

    #[test]
    fn chord_closed_set() {
        // Pass twins: every listed chord parses; modifier order and case do not matter.
        assert_eq!(parse_chord("ctrl+s").unwrap(), (vec![0x11], 0x53));
        assert_eq!(parse_chord("shift+ctrl+S").unwrap(), (vec![0x11, 0x10], 0x53), "ctrl+shift+s in any order");
        assert_eq!(parse_chord("enter").unwrap(), (vec![], 0x0D));
        assert_eq!(parse_chord("esc").unwrap(), (vec![], 0x1B));
        assert_eq!(parse_chord("tab").unwrap(), (vec![], 0x09));
        assert_eq!(parse_chord("shift+tab").unwrap(), (vec![0x10], 0x09));
        for c in CHORDS {
            assert!(parse_chord(c).is_ok(), "listed chord {c} parses");
        }
        // Bites (review R3 M1): system chords and everything not on the list.
        for c in [
            "ctrl+shift+esc", "ctrl+esc", "alt+esc", "alt+tab", "alt+shift+tab", "ctrl+alt+tab", "ctrl+tab",
            "ctrl+alt+s", "ctrl+alt+del", "ctrl+alt+f4", "win+r", "lwin", "alt+space", "alt", "shift+f10",
            "f1", "ctrl+p", "ctrl+shift+f12", "ctrl+shift+n", "a", "1", "ctrl+ctrl+s", "ctrl+", "ctrl+s+t", "",
            // Review R4 S1: the owner's clipboard is not the hands' to paste.
            "ctrl+v", "shift+ctrl+V",
            // Review R4 S2: closing chords can land in the owner's window if the foreground moves.
            "alt+f4", "ctrl+w",
        ] {
            assert_eq!(parse_chord(c).unwrap_err().0, "bad_chord", "{c:?} is refused");
        }
    }

    #[test]
    fn capture_only_bmp_inside_root() {
        let root = Path::new(r"D:\x\caps");
        assert!(capture_path_ok(root, Path::new(r"D:\x\caps\run1\a.bmp")).is_ok());
        assert_eq!(capture_path_ok(root, Path::new(r"D:\x\caps\a.png")).unwrap_err().0, "bad_capture_path");
        assert_eq!(capture_path_ok(root, Path::new(r"D:\x\other\a.bmp")).unwrap_err().0, "bad_capture_path");
        assert_eq!(capture_path_ok(root, Path::new(r"D:\x\caps\..\other\a.bmp")).unwrap_err().0, "bad_capture_path");
    }

    #[test]
    fn batches_split_by_chars() {
        assert_eq!(batches("abcdefg", 3), ["abc", "def", "g"]);
        assert_eq!(batches("héllo", 2), ["hé", "ll", "o"]);
        assert!(batches("", 4).is_empty());
    }
    #[test]
    fn r5_pointer_plan_maps_thousandths_into_the_window_and_nowhere_else() {
        let rect = [100, 200, 1100, 1000]; // 1000 x 800
        assert_eq!(pointer_plan("click", rect, (500, 500), None).unwrap(), vec![(600, 600)]);
        assert_eq!(pointer_plan("click", rect, (0, 0), None).unwrap(), vec![(100, 200)], "the top-left corner is inside");
        assert_eq!(pointer_plan("click", rect, (1000, 1000), None).unwrap(), vec![(1099, 999)], "the far edge is clamped one pixel in: right and bottom are exclusive");
        let drag = pointer_plan("drag", rect, (100, 500), Some((900, 500))).unwrap();
        assert_eq!(drag.len(), DRAG_STEPS + 1);
        assert_eq!((drag[0], drag[DRAG_STEPS]), ((200, 600), (1000, 600)));
        assert!(drag.windows(2).all(|w| w[0].0 <= w[1].0 && w[0].1 == w[1].1), "a straight path, left to right");
        assert!(drag.iter().all(|p| p.0 >= rect[0] && p.0 < rect[2] && p.1 >= rect[1] && p.1 < rect[3]));
    }

    #[test]
    fn r5_bite_pointer_plan_refuses_outside_coordinates_bad_verbs_missing_or_extra_endpoints_and_tiny_windows() {
        let rect = [0, 0, 800, 600];
        for bad in [(-1, 5), (5, -1), (1001, 5), (5, 1001), (i64::MAX, 0), (0, i64::MIN)] {
            assert_eq!(pointer_plan("click", rect, bad, None).unwrap_err().0, "bad_args", "{bad:?}");
            assert_eq!(pointer_plan("drag", rect, (1, 1), Some(bad)).unwrap_err().0, "bad_args", "{bad:?}");
        }
        assert_eq!(pointer_plan("double", rect, (1, 1), None).unwrap_err().0, "bad_args");
        assert_eq!(pointer_plan("right", rect, (1, 1), None).unwrap_err().0, "bad_args", "left button only");
        assert_eq!(pointer_plan("click", rect, (1, 1), Some((2, 2))).unwrap_err().0, "bad_args", "a click has one point");
        assert_eq!(pointer_plan("drag", rect, (1, 1), None).unwrap_err().0, "bad_args", "a drag needs an end");
        assert_eq!(pointer_plan("drag", rect, (7, 7), Some((7, 7))).unwrap_err().0, "bad_args", "a drag that goes nowhere");
        assert_eq!(pointer_plan("click", [0, 0, 30, 30], (5, 5), None).unwrap_err().0, "bad_window", "a window too small to aim in");
        assert_eq!(pointer_plan("click", [10, 10, 5, 5], (5, 5), None).unwrap_err().0, "bad_window", "an inverted rectangle");
    }

    #[test]
    fn r5_label_blocks_pointer_for_named_controls_and_passes_for_canvas_like_places() {
        for role in ["Button", "MenuItem", "Edit", "ListItem", "TabItem", "CheckBox", "Hyperlink", "SplitButton"] {
            assert_eq!(label_blocks_pointer(role, "Save").unwrap_err().0, "has_label", "{role}");
        }
        assert!(label_blocks_pointer("Button", "  ").is_ok(), "pass twin: an unnamed button has no label to act by");
        assert!(label_blocks_pointer("Pane", "Canvas").is_ok(), "pass twin: a drawing surface");
        assert!(label_blocks_pointer("Custom", "").is_ok());
        assert!(label_blocks_pointer("Image", "").is_ok());
    }
}
