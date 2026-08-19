import {
  createContext,
  useContext,
  useEffect,
  useState,
  type DependencyList,
  type ReactNode,
} from "react";

export type TopBarToolItem = {
  /** 稳定的唯一标识，用于 React key 与宽度缓存 */
  key: string;
  node: ReactNode;
  /** high = 宽度紧张时优先保持可见（筛选态芯片、降级警示）。默认 "normal" */
  priority?: "high" | "normal";
};

const TopBarToolItemsContext = createContext<TopBarToolItem[]>([]);
const TopBarToolsSetterContext = createContext<
  ((items: TopBarToolItem[]) => void) | null
>(null);

export function TopBarToolsProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<TopBarToolItem[]>([]);
  return (
    <TopBarToolsSetterContext.Provider value={setItems}>
      <TopBarToolItemsContext.Provider value={items}>
        {children}
      </TopBarToolItemsContext.Provider>
    </TopBarToolsSetterContext.Provider>
  );
}

export function useTopBarToolItems() {
  return useContext(TopBarToolItemsContext);
}

function useTopBarToolsSetter() {
  const setter = useContext(TopBarToolsSetterContext);
  if (!setter) {
    throw new Error("useTopBarTools 必须在 TopBarToolsProvider 内使用");
  }
  return setter;
}

/**
 * 页面注册工具项到顶栏工具槽。
 *
 * ⚠️ 必须在 useEffect 里 setItems，绝不能在 render 期间调用。
 * ⚠️ 依赖数组必须由调用方显式传入，绝不能把 items 本身放进 deps ——
 *    items 里含 JSX，每次 render 都是新引用，放进 deps 就是无限重渲染。
 */
export function useTopBarTools(items: TopBarToolItem[], deps: DependencyList) {
  const setItems = useTopBarToolsSetter();
  useEffect(() => {
    setItems(items);
    return () => setItems([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
