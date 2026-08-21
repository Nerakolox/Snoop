//! API Key 的 OS 原生加密存储。
//!
//! 设计目标：Key **不进 localStorage、不进明文配置文件**。存放方式随平台走
//! 系统自带的凭证加密能力，等价于 keyring，且**零新增依赖**：
//!   - Windows：DPAPI（`CryptProtectData`/`CryptUnprotectData`），密文 base64 落到
//!     `ai_key.dat`。密文与当前 Windows 用户绑定，别的用户/机器拷走也解不开。
//!   - macOS：钥匙串 Keychain 的 Generic Password（Security framework FFI）。
//!   - 其他平台：返回「不支持」（本应用不打包 Linux）。
//!
//! 对外的三个函数签名统一：`set_secret` / `get_secret` / `delete_secret`。
//! macOS 分支忽略 `path`（Keychain 不落文件）；Windows 分支用它定位密文文件。

use std::path::Path;

pub fn set_secret(path: &Path, secret: &str) -> Result<(), String> {
    imp::set(path, secret)
}

pub fn get_secret(path: &Path) -> Result<Option<String>, String> {
    imp::get(path)
}

pub fn delete_secret(path: &Path) -> Result<(), String> {
    imp::delete(path)
}

// ─── Windows：DPAPI + 落盘 ────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use std::ffi::c_void;

    /// Windows `DATA_BLOB`（`_CRYPTOAPI_BLOB`）。DPAPI 输入输出的最小单位。
    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    // 直接 link 系统库，不引入任何 crate。
    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *const c_void,
            p_prompt_struct: *const c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;

        fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *mut *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *const c_void,
            p_prompt_struct: *const c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    /// 不弹任何 UI（静默加解密，失败即报错而非拉起交互对话框）。
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    fn blob(data: &[u8]) -> DataBlob {
        DataBlob {
            cb_data: data.len() as u32,
            pb_data: data.as_ptr() as *mut u8,
        }
    }

    fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(data);
        let mut out = DataBlob { cb_data: 0, pb_data: std::ptr::null_mut() };
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err("DPAPI 加密失败".into());
        }
        let bytes = unsafe { std::slice::from_raw_parts(out.pb_data, out.cb_data as usize).to_vec() };
        unsafe { LocalFree(out.pb_data as *mut c_void) };
        Ok(bytes)
    }

    fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(data);
        let mut out = DataBlob { cb_data: 0, pb_data: std::ptr::null_mut() };
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err("DPAPI 解密失败（密文与当前 Windows 用户绑定）".into());
        }
        let bytes = unsafe { std::slice::from_raw_parts(out.pb_data, out.cb_data as usize).to_vec() };
        unsafe { LocalFree(out.pb_data as *mut c_void) };
        Ok(bytes)
    }

    pub fn set(path: &Path, secret: &str) -> Result<(), String> {
        let cipher = protect(secret.as_bytes())?;
        let b64 = STANDARD.encode(&cipher);
        std::fs::write(path, b64).map_err(|e| format!("写入密钥文件失败：{e}"))
    }

    pub fn get(path: &Path) -> Result<Option<String>, String> {
        let b64 = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => return Ok(None), // 文件不存在 = 未配置
        };
        let cipher = STANDARD
            .decode(b64.trim())
            .map_err(|e| format!("密钥文件损坏：{e}"))?;
        let plain = unprotect(&cipher)?;
        String::from_utf8(plain).map(Some).map_err(|e| format!("解密结果非 UTF-8：{e}"))
    }

    pub fn delete(path: &Path) -> Result<(), String> {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("删除密钥文件失败：{e}")),
        }
    }
}

// ─── macOS：Keychain Generic Password（security-framework）──────────────────
//
// 手写 CF FFI 曾在 NULL-callback 字典下提前 CFRelease，导致 SecItemCopyMatching
// 复制查询时 retain 野指针 → objc_retain 崩溃。改用 security-framework 的
// generic password 接口，CF 对象生命周期由 crate 管理，类型层面杜绝 use-after-free。

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use security_framework::base::Error as SecError;
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    const SERVICE: &str = "org.feedra.snoop.ai";
    const ACCOUNT: &str = "api_key";

    /// SecItemCopyMatching 未找到记录（errSecItemNotFound）。
    const ERR_ITEM_NOT_FOUND: i32 = -25300;

    fn is_not_found(e: &SecError) -> bool {
        e.code() == ERR_ITEM_NOT_FOUND
    }

    /// 写入（已存在则覆盖）。`set_generic_password` 内部已处理 Add/Update 两条路径。
    pub fn set(_path: &Path, secret: &str) -> Result<(), String> {
        set_generic_password(SERVICE, ACCOUNT, secret.as_bytes())
            .map_err(|e| format!("Keychain 写入失败：{e}"))
    }

    pub fn get(_path: &Path) -> Result<Option<String>, String> {
        match get_generic_password(SERVICE, ACCOUNT) {
            Ok(data) => String::from_utf8(data)
                .map(Some)
                .map_err(|e| format!("密钥解码失败：{e}")),
            Err(e) if is_not_found(&e) => Ok(None),
            // 其余错误（用户拒绝授权、Keychain 被锁等）原样上抛，不吞成 Ok(None)，
            // 以免「读不到」与「没存过」混淆，UI 显示成未配置。
            Err(e) => Err(format!("Keychain 读取失败：{e}")),
        }
    }

    pub fn delete(_path: &Path) -> Result<(), String> {
        match delete_generic_password(SERVICE, ACCOUNT) {
            Ok(()) => Ok(()),
            Err(e) if is_not_found(&e) => Ok(()),
            Err(e) => Err(format!("Keychain 删除失败：{e}")),
        }
    }
}

// ─── 其他平台：不支持 ─────────────────────────────────────────────────────────

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod imp {
    use super::*;

    pub fn set(_path: &Path, _secret: &str) -> Result<(), String> {
        Err("当前平台不支持安全存储".into())
    }
    pub fn get(_path: &Path) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn delete(_path: &Path) -> Result<(), String> {
        Ok(())
    }
}
