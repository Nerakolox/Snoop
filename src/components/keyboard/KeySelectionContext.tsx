/**
 * 单键选中状态的传递通道。
 *
 * KLEKeyboard.tsx 与驱动它的 Keyboard.tsx 页面之间隔着 KeyboardPanel.tsx——
 * 那是被冻结的缩放容器（见 KeyboardPanel.tsx 顶部注释），不能改一行来转发
 * 交互 prop。所以这组状态改走 Context：页面在 KeyboardPanel 外层
 * Provide，KLEKeyboard 内部直接 Consume，物理上绕开中间这层。
 */

import { createContext, useContext } from "react";
import type { LayoutKey } from "../../keyboardLayout";

export interface KeySelection {
  /** 点击某个键 */
  onKeyClick?: (key: LayoutKey) => void;
  /** 当前选中的键（下标），用于加选中态 class */
  selectedIndex?: number | null;
}

const KeySelectionContext = createContext<KeySelection>({});

export const KeySelectionProvider = KeySelectionContext.Provider;

export function useKeySelection(): KeySelection {
  return useContext(KeySelectionContext);
}
