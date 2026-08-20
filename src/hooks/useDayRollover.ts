import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 午夜之后再等一小会儿才触发。
 *
 * 正常路径并不需要它——setTimeout 不会早于 deadline 触发，而 deadline 就是
 * 下一个午夜，所以回调里读到的一定已经是新的一天。它只是给「运行中把系统
 * 时钟往回拨」这类边界多一层缓冲，**并不能关闭那个窗口**：真正兜底的是
 * reducer 的幂等守卫 + 每次重排都重算延迟（见下）。
 */
const CUSHION_MS = 1000;

/**
 * 距离下一个**本地**午夜的毫秒数。
 *
 * ⚠️ 必须走日历运算 `new Date(y, m, d + 1)`，不能写 `+ 24*60*60*1000`。
 *    夏令时切换当天真实间隔是 23h 或 25h，加固定毫秒数会差一个小时。
 */
function msUntilNextMidnight(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * 跨日唤醒。三个触发器**共用同一个回调**，不存在第二份跨日逻辑：
 *
 *   1. 自重排的一次性 setTimeout —— 正常挂机跨午夜（主路径）
 *   2. 窗口焦点 onFocusChanged  —— 切走 → 期间跨日 → 切回
 *   3. document visibilitychange —— 最小化 → 还原；部分休眠 → 唤醒
 *
 * 回调必须是幂等的（store 的 DAY_ROLLOVER 有 `a.today === s.today` 守卫），
 * 因为这三者会重叠触发。
 *
 * ⚠️ 休眠场景的已知上限：Tauri v2 的 JS 侧没有可靠的「系统唤醒」事件。
 *    「应用保持焦点 → 合盖休眠 → 唤醒后仍是焦点」这条路径全程没有焦点
 *    **变化**，触发器 2 不会响；此时只能依赖超期 setTimeout 在恢复后被补发，
 *    而窗口被遮挡时 Chromium 的后台节流会让补发明显晚于午夜。要做到严密需
 *    在 Rust 侧监听系统电源事件再 emit 给前端——本次不做。
 */
export function useDayRollover(onRollover: () => void): void {
  const onRolloverRef = useRef(onRollover);
  onRolloverRef.current = onRollover;

  // 触发器 1：自重排的一次性定时器（不是轮询）。
  useEffect(() => {
    let timer: number | undefined;

    const arm = () => {
      const raw = msUntilNextMidnight() + CUSHION_MS;
      // 时钟向前跳过午夜会算出负数，钳到 0 → 下一 tick 立即补一次，
      // 然后重排约 24h。是单次立即触发，不会变成忙循环。
      const delay = Number.isFinite(raw) && raw > 0 ? raw : 0;
      timer = window.setTimeout(() => {
        onRolloverRef.current();
        arm();                  // 在回调内重排，每次都按当前时钟重算距离
      }, delay);
    };

    arm();

    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // ⚠️ 空依赖是刻意的，**绝不能**把 today 之类的状态加进来。
    //    那样会在「定时器触发但日期没变」（守卫 no-op）时让 effect 不重跑，
    //    于是没有新定时器被排上，整条链就此死掉，应用此后永不跨日。
    //    StrictMode 的 mount→cleanup→mount 在这里是安全的：每次 effect 调用
    //    拥有自己的 timer 闭包变量，cleanup 精确清掉自己那一个。
  }, []);

  // 触发器 2：窗口焦点。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    try {
      getCurrentWindow()
        .onFocusChanged(({ payload }) => {
          if (payload) onRolloverRef.current();
        })
        .then((fn) => {
          // promise 在卸载之后才 resolve 时就地退订，否则监听器会泄漏。
          if (cancelled) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    } catch {
      // 非 Tauri 环境（纯浏览器跑 `npm run vite`）：定时器照常工作，
      // 只降级掉焦点监听。
    }

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 触发器 3：文档可见性。
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") onRolloverRef.current();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
}
