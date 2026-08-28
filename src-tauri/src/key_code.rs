//! 按键身份翻译：平台上报的 `rdev::Key` → W3C UI Events `code`。
//!
//! 两个平台（Windows `raw_input_windows::vk_to_key` / macOS rdev `key_from_code`）
//! 都先把按键归一化到 [`rdev::Key`]，再进这里翻译，所以一张表两平台通用。
//! 翻译与修饰键状态无关，也不返回字符/印字——只返回物理键的 W3C `code`。
//!
//! 表里只列「能落到项目自有 ANSI 104 配列」的键 + 一些常见系统键；其余
//! （媒体键、Fn、Intl*、Lang*、Unknown/RawKey 等）返回 `None`，由采集层按
//! 平台原始值（`format!("{:?}", key)`）归入未映射桶，见 activity_tracker。

use rdev::Key;

/// `(rdev Debug 名, W3C code)` 单一真源：实时翻译与 DB 迁移共用这张表。
/// rdev `Key` 派生 `Debug`，故 `format!("{:?}", key)` 恰等于左列字符串。
static DEBUG_TO_CODE: &[(&str, &str)] = &[
    // 字母区（W3C 与 rdev 同名，恒等）
    ("KeyA", "KeyA"), ("KeyB", "KeyB"), ("KeyC", "KeyC"), ("KeyD", "KeyD"),
    ("KeyE", "KeyE"), ("KeyF", "KeyF"), ("KeyG", "KeyG"), ("KeyH", "KeyH"),
    ("KeyI", "KeyI"), ("KeyJ", "KeyJ"), ("KeyK", "KeyK"), ("KeyL", "KeyL"),
    ("KeyM", "KeyM"), ("KeyN", "KeyN"), ("KeyO", "KeyO"), ("KeyP", "KeyP"),
    ("KeyQ", "KeyQ"), ("KeyR", "KeyR"), ("KeyS", "KeyS"), ("KeyT", "KeyT"),
    ("KeyU", "KeyU"), ("KeyV", "KeyV"), ("KeyW", "KeyW"), ("KeyX", "KeyX"),
    ("KeyY", "KeyY"), ("KeyZ", "KeyZ"),
    // 主区数字
    ("Num0", "Digit0"), ("Num1", "Digit1"), ("Num2", "Digit2"),
    ("Num3", "Digit3"), ("Num4", "Digit4"), ("Num5", "Digit5"),
    ("Num6", "Digit6"), ("Num7", "Digit7"), ("Num8", "Digit8"), ("Num9", "Digit9"),
    // 小键盘数字
    ("Kp0", "Numpad0"), ("Kp1", "Numpad1"), ("Kp2", "Numpad2"),
    ("Kp3", "Numpad3"), ("Kp4", "Numpad4"), ("Kp5", "Numpad5"),
    ("Kp6", "Numpad6"), ("Kp7", "Numpad7"), ("Kp8", "Numpad8"), ("Kp9", "Numpad9"),
    // 小键盘运算
    ("KpReturn", "NumpadEnter"), ("KpMinus", "NumpadSubtract"),
    ("KpPlus", "NumpadAdd"), ("KpMultiply", "NumpadMultiply"),
    ("KpDivide", "NumpadDivide"), ("KpDecimal", "NumpadDecimal"),
    // 标点 / 符号
    ("BackQuote", "Backquote"), ("Minus", "Minus"), ("Equal", "Equal"),
    ("LeftBracket", "BracketLeft"), ("RightBracket", "BracketRight"),
    ("BackSlash", "Backslash"), ("SemiColon", "Semicolon"), ("Quote", "Quote"),
    ("Comma", "Comma"), ("Dot", "Period"), ("Slash", "Slash"),
    // 修饰键
    ("ShiftLeft", "ShiftLeft"), ("ShiftRight", "ShiftRight"),
    ("ControlLeft", "ControlLeft"), ("ControlRight", "ControlRight"),
    ("Alt", "AltLeft"), ("AltGr", "AltRight"),
    ("MetaLeft", "MetaLeft"), ("MetaRight", "MetaRight"),
    // 空格 / 回车 / 退格
    ("Space", "Space"), ("Return", "Enter"), ("Backspace", "Backspace"),
    // 制表 / 大写锁定 / 转义
    ("Tab", "Tab"), ("CapsLock", "CapsLock"), ("Escape", "Escape"),
    // 编辑区
    ("Insert", "Insert"), ("Delete", "Delete"), ("Home", "Home"), ("End", "End"),
    ("PageUp", "PageUp"), ("PageDown", "PageDown"),
    // 方向
    ("UpArrow", "ArrowUp"), ("DownArrow", "ArrowDown"),
    ("LeftArrow", "ArrowLeft"), ("RightArrow", "ArrowRight"),
    // 功能键
    ("F1", "F1"), ("F2", "F2"), ("F3", "F3"), ("F4", "F4"),
    ("F5", "F5"), ("F6", "F6"), ("F7", "F7"), ("F8", "F8"),
    ("F9", "F9"), ("F10", "F10"), ("F11", "F11"), ("F12", "F12"),
    ("F13", "F13"), ("F14", "F14"), ("F15", "F15"), ("F16", "F16"),
    ("F17", "F17"), ("F18", "F18"), ("F19", "F19"), ("F20", "F20"),
    ("F21", "F21"), ("F22", "F22"), ("F23", "F23"), ("F24", "F24"),
    // 系统键
    ("PrintScreen", "PrintScreen"), ("ScrollLock", "ScrollLock"),
    ("Pause", "Pause"), ("NumLock", "NumLock"), ("Apps", "ContextMenu"),
];

/// 把一个 `rdev::Key` 翻译成 W3C `code`；翻译失败（未映射）返回 `None`。
pub fn translate(key: &Key) -> Option<&'static str> {
    translate_debug_name(&format!("{:?}", key))
}

/// 按 rdev Debug 名翻译（供 DB 迁移把旧 key_code 字符串翻成新 code）。
pub fn translate_debug_name(name: &str) -> Option<&'static str> {
    DEBUG_TO_CODE
        .iter()
        .find(|(debug, _)| *debug == name)
        .map(|(_, code)| *code)
}
