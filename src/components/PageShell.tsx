/**
 * PageShell —— 右侧主视图统一外壳
 * 唯一负责「视口顶部 → 首个可见内容 = var(--space-6)」的地方：
 *  - 有 header：顶距由 .page-shell__header 的 padding-top 提供
 *  - 无 header：顶距由 .page-shell--no-header .page-shell__body 的 padding-top 提供
 * 页面自身的 className 只负责布局（grid/flex/gap），不得再写 padding。
 */

import type { ReactNode } from "react";

interface PageShellProps {
  /** 页面根 class，用于页面自身的布局（grid/flex/gap 等），不得再写 padding */
  className?: string;
  /** 顶部工具栏/标题区内容，可选 */
  header?: ReactNode;
  /** header 是否吸顶，默认 false */
  stickyHeader?: boolean;
  /** 页面自管滚动（Timeline 场景），默认 false */
  fill?: boolean;
  children: ReactNode;
}

export default function PageShell({
  className,
  header,
  stickyHeader = false,
  fill = false,
  children,
}: PageShellProps) {
  const shellClass = [
    "page-shell",
    fill && "page-shell--fill",
    !header && "page-shell--no-header",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const headerClass = [
    "page-shell__header",
    stickyHeader && "page-shell__header--sticky",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={shellClass}>
      {header && <div className={headerClass}>{header}</div>}
      <div className="page-shell__body">{children}</div>
    </div>
  );
}
