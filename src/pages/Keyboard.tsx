/**
 * 输入 —— 外设活动画像（原「键盘」页）
 * 版式主次：键盘热力图是唯一的主角（唯一有卡片外壳的区块，尽可能放大），
 * 上方一行指标条、下方分隔线以下的鼠标 / Top 按键都是注脚，视觉降一级。
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
import {
  MERGED_KEY_GROUPS,
  MOUSE_PIXELS_PER_METER,
  intensityVar,
  ratioVerdict,
  type Intensity,
} from "../analytics";
import {
  parseKLE,
  getDisplayLabel,
  getLabelRdevCode,
  type KLEKey,
  type ParsedLayout,
} from "../kleParser";
import { getSavedLayout, loadLayoutJSON } from "../components/KLELayoutPicker";
import { getLayoutById } from "../layouts";
import TopKeysPanel from "../components/keyboard/TopKeysPanel";
import MousePanel from "../components/keyboard/MousePanel";
import KeyboardPanel from "../components/keyboard/KeyboardPanel";
import KeyDetailPanel from "../components/keyboard/KeyDetailPanel";
import { KeySelectionProvider } from "../components/keyboard/KeySelectionContext";
import PageShell from "../components/PageShell";
import { useTopBarTools } from "../components/topbar/TopBarToolsContext";
import Tooltip from "../components/shared/Tooltip";
import { adaptKind, useContextActions, useContextState } from "../store/context";
import { anchorLabel } from "../utils/format";

/** 热力色阶图例的档位，与 KLEKeyboard 的 bucketByPercentile 输出同域。 */
const LEGEND_LEVELS: Intensity[] = [0, 1, 2, 3, 4];

/** 鼠标里程：像素 → 米/公里，返回数字与单位两段，便于分别排版。 */
function formatDistance(pixels: number): { num: string; unit: string } {
  const meters = pixels / MOUSE_PIXELS_PER_METER;
  if (meters >= 1000) return { num: (meters / 1000).toFixed(1), unit: "公里" };
  return { num: String(Math.round(meters)), unit: "米" };
}

export default function Keyboard() {
  const { kind, anchor, appId, selectedKey } = useContextState();
  const actions = useContextActions();
  const { kind: viewKind, anchor: viewAnchor } = adaptKind("input", { kind, anchor });
  const range = useMemo(() => toMs(viewKind, viewAnchor), [viewKind, viewAnchor]);

  const [loading, setLoading] = useState(false);
  const [showLoading, setShowLoading] = useState(false);

  // KLE 配列状态（从 localStorage 读取，默认 104 全尺寸；设置页可改，靠
  // kle-layout-change 事件同步——配列选择器已移到设置页，本页只读展示+跳转）
  const [layoutId, setLayoutId] = useState<string>(() => getSavedLayout());
  const [layout, setLayout] = useState<ParsedLayout>({
    keys: [],
    maxX: 0,
    maxY: 0,
    unsupportedFeatures: [],
  });
  const kleKeys = layout.keys;
  const [kleLoading, setKleLoading] = useState(false);

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

  // 设置页切换配列时跨页同步
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      setLayoutId(id);
      loadKLELayout(id);
    };
    window.addEventListener("kle-layout-change", handler);
    return () => window.removeEventListener("kle-layout-change", handler);
  }, []);

  const layoutName = getLayoutById(layoutId)?.name ?? layoutId;

  useTopBarTools(
    [
      {
        key: "layout",
        node: (
          <Tooltip content="前往设置页切换配列">
            <button
              type="button"
              className="topbar__tool-btn"
              data-tauri-drag-region="false"
              onClick={() => actions.navigate({ page: "settings" })}
            >
              配列 · {layoutName}
            </button>
          </Tooltip>
        ),
      },
    ],
    [layoutName]
  );

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

  // 指标条的四个数字全部从 filteredBuckets 聚合 —— 与鼠标块同源，四者口径一致，
  // 不新增任何接口。键鼠比在此一并算出，原来的 RatioPanel 整栏因此取消。
  const totals = useMemo(() => {
    let keys = 0;
    let clicks = 0;
    let dist = 0;
    for (const b of filteredBuckets) {
      keys += b.key_total || 0;
      clicks += (b.mouse_left || 0) + (b.mouse_right || 0) + (b.mouse_middle || 0);
      dist += b.mouse_move_dist || 0;
    }
    return { keys, clicks, dist, ratio: keys > 0 ? clicks / keys : null };
  }, [filteredBuckets]);

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

  const now = useMemo(() => new Date(), []);
  const appName = appId === null
    ? undefined
    : filteredBuckets.find((b) => b.app_bundle_id === appId)?.app_name ?? appId;
  const subtitleParts = [anchorLabel(viewKind, viewAnchor, now)];
  if (appId !== null) subtitleParts.push(`已筛选 ${appName}`);
  if (!loading && filteredBuckets.length === 0) subtitleParts.push("该范围没有采集到数据");

  const distance = formatDistance(totals.dist);
  const metrics = [
    { label: "总按键", num: totals.keys.toLocaleString(), unit: "次" },
    { label: "总点击", num: totals.clicks.toLocaleString(), unit: "次" },
    { label: "鼠标里程", num: distance.num, unit: distance.unit },
    {
      label: "键鼠比",
      num: totals.ratio === null ? "—" : totals.ratio.toFixed(2),
      tag: totals.ratio === null ? undefined : ratioVerdict(totals.ratio),
    },
  ];

  return (
    <PageShell
      className="kb-page"
      header={
        <div className="page-header">
          <h1 className="page-header-title">输入</h1>
          <p className="page-header-subtitle">{subtitleParts.join(" · ")}</p>
        </div>
      }
    >
      {/* ① 指标条 —— 无外壳，压在主角上方只占一行 */}
      <section className="kb-metrics" aria-label="输入概要">
        {metrics.map((m) => (
          <div key={m.label} className="kb-metric">
            <div className="kb-metric-value">
              <span className="kb-metric-num">{m.num}</span>
              {m.unit && <span className="kb-metric-unit">{m.unit}</span>}
              {m.tag && <span className="kb-metric-tag">{m.tag}</span>}
            </div>
            <div className="kb-metric-label">{m.label}</div>
          </div>
        ))}
      </section>

      {/* ② 主角：键盘热力图 + 色阶图例 + 选中键时就地展开的详情条 */}
      <section className="panel kb-hero">
        {kleLoading ? (
          <div className="kb-hero-placeholder">加载配列中…</div>
        ) : kleKeys.length === 0 ? (
          <div className="kb-hero-placeholder">配列加载失败</div>
        ) : (
          <>
            {/* 遮罩只盖键盘，指标条与辅助区留在原位不闪 */}
            <div className="kb-hero-stage">
              {showLoading && (
                <div className="kb-loading-overlay">
                  <div className="kb-loading-spinner" />
                </div>
              )}
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
            </div>

            <div className="kb-hero-foot">
              <div className="kb-legend" aria-label="按键次数色阶">
                <span className="kb-legend-cap">少</span>
                {LEGEND_LEVELS.map((level) => (
                  <span
                    key={level}
                    className="kb-legend-swatch"
                    style={{ background: intensityVar(level) }}
                  />
                ))}
                <span className="kb-legend-cap">多</span>
              </div>
              <span className="kb-hero-hint">
                {selectedKey === null
                  ? "点任意键查看它的使用细节"
                  : `已选 ${getDisplayLabel(selectedKey)} · 再点一次取消`}
              </span>
            </div>

            {selectedKey !== null && (
              <KeyDetailPanel
                label={selectedKey}
                rdevCode={selectedRdevCode}
                totalCount={selectedTotalCount}
                merged={selectedMerged}
                range={range}
                appId={appId}
              />
            )}
          </>
        )}
      </section>

      {/* ③ 辅助区 —— 分隔线以下，无卡片外壳，固定两栏 */}
      <section className="kb-aux">
        <MousePanel buckets={filteredBuckets} />
        <TopKeysPanel
          kleKeyCounts={kleKeyCounts}
          allKeyCounts={allKeyCounts}
          title={topPanelTitle}
        />
      </section>
    </PageShell>
  );
}
