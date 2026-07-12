/**
 * 分析层派生类型。
 * data 层负责"从数据库拿到的形状"；analytics 层负责"页面愿意直接吃的形状"。
 * 两层通过这些类型解耦。
 */

/** 与页面样式变量 --intensity-0..4 一一对应的强度档位。 */
export type Intensity = 0 | 1 | 2 | 3 | 4;

/**
 * 一次"会话" —— 连续同一 App 的桶被合并后的产物。
 * 端点用 UTC ms；页面显示时按本地时区格式化。
 */
export type Session = {
  /** 起始时刻（首个桶的 bucket_start） */
  start_ms: number;
  /** 结束时刻（末桶 bucket_start + duration_ms） */
  end_ms: number;
  app_name: string;
  app_bundle_id: string;
  /** 会话总时长（ms），= sum(duration_ms) */
  duration_ms: number;
  /** 会话内的总按键 & 总鼠标事件 */
  key_total: number;
  mouse_total: number;
  /** 平均强度档，按每分钟键鼠总数分档 */
  intensity: Intensity;
  /** 会话里被合并的桶数量，方便调试 */
  bucket_count: number;
  /**
   * 若这段"看起来是分心/瞟一眼"，标记一下。
   * `glance` = 时长过短的独立小会话；
   * `distraction` = 短时间内 App 频繁横跳被打包起来的一段。
   */
  kind?: "glance" | "distraction";
};

/** 按键区域分类。KEY_REGIONS 里定义具体归属。 */
export type KeyRegion =
  | "wasd"
  | "letter"
  | "number"
  | "editing"
  | "modifier"
  | "space_enter"
  | "punctuation"
  | "other";

/** 每个区域的按压统计。 */
export type KeyRegionStat = {
  region: KeyRegion;
  count: number;
  /** 该区域内按压最多的前几个 key_code（含次数），供 UI 展示 */
  top: { key_code: string; count: number }[];
};

/** 按小时聚合的活跃指标。 */
export type HourStat = {
  /** 本地时区的小时 0..23 */
  hour: number;
  /** 期间内该小时出现过的所有日期数（用于求每小时平均） */
  day_count: number;
  key_total: number;
  mouse_total: number;
  /** 该小时平均强度档 */
  intensity: Intensity;
};

/** 一周 × 24 小时的强度网格。行是周一..周日，列是 0..23。 */
export type WeekHourGrid = Intensity[][];

/** 按天聚合的活跃指标。 */
export type DayStat = {
  /** 本地时区的日期 00:00 UTC ms */
  day_ms: number;
  /** 0=周一 … 6=周日 */
  day_of_week: number;
  /** 该天总活跃时长（ms） */
  active_ms: number;
  key_total: number;
  mouse_total: number;
};

/** 按 App 聚合的时长与强度。 */
export type AppStat = {
  app_bundle_id: string;
  app_name: string;
  duration_ms: number;
  key_total: number;
  mouse_total: number;
  intensity: Intensity;
  /** 该 App 桶数量，等价于总秒数 / 5 的粗略估计 */
  bucket_count: number;
};
