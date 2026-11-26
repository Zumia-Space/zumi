//! Push-to-talk: the global hotkey (RegisterHotKey). The press tests inject real key events with SendInput and use a chord
//! nothing else uses (Ctrl+Alt+Shift+F23), so they cannot type into another window.
#![cfg(windows)]
use std::sync::mpsc::{channel, Receiver};
use std::sync::Mutex;
use std::time::Duration;
use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY};
use zumi_stt::hotkey::{chord, Chord, Hotkey, HotkeyEvent, DEFAULT_KEY};

const MOD_ALT: u32 = 1;
const MOD_CONTROL: u32 = 2;
const MOD_SHIFT: u32 = 4;
const VK_SPACE: u32 = 0x20;
const VK_F23: u32 = 0x86;
const VK_CONTROL: u32 = 0x11;
const VK_MENU: u32 = 0x12;
const VK_SHIFT: u32 = 0x10;

/// One chord, one keyboard: the tests that use them run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

const TEST_CHORD: Chord = Chord { id: "test-f23", label: "test", mods: MOD_CONTROL | MOD_ALT | MOD_SHIFT, vk: VK_F23 };

fn key(vk: u32, up: bool) {
    let input = INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk as u16), wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 } } };
    // SAFETY: one well-formed INPUT, its true size.
    let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    assert_eq!(sent, 1, "SendInput: this test needs an interactive desktop");
    std::thread::sleep(Duration::from_millis(30));
}

fn listen(c: Chord) -> (Hotkey, Receiver<HotkeyEvent>) {
    let (tx, rx) = channel();
    let hk = Hotkey::register(c, move |e| {
        let _ = tx.send(e);
    })
    .expect("the test chord is free");
    (hk, rx)
}

fn hold_down() {
    for vk in [VK_CONTROL, VK_MENU, VK_SHIFT, VK_F23] {
        key(vk, false);
    }
}
fn let_go() {
    for vk in [VK_F23, VK_SHIFT, VK_MENU, VK_CONTROL] {
        key(vk, true);
    }
}

#[test]
fn the_three_upstream_chords_are_offered_by_their_upstream_ids() {
    let want = [("ctrl-opt-space", MOD_CONTROL | MOD_ALT), ("ctrl-shift-space", MOD_CONTROL | MOD_SHIFT), ("opt-shift-space", MOD_ALT | MOD_SHIFT)];
    for (id, mods) in want {
        let c = chord(id).unwrap_or_else(|| panic!("{id}"));
        assert_eq!((c.id, c.mods, c.vk), (id, mods, VK_SPACE), "{id}");
        assert!(!c.label.is_empty());
    }
    assert_eq!(DEFAULT_KEY, "ctrl-opt-space");
    assert!(chord("ctrl-x").is_none() && chord("").is_none());
}

#[test]
fn a_chord_someone_else_holds_is_reported_taken_and_is_free_again_when_dropped() {
    let _one_at_a_time = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (first, _rx) = listen(TEST_CHORD);
    let again = Hotkey::register(TEST_CHORD, |_| {});
    assert_eq!(again.err().map(|e| e.code()), Some("stt_hotkey_taken"));
    drop(first);
    assert!(Hotkey::register(TEST_CHORD, |_| {}).is_ok(), "dropping the hotkey gives the chord back");
}

#[test]
fn holding_the_chord_is_one_press_and_letting_go_is_one_release_whatever_the_key_repeat() {
    let _one_at_a_time = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (_hk, rx) = listen(TEST_CHORD);
    for vk in [VK_CONTROL, VK_MENU, VK_SHIFT] {
        key(vk, false);
    }
    key(VK_F23, false);
    key(VK_F23, false); // auto-repeat
    key(VK_F23, false);
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)), Ok(HotkeyEvent::Press));
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err(), "key repeat is not another press");
    let_go();
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)), Ok(HotkeyEvent::Release));
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    // and it works again
    hold_down();
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)), Ok(HotkeyEvent::Press));
    let_go();
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)), Ok(HotkeyEvent::Release));
}

#[test]
fn letting_go_of_a_modifier_first_also_ends_the_hold() {
    let _one_at_a_time = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (_hk, rx) = listen(TEST_CHORD);
    hold_down();
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)), Ok(HotkeyEvent::Press));
    key(VK_MENU, true); // upstream finishes on the modifiers' release
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)), Ok(HotkeyEvent::Release));
    key(VK_F23, true);
    key(VK_SHIFT, true);
    key(VK_CONTROL, true);
}

#[test]
fn nothing_is_heard_after_the_hotkey_is_dropped() {
    let _one_at_a_time = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (hk, rx) = listen(TEST_CHORD);
    drop(hk);
    hold_down();
    assert!(rx.recv_timeout(Duration::from_millis(500)).is_err());
    let_go();
}
