# macOS 平台笔记

## Keychain 崩溃：use-after-free（已修）

**根因**：`src-tauri/src/ai/secure.rs` 的 macOS 分支原来是手写 CF FFI。
`base_query()` 用 `CFDictionaryCreateMutable(..., NULL, NULL)` 创建字典
（**NULL value callbacks → `CFDictionarySetValue` 不 retain**），却在返回前
就 `CFRelease` 了 `svc`/`acct` 两个 CFString。字典里留下悬垂指针，
`SecItemCopyMatching` 内部 `SecCFDictionaryCOWGetMutable` 复制查询字典时
对每个 value 调 `objc_retain`，撞上已释放的野指针 → `EXC_BAD_ACCESS`。

两次崩溃的入口不同（一次是 setup 里的 `AiState::load`，一次是前端
`get_ai_config`），但后半段栈完全一致——懒加载只是把崩溃从启动时推迟到
首次查配置，没有修好任何东西。

**结论与修复**：改用手写 CF FFI 的全部替换为 `security-framework` crate 的
`passwords` 泛型口令接口（`set/get/delete_generic_password`），CF 对象生命周期
交给 crate 管理，类型层面杜绝 use-after-free。

**教训**：这段 150 行 unsafe FFI 是在「当前开发机是 Windows、无法本地编译验证
macOS」的条件下写的，注释里自己都标了「无法编译验证」。**在无法本地验证的平台
上手写 unsafe FFI 是这次崩溃的直接成因**。以后同类代码要么用成熟 crate，要么
必须能在目标平台实际跑通再交付。

## 手写 FFI 敞口清单（待还的债）

以下是从本次教训出发全仓扫出来的同类风险敞口。**只是记录，不是现在要做的事**，
等哪天某个平台代码要动或真出问题时再一起处理。

### macOS — 手写 raw `extern "C"`（非 crate 封装）

| 位置 | 用途 | 风险 | 替代 |
|---|---|---|---|
| `platform/macos.rs:11-14` | `AXIsProcessTrustedWithOptions`（ApplicationServices），查辅助功能权限 | 极低（只传 null） | `macos-accessibility-client`，或保持现状 |

### macOS — 走 `objc`/`cocoa` crate 的 unsafe objc 消息（标准 crate，但仍 unsafe + 手动生命周期）

| 位置 | 用途 | 风险 | 替代 |
|---|---|---|---|
| `platform/macos.rs` 整文件（L55-334） | 红绿灯偏移 `configure_titlebar`/`reposition_traffic_lights`、前台 App `get_frontmost_app`、NSWorkspace 观察者 `spawn_switch_observer` | **最高**：运行时 `ClassDecl` 注册 ObjC 类、`extern "C" fn` 回调、`PINNED_WINDOW`/`WORKSPACE_OBSERVER` 静态钉生命周期、autorelease pool 手管、`catch_unwind` | 无——红绿灯偏移是定制逻辑，`objc`/`cocoa` 已是标准封装 |
| `icon_cache.rs:239-320` | `extract_icon_png` macOS：NSWorkspace 定位 .app → iconForFile → TIFF → PNG | 中：只读、无运行时类注册，有 pool + catch_unwind | 无专门 crate，`cocoa`/`objc` 是标准做法 |
| `lib.rs:169-173` | `setTitlebarAppearsTransparent:` 单条 msg_send | 极低 | 无 |

### 非 macOS — 同类手写 FFI（顺带记录）

| 位置 | 用途 | 备注 |
|---|---|---|
| `secure.rs:43-99` | Windows DPAPI `CryptProtectData`/`CryptUnprotectData` + `LocalFree`，手写 `extern "system"` | macOS bug 的 Windows 孪生，但 DPAPI 无 CoreFoundation 引用计数陷阱，且该路径一直在 Windows 上跑。可换 `windows` crate（已依赖）。暂不换——不动能跑的代码 |
| `raw_input_windows.rs:102` / `platform/windows.rs:149` | `unsafe extern "system" fn` 窗口回调 | 走 `windows` crate，属必要样板 |
| `updater.rs:457,552`（`ShellExecuteW`）、`icon_cache.rs:131-237`（Windows 图标） | Windows API 调用 | 走 `windows` crate，非手写 extern |

## Node 版本要求

Vite 7 要求 Node 20.19+ / 22.12+。Node 18 会报 `crypto.hash is not a function`，
vite dev server 起不来。开发前 `nvm use 22`（或等价方式）切到 Node 22。
