/**
 * 后端 `updater.rs` 的 `UpdateState` 在前端的映射。
 *
 * Rust 侧用 `#[serde(tag = "status", rename_all = "snake_case")]` 序列化，
 * 这里的手写联合类型必须与之一一对应。设置页与全局更新提示弹窗共用，
 * 所以从页面文件里抽出来，别再各写一份。
 */
export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up_to_date"; current: string }
  | { status: "downloading"; version: string; done: number; total: number }
  | { status: "ready"; version: string }
  | { status: "manual_download"; version: string; url: string }
  | { status: "error"; message: string };

/**
 * 开发预览通道：Dev →「弹窗预览」页往 window 上派发这个事件，
 * UpdatePrompt 收到后把 detail 当成一次真实的状态推送。
 *
 * 只用于本地看版式，不参与任何生产逻辑；真实链路仍然只认 `updater://state`。
 */
export const UPDATE_PREVIEW_EVENT = "snoop:update-preview";
