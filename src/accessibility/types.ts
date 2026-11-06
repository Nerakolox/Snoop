/** 后端 `AccessibilityStatus` 的前端映射（granted / untrusted / listener_stopped / listener_error）。 */
export type AccessibilityStatus = { granted: boolean; reason: string };

/** 开发预览通道：Dev →「弹窗预览」派发，detail 为 null 表示退出预览。 */
export const ACCESSIBILITY_PREVIEW_EVENT = "snoop:accessibility-preview";
export type AccessibilityPreviewDetail = AccessibilityStatus | null;
