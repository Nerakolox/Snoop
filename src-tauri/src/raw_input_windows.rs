//! Windows 全局输入捕获，用 Raw Input API 而不是 low-level hook。
//!
//! 背景:rdev/rustdesk-rdev 在 Windows 上用 WH_KEYBOARD_LL / WH_MOUSE_LL
//! 两个用户态钩子。EAC、小蓝熊、Wallpaper Engine、部分反外挂/防宏工具会
//! 主动拦截或反注册其它进程的这类钩子,一旦发生 rdev 的 listen 会静默返回,
//! 该进程从此再也收不到全局键鼠事件。
//!
//! Raw Input(WM_INPUT)是 Windows 给游戏用的原始设备输入通道,走内核层
//! 直连,不经过 hook 链,反外挂工具挡不住(挡了他们自己也没法玩)。
//! 用 RIDEV_INPUTSINK 标志,窗口不需要前台焦点就能收到全局输入。
//!
//! 签名和 rdev::listen 对齐,activity_tracker 里只按平台切换调用点即可。

use rdev::{Button, Event, EventType, Key};
use std::cell::RefCell;
use std::mem::size_of;
use std::time::SystemTime;

use windows::core::{Result as WinResult, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::Input::{
    GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE,
    RAWINPUTHEADER, RID_INPUT, RIDEV_INPUTSINK, RIM_TYPEKEYBOARD, RIM_TYPEMOUSE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetCursorPos, GetMessageW,
    RegisterClassW, TranslateMessage, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE,
    WM_INPUT, WNDCLASSW,
};

thread_local! {
    static CALLBACK: RefCell<Option<Box<dyn FnMut(Event)>>> = RefCell::new(None);
}

/// Drop-in 替换 rdev::listen。阻塞当前线程跑消息循环,直到窗口销毁或错误。
///
/// 回调在同一线程被同步调用,与 rdev 语义一致。
pub fn listen<F>(callback: F) -> WinResult<()>
where
    F: FnMut(Event) + 'static,
{
    CALLBACK.with(|c| *c.borrow_mut() = Some(Box::new(callback)));

    unsafe {
        let hinstance = GetModuleHandleW(PCWSTR::null())?;

        // 类名带进程 id 避免与其它 crate/instance 冲突
        let class_name_str: Vec<u16> = "SnoopRawInputWindow\0".encode_utf16().collect();
        let class_name = PCWSTR(class_name_str.as_ptr());

        let wc = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinstance.into(),
            lpszClassName: class_name,
            ..Default::default()
        };
        // 注册失败通常是重复注册,忽略即可
        let _ = RegisterClassW(&wc);

        let window_name_str: Vec<u16> = "snoop-raw-input\0".encode_utf16().collect();
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class_name,
            PCWSTR(window_name_str.as_ptr()),
            WINDOW_STYLE(0),
            0, 0, 0, 0,
            HWND_MESSAGE,       // message-only 窗口,不显示
            None,
            hinstance,
            None,
        )?;

        // usUsagePage 0x01 = Generic Desktop, 0x06 = Keyboard, 0x02 = Mouse
        // RIDEV_INPUTSINK 让我们的窗口即使无焦点也能收到 WM_INPUT
        let devices = [
            RAWINPUTDEVICE {
                usUsagePage: 0x01,
                usUsage: 0x06,
                dwFlags: RIDEV_INPUTSINK,
                hwndTarget: hwnd,
            },
            RAWINPUTDEVICE {
                usUsagePage: 0x01,
                usUsage: 0x02,
                dwFlags: RIDEV_INPUTSINK,
                hwndTarget: hwnd,
            },
        ];
        RegisterRawInputDevices(&devices, size_of::<RAWINPUTDEVICE>() as u32)?;

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).into() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    Ok(())
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_INPUT {
        handle_wm_input(lparam);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

unsafe fn handle_wm_input(lparam: LPARAM) {
    let hraw = HRAWINPUT(lparam.0 as *mut _);
    let header_size = size_of::<RAWINPUTHEADER>() as u32;

    // 先探测所需缓冲区大小
    let mut size: u32 = 0;
    let probe = GetRawInputData(hraw, RID_INPUT, None, &mut size, header_size);
    if probe != 0 || size == 0 {
        return;
    }
    let mut buf = vec![0u8; size as usize];
    let got = GetRawInputData(
        hraw,
        RID_INPUT,
        Some(buf.as_mut_ptr() as *mut _),
        &mut size,
        header_size,
    );
    if got == u32::MAX {
        return;
    }
    let raw = &*(buf.as_ptr() as *const RAWINPUT);

    match raw.header.dwType {
        t if t == RIM_TYPEKEYBOARD.0 => dispatch_keyboard(raw),
        t if t == RIM_TYPEMOUSE.0 => dispatch_mouse(raw),
        _ => {}
    }
}

unsafe fn dispatch_keyboard(raw: &RAWINPUT) {
    let kb = &raw.data.keyboard;
    // 有些键盘会发 VKey = 0xFF 的"占位"事件（Pause 键分两段发等）,丢弃
    if kb.VKey == 0xFF {
        return;
    }
    let is_break = (kb.Flags & 0x01) != 0; // RI_KEY_BREAK
    let is_e0 = (kb.Flags & 0x02) != 0;    // RI_KEY_E0
    let vk = kb.VKey as u32;
    let scan = kb.MakeCode as u32;
    let key = vk_to_key(vk, scan, is_e0);

    let event_type = if is_break {
        EventType::KeyRelease(key)
    } else {
        EventType::KeyPress(key)
    };
    emit(event_type, vk, scan);
}

unsafe fn dispatch_mouse(raw: &RAWINPUT) {
    let m = &raw.data.mouse;
    let btn_flags = m.Anonymous.Anonymous.usButtonFlags as u32;

    // 按钮位翻译:每个 flag 都是独立位,一次 WM_INPUT 可能带多个(理论上罕见)
    let button_events: &[(u32, bool, Button)] = &[
        (0x0001, false, Button::Left),
        (0x0002, true,  Button::Left),
        (0x0004, false, Button::Right),
        (0x0008, true,  Button::Right),
        (0x0010, false, Button::Middle),
        (0x0020, true,  Button::Middle),
        (0x0040, false, Button::Unknown(1)),   // XButton1 / 后退
        (0x0080, true,  Button::Unknown(1)),
        (0x0100, false, Button::Unknown(2)),   // XButton2 / 前进
        (0x0200, true,  Button::Unknown(2)),
    ];
    for (mask, is_release, btn) in button_events {
        if btn_flags & mask != 0 {
            let event_type = if *is_release {
                EventType::ButtonRelease(*btn)
            } else {
                EventType::ButtonPress(*btn)
            };
            emit(event_type, 0, 0);
        }
    }

    // 滚轮:usButtonData 是有符号 16 位,120 = 一格
    if btn_flags & 0x0400 != 0 {
        let delta = m.Anonymous.Anonymous.usButtonData as i16 as i64;
        emit(EventType::Wheel { delta_x: 0, delta_y: delta / 120 }, 0, 0);
    }
    if btn_flags & 0x0800 != 0 {
        let delta = m.Anonymous.Anonymous.usButtonData as i16 as i64;
        emit(EventType::Wheel { delta_x: delta / 120, delta_y: 0 }, 0, 0);
    }

    // 鼠标位移:Raw Input 给的是相对增量,我们用 GetCursorPos 拿绝对屏幕坐标,
    // 保持与 rdev 语义一致(activity_tracker 里按 last_x/last_y 计距离)
    if m.lLastX != 0 || m.lLastY != 0 {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_ok() {
            emit(
                EventType::MouseMove {
                    x: pt.x as f64,
                    y: pt.y as f64,
                },
                0,
                0,
            );
        }
    }
}

fn emit(event_type: EventType, platform_code: u32, position_code: u32) {
    let event = Event {
        time: SystemTime::now(),
        unicode: None,
        event_type,
        platform_code,
        position_code,
        usb_hid: 0,
        extra_data: 0,
    };
    CALLBACK.with(|c| {
        if let Some(cb) = c.borrow_mut().as_mut() {
            cb(event);
        }
    });
}

/// Windows VK 码 → rdev::Key。覆盖字母/数字/F1-12/常见符号 + 用 E0 flag
/// 区分左右修饰键 / 数字键盘回车。未识别的落 Unknown(vk),前端 KeymapTest
/// 会把它标成"未匹配"。
fn vk_to_key(vk: u32, scan: u32, is_e0: bool) -> Key {
    match vk {
        0x08 => Key::Backspace,
        0x09 => Key::Tab,
        0x0D => if is_e0 { Key::KpReturn } else { Key::Return },
        // VK_SHIFT 是"通用"版本,用扫描码区分左右
        0x10 => match scan {
            0x36 => Key::ShiftRight,
            _ => Key::ShiftLeft,
        },
        0x11 => if is_e0 { Key::ControlRight } else { Key::ControlLeft },
        0x12 => if is_e0 { Key::AltGr } else { Key::Alt },
        0x13 => Key::Pause,
        0x14 => Key::CapsLock,
        0x1B => Key::Escape,
        0x20 => Key::Space,
        0x21 => Key::PageUp,
        0x22 => Key::PageDown,
        0x23 => Key::End,
        0x24 => Key::Home,
        0x25 => Key::LeftArrow,
        0x26 => Key::UpArrow,
        0x27 => Key::RightArrow,
        0x28 => Key::DownArrow,
        0x2C => Key::PrintScreen,
        0x2D => Key::Insert,
        0x2E => Key::Delete,
        0x30 => Key::Num0, 0x31 => Key::Num1, 0x32 => Key::Num2,
        0x33 => Key::Num3, 0x34 => Key::Num4, 0x35 => Key::Num5,
        0x36 => Key::Num6, 0x37 => Key::Num7, 0x38 => Key::Num8,
        0x39 => Key::Num9,
        0x41 => Key::KeyA, 0x42 => Key::KeyB, 0x43 => Key::KeyC,
        0x44 => Key::KeyD, 0x45 => Key::KeyE, 0x46 => Key::KeyF,
        0x47 => Key::KeyG, 0x48 => Key::KeyH, 0x49 => Key::KeyI,
        0x4A => Key::KeyJ, 0x4B => Key::KeyK, 0x4C => Key::KeyL,
        0x4D => Key::KeyM, 0x4E => Key::KeyN, 0x4F => Key::KeyO,
        0x50 => Key::KeyP, 0x51 => Key::KeyQ, 0x52 => Key::KeyR,
        0x53 => Key::KeyS, 0x54 => Key::KeyT, 0x55 => Key::KeyU,
        0x56 => Key::KeyV, 0x57 => Key::KeyW, 0x58 => Key::KeyX,
        0x59 => Key::KeyY, 0x5A => Key::KeyZ,
        0x5B => Key::MetaLeft, 0x5C => Key::MetaRight,
        0x60 => Key::Kp0, 0x61 => Key::Kp1, 0x62 => Key::Kp2,
        0x63 => Key::Kp3, 0x64 => Key::Kp4, 0x65 => Key::Kp5,
        0x66 => Key::Kp6, 0x67 => Key::Kp7, 0x68 => Key::Kp8,
        0x69 => Key::Kp9,
        0x6A => Key::KpMultiply, 0x6B => Key::KpPlus,
        0x6D => Key::KpMinus, 0x6E => Key::KpDecimal, 0x6F => Key::KpDivide,
        0x70 => Key::F1, 0x71 => Key::F2, 0x72 => Key::F3,
        0x73 => Key::F4, 0x74 => Key::F5, 0x75 => Key::F6,
        0x76 => Key::F7, 0x77 => Key::F8, 0x78 => Key::F9,
        0x79 => Key::F10, 0x7A => Key::F11, 0x7B => Key::F12,
        0x90 => Key::NumLock, 0x91 => Key::ScrollLock,
        0xA0 => Key::ShiftLeft, 0xA1 => Key::ShiftRight,
        0xA2 => Key::ControlLeft, 0xA3 => Key::ControlRight,
        0xA4 => Key::Alt, 0xA5 => Key::AltGr,
        0xBA => Key::SemiColon, 0xBB => Key::Equal,
        0xBC => Key::Comma, 0xBD => Key::Minus,
        0xBE => Key::Dot, 0xBF => Key::Slash,
        0xC0 => Key::BackQuote,
        0xDB => Key::LeftBracket, 0xDC => Key::BackSlash,
        0xDD => Key::RightBracket, 0xDE => Key::Quote,
        _ => Key::Unknown(vk),
    }
}

// GetAsyncKeyState 保留导入以便未来做状态回读兜底,当前未使用
#[allow(dead_code)]
fn _touch_symbols() {
    let _ = GetAsyncKeyState;
}
