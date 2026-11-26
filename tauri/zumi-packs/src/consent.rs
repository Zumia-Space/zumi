//! Native consent (roadmap 1.5), the power-pack extension of the HB-2 signed acceptance (`zumi-agent-loop/src/dialog.rs`, same key, same MAC).
//!
//! The risk text and the list of what the pack can do (generated from its declared capabilities, never hand-written, so the text cannot
//! drift from the code) are shown in a window the HOST owns. A person clicks Accept or Decline there. Only an Accept makes a record, and
//! the record carries a MAC under the host's key, so whoever writes the file without the key (the sidecar, the model, a helper, a bench
//! script) cannot make a record that counts. No rpc method, tool or helper request reaches `request_consent`: it takes the dialog as an
//! argument, and the only dialog that returns `true` without a person is a test's own.
//!
//! The record is bound to the pack id, its version, the hash of its declared capabilities, the hash of both risk texts, the Windows user
//! and the hash of what the person granted (shown in the window, R7b M1): a pack that gains a capability, a new version or other risk words is NOT accepted any more and asks again. Because the HB-2 key
//! is made fresh by each run of the app and never written down, an acceptance lasts for this run of the app (a restart asks again).
use crate::audit::{PackAudit, Row};
use crate::manifest::Manifest;
use crate::scope::Grants;
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use zumi_audit::hostmac::{mac_hex, sha256_hex, verify};

/// A modal question to a person. `true` only if the person chose Accept. Decline is the default button.
pub trait ConsentDialog {
    fn ask(&self, title: &str, text: &str) -> bool;
    /// As `ask`, with the reason when the window could not be shown at all (the real window says why; a test dialog never fails).
    fn ask_checked(&self, title: &str, text: &str) -> Result<bool, String> {
        Ok(self.ask(title, text))
    }
}

pub const CONSENT_FILE: &str = "consent.jsonl";

/// The sha256 that binds a record to the exact words the person was shown.
pub fn risk_text_sha256(en: &str, vi: &str) -> String {
    sha256_hex(format!("{en}\u{1f}{vi}").as_bytes())
}

fn join_list(items: &[String], sep: &str) -> String {
    items.join(sep)
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string())).collect()).unwrap_or_default()
}

/// One line per declared capability, from the manifest only: `(english, vietnamese, chinese)`.
fn capability_lines(manifest: &Manifest) -> Vec<(String, String, String)> {
    manifest
        .capabilities
        .iter()
        .map(|c| {
            let s = &c.scope;
            match c.id.as_str() {
                "proc.spawn" => {
                    let programs = join_list(&strs(&s["programs"]), ", ");
                    let shell = s["shell"].as_bool() == Some(true);
                    (
                        format!("Can start programs on this PC: {programs}{}. A program it starts can do anything you can do on this PC", if shell { " (including a command shell)" } else { "" }),
                        format!("Có thể chạy chương trình trên máy này: {programs}{}. Chương trình nó chạy làm được mọi việc anh làm được trên máy này", if shell { " (kể cả dòng lệnh)" } else { "" }),
                        format!("可以在这台电脑上运行程序：{programs}{}。它运行的程序可以做你在这台电脑上能做的一切", if shell { "（包括命令行）" } else { "" }),
                    )
                }
                "fs.read" => {
                    let r = join_list(&strs(&s["roots"]), ", ");
                    (format!("Can read files in: {r}"), format!("Có thể đọc tệp trong: {r}"), format!("可以读取这些位置的文件：{r}"))
                }
                "fs.write" => {
                    let r = join_list(&strs(&s["roots"]), ", ");
                    (format!("Can change files in: {r}"), format!("Có thể sửa tệp trong: {r}"), format!("可以修改这些位置的文件：{r}"))
                }
                "net.egress" => match &s["origins"] {
                    Value::String(w) if w == "user-added" => ("Can send data to: the sites you add".to_string(), "Có thể gửi dữ liệu tới: các trang anh thêm".to_string(), "可以向以下地址发送数据：你添加的网站".to_string()),
                    other => {
                        let o = join_list(&strs(other), ", ");
                        (format!("Can send data to: {o}"), format!("Có thể gửi dữ liệu tới: {o}"), format!("可以向以下地址发送数据：{o}"))
                    }
                },
                "net.listen" => {
                    let bind = s["bind"].as_str().unwrap_or("?");
                    let ports = join_list(&strs(&s["ports"]), ", ");
                    let (en, vi, zh) = match bind {
                        "loopback" => ("only programs on this PC", "chỉ chương trình trên máy này", "仅限这台电脑上的程序"),
                        "lan" => ("other devices on your network", "các thiết bị khác trong mạng của anh", "你所在网络中的其他设备"),
                        _ => ("others", "bên khác", "其他方"),
                    };
                    (format!("Opens a door ({en}) that others can knock on, ports {ports}"), format!("Mở một cổng ({vi}) cho bên khác gõ vào, cổng {ports}"), format!("打开一个入口（{zh}），其他方可以连接，端口 {ports}"))
                }
                "input.inject" => ("Can move the mouse and type".to_string(), "Có thể điều khiển chuột và gõ phím".to_string(), "可以控制鼠标和键盘".to_string()),
                "screen.capture" => ("Can see the screen".to_string(), "Có thể nhìn màn hình".to_string(), "可以查看屏幕".to_string()),
                "audio.capture" => ("Can record sound".to_string(), "Có thể ghi âm".to_string(), "可以录音".to_string()),
                "account.act" => ("Can send or post as you".to_string(), "Có thể gửi hoặc đăng bài thay anh".to_string(), "可以替你发送或发布内容".to_string()),
                "device.usb" => ("Can control a phone plugged into this PC".to_string(), "Có thể điều khiển điện thoại cắm vào máy này".to_string(), "可以控制插在这台电脑上的手机".to_string()),
                "unattended.run" => ("Can act while you are away".to_string(), "Có thể chạy khi anh vắng mặt".to_string(), "可以在你不在时运行".to_string()),
                other => (format!("Capability {other}"), format!("Quyền {other}"), format!("权限 {other}")),
            }
        })
        .collect()
}

/// What the person granted, one line each `(english, vietnamese, chinese)`: the folders, sites and programs by name and the LAN switch. These
/// are part of what is accepted (the record covers `grants_sha256`).
fn grant_lines(g: &Grants) -> Vec<(String, String, String)> {
    let show = |ps: &[std::path::PathBuf]| ps.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ");
    let mut out = Vec::new();
    if let Some(ws) = &g.workspace {
        out.push((format!("Workspace folder: {}", ws.display()), format!("Thư mục làm việc: {}", ws.display()), format!("工作文件夹：{}", ws.display())));
    }
    if !g.paths.is_empty() {
        out.push((format!("Other folders: {}", show(&g.paths)), format!("Thư mục khác: {}", show(&g.paths)), format!("其他文件夹：{}", show(&g.paths))));
    }
    if !g.origins.is_empty() {
        out.push((format!("Sites you added: {}", g.origins.join(", ")), format!("Trang anh đã thêm: {}", g.origins.join(", ")), format!("你添加的网站：{}", g.origins.join(", "))));
    }
    if !g.programs.is_empty() {
        out.push((format!("Programs you chose: {}", show(&g.programs)), format!("Chương trình anh chọn: {}", show(&g.programs)), format!("你选择的程序：{}", show(&g.programs))));
    }
    if g.lan {
        out.push(("Other devices on your network may connect".to_string(), "Các thiết bị khác trong mạng của anh được kết nối vào".to_string(), "你网络中的其他设备可以连接".to_string()));
    }
    if out.is_empty() {
        out.push(("Nothing granted yet".to_string(), "Chưa cấp gì".to_string(), "尚未授予任何权限".to_string()));
    }
    out
}

/// The sha256 of the grants as the host stores them (`grants_to_json`): binds a record to exactly what was granted.
pub fn grants_sha256(g: &Grants) -> String {
    sha256_hex(crate::packs::grants_to_json(g).to_string().as_bytes())
}

/// What a helper that is NOT boxed in can reach, in plain words `(english, vietnamese, chinese)`, or `None` for a contained helper (R7d,
/// gate R7c section 7: "data can leave through the pack's own helper program" said where the data goes, not what the helper can reach).
/// `input.inject` runs at the user's own integrity: it reads and changes every file of the user. `screen.capture`, `audio.capture` and
/// `device.usb` run at Low integrity: they read the user's files and use the network but cannot change the user's files (measured, R7c).
fn uncontained_helper_words(manifest: &Manifest) -> Option<(&'static str, &'static str, &'static str)> {
    if manifest.helper_contained() {
        None
    } else if manifest.capability("input.inject").is_some() {
        Some((
            "The pack's own helper program is not boxed in. On its own, without asking Zumi, it can read and change your files, use the network, and control the mouse and keyboard.",
            "Chương trình trợ giúp của chính gói không bị nhốt trong hộp kín. Nó tự làm được, không cần hỏi Zumi: đọc và sửa tệp của anh, dùng mạng, và điều khiển chuột, bàn phím.",
            "该包自带的辅助程序没有被隔离。它无需询问 Zumi，就可以读取和修改你的文件、使用网络，并控制鼠标和键盘。",
        ))
    } else {
        Some((
            "The pack's own helper program is not boxed in. On its own, without asking Zumi, it can read your files and use the network.",
            "Chương trình trợ giúp của chính gói không bị nhốt trong hộp kín. Nó tự làm được, không cần hỏi Zumi: đọc tệp của anh và dùng mạng.",
            "该包自带的辅助程序没有被隔离。它无需询问 Zumi，就可以读取你的文件并使用网络。",
        ))
    }
}

/// The words the person sees, `(english, vietnamese)`: the pack's own first line (the worst realistic case), the generated list of what
/// it can do, what the person granted, who pays, and what Zumi does not promise. Nothing here says or implies that the pack is protected.
pub fn consent_text(manifest: &Manifest, risk_en: &str, risk_vi: &str, grants: &Grants) -> (String, String) {
    let (en, vi, _) = consent_text3(manifest, risk_en, risk_vi, grants);
    (en, vi)
}

/// The same words in Chinese. A pack ships its own worst-case line in English and Vietnamese only, so this text points to those two.
pub fn consent_text_zh(manifest: &Manifest, grants: &Grants) -> String {
    consent_text3(manifest, "", "", grants).2
}

fn consent_text3(manifest: &Manifest, risk_en: &str, risk_vi: &str, grants: &Grants) -> (String, String, String) {
    let lines = capability_lines(manifest);
    let list_en = lines.iter().map(|(e, _, _)| format!("- {e}")).collect::<Vec<_>>().join("\n");
    let list_vi = lines.iter().map(|(_, v, _)| format!("- {v}")).collect::<Vec<_>>().join("\n");
    let list_zh = lines.iter().map(|(_, _, z)| format!("- {z}")).collect::<Vec<_>>().join("\n");
    let granted = grant_lines(grants);
    // R7b (gate should-fix 1): "data leaves only to the places listed" is true only for a pack that can neither start programs nor open a door.
    // R7c (re-gate R7b S-B): also not true when the helper's own code is not contained (it needs the user's desktop or devices).
    // R7d: for such a helper the words say what it can reach, not only where data goes (`uncontained_helper_words`).
    let (spawns, listens) = (manifest.capability("proc.spawn").is_some(), manifest.capability("net.listen").is_some());
    let own = uncontained_helper_words(manifest);
    let (mut flow_en, mut flow_vi, mut flow_zh) = match (spawns, listens, own.is_some()) {
        (false, false, false) => ("Data leaves this PC only to the places listed above.".to_string(), "Dữ liệu chỉ rời máy này tới những nơi liệt kê ở trên.".to_string(), "数据只会发送到上面列出的位置。".to_string()),
        (false, false, true) => (String::new(), String::new(), String::new()),
        _ => {
            let ways_en = [spawns.then_some("the programs it starts"), listens.then_some("whoever connects to the door it opens")].into_iter().flatten().collect::<Vec<_>>().join(" and ");
            let ways_vi = [spawns.then_some("các chương trình nó chạy"), listens.then_some("bất kỳ ai kết nối vào cổng nó mở")].into_iter().flatten().collect::<Vec<_>>().join(" và ");
            let ways_zh = [spawns.then_some("它运行的程序"), listens.then_some("任何连接到它所开放入口的人")].into_iter().flatten().collect::<Vec<_>>().join("和");
            (format!("Data can leave this PC through {ways_en}, not only to the places listed above."), format!("Dữ liệu có thể rời máy này qua {ways_vi}, không chỉ tới những nơi liệt kê ở trên."), format!("数据可能经由{ways_zh}离开这台电脑，而不只是发送到上面列出的位置。"))
        }
    };
    if let Some((e, v, z)) = own {
        flow_en = format!("{flow_en} {e}").trim().to_string();
        flow_vi = format!("{flow_vi} {v}").trim().to_string();
        flow_zh = format!("{flow_zh}{z}");
    }
    let granted_en = granted.iter().map(|(e, _, _)| format!("- {e}")).collect::<Vec<_>>().join("\n");
    let granted_vi = granted.iter().map(|(_, v, _)| format!("- {v}")).collect::<Vec<_>>().join("\n");
    let granted_zh = granted.iter().map(|(_, _, z)| format!("- {z}")).collect::<Vec<_>>().join("\n");
    // RC1 gate + live gate C1: "stop it at any time" and "removing deletes everything it stored" are true only for a pack that cannot leave anything behind: its
    // helper is boxed in, it starts no program (a program it starts can outlive a stop, start itself again through WMI and write anywhere the user can) and it
    // writes only in its own folder (files it wrote in a workspace or a folder the person picked stay when the pack is removed). Any other pack gets words that
    // say what Zumi cannot promise.
    let writes_outside = manifest.capabilities.iter().filter(|c| c.id == "fs.write").any(|c| strs(&c.scope["roots"]).iter().any(|r| r != "pack-data"));
    let (end_en, end_vi, end_zh) = if own.is_some() {
        (
            "You can ask Zumi to stop it and remove it. Its helper program is not boxed in, so Zumi cannot promise that it stops for good or that removing deletes everything it saved or wrote.",
            "Anh có thể yêu cầu Zumi dừng và gỡ gói. Chương trình trợ giúp của gói không bị nhốt trong hộp kín, nên Zumi không thể hứa rằng nó dừng hẳn, hay rằng gỡ sẽ xóa mọi thứ nó đã lưu hoặc đã ghi.",
            "你可以让 Zumi 停止并移除它。它自带的辅助程序没有被隔离，因此 Zumi 无法保证它会彻底停止，也无法保证移除会删除它保存或写入的所有内容。",
        )
    } else if spawns || writes_outside {
        (
            "You can ask Zumi to stop it and remove it. A program it starts can keep running, and files it wrote outside its own folder stay where they are, so Zumi cannot promise that it stops for good or that removing deletes everything it saved or wrote.",
            "Anh có thể yêu cầu Zumi dừng và gỡ gói. Chương trình gói chạy có thể vẫn chạy tiếp, và tệp gói đã ghi ngoài thư mục riêng của nó vẫn nằm lại, nên Zumi không thể hứa rằng nó dừng hẳn, hay rằng gỡ sẽ xóa mọi thứ nó đã lưu hay đã ghi.",
            "你可以让 Zumi 停止并移除它。它运行的程序可能继续运行，它写在自己文件夹之外的文件会留在原处，因此 Zumi 无法保证它会彻底停止，也无法保证移除会删除它保存或写入的所有内容。",
        )
    } else {
        (
            "You can stop it at any time and remove it; removing deletes everything it stored.",
            "Anh có thể dừng bất cứ lúc nào và gỡ ra; gỡ sẽ xóa mọi thứ gói đã lưu.",
            "你可以随时停止并移除它；移除会删除它保存的所有内容。",
        )
    };
    let level = manifest.risk_level.as_deref().unwrap_or("high").to_uppercase();
    let en = format!(
        "{}\n\nPack: {} {} (risk: {level})\nThis pack can:\n{list_en}\n\nWhat you granted it:\n{granted_en}\n\n{flow_en} You use your own keys and accounts, and that service's own terms apply.\nZumi gives no promise about what this pack does once you accept. You accept the risk.\n{end_en}",
        risk_en.trim(),
        manifest.id,
        manifest.version
    );
    let vi = format!(
        "{}\n\nGói: {} {} (mức rủi ro: {level})\nGói này có thể:\n{list_vi}\n\nAnh đã cấp cho gói:\n{granted_vi}\n\n{flow_vi} Anh dùng khóa và tài khoản của chính anh, và điều khoản của dịch vụ đó vẫn áp dụng.\nZumi không hứa gì về việc gói này làm sau khi anh chấp nhận. Anh tự chịu rủi ro.\n{end_vi}",
        risk_vi.trim(),
        manifest.id,
        manifest.version
    );
    let zh = format!(
        "风险说明见上方的英文和越南文。\n\n包：{} {}（风险等级：{level}）\n该包可以：\n{list_zh}\n\n你授予它的权限：\n{granted_zh}\n\n{flow_zh}你使用你自己的密钥和账户，该服务自己的条款同样适用。\nZumi 不保证你接受后该包会做什么。风险由你自己承担。\n{end_zh}",
        manifest.id, manifest.version
    );
    (en, vi, zh)
}

/// What the host asks of the OS for the user the app runs as; part of the record. Fail closed: no SID, no consent.
#[cfg(windows)]
pub fn current_user_sid() -> Result<String, String> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    // SAFETY: the token handle is opened and closed here; the buffer is sized by the first call and the SID text is freed with LocalFree.
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(|e| format!("sid_token: {e}"))?;
        let mut need = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut need);
        let mut buf = vec![0u8; need.max(1) as usize];
        let got = GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr() as *mut _), need, &mut need);
        let result = match got {
            Ok(()) => {
                let user = &*(buf.as_ptr() as *const TOKEN_USER);
                let mut pw = windows::core::PWSTR::null();
                match ConvertSidToStringSidW(user.User.Sid, &mut pw) {
                    Ok(()) => {
                        let text = pw.to_string().map_err(|e| format!("sid_text: {e}"));
                        let _ = LocalFree(Some(HLOCAL(pw.0 as *mut _)));
                        text
                    }
                    Err(e) => Err(format!("sid_convert: {e}")),
                }
            }
            Err(e) => Err(format!("sid_info: {e}")),
        };
        let _ = CloseHandle(token);
        result
    }
}

#[cfg(not(windows))]
pub fn current_user_sid() -> Result<String, String> {
    Err("sid_unsupported".to_string())
}

/// The real dialog (R7b M3): the question on its own private desktop (`secure_ask`), the screen switched to it, injected input dropped,
/// Decline (No) the default button, no answer in two minutes = No. The 5-second delay, scroll-to-end and typed pack name of roadmap 1.5
/// are K0b (the public gate).
#[cfg(windows)]
pub struct NativeConsent;

#[cfg(windows)]
pub const CONSENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

#[cfg(windows)]
impl ConsentDialog for NativeConsent {
    fn ask(&self, title: &str, text: &str) -> bool {
        self.ask_checked(title, text).unwrap_or(false)
    }

    fn ask_checked(&self, title: &str, text: &str) -> Result<bool, String> {
        secure_ask(title, &format!("{text}\n\nAccept this risk? / Chấp nhận rủi ro này?"), &SecureOpts { switch: true, timeout: CONSENT_TIMEOUT })
    }
}

/// How the consent window is shown.
pub struct SecureOpts {
    /// Switch the screen to the window's private desktop (the person sees only the question). The real window always does; tests that
    /// must not take over the screen of the machine they run on do not (the window still lives on its private desktop).
    pub switch: bool,
    /// No answer in this time is No.
    pub timeout: std::time::Duration,
}

/// R7b M3 (gate R7): the consent question on a PRIVATE desktop of its own, like a secure desktop.
/// - The desktop gets a random name and a DACL that grants nobody but SYSTEM (and the owner only READ_CONTROL, so the user's processes
///   cannot rewrite it): another process of the same user cannot open it, so it cannot attach a thread there, and window messages do not
///   cross desktops, so FindWindow / SendMessage / PostMessage from the user's desktop never reach the box. Only the host holds a handle.
/// - With `switch`, the screen shows that desktop while the question is open, and low-level keyboard and mouse hooks on it drop every
///   INJECTED event (`SendInput`), so only input from real devices answers. A remote-control tool that injects input cannot answer.
/// - No answer within `timeout` is No. Any step that fails is an error and no consent (the caller records nothing).
/// What a process of the same user and integrity can still do is to act INSIDE the Zumi process (open it and inject code), which no
/// window can stop. Packs are kept from that by the token (R7c): the programs a pack starts run at Low integrity, a helper that needs no
/// desktop or device runs in an AppContainer; the job's UI limits alone do not hold (a nested job or a WMI-born process leaves them).
#[cfg(windows)]
pub fn secure_ask(title: &str, text: &str, opts: &SecureOpts) -> Result<bool, String> {
    secure::ask(title, text, opts, None)
}

/// The same window answered by the host itself (a thread on that desktop presses the button): the positive control of the tests.
#[cfg(all(windows, feature = "canary"))]
pub fn secure_ask_answered_by_host(title: &str, text: &str, opts: &SecureOpts, answer: bool) -> Result<bool, String> {
    secure::ask(title, text, opts, Some(answer))
}

#[cfg(windows)]
mod secure {
    use super::SecureOpts;
    use std::cell::Cell;
    use windows::core::{BOOL, PCWSTR};
    use windows::Win32::Foundation::{GetLastError, LocalFree, HLOCAL, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::StationsAndDesktops::{CloseDesktop, CreateDesktopW, OpenInputDesktop, SetThreadDesktop, SwitchDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_SWITCHDESKTOP, HDESK};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, EndDialog, EnumThreadWindows, GetDlgItem, KillTimer, MessageBoxW, SendMessageW, SetTimer, SetWindowsHookExW, UnhookWindowsHookEx, BM_CLICK, HC_ACTION, IDNO, IDYES,
        KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLMHF_INJECTED, MB_DEFBUTTON2, MB_ICONWARNING, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO, MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL,
    };

    /// SYSTEM: all; the owner: READ_CONTROL only (no implicit WRITE_DAC); nobody else. Protected (no inherited ACEs).
    const SDDL: &str = "D:P(A;;GA;;;SY)(A;;RC;;;OW)";
    const GENERIC_ALL: u32 = 0x1000_0000;

    thread_local! {
        static HOST_ANSWER: Cell<Option<bool>> = const { Cell::new(None) };
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Ends the box on this thread with `result`, or presses its button (`press`).
    fn each_box(press: Option<i32>, result: isize) {
        unsafe extern "system" fn visit(hwnd: HWND, l: LPARAM) -> BOOL {
            let (press, result) = (l.0 >> 32, l.0 & 0xffff_ffff);
            // SAFETY: a window of this thread (EnumThreadWindows), so the calls run on its owner.
            unsafe {
                if press > 0 {
                    if let Ok(b) = GetDlgItem(Some(hwnd), press as i32) {
                        SendMessageW(b, BM_CLICK, Some(WPARAM(0)), Some(LPARAM(0)));
                    }
                } else {
                    let _ = EndDialog(hwnd, result);
                }
            }
            true.into()
        }
        let packed = ((press.unwrap_or(0) as isize) << 32) | result;
        // SAFETY: the callback only touches windows of this thread.
        unsafe {
            let _ = EnumThreadWindows(GetCurrentThreadId(), Some(visit), LPARAM(packed));
        }
    }

    unsafe extern "system" fn on_timeout(_: HWND, _: u32, _: usize, _: u32) {
        each_box(None, IDNO.0 as isize);
    }

    unsafe extern "system" fn on_host_answer(_: HWND, _: u32, id: usize, _: u32) {
        // SAFETY: a timer of this thread.
        let _ = unsafe { KillTimer(None, id) };
        if let Some(yes) = HOST_ANSWER.with(Cell::get) {
            each_box(Some(if yes { IDYES.0 } else { IDNO.0 }), 0);
        }
    }

    unsafe extern "system" fn keyboard(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        // SAFETY: for HC_ACTION, lParam points at a KBDLLHOOKSTRUCT (WH_KEYBOARD_LL contract).
        unsafe {
            if code == HC_ACTION as i32 && ((*(l.0 as *const KBDLLHOOKSTRUCT)).flags.0 & LLKHF_INJECTED.0) != 0 {
                return LRESULT(1);
            }
            CallNextHookEx(None, code, w, l)
        }
    }

    unsafe extern "system" fn mouse(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        // SAFETY: for HC_ACTION, lParam points at a MSLLHOOKSTRUCT (WH_MOUSE_LL contract).
        unsafe {
            if code == HC_ACTION as i32 && ((*(l.0 as *const MSLLHOOKSTRUCT)).flags & LLMHF_INJECTED) != 0 {
                return LRESULT(1);
            }
            CallNextHookEx(None, code, w, l)
        }
    }

    /// The box itself, on a fresh thread attached to the private desktop.
    fn show(desk: isize, title: &str, text: &str, timeout_ms: u32, hooks: bool, host_answer: Option<bool>) -> Result<bool, String> {
        // SAFETY: this thread has no window or hook yet (a fresh thread), so it may move to the desktop; the hooks and timers are its own
        // and are removed before it ends; the buffers outlive MessageBoxW.
        unsafe {
            SetThreadDesktop(HDESK(desk as *mut _)).map_err(|e| format!("consent_desktop_attach: {e}"))?;
            let mut installed = Vec::new();
            if hooks {
                let module = GetModuleHandleW(None).map_err(|e| format!("consent_hook: {e}"))?;
                installed.push(SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), Some(module.into()), 0).map_err(|e| format!("consent_hook: {e}"))?);
                match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), Some(module.into()), 0) {
                    Ok(h) => installed.push(h),
                    Err(e) => {
                        for h in installed {
                            let _ = UnhookWindowsHookEx(h);
                        }
                        return Err(format!("consent_hook: {e}"));
                    }
                }
            }
            let timer = SetTimer(None, 0, timeout_ms, Some(on_timeout));
            HOST_ANSWER.with(|c| c.set(host_answer));
            let answer_timer = if host_answer.is_some() { SetTimer(None, 0, 300, Some(on_host_answer)) } else { 0 };
            let (t, x) = (wide(title), wide(text));
            let r = MessageBoxW(None, PCWSTR(x.as_ptr()), PCWSTR(t.as_ptr()), MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SETFOREGROUND | MB_TOPMOST);
            let err = GetLastError();
            for id in [timer, answer_timer] {
                if id != 0 {
                    let _ = KillTimer(None, id);
                }
            }
            for h in installed {
                let _ = UnhookWindowsHookEx(h);
            }
            if timer == 0 {
                return Err("consent_timer_failed".to_string());
            }
            if r.0 == 0 {
                return Err(format!("consent_box_failed: {err:?}"));
            }
            Ok(r == IDYES)
        }
    }

    /// A new desktop under `SDDL`; the returned handle is the only way in.
    pub(super) fn make_desktop(name: &str) -> Result<HDESK, String> {
        // SAFETY: the security descriptor is freed with LocalFree after the call that reads it.
        unsafe {
            let mut sd = PSECURITY_DESCRIPTOR::default();
            ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(wide(SDDL).as_ptr()), SDDL_REVISION_1, &mut sd, None).map_err(|e| format!("consent_sd: {e}"))?;
            let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd.0, bInheritHandle: false.into() };
            let made = CreateDesktopW(PCWSTR(wide(name).as_ptr()), PCWSTR::null(), None, DESKTOP_CONTROL_FLAGS(0), GENERIC_ALL, Some(&sa));
            let _ = LocalFree(Some(HLOCAL(sd.0)));
            made.map_err(|e| format!("consent_desktop: {e}"))
        }
    }

    pub fn ask(title: &str, text: &str, opts: &SecureOpts, host_answer: Option<bool>) -> Result<bool, String> {
        let name = format!("zumi-consent-{}", zumi_audit::hostmac::to_hex(&zumi_audit::hostmac::new_key()?[..12]));
        let timeout_ms = u32::try_from(opts.timeout.as_millis()).unwrap_or(u32::MAX).max(1);
        let desk = make_desktop(&name)?;
        // SAFETY: desktop handles are closed on every path; the dialog thread is joined before its desktop is closed.
        unsafe {
            let original = if opts.switch {
                match OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_SWITCHDESKTOP) {
                    Ok(o) => Some(o),
                    Err(e) => {
                        let _ = CloseDesktop(desk);
                        return Err(format!("consent_input_desktop: {e}"));
                    }
                }
            } else {
                None
            };
            if original.is_some() {
                if let Err(e) = SwitchDesktop(desk) {
                    let _ = original.map(|o| CloseDesktop(o));
                    let _ = CloseDesktop(desk);
                    return Err(format!("consent_switch: {e}"));
                }
            }
            let (raw, t, x, hooks) = (desk.0 as isize, title.to_string(), text.to_string(), opts.switch);
            let joined = std::thread::spawn(move || show(raw, &t, &x, timeout_ms, hooks, host_answer)).join();
            if let Some(o) = original {
                // Back to the person's desktop whatever happened above.
                let _ = SwitchDesktop(o);
                let _ = CloseDesktop(o);
            }
            let _ = CloseDesktop(desk);
            joined.map_err(|_| "consent_thread_panicked".to_string())?
        }
    }
}

/// What a consent record is bound to.
pub struct Binding<'a> {
    pub manifest: &'a Manifest,
    pub risk_en: &'a str,
    pub risk_vi: &'a str,
    pub sid: &'a str,
    /// What the person granted (folders, sites, programs, LAN): shown in the window and covered by the record.
    pub grants: &'a Grants,
}

impl Binding<'_> {
    fn fields(&self, t: &str) -> [String; 7] {
        [self.manifest.id.clone(), self.manifest.version.clone(), self.manifest.capabilities_sha256(), risk_text_sha256(self.risk_en, self.risk_vi), self.sid.to_string(), grants_sha256(self.grants), t.to_string()]
    }
}

/// Shows the consent window and, only if a person accepts, writes the audit line and the signed record. Declining writes an audit line
/// and no record. An acceptance that cannot be logged is not recorded. No key, no window: a record that could not be signed is not asked for.
pub fn request_consent(dialog: &dyn ConsentDialog, b: &Binding, audit: &PackAudit, state_dir: &Path, key: &[u8]) -> Result<bool, String> {
    if key.len() < 16 {
        return Err("host_key_missing".to_string());
    }
    let (id, version) = (b.manifest.id.as_str(), b.manifest.version.as_str());
    let (en, vi, zh) = consent_text3(b.manifest, b.risk_en, b.risk_vi, b.grants);
    let asked = dialog.ask_checked(&format!("Zumi: {id} {version}"), &format!("{en}

---

{vi}

---

{zh}"));
    let accepted = match asked {
        Ok(a) => a,
        Err(e) => {
            // No window, no consent: logged as a refusal with the reason, and returned so the UI can say it.
            let _ = audit.append(&Row::event(id, version, "consent", "refused-user", Some("window_failed"), &e));
            return Err(format!("consent_window: {e}"));
        }
    };
    if !accepted {
        audit.append(&Row::event(id, version, "consent", "refused-user", Some("declined"), "")).map_err(|e| format!("audit: {e}"))?;
        return Ok(false);
    }
    let detail = json!({ "by": "host_dialog", "capabilities_sha256": b.manifest.capabilities_sha256(), "risk_text_sha256": risk_text_sha256(b.risk_en, b.risk_vi), "grants_sha256": grants_sha256(b.grants) }).to_string();
    audit.append(&Row::event(id, version, "consent", "allowed", None, &detail)).map_err(|e| format!("the acceptance could not be logged, so it was not recorded: {e}"))?;
    write_record(state_dir, b, key)?;
    Ok(true)
}

/// Is there a record for exactly this pack, version, capabilities, risk words and user, signed by the host key? Fixed code words:
/// `consent_missing` (no record for this pack), `consent_stale` (records exist but none matches what the pack declares now),
/// `consent_invalid` (a matching record whose MAC does not verify, or a key too short to verify anything).
pub fn verify_consent(b: &Binding, state_dir: &Path, key: &[u8]) -> Result<(), &'static str> {
    if key.len() < 16 {
        return Err("consent_invalid");
    }
    let text = match std::fs::read_to_string(state_dir.join(CONSENT_FILE)) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err("consent_missing"),
        Err(_) => return Err("consent_invalid"),
    };
    let want = b.fields("");
    let (mut for_pack, mut matching) = (0, 0);
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("");
        if !v.is_object() || s("pack") != b.manifest.id {
            continue;
        }
        for_pack += 1;
        if (s("version"), s("capabilities_sha256"), s("risk_text_sha256"), s("windows_user_sid"), s("grants_sha256")) != (want[1].as_str(), want[2].as_str(), want[3].as_str(), want[4].as_str(), want[5].as_str()) {
            continue;
        }
        matching += 1;
        let t = v.get("t_unix_ms").and_then(Value::as_u64).map(|t| t.to_string()).unwrap_or_default();
        let f = b.fields(&t);
        let refs: Vec<&str> = f.iter().map(String::as_str).collect();
        if verify(key, &refs, s("mac")) {
            return Ok(());
        }
    }
    match (for_pack, matching) {
        (0, _) => Err("consent_missing"),
        (_, 0) => Err("consent_stale"),
        _ => Err("consent_invalid"),
    }
}

/// Takes every record of a pack away (a kill, an uninstall). `Ok(true)` if there was a file.
pub fn revoke_consent(state_dir: &Path) -> Result<bool, String> {
    match std::fs::remove_file(state_dir.join(CONSENT_FILE)) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("consent_revoke: {e}")),
    }
}

fn write_record(state_dir: &Path, b: &Binding, key: &[u8]) -> Result<(), String> {
    let t = zumi_audit::unix_ms().to_string();
    let f = b.fields(&t);
    let refs: Vec<&str> = f.iter().map(String::as_str).collect();
    let mac = mac_hex(key, &refs);
    let line = json!({ "pack": f[0], "version": f[1], "capabilities_sha256": f[2], "risk_text_sha256": f[3], "windows_user_sid": f[4], "grants_sha256": f[5], "t_unix_ms": t.parse::<u64>().unwrap_or(0), "mac": mac }).to_string();
    std::fs::create_dir_all(state_dir).map_err(|e| format!("consent_dir: {e}"))?;
    std::fs::OpenOptions::new().create(true).append(true).open(state_dir.join(CONSENT_FILE)).and_then(|mut f| writeln!(f, "{line}")).map_err(|e| format!("consent_store: {e}"))
}

#[cfg(all(test, windows))]
mod tests {
    /// Bite for the desktop DACL: the SAME user, even this very process, cannot open the consent desktop by its name. Only the handle
    /// returned at creation works.
    #[test]
    fn nobody_opens_the_consent_desktop_by_name_not_even_the_same_user() {
        use windows::core::PCWSTR;
        use windows::Win32::System::StationsAndDesktops::{CloseDesktop, OpenDesktopW, DESKTOP_CONTROL_FLAGS};
        let name = format!("zumi-consent-test-{}", std::process::id());
        let desk = super::secure::make_desktop(&name).expect("made");
        let w: Vec<u16> = name.encode_utf16().chain([0]).collect();
        for access in [0x01FFu32, 0x0001, 0x0080, 0x0100] {
            // SAFETY: a NUL-terminated name; a handle that opens is closed.
            let opened = unsafe { OpenDesktopW(PCWSTR(w.as_ptr()), DESKTOP_CONTROL_FLAGS(0), false, access) };
            if let Ok(h) = opened {
                // SAFETY: closed once.
                let _ = unsafe { CloseDesktop(h) };
                panic!("opened the consent desktop by name with access {access:#x}");
            }
        }
        // SAFETY: closed once.
        let _ = unsafe { CloseDesktop(desk) };
    }
}
