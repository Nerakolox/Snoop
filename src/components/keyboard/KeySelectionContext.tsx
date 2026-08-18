/**
 * 单键选中状态的传递通道。
 *
 * KLEKeyboard.tsx 与驱动它的 Keyboard.tsx 页面之间隔着 KeyboardPanel.tsx——
 * 那是被冻结的缩放容器（见 KeyboardPanel.tsx 顶部注释），不能改一行来转发
 * 交互 prop。所以这四项状态改走 Context：页面在 KeyboardPanel 外层
 * Provide，KLEKeyboard 内部直接 Consume，物理上绕开中间这层。
 */

import { createContext, useContext } from "react";
import type { KLEKey } from "../../kleParser";

export interface KeySelection {
  /** 点击某个键。index 与 keys 数组下标一致 */
  onKeyClick?: (index: number, key: KLEKey) => void;
  /** 当前选中的键（下标），用于加选中态 class */
  selectedIndex?: number | null;
  /** 不可点的键（下标集合），通常是右侧合并计数的修饰键 */
  mergedIndices?: Set<number>;
  /** 覆盖某个键的 title（右侧修饰键说明"与左侧合并计数"） */
  keyTitles?: Record<number, string>;
}

const KeySelectionContext = createContext<KeySelection>({});

export const KeySelectionProvider = KeySelectionContext.Provider;

export function useKeySelection(): KeySelection {
  return useContext(KeySelectionContext);
}
