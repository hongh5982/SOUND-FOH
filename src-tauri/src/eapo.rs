//! Equalizer APO connection: find the Windows audio endpoint behind a speaker, switch Equalizer APO on
//! for it, and write Sound FOH's own correction file.
//!
//! The registry layout follows Equalizer APO's Device Selector (GPL-2.0), so its own tools still see a
//! device that Sound FOH switched on, and can switch it off again.

use serde::Serialize;

pub const SOUNDFOH_FILE: &str = "soundfoh.txt";
pub const INCLUDE_LINE: &str = "Include: soundfoh.txt";

#[derive(Serialize, Clone, Debug, Default)]
pub struct Status {
    /// Equalizer APO is installed on this PC.
    pub installed: bool,
    /// The Windows endpoint for the chosen speaker was found.
    pub found: bool,
    /// Equalizer APO is switched on for that endpoint.
    pub enabled: bool,
    pub guid: Option<String>,
    pub config_dir: Option<String>,
}

/// "3|Speakers (Realtek Audio)" -> "Speakers (Realtek Audio)"
pub fn device_name(id: &str) -> &str {
    id.split_once('|').map(|(_, n)| n).unwrap_or(id)
}

/// Adds the Include line to an Equalizer APO config.txt, keeping everything else.
pub fn with_include(config: &str) -> Option<String> {
    let has = config.lines().any(|l| l.trim().eq_ignore_ascii_case(INCLUDE_LINE));
    if has {
        return None;
    }
    let mut s = config.to_string();
    if !s.is_empty() && !s.ends_with('\n') {
        s.push_str("\r\n");
    }
    s.push_str(INCLUDE_LINE);
    s.push_str("\r\n");
    Some(s)
}

#[cfg(windows)]
pub use win::*;

#[cfg(not(windows))]
pub fn status(_device: &str) -> Status {
    Status::default()
}
#[cfg(not(windows))]
pub fn enable(_device: &str) -> Result<Status, String> {
    Err("Windows에서만 쓸 수 있어요".into())
}
#[cfg(not(windows))]
pub fn write_correction(_text: &str) -> Result<(), String> {
    Err("Windows에서만 쓸 수 있어요".into())
}
#[cfg(not(windows))]
pub fn helper_main() -> Option<i32> {
    None
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::Command;
    use winreg::enums::*;
    use winreg::RegKey;

    const PRE: &str = "{EACD2258-FCAC-4FF4-B36D-419E924A6D79}";
    const POST: &str = "{EC1CC9CE-FAED-4822-828A-82A81A6F018F}";
    const FX: &str = "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d}";
    const MODE: &str = "{d3993a3f-99c2-4402-b5ec-a92a0367664b}";
    const DEFAULT_MODE: &str = "{C18E2F7E-933D-4965-B7D1-1EEF228D2AF3}";
    const FX_TITLE: &str = "{b725f130-47ef-101a-a5f1-02608c9eebac},10";
    const DISABLE_ENH: &str = "{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},5";
    const P_CONNECTION: &str = "{a45c254e-df1c-4efd-8020-67d146a850e0},2";
    const P_DEVICE: &str = "{b3f8fa53-0004-438e-9003-51a46e139bfc},6";
    const P_COMBINED: &str = "{b3f8fa53-0004-438e-9003-51a46e139bfc},41";
    const RENDER: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render";
    const APP: &str = r"SOFTWARE\EqualizerAPO";
    const NOKEY: &str = "!KEY";
    const NOVALUE: &str = "!VALUE";
    const NO_WINDOW: u32 = 0x0800_0000;

    fn hklm() -> RegKey {
        RegKey::predef(HKEY_LOCAL_MACHINE)
    }
    fn read(path: &str) -> Option<RegKey> {
        hklm().open_subkey_with_flags(path, KEY_READ | KEY_WOW64_64KEY).ok()
    }
    fn fx_name(i: u32) -> String {
        format!("{FX},{i}")
    }

    fn install_dir() -> Option<PathBuf> {
        let k = read(APP)?;
        let p: String = k.get_value("InstallPath").ok()?;
        Some(PathBuf::from(p))
    }
    pub fn config_dir() -> Option<PathBuf> {
        let k = read(APP)?;
        if let Ok(p) = k.get_value::<String, _>("ConfigPath") {
            let p = PathBuf::from(p);
            if p.is_dir() {
                return Some(p);
            }
        }
        let p = install_dir()?.join("config");
        p.is_dir().then_some(p)
    }

    /// Finds the render endpoint whose Windows name is "<connection> (<device>)", as WASAPI names it.
    pub fn find_endpoint(name: &str) -> Option<String> {
        let render = read(RENDER)?;
        let mut best: Option<(String, bool)> = None;
        for guid in render.enum_keys().flatten() {
            let Ok(dev) = render.open_subkey_with_flags(&guid, KEY_READ | KEY_WOW64_64KEY) else { continue };
            let Ok(props) = dev.open_subkey_with_flags("Properties", KEY_READ | KEY_WOW64_64KEY) else { continue };
            let conn: String = props.get_value(P_CONNECTION).unwrap_or_default();
            let devn: String = props.get_value(P_DEVICE).unwrap_or_default();
            if format!("{conn} ({devn})") != name && conn != name {
                continue;
            }
            let active = dev.get_value::<u32, _>("DeviceState").map(|s| s & 0xF == 1).unwrap_or(false);
            if best.as_ref().map_or(true, |(_, a)| !a && active) {
                best = Some((guid, active));
            }
        }
        best.map(|(g, _)| g)
    }

    fn fx_values(guid: &str) -> Option<Vec<String>> {
        let fx = read(&format!(r"{RENDER}\{guid}\FxProperties"))?;
        Some([1, 2, 5, 6, 7].iter().map(|i| fx.get_value::<String, _>(fx_name(*i)).unwrap_or_else(|_| NOVALUE.into())).collect())
    }
    fn is_enabled(guid: &str) -> bool {
        fx_values(guid).map_or(false, |v| v.iter().any(|s| s.eq_ignore_ascii_case(PRE) || s.eq_ignore_ascii_case(POST)))
    }

    pub fn status(device: &str) -> Status {
        let installed = install_dir().map_or(false, |d| d.join("EqualizerAPO.dll").is_file());
        let guid = find_endpoint(device_name(device));
        Status {
            installed,
            found: guid.is_some(),
            enabled: guid.as_deref().map_or(false, is_enabled),
            config_dir: config_dir().map(|p| p.to_string_lossy().into_owned()),
            guid,
        }
    }

    /// Writes the correction into soundfoh.txt. Equalizer APO notices the change and applies it at once.
    pub fn write_correction(text: &str) -> Result<(), String> {
        let dir = config_dir().ok_or("Equalizer APO 설정 폴더를 찾을 수 없어요")?;
        let cfg = dir.join("config.txt");
        let cur = std::fs::read_to_string(&cfg).unwrap_or_default();
        if let Some(next) = with_include(&cur) {
            std::fs::write(&cfg, next).map_err(|e| format!("denied: {e}"))?;
        }
        std::fs::write(dir.join(SOUNDFOH_FILE), text).map_err(|e| format!("denied: {e}"))
    }

    // ---------- switching a device on (runs elevated, in a second copy of the app) ----------

    /// Asks Windows for administrator rights once and switches Equalizer APO on for the speaker.
    pub fn enable(device: &str) -> Result<Status, String> {
        let st = status(device);
        if !st.installed {
            return Err("Equalizer APO가 설치돼 있지 않아요".into());
        }
        let guid = st.guid.clone().ok_or("이 스피커를 Windows 오디오 장치에서 찾지 못했어요")?;
        let result = std::env::temp_dir().join(format!("soundfoh-helper-{}.txt", std::process::id()));
        let _ = std::fs::remove_file(&result);
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let args = format!("--eapo-helper enable {guid} \"{}\"", result.display());
        let code = run_elevated(&exe.to_string_lossy(), &args)?;
        let msg = std::fs::read_to_string(&result).unwrap_or_default();
        let _ = std::fs::remove_file(&result);
        if code != 0 {
            return Err(if msg.is_empty() { format!("설정을 바꾸지 못했어요 (코드 {code})") } else { msg });
        }
        Ok(status(device))
    }

    fn run_elevated(exe: &str, args: &str) -> Result<u32, String> {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
        use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
        let w = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let (verb, file, params) = (w("runas"), w(exe), w(args));
        unsafe {
            let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
            info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
            info.lpVerb = verb.as_ptr();
            info.lpFile = file.as_ptr();
            info.lpParameters = params.as_ptr();
            info.nShow = 0; // SW_HIDE
            if ShellExecuteExW(&mut info) == 0 {
                return Err(if GetLastError() == ERROR_CANCELLED { "cancelled".into() } else { format!("관리자 권한으로 실행하지 못했어요 ({})", GetLastError()) });
            }
            if info.hProcess.is_null() {
                return Err("관리자 권한으로 실행하지 못했어요".into());
            }
            let waited = WaitForSingleObject(info.hProcess, 120_000);
            let mut code = 1u32;
            GetExitCodeProcess(info.hProcess, &mut code);
            CloseHandle(info.hProcess);
            if waited != WAIT_OBJECT_0 {
                return Err("설정이 너무 오래 걸려요".into());
            }
            Ok(code)
        }
    }

    /// Entry for the elevated copy: `--eapo-helper enable <guid> <result file>`.
    pub fn helper_main() -> Option<i32> {
        let args: Vec<String> = std::env::args().collect();
        if args.get(1).map(String::as_str) != Some("--eapo-helper") {
            return None;
        }
        let out = args.get(4).cloned();
        let r = match (args.get(2).map(String::as_str), args.get(3)) {
            (Some("enable"), Some(guid)) => helper_enable(guid),
            _ => Err("bad arguments".into()),
        };
        if let (Err(e), Some(p)) = (&r, &out) {
            let _ = std::fs::write(p, e);
        }
        Some(if r.is_ok() { 0 } else { 2 })
    }

    fn helper_enable(guid: &str) -> Result<(), String> {
        if !guid.starts_with('{') || guid.contains('\\') {
            return Err("bad device".into());
        }
        check_registration()?;
        if !is_enabled(guid) {
            install(guid)?;
        }
        prepare_config()?;
        restart_audio();
        Ok(())
    }

    fn run_quiet(cmd: &str, args: &[&str]) -> bool {
        Command::new(cmd).args(args).creation_flags(NO_WINDOW).status().map_or(false, |s| s.success())
    }

    fn check_registration() -> Result<(), String> {
        let cr = RegKey::predef(HKEY_CLASSES_ROOT);
        let ok = [PRE, POST].iter().all(|g| cr.open_subkey(format!(r"CLSID\{g}")).is_ok() && cr.open_subkey(format!(r"AudioEngine\AudioProcessingObjects\{g}")).is_ok());
        if ok {
            return Ok(());
        }
        let dll = install_dir().ok_or("Equalizer APO가 설치돼 있지 않아요")?.join("EqualizerAPO.dll");
        run_quiet("regsvr32.exe", &["/s", &dll.to_string_lossy()]);
        Ok(())
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        LfxGfx,
        SfxMfx,
        SfxEfx,
    }

    fn install(guid: &str) -> Result<(), String> {
        let dev_path = format!(r"{RENDER}\{guid}");
        let fx_path = format!(r"{dev_path}\FxProperties");
        let names: Vec<String> = [1, 2, 5, 6, 7].iter().map(|i| fx_name(*i)).collect();
        let existing = read(&fx_path);
        let orig: Vec<String> = match &existing {
            None => vec![NOKEY.to_string(); 5],
            Some(k) => names.iter().map(|n| k.get_value::<String, _>(n).unwrap_or_else(|_| NOVALUE.into())).collect(),
        };
        let real = |s: &String| s != NOKEY && s != NOVALUE && !s.is_empty();
        let multi = existing.as_ref().map_or(false, |k| [13, 14, 15].iter().any(|i| k.get_raw_value(fx_name(*i)).is_ok()));
        let combined = read(&format!(r"{dev_path}\Properties")).map_or(false, |p| p.get_raw_value(P_COMBINED).is_ok());
        let mode = if (real(&orig[0]) || real(&orig[1])) && !orig[2..].iter().any(real) && !multi {
            Mode::LfxGfx
        } else if combined {
            Mode::SfxMfx
        } else {
            Mode::SfxEfx
        };

        // remember what the driver had, where Equalizer APO keeps it
        let flags = KEY_ALL_ACCESS | KEY_WOW64_64KEY;
        let (child, _) = hklm()
            .create_subkey_with_flags(format!(r"{APP}\Child APOs\{guid}"), flags)
            .map_err(|e| format!("Equalizer APO 설정을 쓸 수 없어요: {e}"))?;
        for (n, v) in names.iter().zip(&orig) {
            child.set_value(n, v).map_err(|e| e.to_string())?;
        }
        let chain = |s: &String| if real(s) { s.clone() } else { String::new() };
        let (pre_child, post_child) = match mode {
            Mode::LfxGfx => (chain(&orig[0]), chain(&orig[1])),
            Mode::SfxMfx => (chain(&orig[2]), chain(&orig[3])),
            Mode::SfxEfx => (chain(&orig[2]), chain(&orig[4])),
        };
        child.set_value("PreMixChild", &pre_child).map_err(|e| e.to_string())?;
        child.set_value("PostMixChild", &post_child).map_err(|e| e.to_string())?;
        child.set_value("AllowSilentBufferModification", &"false").map_err(|e| e.to_string())?;
        let _ = child.delete_value("DisableAutomaticAdjustment");
        child.set_value("Version", &"2").map_err(|e| e.to_string())?;

        // open FxProperties for writing; some PCs need the key's owner and rights changed first
        let fx = match hklm().create_subkey_with_flags(&fx_path, flags) {
            Ok((k, _)) => k,
            Err(_) => {
                take_ownership(&dev_path);
                make_writable(&dev_path);
                hklm().create_subkey_with_flags(&fx_path, flags).map_err(|e| format!("장치 설정을 바꿀 수 없어요: {e}"))?.0
            }
        };
        if existing.is_none() {
            fx.set_value(FX_TITLE, &"Equalizer APO").map_err(|e| e.to_string())?;
        }
        let set = |n: &String, v: &str| fx.set_value(n, &v.to_string()).map_err(|e| e.to_string());
        let set_mode = |i: u32| -> Result<(), String> {
            let n = format!("{MODE},{i}");
            if fx.get_raw_value(&n).is_err() {
                fx.set_value(&n, &vec![DEFAULT_MODE.to_string()]).map_err(|e| e.to_string())?;
            }
            Ok(())
        };
        match mode {
            Mode::LfxGfx => {
                set(&names[0], PRE)?;
                set(&names[1], POST)?;
                for n in &names[2..] {
                    let _ = fx.delete_value(n);
                }
            }
            Mode::SfxMfx => {
                let _ = fx.delete_value(&names[0]);
                let _ = fx.delete_value(&names[1]);
                set(&names[2], PRE)?;
                set_mode(5)?;
                set(&names[3], POST)?;
                set_mode(6)?;
            }
            Mode::SfxEfx => {
                let _ = fx.delete_value(&names[0]);
                let _ = fx.delete_value(&names[1]);
                set(&names[2], PRE)?;
                set_mode(5)?;
                set(&names[4], POST)?;
                set_mode(7)?;
            }
        }
        let _ = fx.delete_value(DISABLE_ENH); // audio enhancements must be on for Equalizer APO to run
        Ok(())
    }

    /// Lets normal users write the config folder, so the app can change the correction without asking again.
    fn prepare_config() -> Result<(), String> {
        let dir = config_dir().ok_or("Equalizer APO 설정 폴더를 찾을 수 없어요")?;
        run_quiet("icacls", &[&dir.to_string_lossy(), "/grant", "*S-1-5-32-545:(OI)(CI)M", "/T", "/C", "/Q"]);
        let sf = dir.join(SOUNDFOH_FILE);
        if !sf.exists() {
            std::fs::write(&sf, "# Sound FOH\r\n").map_err(|e| e.to_string())?;
        }
        let cfg = dir.join("config.txt");
        let cur = std::fs::read_to_string(&cfg).unwrap_or_default();
        if let Some(next) = with_include(&cur) {
            std::fs::write(&cfg, next).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Restarting the Windows audio service loads Equalizer APO on the device without a reboot.
    fn restart_audio() {
        run_quiet("net", &["stop", "audiosrv", "/y"]);
        run_quiet("net", &["start", "audiosrv"]);
    }

    // ---------- registry permissions (only when FxProperties can't be created) ----------
    fn reg_object(path: &str) -> Vec<u16> {
        format!(r"MACHINE\{path}").encode_utf16().chain(Some(0)).collect()
    }
    fn admins_sid() -> Vec<u8> {
        use windows_sys::Win32::Security::{CreateWellKnownSid, WinBuiltinAdministratorsSid};
        let mut buf = vec![0u8; 68];
        let mut len = buf.len() as u32;
        unsafe {
            CreateWellKnownSid(WinBuiltinAdministratorsSid, std::ptr::null_mut(), buf.as_mut_ptr() as _, &mut len);
        }
        buf
    }
    fn take_ownership(path: &str) {
        use windows_sys::Win32::Foundation::{CloseHandle, LUID};
        use windows_sys::Win32::Security::Authorization::{SetNamedSecurityInfoW, SE_REGISTRY_KEY};
        use windows_sys::Win32::Security::{
            AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES, OWNER_SECURITY_INFORMATION, SE_PRIVILEGE_ENABLED, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES,
            TOKEN_QUERY,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        let name: Vec<u16> = "SeTakeOwnershipPrivilege".encode_utf16().chain(Some(0)).collect();
        let mut obj = reg_object(path);
        let mut sid = admins_sid();
        unsafe {
            let mut token = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &mut token) == 0 {
                return;
            }
            let mut luid: LUID = std::mem::zeroed();
            LookupPrivilegeValueW(std::ptr::null(), name.as_ptr(), &mut luid);
            let mut tp = TOKEN_PRIVILEGES { PrivilegeCount: 1, Privileges: [LUID_AND_ATTRIBUTES { Luid: luid, Attributes: SE_PRIVILEGE_ENABLED }] };
            AdjustTokenPrivileges(token, 0, &tp, 0, std::ptr::null_mut(), std::ptr::null_mut());
            SetNamedSecurityInfoW(obj.as_mut_ptr(), SE_REGISTRY_KEY, OWNER_SECURITY_INFORMATION, sid.as_mut_ptr() as _, std::ptr::null_mut(), std::ptr::null(), std::ptr::null());
            tp.Privileges[0].Attributes = 0;
            AdjustTokenPrivileges(token, 0, &tp, 0, std::ptr::null_mut(), std::ptr::null_mut());
            CloseHandle(token);
        }
    }
    fn make_writable(path: &str) {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{
            GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, NO_MULTIPLE_TRUSTEE, SET_ACCESS, SE_REGISTRY_KEY, TRUSTEE_IS_GROUP, TRUSTEE_IS_SID, TRUSTEE_W,
        };
        use windows_sys::Win32::Security::{ACL, DACL_SECURITY_INFORMATION, SUB_CONTAINERS_AND_OBJECTS_INHERIT};
        use windows_sys::Win32::System::Registry::KEY_ALL_ACCESS as ALL;
        let mut obj = reg_object(path);
        let mut sid = admins_sid();
        unsafe {
            let mut old: *mut ACL = std::ptr::null_mut();
            let mut sd = std::ptr::null_mut();
            if GetNamedSecurityInfoW(obj.as_ptr(), SE_REGISTRY_KEY, DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), &mut old, std::ptr::null_mut(), &mut sd) != 0 {
                return;
            }
            let ea = EXPLICIT_ACCESS_W {
                grfAccessPermissions: ALL,
                grfAccessMode: SET_ACCESS,
                grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
                Trustee: TRUSTEE_W {
                    pMultipleTrustee: std::ptr::null_mut(),
                    MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_GROUP,
                    ptstrName: sid.as_mut_ptr() as _,
                },
            };
            let mut acl: *mut ACL = std::ptr::null_mut();
            if SetEntriesInAclW(1, &ea, old, &mut acl) == 0 {
                SetNamedSecurityInfoW(obj.as_mut_ptr(), SE_REGISTRY_KEY, DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), acl, std::ptr::null());
                LocalFree(acl as _);
            }
            LocalFree(sd as _);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn include_is_added_once() {
        assert_eq!(with_include("Preamp: -6 dB").unwrap(), "Preamp: -6 dB\r\nInclude: soundfoh.txt\r\n");
        assert_eq!(with_include(""), Some("Include: soundfoh.txt\r\n".into()));
        assert_eq!(with_include("a\r\n  include: SOUNDFOH.txt \r\n"), None);
        assert_eq!(device_name("2|Speakers (USB)"), "Speakers (USB)");
    }
}
