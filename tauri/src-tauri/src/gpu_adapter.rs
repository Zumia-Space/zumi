// The display adapter's name and driver version, for the 3D-room bench memory key (ADR room-live-b D8: "again when the GPU adapter
// name or driver version changes"). Windows only; elsewhere, or when anything is unreadable, both parts are empty and the caller
// writes `unknown`. No DXGI and no new crate: `EnumDisplayDevicesW` names the primary adapter, and the display-adapter class key in the
// registry holds its `DriverVersion`. Nothing here is shown to a page or sent anywhere; it only becomes part of a local settings key.

/// (adapter name, driver version), either may be empty.
pub fn read() -> (String, String) {
    imp::read()
}

#[cfg(not(windows))]
mod imp {
    pub fn read() -> (String, String) {
        (String::new(), String::new())
    }
}

#[cfg(windows)]
mod imp {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Graphics::Gdi::{EnumDisplayDevicesW, DISPLAY_DEVICEW, DISPLAY_DEVICE_PRIMARY_DEVICE};
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

    const DISPLAY_CLASS: &str = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn from_wide(w: &[u16]) -> String {
        String::from_utf16_lossy(&w[..w.iter().position(|c| *c == 0).unwrap_or(w.len())]).trim().to_string()
    }

    fn reg_string(sub: &str, value: &str) -> Option<String> {
        let (sub, value) = (wide(sub), wide(value));
        let mut buf = [0u16; 256];
        let mut bytes = (buf.len() * 2) as u32;
        // SAFETY: both strings are NUL-terminated, `buf` and `bytes` describe the same writable memory.
        let rc = unsafe { RegGetValueW(HKEY_LOCAL_MACHINE, sub.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, null_mut(), buf.as_mut_ptr().cast(), &mut bytes) };
        (rc == 0).then(|| from_wide(&buf))
    }

    fn primary_adapter() -> String {
        let mut first = String::new();
        for i in 0..16 {
            // SAFETY: DISPLAY_DEVICEW is plain data; `cb` is set as the API requires.
            let mut d: DISPLAY_DEVICEW = unsafe { std::mem::zeroed() };
            d.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
            // SAFETY: a valid out pointer; a null device name enumerates adapters.
            if unsafe { EnumDisplayDevicesW(null(), i, &mut d, 0) } == 0 {
                break;
            }
            let name = from_wide(&d.DeviceString);
            if d.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE != 0 {
                return name;
            }
            if first.is_empty() {
                first = name;
            }
        }
        first
    }

    pub fn read() -> (String, String) {
        let name = primary_adapter();
        if name.is_empty() {
            return (name, String::new());
        }
        let driver = (0..32)
            .find_map(|i| {
                let sub = format!(r"{DISPLAY_CLASS}\{i:04}");
                (reg_string(&sub, "DriverDesc").as_deref() == Some(name.as_str())).then(|| reg_string(&sub, "DriverVersion")).flatten()
            })
            .unwrap_or_default();
        (name, driver)
    }
}
