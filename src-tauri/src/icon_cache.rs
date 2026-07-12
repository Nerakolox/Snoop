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

pub struct IconCache {
    /// bundle_id → base64 PNG 字符串
    memory_cache: Mutex<HashMap<String, String>>,
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

    /// 获取 App 图标的 base64 PNG。优先从内存缓存，其次磁盘缓存，最后提取。
    pub fn get_icon(&self, bundle_id: &str) -> Option<String> {
        // 1. 内存缓存
        {
            let cache = self.memory_cache.lock().unwrap();
            if let Some(b64) = cache.get(bundle_id) {
                return Some(b64.clone());
            }
        }

        // 2. 磁盘缓存
        let disk_path = self.disk_cache_path(bundle_id);
        if disk_path.exists() {
            if let Ok(png_data) = std::fs::read(&disk_path) {
                let b64 = base64_encode(&png_data);
                self.memory_cache.lock().unwrap().insert(bundle_id.to_string(), b64.clone());
                return Some(b64);
            }
        }

        // 3. 提取并缓存
        self.extract_and_cache(bundle_id)
    }

    fn disk_cache_path(&self, bundle_id: &str) -> PathBuf {
        // bundle_id 在 Windows 上是 exe 路径，可能包含特殊字符，用 hash 作文件名
        let hash = simple_hash(bundle_id);
        self.disk_cache_dir.join(format!("{}.png", hash))
    }

    fn extract_and_cache(&self, bundle_id: &str) -> Option<String> {
        let png_data = extract_icon_png(bundle_id)?;
        let b64 = base64_encode(&png_data);

        // 写入磁盘缓存
        let disk_path = self.disk_cache_path(bundle_id);
        std::fs::write(&disk_path, &png_data).ok();

        // 写入内存缓存
        self.memory_cache.lock().unwrap().insert(bundle_id.to_string(), b64.clone());

        Some(b64)
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

#[cfg(not(target_os = "windows"))]
fn extract_icon_png(_bundle_id: &str) -> Option<Vec<u8>> {
    // macOS/Linux: 后续可接入对应平台的图标提取 API
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
