use super::{send_switch, FrontmostApp};

use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::PathBuf;
use std::thread;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, WPARAM};
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
    TranslateMessage, EVENT_SYSTEM_FOREGROUND, MSG, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS,
};

pub fn get_frontmost_app() -> FrontmostApp {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return FrontmostApp::unknown();
        }

        let mut pid: u32 = 0;
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return FrontmostApp::unknown();
        }

        let handle: HANDLE = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => h,
            Err(_) => return FrontmostApp::unknown(),
        };

        let exe_path = query_full_process_image_name(handle);
        let _ = CloseHandle(handle);

        let exe_path = match exe_path {
            Some(p) => p,
            None => return FrontmostApp::unknown(),
        };

        // bundle_id 用 exe 完整路径（同 App 升级路径通常稳定），跨进程去重
        let bundle_id = exe_path.to_string_lossy().to_string();

        // 显示名优先取 PE 版本资源的 FileDescription，取不到就用 exe basename
        let name = read_file_description(&exe_path).unwrap_or_else(|| {
            exe_path
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_else(|| "Unknown".to_string())
        });

        FrontmostApp { name, bundle_id }
    }
}

unsafe fn query_full_process_image_name(handle: HANDLE) -> Option<PathBuf> {
    let mut buf: Vec<u16> = vec![0; 1024];
    let mut size: u32 = buf.len() as u32;
    QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PCWSTR_mut(&mut buf), &mut size).ok()?;
    Some(PathBuf::from(OsString::from_wide(&buf[..size as usize])))
}

// windows crate 中 QueryFullProcessImageNameW 需要 PWSTR，这里手动构造
#[allow(non_snake_case)]
unsafe fn PCWSTR_mut(buf: &mut [u16]) -> windows::core::PWSTR {
    windows::core::PWSTR(buf.as_mut_ptr())
}

unsafe fn read_file_description(exe_path: &PathBuf) -> Option<String> {
    let wide: Vec<u16> = exe_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let filename = PCWSTR(wide.as_ptr());

    let size = GetFileVersionInfoSizeW(filename, None);
    if size == 0 {
        return None;
    }

    let mut data: Vec<u8> = vec![0; size as usize];
    GetFileVersionInfoW(filename, 0, size, data.as_mut_ptr() as *mut _).ok()?;

    // 先读 \VarFileInfo\Translation 拿真实的 (lang, codepage)，避免猜 040904E4
    let translation_query: Vec<u16> = "\\VarFileInfo\\Translation\0"
        .encode_utf16()
        .collect();
    let mut tr_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut tr_len: u32 = 0;
    let ok = VerQueryValueW(
        data.as_ptr() as *const _,
        PCWSTR(translation_query.as_ptr()),
        &mut tr_ptr,
        &mut tr_len,
    );
    if !ok.as_bool() || tr_ptr.is_null() || tr_len < 4 {
        return None;
    }

    // 每条 translation 是 2 个 u16：lang、codepage
    let lang = *(tr_ptr as *const u16);
    let codepage = *((tr_ptr as *const u16).offset(1));

    let subblock = format!(
        "\\StringFileInfo\\{:04x}{:04x}\\FileDescription\0",
        lang, codepage
    );
    let subblock_wide: Vec<u16> = subblock.encode_utf16().collect();

    let mut desc_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut desc_len: u32 = 0;
    let ok = VerQueryValueW(
        data.as_ptr() as *const _,
        PCWSTR(subblock_wide.as_ptr()),
        &mut desc_ptr,
        &mut desc_len,
    );
    if !ok.as_bool() || desc_ptr.is_null() || desc_len == 0 {
        return None;
    }

    let slice = std::slice::from_raw_parts(desc_ptr as *const u16, desc_len as usize);
    // 去掉可能的结尾 \0
    let end = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
    let s = String::from_utf16_lossy(&slice[..end]).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

pub fn spawn_switch_observer() {
    thread::spawn(|| {
        run_win_event_hook();
    });
}

unsafe extern "system" fn win_event_proc(
    _hook: HWINEVENTHOOK,
    _event: u32,
    _hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    // 直接取当前前台 App，避免 hwnd 是子控件的情况
    let app = get_frontmost_app();
    send_switch(app);
}

fn run_win_event_hook() {
    unsafe {
        let hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(win_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );

        if hook.0.is_null() {
            eprintln!("⚠️ SetWinEventHook 失败，Windows 前台切换事件不可用（走 300ms 轮询兜底）");
            return;
        }

        println!("✅ Windows SetWinEventHook 观察者已注册");

        // WINEVENT_OUTOFCONTEXT 要求安装 hook 的线程有消息循环
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

// LPARAM / WPARAM 仅用作签名占位，抑制未用警告
#[allow(dead_code)]
fn _keep_unused_types(_: LPARAM, _: WPARAM) {}
