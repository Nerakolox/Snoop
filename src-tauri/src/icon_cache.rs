use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(target_os = "windows")]
use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
#[cfg(target_os = "windows")]
use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{GetDIBits, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS};
#[cfg(target_os = "windows")]
use windows::core::PCWSTR;

/// 提取失败标记文件后缀，用于跳过下次重复提取（系统进程类没有图标的情况）
const NEG_CACHE_EXT: &str = "none";

pub struct IconCache {
    /// bundle_id → Some(base64 PNG) 命中；None 表示已知取不到图标，避免重试
    memory_cache: Mutex<HashMap<String, Option<String>>>,
    /// 磁盘缓存目录
    disk_cache_dir: PathBuf,
}

impl IconCache {
    pub fn new(cache_dir: PathBuf) -> Self {
        std::fs::create_dir_all(&cache_dir).ok();
        IconCache {
            memory_cache: Mutex::new(HashMap::new()),
            disk_cache_dir: cache_dir,
        }
    }

    /// 获取 App 图标的 base64 PNG。优先内存缓存 → 磁盘缓存 → 现场提取。
    /// 返回 None：确认取不到（同时写入负缓存，后续不再重试）。
    pub fn get_icon(&self, bundle_id: &str) -> Option<String> {
        // 1. 内存缓存（命中即返回，含负缓存）
        {
            let cache = self.memory_cache.lock().unwrap();
            if let Some(entry) = cache.get(bundle_id) {
                return entry.clone();
            }
        }

        // 2. 磁盘缓存 - PNG
        let disk_path = self.disk_cache_path(bundle_id);
        if disk_path.exists() {
            if let Ok(png_data) = std::fs::read(&disk_path) {
                let b64 = base64_encode(&png_data);
                self.memory_cache
                    .lock()
                    .unwrap()
                    .insert(bundle_id.to_string(), Some(b64.clone()));
                return Some(b64);
            }
        }

        // 2b. 磁盘负缓存 sentinel（之前提取失败过，跳过）
        let neg_path = self.disk_neg_path(bundle_id);
        if neg_path.exists() {
            self.memory_cache
                .lock()
                .unwrap()
                .insert(bundle_id.to_string(), None);
            return None;
        }

        // 3. 现场提取并缓存
        self.extract_and_cache(bundle_id)
    }

    fn disk_cache_path(&self, bundle_id: &str) -> PathBuf {
        // bundle_id 在 Windows 上是 exe 路径，可能包含特殊字符，用 hash 作文件名
        let hash = simple_hash(bundle_id);
        self.disk_cache_dir.join(format!("{}.png", hash))
    }

    fn disk_neg_path(&self, bundle_id: &str) -> PathBuf {
        let hash = simple_hash(bundle_id);
        self.disk_cache_dir.join(format!("{}.{}", hash, NEG_CACHE_EXT))
    }

    fn extract_and_cache(&self, bundle_id: &str) -> Option<String> {
        match extract_icon_png(bundle_id) {
            Some(png_data) => {
                let b64 = base64_encode(&png_data);

                // 写入磁盘缓存
                let disk_path = self.disk_cache_path(bundle_id);
                std::fs::write(&disk_path, &png_data).ok();

                // 写入内存缓存
                self.memory_cache
                    .lock()
                    .unwrap()
                    .insert(bundle_id.to_string(), Some(b64.clone()));

                Some(b64)
            }
            None => {
                // 负缓存：内存 + 空 sentinel 文件，避免下次启动继续重试
                self.memory_cache
                    .lock()
                    .unwrap()
                    .insert(bundle_id.to_string(), None);
                let neg_path = self.disk_neg_path(bundle_id);
                std::fs::write(&neg_path, b"").ok();
                None
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn extract_icon_png(exe_path: &str) -> Option<Vec<u8>> {
    use std::os::windows::ffi::OsStrExt;
    use std::ffi::OsStr;

    unsafe {
        let path = Path::new(exe_path);
        if !path.exists() {
            return None;
        }

        let wide: Vec<u16> = OsStr::new(exe_path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let mut shfi: SHFILEINFOW = std::mem::zeroed();
        let result = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );

        if result == 0 || shfi.hIcon.is_invalid() {
            return None;
        }

        let hicon = shfi.hIcon;

        // 获取图标信息
        let mut icon_info = std::mem::zeroed();
        if !GetIconInfo(hicon, &mut icon_info).is_ok() {
            let _ = DestroyIcon(hicon);
            return None;
        }

        let hbm_color = icon_info.hbmColor;
        let hbm_mask = icon_info.hbmMask;

        // 获取位图尺寸
        let mut bmp: windows::Win32::Graphics::Gdi::BITMAP = std::mem::zeroed();
        if windows::Win32::Graphics::Gdi::GetObjectW(
            hbm_color,
            std::mem::size_of::<windows::Win32::Graphics::Gdi::BITMAP>() as i32,
            Some(&mut bmp as *mut _ as *mut _)
        ) == 0 {
            if !hbm_color.is_invalid() { let _ = DeleteObject(hbm_color); }
            if !hbm_mask.is_invalid() { let _ = DeleteObject(hbm_mask); }
            let _ = DestroyIcon(hicon);
            return None;
        }

        let width = bmp.bmWidth;
        let height = bmp.bmHeight.abs();

        // 准备 BITMAPINFO
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = width;
        bmi.bmiHeader.biHeight = -height; // 负高度表示 top-down DIB
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB.0;

        let stride = ((width * 4 + 3) / 4) * 4; // 4-byte 对齐
        let buffer_size = (stride * height) as usize;
        let mut buffer: Vec<u8> = vec![0; buffer_size];

        let hdc = windows::Win32::Graphics::Gdi::GetDC(windows::Win32::Foundation::HWND(std::ptr::null_mut()));
        let scan_lines = GetDIBits(
            hdc,
            hbm_color,
            0,
            height as u32,
            Some(buffer.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        windows::Win32::Graphics::Gdi::ReleaseDC(windows::Win32::Foundation::HWND(std::ptr::null_mut()), hdc);

        if !hbm_color.is_invalid() { let _ = DeleteObject(hbm_color); }
        if !hbm_mask.is_invalid() { let _ = DeleteObject(hbm_mask); }
        let _ = DestroyIcon(hicon);

        if scan_lines == 0 || scan_lines != height as i32 {
            return None;
        }

        // 转换 BGRA → RGBA
        for i in (0..buffer.len()).step_by(4) {
            buffer.swap(i, i + 2); // B <-> R
        }

        // 编码为 PNG
        let mut png_data = Vec::new();
        {
            use image::{ImageBuffer, Rgba};
            let img = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(width as u32, height as u32, buffer)?;
            let mut cursor = std::io::Cursor::new(&mut png_data);
            img.write_to(&mut cursor, image::ImageFormat::Png).ok()?;
        }

        Some(png_data)
    }
}

#[cfg(target_os = "macos")]
fn extract_icon_png(bundle_id: &str) -> Option<Vec<u8>> {
    // macOS：NSWorkspace 定位 .app → iconForFile: 拿 NSImage → TIFF → PNG
    //
    // 只有 CFBundleIdentifier 形式的 bundle_id 才能被系统解析；unknown.bundle.id
    // 或空串会拿到 nil URL，直接返回 None 让上层写负缓存。
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSAutoreleasePool, NSString};
    use objc::runtime::YES;
    use objc::{class, msg_send, sel, sel_impl};

    if bundle_id.is_empty() || bundle_id == "unknown.bundle.id" {
        return None;
    }

    unsafe {
        let pool: id = NSAutoreleasePool::new(nil);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
            let ns_bid: id = NSString::alloc(nil).init_str(bundle_id);
            // Big Sur+ 用 URLForApplicationWithBundleIdentifier: 返回 NSURL
            let app_url: id = msg_send![workspace, URLForApplicationWithBundleIdentifier: ns_bid];
            if app_url == nil {
                return None;
            }
            let app_path: id = msg_send![app_url, path];
            if app_path == nil {
                return None;
            }

            // NSImage *icon = [workspace iconForFile:appPath]
            let icon: id = msg_send![workspace, iconForFile: app_path];
            if icon == nil {
                return None;
            }

            // 设置目标像素尺寸（NSImage 是矢量+多分辨率，指定 size 后 TIFFRepresentation 才有一致输出）
            use cocoa::foundation::NSSize;
            let target: NSSize = NSSize::new(128.0, 128.0);
            let _: () = msg_send![icon, setSize: target];

            let tiff_data: id = msg_send![icon, TIFFRepresentation];
            if tiff_data == nil {
                return None;
            }

            // NSBitmapImageRep *rep = [NSBitmapImageRep imageRepWithData:tiff_data]
            let rep: id =
                msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff_data];
            if rep == nil {
                return None;
            }

            // NSDictionary *props = @{}
            let props: id = msg_send![class!(NSDictionary), dictionary];

            // NSBitmapImageFileTypePNG = 4
            let ns_png_type: u64 = 4;
            let png_data: id = msg_send![
                rep,
                representationUsingType: ns_png_type
                properties: props
            ];
            if png_data == nil {
                return None;
            }

            let length: usize = msg_send![png_data, length];
            let bytes: *const u8 = msg_send![png_data, bytes];
            if bytes.is_null() || length == 0 {
                return None;
            }

            let slice = std::slice::from_raw_parts(bytes, length);
            Some(slice.to_vec())
        }));

        let _: () = msg_send![pool, drain];
        let _ = YES; // 抑制未使用 warning
        result.ok().flatten()
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn extract_icon_png(_bundle_id: &str) -> Option<Vec<u8>> {
    // Linux: 尚未实现
    None
}

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn simple_hash(s: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    hasher.finish()
}
