/**
 * 数据层原始类型 —— 与 Rust `commands.rs` 中 `#[derive(Serialize)]` 结构体一一对应。
 * 命名沿用 snake_case 以对齐序列化字段，避免中间层做键名转换。
 * 这里只放"贴近数据库"的形状；派生结构（会话、区域统计等）在 analytics 层定义。
 */

/** 一个 5 秒（或提前结算的）活动桶。 */
export type RawBucket = {
  id: number;
  /** 桶开始时刻，UTC ms 时间戳 */
  bucket_start: number;
  /** 桶实际时长（ms），可能小于 5000（App 切换提前结算） */
  duration_ms: number;
  app_name: string;
  app_bundle_id: string;
  key_total: number;
  mouse_left: number;
  mouse_right: number;
  mouse_middle: number;
  mouse_back: number;
  mouse_forward: number;
  /** 鼠标移动距离，累加 |dx|+|dy|（px） */
  mouse_move_dist: number;
  /** 滚轮增量累加 */
  scroll_dist: number;
};

/** 单个 key_code 的按压次数。范围查询时是 SUM 聚合后的数。 */
export type RawKeyDetail = {
  key_code: string;
  count: number;
};

/** 按 app_bundle_id 聚合的时长排行。 */
export type RawAppRank = {
  app_bundle_id: string;
  app_name: string;
  bucket_count: number;
  /** 该 App 桶时长之和（秒） */
  total_sec: number;
};

/**
 * 按 **本地时区整点** 聚合的活跃度。
 * `hour_start` 是该整点的 UTC ms 时间戳，前端 `new Date(hour_start).getHours()`
 * 得到的就是本地小时（0..23）。
 */
export type RawHourBucket = {
  hour_start: number;
  key_total: number;
  mouse_clicks: number;
  mouse_move_dist: number;
  scroll_dist: number;
  duration_ms: number;
};

/** 一个闭右开的时间窗 [start_ms, end_ms)。 */
export type TimeRange = {
  start_ms: number;
  end_ms: number;
};
