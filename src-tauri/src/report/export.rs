//! 报告导出成图（批次 7）—— 前端把导出卡经 foreignObject→canvas 渲染成 PNG 字节，
//! 这里只负责「接收字节 + 弹系统保存对话框 + 落盘」。截图逻辑全在前端，本模块零截图依赖。

use base64::Engine;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// 接收前端导出的 PNG 字节（base64），弹系统保存对话框落盘。
///
/// 返回 `Some(路径)` 表示保存成功；`None` 表示用户在对话框里取消。
/// 数据由前端 `canvas.toBlob` 产出，再经 `arrayBuffer` → base64 传进来（JSON IPC 下
/// `Vec<u8>` 会退化成数字数组，base64 字符串更省、更稳）。
#[tauri::command]
pub async fn save_report_png(
    app: AppHandle,
    data_b64: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.trim())
        .map_err(|e| format!("图片数据解码失败：{e}"))?;
    if bytes.is_empty() {
        return Err("图片数据为空".into());
    }

    // blocking_save_file 内部会调度到主线程再阻塞当前线程等待；async 命令跑在异步
    // 运行时的 worker 线程上，不会与主线程死锁（与 dialog 插件文档示例一致）。
    let Some(file_path) = app
        .dialog()
        .file()
        .set_file_name(&suggested_name)
        .add_filter("PNG 图片", &["png"])
        .blocking_save_file()
    else {
        return Ok(None); // 用户取消
    };

    let path = file_path
        .into_path()
        .map_err(|e| format!("无法解析保存路径：{e}"))?;

    std::fs::write(&path, bytes).map_err(|e| format!("写入文件失败：{e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}
