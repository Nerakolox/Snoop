/**
 * 输入 —— 外设活动画像（原「键盘」页）
 * KLE 格式驱动的键盘热力图 + 鼠标热力 + Top 按键排行。
 * 范围/App 筛选来自全局上下文，顶栏切换即自动重拉。
 */

import { useEffect, useMemo, useState } from "react";
import {
  fetchBucketsInRange,
  fetchKeyDetailsInRange,
  formatAnchor,
  type RawBucket,
  type RawKeyDetail,
} from "../data";
import { toMs } from "../data/ranges";
import { aggregateByApp, MERGED_KEY_GROUPS } from "../analytics";
import { parseKLE, getLabelRdevCode, type KLEKey, type ParsedLayout } from "../kleParser";
import KLELayoutPicker, {
  getSavedLayout,
  saveLayout,
  loadLayoutJSON,
} from "../components/KLELayoutPicker";
import TopKeysPanel from "../components/keyboard/TopKeysPanel";
import MousePanel from "../components/keyboard/MousePanel";
import KeyboardPanel from "../components/keyboard/KeyboardPanel";
import KeyDetailPanel from "../components/keyboard/KeyDetailPanel";
import { KeySelectionProvider } from "../components/keyboard/KeySelectionContext";
import PageShell from "../components/PageShell";
import ContextChips from "../components/shared/ContextChips";
import { adaptKind, useContextActions, useContextState } from "../store/context";

export default function Keyboard() {
  const { kind, anchor, appId, selectedKey } = useContextState();
  const actions = useContextActions();
  const { kind: viewKind, anchor: viewAnchor, note } = adaptKind("input", { kind, anchor });
  const range = useMemo(() => toMs(viewKind, viewAnchor), [viewKind, viewAnchor]);

  const [loading, setLoading] = useState(false);
  const [showLoading, setShowLoading] = useState(false);

  // KLE 配列状态（从 localStorage 读取，默认 104 全尺寸）
  const [layoutId, setLayoutId] = useState<string>(() => getSavedLayout());
  const [layout, setLayout] = useState<ParsedLayout>({
    keys: [],
    maxX: 0,
    maxY: 0,
    unsupportedFeatures: [],
  });
  const kleKeys = layout.keys;
  const [kleLoading, setKleLoading] = useState(false);

  // 保存配列选择并加载新配列
  const handleLayoutChange = async (id: string) => {
    setLayoutId(id);
    saveLayout(id);
    await loadKLELayout(id);
  };

  // 加载 KLE 配列 JSON 并解析
  const loadKLELayout = async (id: string) => {
    setKleLoading(true);
    try {
      const kleJson = await loadLayoutJSON(id);
      const parsed = parseKLE(kleJson);
      setLayout(parsed);
    } catch (e) {
      console.error("Failed to load KLE layout:", e);
    } finally {
      setKleLoading(false);
    }
  };

  // 初始加载配列
  useEffect(() => {
    loadKLELayout(layoutId);
  }, []);

  // 全量桶（未筛选，鼠标面板/键鼠比要用来做分 App 对比）+ 按键明细（后端按 appId 过滤）
  const [allBuckets, setAllBuckets] = useState<RawBucket[]>([]);
  const [keyDetails, setKeyDetails] = useState<RawKeyDetail[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [buckets, details] = await Promise.all([
          fetchBucketsInRange(range),
          fetchKeyDetailsInRange(range, appId ?? undefined),
        ]);
        if (cancelled) return;
        setAllBuckets(buckets);
        setKeyDetails(details);
      } catch (e) {
        console.error("输入页数据加载失败:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKind, viewAnchor, appId]);

  // 延迟显示 loading 状态，避免快速切换时闪烁
  useEffect(() => {
    let timer: number | undefined;
    if (loading) {
      timer = window.setTimeout(() => setShowLoading(true), 200);
    } else {
      setShowLoading(false);
      if (timer) window.clearTimeout(timer);
    }
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [loading]);

  // 鼠标面板仍按当前 App 筛选展示（按钮/滚轮/移动距离都在 bucket 里，前端过滤即可）
  const filteredBuckets = useMemo(
    () => (appId === null ? allBuckets : allBuckets.filter((b) => b.app_bundle_id === appId)),
    [allBuckets, appId]
  );

  // 构建 rdevCode → count 的映射（键盘热力）
  const keyCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const kd of keyDetails) {
      map[kd.key_code] = (map[kd.key_code] ?? 0) + kd.count;
    }
    return map;
  }, [keyDetails]);

  // 构建 KLE 键标签 → count 的映射（通过 rdevCode 匹配，MERGED_KEY_GROUPS 命中的
  // 修饰键把左右两侧 rdev code 的计数合并求和，见 analytics/keys.ts 顶部注释）
  const kleKeyCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const key of kleKeys) {
      const rdevCode = getLabelRdevCode(key.label);
      if (rdevCode) {
        const group = MERGED_KEY_GROUPS[rdevCode] ?? [rdevCode];
        map[key.label] = group.reduce((sum, code) => sum + (keyCounts[code] ?? 0), 0);
      }
    }
    return map;
  }, [kleKeys, keyCounts]);

  // 提取所有键的按压次数数组，用于分位数分档
  const allKeyCounts = useMemo(() => Object.values(kleKeyCounts), [kleKeyCounts]);

  // 同 label 的多个键（左右 Shift/Ctrl/Alt/Meta）按 x 取最小者为可点击主键，
  // 其余进 mergedIndices：不可点、count 已并入主键，仅在 hover 时提示"合并计数"。
  const { mergedIndices, primaryIndexByLabel } = useMemo(() => {
    const byLabel = new Map<string, number[]>();
    kleKeys.forEach((key, index) => {
      if (key.decal) return;
      const arr = byLabel.get(key.label) ?? [];
      arr.push(index);
      byLabel.set(key.label, arr);
    });
    const merged = new Set<number>();
    const primary = new Map<string, number>();
    for (const [label, indices] of byLabel) {
      if (indices.length <= 1) {
        primary.set(label, indices[0]);
        continue;
      }
      const sorted = [...indices].sort((a, b) => kleKeys[a].x - kleKeys[b].x);
      primary.set(label, sorted[0]);
      for (const idx of sorted.slice(1)) merged.add(idx);
    }
    return { mergedIndices: merged, primaryIndexByLabel: primary };
  }, [kleKeys]);

  const keyTitles = useMemo(() => {
    const titles: Record<number, string> = {};
    for (const idx of mergedIndices) titles[idx] = "与左侧同名键合并计数";
    return titles;
  }, [mergedIndices]);

  const handleKeyClick = (index: number, key: KLEKey) => {
    if (mergedIndices.has(index)) return;
    actions.setSelectedKey(selectedKey === key.label ? null : key.label);
  };

  const selectedIndex = useMemo(
    () => (selectedKey === null ? null : primaryIndexByLabel.get(selectedKey) ?? null),
    [selectedKey, primaryIndexByLabel]
  );

  const selectedRdevCode = selectedKey !== null ? getLabelRdevCode(selectedKey) ?? null : null;
  const selectedTotalCount = selectedKey !== null ? kleKeyCounts[selectedKey] ?? 0 : 0;
  const selectedMerged =
    selectedRdevCode !== null && (MERGED_KEY_GROUPS[selectedRdevCode]?.length ?? 0) > 1;

  const isToday = viewKind === "day" && viewAnchor === formatAnchor(new Date());
  const topPanelTitle =
    viewKind === "month" ? "本月按得最多" : viewKind === "week" ? "本周按得最多" : isToday ? "今天按得最多" : "当天按得最多";

  const appName =
    appId === null
      ? undefined
      : aggregateByApp(allBuckets).find((a) => a.app_bundle_id === appId)?.app_name ?? appId;

  return (
    <PageShell
      className="kb-page"
      stickyHeader
      header={
        <div className="kb-filters">
          {note !== null && <div className="kb-filter-row kb-header-note">{note}</div>}
          <ContextChips show={["app", "selectedKey"]} appName={appName} />

          {/* KLE 配列选择——展示配置，不是数据筛选 */}
          <div className="kb-filter-row kb-filter-row--layout">
            <KLELayoutPicker value={layoutId} onChange={handleLayoutChange} />
          </div>
        </div>
      }
    >
      {/* 统一活动面板：键盘热力图 + 鼠标 + Top 按键 */}
      <section className="panel kb-unified-panel" style={{ position: "relative" }}>
        {showLoading && (
          <div className="kb-loading-overlay">
            <div className="kb-loading-spinner" />
          </div>
        )}

        {kleLoading ? (
          <div style={{ padding: "var(--space-6)", textAlign: "center", color: "var(--color-text-3)" }}>
            加载配列中...
          </div>
        ) : kleKeys.length === 0 ? (
          <div style={{ padding: "var(--space-6)", textAlign: "center", color: "var(--color-text-3)" }}>
            配列加载失败
          </div>
        ) : (
          <>
            <KeySelectionProvider
              value={{ onKeyClick: handleKeyClick, selectedIndex, mergedIndices, keyTitles }}
            >
              <KeyboardPanel
                kleKeys={kleKeys}
                kleKeyCounts={kleKeyCounts}
                allKeyCounts={allKeyCounts}
                maxX={layout.maxX}
                maxY={layout.maxY}
              />
            </KeySelectionProvider>

            {/* 下方分栏：鼠标 + Top 按键 + 单键详情 */}
            <div className="kb-lower-section">
              <MousePanel buckets={filteredBuckets} />

              <TopKeysPanel
                kleKeyCounts={kleKeyCounts}
                allKeyCounts={allKeyCounts}
                title={topPanelTitle}
              />

              <KeyDetailPanel
                label={selectedKey}
                rdevCode={selectedRdevCode}
                totalCount={selectedTotalCount}
                merged={selectedMerged}
                range={range}
                appId={appId}
              />
            </div>
          </>
        )}
      </section>
    </PageShell>
  );
}
