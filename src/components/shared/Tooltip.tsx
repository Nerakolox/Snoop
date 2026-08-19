import {
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { positionTooltip } from "./tooltipPosition";

type TooltipProps = {
  /** 悬浮提示内容；falsy 时不包装，直接渲染 children */
  content: ReactNode;
  /** 单个可承载 ref 的原生元素（button/div/span/...） */
  children: ReactElement;
  /** 展示延迟，隐藏无延迟。默认 300ms，避免划过时闪烁 */
  delay?: number;
};

/** children.props 的已知子集——原生元素上可能已有的事件/ref/disabled */
type ChildProps = {
  onMouseEnter?: (e: React.MouseEvent) => void;
  onMouseLeave?: (e: React.MouseEvent) => void;
  onFocus?: (e: React.FocusEvent) => void;
  onBlur?: (e: React.FocusEvent) => void;
  disabled?: boolean;
  ref?: React.Ref<HTMLElement>;
};

const OFFSET = 8;

/** 全站通用悬浮提示，替代原生 title= 属性。
 * 挂在触发元素上，hover/focus 后 portal 到 document.body 显示，
 * 定位跟随触发元素本身（不是光标），碰边自动翻转 + clamp 进视口。
 * disabled 的表单元素不触发鼠标事件，遇到时改在外层包一个 span 承接事件。 */
export default function Tooltip({ content, children, delay = 300 }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const show = (immediate: boolean) => {
    clearTimer();
    if (immediate) {
      setVisible(true);
      return;
    }
    timerRef.current = window.setTimeout(() => setVisible(true), delay);
  };

  const hide = () => {
    clearTimer();
    setVisible(false);
  };

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("scroll", hide, { capture: true });
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", hide, { capture: true });
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [visible]);

  useLayoutEffect(() => {
    if (!visible) return;
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const rect = anchor.getBoundingClientRect();
    const { left, top } = positionTooltip(tip, rect.left + rect.width / 2, rect.top, OFFSET);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = "visible";
  }, [visible, content]);

  useEffect(() => clearTimer, []);

  if (!content || !isValidElement(children)) return children;

  const childProps = children.props as ChildProps;

  const handlers = {
    onMouseEnter: (e: React.MouseEvent) => {
      childProps.onMouseEnter?.(e);
      show(false);
    },
    onMouseLeave: (e: React.MouseEvent) => {
      childProps.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent) => {
      childProps.onFocus?.(e);
      show(true);
    },
    onBlur: (e: React.FocusEvent) => {
      childProps.onBlur?.(e);
      hide();
    },
  };

  const tooltipNode = visible
    ? createPortal(
        <div
          ref={tipRef}
          className="tooltip-bubble"
          role="tooltip"
          style={{ left: 0, top: 0, visibility: "hidden" }}
        >
          {content}
        </div>,
        document.body
      )
    : null;

  // disabled 的原生表单元素不触发鼠标事件，改在外层包一个非 disabled 的 span 承接
  if (childProps.disabled) {
    return (
      <span
        ref={anchorRef as React.RefObject<HTMLSpanElement>}
        style={{ display: "inline-block" }}
        {...handlers}
      >
        {children}
        {tooltipNode}
      </span>
    );
  }

  const childRef = childProps.ref;
  const cloned = cloneElement(children, {
    ...handlers,
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node;
      if (typeof childRef === "function") childRef(node);
      else if (childRef && typeof childRef === "object") {
        (childRef as React.MutableRefObject<HTMLElement | null>).current = node;
      }
    },
  } as Partial<unknown>);

  return (
    <>
      {cloned}
      {tooltipNode}
    </>
  );
}
