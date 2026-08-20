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

// ─── macOS：Keychain Generic Password ────────────────────────────────────────
//
// ⚠️ 本分支在当前（Windows）开发机上无法编译验证，仅按 Apple 官方 C API 文档
// 编写。若 macOS 打包报错或运行异常，优先排查这里的 extern "C" 常量名与签名。

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::ffi::c_void;
    use std::ptr;

    const SERVICE: &str = "org.feedra.snoop.ai";
    const ACCOUNT: &str = "api_key";

    type CFStringRef = *const c_void;
    type CFDataRef = *const c_void;
    type CFDictionaryRef = *const c_void;
    type CFMutableDictionaryRef = *const c_void;
    type CFAllocatorRef = *const c_void;
    type CFTypeRef = *const c_void;
    type OSStatus = i32;

    const ERR_SUCCESS: OSStatus = 0;
    const ERR_ITEM_NOT_FOUND: OSStatus = -25300;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        static kSecClass: CFStringRef;
        static kSecClassGenericPassword: CFStringRef;
        static kSecAttrService: CFStringRef;
        static kSecAttrAccount: CFStringRef;
        static kSecValueData: CFStringRef;
        static kSecReturnData: CFStringRef;
        static kSecMatchLimit: CFStringRef;
        static kSecMatchLimitOne: CFStringRef;

        fn SecItemCopyMatching(query: CFDictionaryRef, result: *mut CFTypeRef) -> OSStatus;
        fn SecItemAdd(attributes: CFDictionaryRef, result: *mut CFTypeRef) -> OSStatus;
        fn SecItemUpdate(query: CFDictionaryRef, attributes: CFDictionaryRef) -> OSStatus;
        fn SecItemDelete(query: CFDictionaryRef) -> OSStatus;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: CFTypeRef;
        fn CFDictionaryCreateMutable(
            allocator: CFAllocatorRef,
            capacity: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> CFMutableDictionaryRef;
        fn CFDictionarySetValue(dict: CFMutableDictionaryRef, key: *const c_void, value: *const c_void);
        fn CFStringCreateWithCString(
            allocator: CFAllocatorRef,
            c_str: *const std::os::raw::c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFDataCreate(allocator: CFAllocatorRef, bytes: *const u8, length: isize) -> CFDataRef;
        fn CFDataGetLength(data: CFDataRef) -> isize;
        fn CFDataGetBytePtr(data: CFDataRef) -> *const u8;
        fn CFRelease(cf: CFTypeRef);
    }

    fn cf_string(s: &str) -> CFStringRef {
        let c = std::ffi::CString::new(s).expect("CString 转换失败");
        unsafe { CFStringCreateWithCString(ptr::null(), c.as_ptr(), K_CF_STRING_ENCODING_UTF8) }
    }

    fn cf_data(bytes: &[u8]) -> CFDataRef {
        unsafe { CFDataCreate(ptr::null(), bytes.as_ptr(), bytes.len() as isize) }
    }

    /// 以 (class=GenericPassword, service, account) 为键的基础查询字典。
    fn base_query() -> CFMutableDictionaryRef {
        unsafe {
            let d = CFDictionaryCreateMutable(ptr::null(), 0, ptr::null(), ptr::null());
            let svc = cf_string(SERVICE);
            let acct = cf_string(ACCOUNT);
            CFDictionarySetValue(d, kSecClass as *const c_void, kSecClassGenericPassword as *const c_void);
            CFDictionarySetValue(d, kSecAttrService as *const c_void, svc as *const c_void);
            CFDictionarySetValue(d, kSecAttrAccount as *const c_void, acct as *const c_void);
            CFRelease(svc as CFTypeRef);
            CFRelease(acct as CFTypeRef);
            d
        }
    }

    pub fn set(_path: &Path, secret: &str) -> Result<(), String> {
        unsafe {
            let query = base_query();
            let value = cf_data(secret.as_bytes());
            let attrs = CFDictionaryCreateMutable(ptr::null(), 0, ptr::null(), ptr::null());
            CFDictionarySetValue(attrs, kSecValueData as *const c_void, value as *const c_void);

            let status = SecItemUpdate(query, attrs);
            let status = if status == ERR_ITEM_NOT_FOUND {
                // 不存在则新增：把 class/service/account 补进 attributes
                CFDictionarySetValue(attrs, kSecClass as *const c_void, kSecClassGenericPassword as *const c_void);
                let svc = cf_string(SERVICE);
                let acct = cf_string(ACCOUNT);
                CFDictionarySetValue(attrs, kSecAttrService as *const c_void, svc as *const c_void);
                CFDictionarySetValue(attrs, kSecAttrAccount as *const c_void, acct as *const c_void);
                CFRelease(svc as CFTypeRef);
                CFRelease(acct as CFTypeRef);
                SecItemAdd(attrs, ptr::null_mut())
            } else {
                status
            };

            CFRelease(attrs as CFTypeRef);
            CFRelease(value as CFTypeRef);
            CFRelease(query as CFTypeRef);

            if status == ERR_SUCCESS {
                Ok(())
            } else {
                Err(format!("Keychain 写入失败（状态码 {status}）"))
            }
        }
    }

    pub fn get(_path: &Path) -> Result<Option<String>, String> {
        unsafe {
            let query = base_query();
            CFDictionarySetValue(query, kSecReturnData as *const c_void, kCFBooleanTrue as *const c_void);
            CFDictionarySetValue(query, kSecMatchLimit as *const c_void, kSecMatchLimitOne as *const c_void);

            let mut result: CFTypeRef = ptr::null();
            let status = SecItemCopyMatching(query, &mut result);
            CFRelease(query as CFTypeRef);

            if status == ERR_ITEM_NOT_FOUND || result.is_null() {
                return Ok(None);
            }
            if status != ERR_SUCCESS {
                return Err(format!("Keychain 读取失败（状态码 {status}）"));
            }

            let data = result as CFDataRef;
            let len = CFDataGetLength(data);
            let p = CFDataGetBytePtr(data);
            let bytes = std::slice::from_raw_parts(p, len as usize).to_vec();
            CFRelease(result);
            String::from_utf8(bytes).map(Some).map_err(|e| format!("密钥解码失败：{e}"))
        }
    }

    pub fn delete(_path: &Path) -> Result<(), String> {
        unsafe {
            let query = base_query();
            let status = SecItemDelete(query);
            CFRelease(query as CFTypeRef);
            if status == ERR_SUCCESS || status == ERR_ITEM_NOT_FOUND {
                Ok(())
            } else {
                Err(format!("Keychain 删除失败（状态码 {status}）"))
            }
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
