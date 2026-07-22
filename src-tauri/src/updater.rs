//! 应用自更新：latest.json 检查 + 限速下载 + SHA256 校验 + pending 状态持久化。
//!
//! 更新分两阶段完成，用户全程无感：
//!   1. 应用运行时后台下载新版 installer 到 `%APPDATA%/Snoop/updates/pending.exe`，
//!      成功后写 `pending_update.json` 标记 (版本, 路径, sha256)。
//!   2. 下次启动时 `take_pending_install` 发现文件齐全且版本更新，
//!      直接静默运行 installer，当前进程 exit(0) 让 NSIS 接管重启。
//!
//! 限速：`RATE_LIMIT_BPS = 1MB/s`，reqwest 流式循环内 sleep 控速。
//! 校验：HTTPS + SHA256，签名验证后续再叠。

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

const UPDATE_BASE_URL: &str = "https://snoop.cn-nb1.rains3.com";
const RATE_LIMIT_BPS: u64 = 1024 * 1024; // 1 MB/s
const UPDATE_EVENT: &str = "updater://state";

/// 远端 `latest.json` 的 schema。
///
/// 结构与 Tauri 官方 updater 对齐,按 `target_os-target_arch` 三元组分平台。
/// 支持平台级独立版本号（三平台发版进度不同步时用）,platforms.*.version 优先,
/// 缺失则 fallback 到顶层 version:
/// ```json
/// {
///   "version": "0.1.6",
///   "notes": "...",
///   "platforms": {
///     "windows-x86_64":  { "version": "0.1.6", "url": "...", "sha256": "..." },
///     "darwin-x86_64":   { "version": "0.1.5", "url": "...", "sha256": "..." },
///     "darwin-aarch64":  { "version": "0.1.6", "url": "...", "sha256": "..." }
///   }
/// }
/// ```
#[derive(Debug, Deserialize)]
struct RemoteManifest {
    /// 顶层默认版本号,平台条目缺 version 时用作 fallback。
    version: String,
    #[serde(default)]
    #[allow(dead_code)]
    notes: Option<String>,
    #[serde(default)]
    platforms: std::collections::HashMap<String, PlatformAsset>,
}

#[derive(Debug, Deserialize)]
struct PlatformAsset {
    /// installer 相对 UPDATE_BASE_URL 的路径,或完整 URL 也支持。
    url: String,
    /// installer 的 SHA256(hex,小写);Mac 手动下载分支可选。
    #[serde(default)]
    sha256: Option<String>,
    /// 平台级版本号,优先于顶层 version 使用,缺失时 fallback 到顶层。
    #[serde(default)]
    version: Option<String>,
}

/// 返回当前平台在 manifest.platforms 里的 key。
fn current_platform_key() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    { "windows-x86_64" }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { "darwin-x86_64" }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { "darwin-aarch64" }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
    )))]
    { "unsupported" }
}

/// 本地 `pending_update.json` 的持久化 schema。
#[derive(Debug, Serialize, Deserialize)]
struct PendingRecord {
    version: String,
    installer_path: String,
    sha256: String,
}

/// 前端可见的更新状态。用 tag = "status" 与 TS discriminated union 对齐。
///
/// - Windows 走完整 checking → downloading → ready 链路,ready 后可静默安装。
/// - macOS 因为 dmg 无法真静默,只走 checking → manual_download,前端渲染一个
///   「打开下载页」按钮把用户送到雨云 dmg 链接,不下不装。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum UpdateState {
    Idle,
    Checking,
    UpToDate { current: String },
    Downloading { version: String, done: u64, total: u64 },
    Ready { version: String },
    /// macOS 分支:只提示,不下载。前端点按钮 openUrl 到 url。
    #[allow(dead_code)]
    ManualDownload { version: String, url: String },
    Error { message: String },
}

/// AppHandle 里 manage 的运行时状态。所有对状态的写入都要走 `set_state`
/// 以保证 emit 事件同步到前端。
pub struct UpdaterState {
    inner: Mutex<UpdateState>,
    running: AtomicBool,
}

impl UpdaterState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(UpdateState::Idle),
            running: AtomicBool::new(false),
        }
    }

    pub async fn snapshot(&self) -> UpdateState {
        self.inner.lock().await.clone()
    }
}

async fn set_state(app: &AppHandle, state: UpdateState) {
    if let Some(s) = app.try_state::<UpdaterState>() {
        *s.inner.lock().await = state.clone();
    }
    let _ = app.emit(UPDATE_EVENT, &state);
}

fn updates_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    let dir = data.join("updates");
    Ok(dir)
}

fn pending_json_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(updates_dir(app)?.join("pending_update.json"))
}

/// 简单的语义化版本比较：仅比 `major.minor.patch` 三段数字，忽略预发布后缀。
/// 用于判断远端是否比本地新。
fn version_gt(a: &str, b: &str) -> bool {
    fn parse(v: &str) -> (u32, u32, u32) {
        let core = v.split(['-', '+']).next().unwrap_or(v);
        let mut it = core.split('.').map(|s| s.parse::<u32>().unwrap_or(0));
        (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
    }
    parse(a) > parse(b)
}

fn build_installer_url(url_field: &str) -> String {
    if url_field.starts_with("http://") || url_field.starts_with("https://") {
        url_field.to_string()
    } else {
        format!("{}/{}", UPDATE_BASE_URL.trim_end_matches('/'), url_field.trim_start_matches('/'))
    }
}

async fn fetch_manifest() -> Result<RemoteManifest, String> {
    let url = format!("{}/latest.json", UPDATE_BASE_URL.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败: {e}"))?;
    let resp = client.get(&url).send().await.map_err(|e| format!("请求 latest.json 失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("latest.json 返回 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| format!("读取响应体失败: {e}"))?;
    serde_json::from_str::<RemoteManifest>(&text).map_err(|e| format!("解析 latest.json 失败: {e}"))
}

/// 限速流式下载 + SHA256 计算。
///
/// 限速实现：按 1 秒时间片累计发送字节数，超过配额就 sleep 到下一个时间片。
/// 简单可靠，且 reqwest 的 chunk 通常在几十 KB 量级，粒度足够细。
async fn download_with_rate_limit(
    app: &AppHandle,
    version: &str,
    url: &str,
    dst: &Path,
    expected_sha: &str,
    running: Arc<AtomicBool>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60 * 30))
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败: {e}"))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("请求 installer 失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("installer 返回 {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut stream = resp.bytes_stream();

    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).await.map_err(|e| format!("创建下载目录失败: {e}"))?;
    }
    // 先写到 .part,校验通过再原子重命名
    let tmp_path = dst.with_extension("part");
    let _ = fs::remove_file(&tmp_path).await;
    let mut file = fs::File::create(&tmp_path)
        .await
        .map_err(|e| format!("创建下载文件失败: {e}"))?;

    let mut hasher = Sha256::new();
    let mut done: u64 = 0;
    let mut window_start = Instant::now();
    let mut window_bytes: u64 = 0;

    while let Some(chunk_res) = stream.next().await {
        if !running.load(Ordering::Relaxed) {
            let _ = fs::remove_file(&tmp_path).await;
            return Err("已取消".into());
        }
        let chunk = chunk_res.map_err(|e| format!("下载中断: {e}"))?;
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| format!("写入文件失败: {e}"))?;
        done += chunk.len() as u64;
        window_bytes += chunk.len() as u64;

        // 每次 chunk 后推送进度,让前端进度条流畅
        set_state(
            app,
            UpdateState::Downloading {
                version: version.to_string(),
                done,
                total,
            },
        )
        .await;

        // 限速：当前 1 秒窗口内超配额就 sleep
        if window_bytes >= RATE_LIMIT_BPS {
            let elapsed = window_start.elapsed();
            if elapsed < Duration::from_secs(1) {
                tokio::time::sleep(Duration::from_secs(1) - elapsed).await;
            }
            window_start = Instant::now();
            window_bytes = 0;
        }
    }

    file.flush().await.map_err(|e| format!("flush 失败: {e}"))?;
    drop(file);

    let actual = hex::encode(hasher.finalize());
    if actual.to_lowercase() != expected_sha.to_lowercase() {
        let _ = fs::remove_file(&tmp_path).await;
        return Err(format!("SHA256 不匹配: expected {expected_sha}, got {actual}"));
    }

    // 原子重命名,避免半写文件被后续启动认成 ready
    let _ = fs::remove_file(dst).await;
    fs::rename(&tmp_path, dst)
        .await
        .map_err(|e| format!("重命名下载文件失败: {e}"))?;
    Ok(())
}

async fn write_pending(app: &AppHandle, rec: &PendingRecord) -> Result<(), String> {
    let path = pending_json_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await.map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(rec).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, json).await.map_err(|e| format!("写 pending 记录失败: {e}"))
}

fn read_pending_blocking(app: &AppHandle) -> Option<PendingRecord> {
    let path = pending_json_path(app).ok()?;
    let text = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str::<PendingRecord>(&text).ok()
}

/// 核心流程：检查 → 下载 → 校验 → 写 pending。全程 emit 状态事件。
///
/// `running` 用于取消（目前只在应用退出时可能触发，接口保留给未来手动取消用）。
pub async fn check_and_download(app: AppHandle) {
    let state = match app.try_state::<UpdaterState>() {
        Some(s) => s,
        None => return,
    };
    if state.running.swap(true, Ordering::AcqRel) {
        // 已有一次在跑,直接返回
        return;
    }
    let running_flag = Arc::new(AtomicBool::new(true));

    set_state(&app, UpdateState::Checking).await;
    let current = env!("CARGO_PKG_VERSION").to_string();

    let result: Result<(), String> = async {
        let manifest = fetch_manifest().await?;

        let key = current_platform_key();
        let asset = manifest
            .platforms
            .get(key)
            .ok_or_else(|| format!("latest.json 缺少当前平台 {key} 的更新条目"))?;

        // 优先使用平台级 version,没有则 fallback 到顶层 version
        let remote_version = asset.version.as_deref().unwrap_or(&manifest.version);

        if !version_gt(remote_version, &current) {
            set_state(&app, UpdateState::UpToDate { current: current.clone() }).await;
            return Ok(());
        }

        let url = build_installer_url(&asset.url);

        // macOS 分支：dmg 无法真静默,只把下载链接送到前端,让用户点按钮跳浏览器
        #[cfg(target_os = "macos")]
        {
            let _ = running_flag;
            set_state(
                &app,
                UpdateState::ManualDownload {
                    version: remote_version.to_string(),
                    url: url.clone(),
                },
            )
            .await;
            let _ = app.emit("updater://ready", remote_version);
            return Ok(());
        }

        #[cfg(target_os = "windows")]
        {
            let sha = asset
                .sha256
                .as_deref()
                .ok_or_else(|| "latest.json 当前平台条目缺少 sha256".to_string())?;

            // 已经下载过同版本 pending? 直接跳到 Ready
            if let Some(existing) = read_pending_blocking(&app) {
                if existing.version == remote_version
                    && Path::new(&existing.installer_path).exists()
                {
                    set_state(&app, UpdateState::Ready { version: remote_version.to_string() }).await;
                    let _ = app.emit("updater://ready", remote_version);
                    return Ok(());
                }
            }

            let dir = updates_dir(&app)?;
            fs::create_dir_all(&dir).await.map_err(|e| format!("创建下载目录失败: {e}"))?;
            let installer = dir.join("pending.exe");

            set_state(
                &app,
                UpdateState::Downloading {
                    version: remote_version.to_string(),
                    done: 0,
                    total: 0,
                },
            )
            .await;

            download_with_rate_limit(
                &app,
                remote_version,
                &url,
                &installer,
                sha,
                running_flag.clone(),
            )
            .await?;

            let rec = PendingRecord {
                version: remote_version.to_string(),
                installer_path: installer.to_string_lossy().to_string(),
                sha256: sha.to_string(),
            };
            write_pending(&app, &rec).await?;

            set_state(&app, UpdateState::Ready { version: remote_version.to_string() }).await;
            let _ = app.emit("updater://ready", remote_version);
        }

        Ok(())
    }
    .await;

    if let Err(e) = result {
        eprintln!("[updater] {e}");
        set_state(&app, UpdateState::Error { message: e }).await;
    }
    state.running.store(false, Ordering::Release);
}

/// macOS 分支:打开雨云 dmg 下载页,由前端「打开下载页」按钮 / 托盘菜单触发。
/// 从当前 UpdaterState 里取 ManualDownload.url,若状态不匹配就直接回退到 UPDATE_BASE_URL。
#[cfg(target_os = "macos")]
pub fn open_manual_download(app: &AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let url = if let Some(state) = app.try_state::<UpdaterState>() {
        // try_lock 避免阻塞事件循环;拿不到锁就走 fallback
        match state.inner.try_lock() {
            Ok(guard) => match &*guard {
                UpdateState::ManualDownload { url, .. } => url.clone(),
                _ => UPDATE_BASE_URL.to_string(),
            },
            Err(_) => UPDATE_BASE_URL.to_string(),
        }
    } else {
        UPDATE_BASE_URL.to_string()
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("打开下载链接失败: {e}"))
}

/// 立即静默运行 pending installer,由前端「重启安装」按钮 / 托盘菜单触发。
/// Windows 走 `installer.exe /S` NSIS 静默模式,启动后当前进程退出。
pub fn run_pending_installer(app: &AppHandle) -> Result<(), String> {
    let rec = read_pending_blocking(app).ok_or_else(|| "没有待安装的更新".to_string())?;
    if !Path::new(&rec.installer_path).exists() {
        return Err("安装包文件不存在".into());
    }

    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

        // NSIS perMachine 装到 Program Files 需要管理员权限。CreateProcessW
        // (std::process::Command::spawn) 遇到 requireAdministrator manifest 会直接
        // 返回 ERROR_ELEVATION_REQUIRED (740),连 UAC 弹窗都不会触发。
        // 必须走 ShellExecuteW + "runas" 让 shell 层触发 UAC 提权对话框。
        let file: Vec<u16> = OsStr::new(&rec.installer_path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let verb: Vec<u16> = "runas\0".encode_utf16().collect();
        let params: Vec<u16> = "/S\0".encode_utf16().collect();

        let hinst = unsafe {
            ShellExecuteW(
                HWND(std::ptr::null_mut()),
                PCWSTR(verb.as_ptr()),
                PCWSTR(file.as_ptr()),
                PCWSTR(params.as_ptr()),
                PCWSTR::null(),
                SW_HIDE,
            )
        };
        // MSDN: 返回值 > 32 表示成功;<= 32 是错误码(如 SE_ERR_ACCESSDENIED=5 代表用户
        // 在 UAC 对话框里点了「否」)。指针值转 usize 拿到那个数字直接比较。
        let code = hinst.0 as usize;
        if code <= 32 {
            return Err(format!(
                "启动 installer 失败(shell 错误码 {code}),可能是被 UAC 取消或安装包被拦截"
            ));
        }
        // 给 installer 一点时间接管,再退出当前进程,让 NSIS 释放可执行文件占用
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(500));
            std::process::exit(0);
        });
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = rec;
        Err("当前平台暂不支持自动更新".into())
    }
}

/// 应用启动时（Tauri builder 之前）调用：若发现有效的 pending 更新
/// 就静默拉起 installer 并 exit(0)。校验失败或文件缺失则删除脏记录。
///
/// 返回 true 表示已经把控制权交给 installer,调用方应立即 return（当前进程会被替换）。
#[cfg(target_os = "windows")]
pub fn try_install_pending_on_startup() -> bool {
    // 这里没法拿到 AppHandle,直接按已知路径 %APPDATA%\{identifier}\updates\ 找
    let base = match std::env::var("APPDATA") {
        Ok(v) => PathBuf::from(v),
        Err(_) => return false,
    };
    #[cfg(debug_assertions)]
    let dir = base.join("org.feedra.snoop.dev").join("updates");
    #[cfg(not(debug_assertions))]
    let dir = base.join("org.feedra.snoop").join("updates");
    let pending = dir.join("pending_update.json");
    let Ok(text) = std::fs::read_to_string(&pending) else { return false };
    let Ok(rec) = serde_json::from_str::<PendingRecord>(&text) else {
        let _ = std::fs::remove_file(&pending);
        return false;
    };

    let current = env!("CARGO_PKG_VERSION");
    if !version_gt(&rec.version, current) {
        // 当前进程已经是新版本，pending 记录过期，清理
        let _ = std::fs::remove_file(&pending);
        let _ = std::fs::remove_file(&rec.installer_path);
        return false;
    }

    let installer = PathBuf::from(&rec.installer_path);
    if !installer.exists() {
        let _ = std::fs::remove_file(&pending);
        return false;
    }

    // 二次校验 SHA256,防止 pending.exe 被外部破坏
    let Ok(bytes) = std::fs::read(&installer) else { return false };
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let actual = hex::encode(hasher.finalize());
    if actual.to_lowercase() != rec.sha256.to_lowercase() {
        let _ = std::fs::remove_file(&pending);
        let _ = std::fs::remove_file(&installer);
        return false;
    }

    // 同 run_pending_installer:perMachine NSIS 要 UAC,只能走 ShellExecuteW/runas。
    // 用 CreateProcessW 会因 ERROR_ELEVATION_REQUIRED 直接失败,连 UAC 弹窗都没有。
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let file: Vec<u16> = installer
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let verb: Vec<u16> = "runas\0".encode_utf16().collect();
    let params: Vec<u16> = "/S\0".encode_utf16().collect();

    let hinst = unsafe {
        ShellExecuteW(
            HWND(std::ptr::null_mut()),
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR(params.as_ptr()),
            PCWSTR::null(),
            SW_HIDE,
        )
    };
    if (hinst.0 as usize) > 32 {
        // pending 交给 installer 完成,清掉记录让下次启动不重复安装
        let _ = std::fs::remove_file(&pending);
        true
    } else {
        // 用户拒了 UAC 或其他失败:留着 pending,让用户下次或手动再触发
        false
    }
}

#[cfg(not(target_os = "windows"))]
pub fn try_install_pending_on_startup() -> bool {
    false
}
