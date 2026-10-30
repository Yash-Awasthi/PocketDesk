// SPDX-License-Identifier: GPL-3.0-or-later
// Registration and session camera from NectarLink's desktop/app/src/win/vcam.rs (GPL-3.0-or-later).
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::io::Read;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use pocketdesk_vcam::{DEFAULT_MAPPING_NAME, LOCAL_MAPPING_NAME, MAX_FRAME_BYTES, SharedFrameMapping};
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS};
use windows::Win32::Media::KernelStreaming::{KSCATEGORY_CAPTURE, KSCATEGORY_VIDEO, KSCATEGORY_VIDEO_CAMERA};
use windows::Win32::Media::MediaFoundation::{
    IMFVirtualCamera, MF_VERSION, MFSTARTUP_NOSOCKET, MFStartup, MFVirtualCameraAccess,
    MFVirtualCameraAccess_CurrentUser, MFVirtualCameraLifetime, MFVirtualCameraLifetime_Session, MFVirtualCameraType,
    MFVirtualCameraType_SoftwareCameraSource,
};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW};
use windows::Win32::System::Registry::{
    HKEY, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ, RegCloseKey,
    RegCreateKeyExW, RegDeleteTreeW, RegGetValueW, RegSetValueExW,
};
use windows::core::{GUID, HRESULT, HSTRING, Interface, PCWSTR, s, w};

const CLSID: &str = "{FDC8637A-70EA-40D9-9CE5-A27D436FDFD6}";
const FRIENDLY_NAME: &str = "PocketDesk Webcam";
const CLASSES: &str = r"SOFTWARE\Classes\CLSID";
const FRAMESERVER: &str = r"SOFTWARE\Microsoft\Windows Media Foundation\Platform\FrameServer\Sources";

pub fn run(args: Vec<String>) -> i32 {
    let result = match args.first().map(String::as_str) {
        Some("--register") => register(),
        Some("--unregister") => unregister(),
        Some("--status") => {
            println!("{}", if registered() { "registered" } else { "unregistered" });
            Ok(())
        }
        _ => {
            let name = args.iter().position(|a| a == "--name").and_then(|i| args.get(i + 1)).cloned().unwrap_or_default();
            serve(&name)
        }
    };
    match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// The camera's DLL, next to this program.
fn dll() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dll = exe.with_file_name("pocketdesk_vcam.dll");
    if dll.is_file() { Ok(dll) } else { Err(format!("missing {}", dll.display())) }
}

fn registered() -> bool {
    let key = HSTRING::from(format!(r"{CLASSES}\{CLSID}\InprocServer32"));
    let mut buf = [0u16; 512];
    let mut size = std::mem::size_of_val(&buf) as u32;
    let status = unsafe {
        RegGetValueW(HKEY_LOCAL_MACHINE, &key, PCWSTR::null(), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut size))
    };
    if status != ERROR_SUCCESS {
        return false;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    len > 0 && PathBuf::from(String::from_utf16_lossy(&buf[..len])).is_file()
}

fn set_values(subkey: &str, values: &[(Option<&str>, &str)]) -> Result<(), String> {
    let mut key = HKEY::default();
    let status = unsafe {
        RegCreateKeyExW(HKEY_LOCAL_MACHINE, &HSTRING::from(subkey), Some(0), PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_WRITE | KEY_READ, None, &mut key, None)
    };
    if status != ERROR_SUCCESS {
        return Err(format!("cannot create HKLM\\{subkey} ({}): run as administrator", status.0));
    }
    let res = values.iter().try_for_each(|&(name, value)| {
        let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes = unsafe { std::slice::from_raw_parts(wide.as_ptr().cast::<u8>(), wide.len() * 2) };
        let name = name.map(HSTRING::from);
        let status = unsafe { RegSetValueExW(key, name.as_ref().map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr())), Some(0), REG_SZ, Some(bytes)) };
        if status == ERROR_SUCCESS { Ok(()) } else { Err(format!("cannot write HKLM\\{subkey} ({})", status.0)) }
    });
    unsafe {
        let _ = RegCloseKey(key);
    }
    res
}

/// COM registration of the media source, and the Frame Server source entry that names it.
fn register() -> Result<(), String> {
    let dll = dll()?;
    set_values(&format!(r"{CLASSES}\{CLSID}"), &[(None, "PocketDesk Virtual Camera Media Source")])?;
    set_values(&format!(r"{CLASSES}\{CLSID}\InprocServer32"), &[(None, &dll.to_string_lossy()), (Some("ThreadingModel"), "Both")])?;
    set_values(&format!(r"{FRAMESERVER}\{CLSID}"), &[(Some("FriendlyName"), FRIENDLY_NAME)])
}

fn unregister() -> Result<(), String> {
    for subkey in [format!(r"{CLASSES}\{CLSID}"), format!(r"{FRAMESERVER}\{CLSID}")] {
        let status = unsafe { RegDeleteTreeW(HKEY_LOCAL_MACHINE, &HSTRING::from(subkey.as_str())) };
        if status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND && status != ERROR_PATH_NOT_FOUND {
            return Err(format!("cannot remove HKLM\\{subkey} ({}): run as administrator", status.0));
        }
    }
    Ok(())
}

type CreateVirtualCamera = unsafe extern "system" fn(
    MFVirtualCameraType,
    MFVirtualCameraLifetime,
    MFVirtualCameraAccess,
    PCWSTR,
    PCWSTR,
    *const GUID,
    u32,
    *mut *mut c_void,
) -> HRESULT;

/// The session camera: there while this process runs. MFCreateVirtualCamera exists from
/// Windows 11 on, so it is looked up rather than linked.
fn start_camera() -> Result<IMFVirtualCamera, String> {
    unsafe {
        let module = LoadLibraryExW(w!("mfsensorgroup.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).map_err(|_| "the webcam needs Windows 11".to_owned())?;
        let found = GetProcAddress(module, s!("MFCreateVirtualCamera")).ok_or("the webcam needs Windows 11")?;
        let create = std::mem::transmute::<unsafe extern "system" fn() -> isize, CreateVirtualCamera>(found);
        MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET).map_err(|e| e.to_string())?;
        let categories = [KSCATEGORY_VIDEO_CAMERA, KSCATEGORY_VIDEO, KSCATEGORY_CAPTURE];
        let name = HSTRING::from(FRIENDLY_NAME);
        let source = HSTRING::from(CLSID);
        let mut raw = std::ptr::null_mut();
        create(
            MFVirtualCameraType_SoftwareCameraSource,
            MFVirtualCameraLifetime_Session,
            MFVirtualCameraAccess_CurrentUser,
            PCWSTR(name.as_ptr()),
            PCWSTR(source.as_ptr()),
            categories.as_ptr(),
            categories.len() as u32,
            &mut raw,
        )
        .ok()
        .map_err(|e| e.to_string())?;
        let cam = IMFVirtualCamera::from_raw(raw);
        cam.Start(None).map_err(|e| e.to_string())?;
        Ok(cam)
    }
}

/// The frame mapping: the camera's global one once an app opens the camera (Windows' Frame Server
/// creates it), until then this session's.
struct Mapping {
    map: Option<SharedFrameMapping>,
    global: bool,
    tried: Instant,
}

impl Mapping {
    fn get(&mut self) -> Option<&SharedFrameMapping> {
        if !self.global && self.tried.elapsed() >= Duration::from_secs(1) {
            self.tried = Instant::now();
            if let Ok(m) = SharedFrameMapping::open_existing(DEFAULT_MAPPING_NAME) {
                self.map = Some(m);
                self.global = true;
            }
        }
        if self.map.is_none() {
            self.map = SharedFrameMapping::open_or_create(LOCAL_MAPPING_NAME).ok();
        }
        self.map.as_ref()
    }
}

fn serve(name: &str) -> Result<(), String> {
    if !registered() {
        return Err("the PocketDesk Webcam is not registered: run with --register as administrator".into());
    }
    let cam = start_camera()?;
    println!("ready");
    let mut mapping = Mapping { map: None, global: false, tried: Instant::now() - Duration::from_secs(2) };
    if let Some(m) = mapping.get() {
        m.set_idle(name);
    }
    let started = Instant::now();
    let mut stdin = std::io::stdin().lock();
    let mut head = [0u8; 12];
    let mut frame = Vec::new();
    while stdin.read_exact(&mut head).is_ok() {
        if &head[..4] != b"PDVF" {
            break;
        }
        let w = u32::from_le_bytes(head[4..8].try_into().unwrap());
        let h = u32::from_le_bytes(head[8..12].try_into().unwrap());
        let len = (w as usize) * (h as usize) * 4;
        if w == 0 || h == 0 || len > MAX_FRAME_BYTES {
            break;
        }
        frame.resize(len, 0);
        if stdin.read_exact(&mut frame).is_err() {
            break;
        }
        if let Some(m) = mapping.get() {
            m.write_frame(name, w, h, started.elapsed().as_micros() as u64, &frame, false);
        }
    }
    if let Some(m) = mapping.get() {
        m.set_idle(name);
    }
    unsafe {
        let _ = cam.Stop();
        let _ = cam.Remove();
    }
    Ok(())
}
