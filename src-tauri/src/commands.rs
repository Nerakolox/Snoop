use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

pub struct DbPath(pub PathBuf);

#[derive(Serialize)]
pub struct Bucket {
    pub id: i64,
    pub bucket_start: i64,
    pub duration_ms: i64,
    pub app_name: String,
    pub app_bundle_id: String,
    pub key_total: i64,
    pub mouse_left: i64,
    pub mouse_right: i64,
    pub mouse_middle: i64,
    pub mouse_back: i64,
    pub mouse_forward: i64,
    pub mouse_move_dist: i64,
    pub scroll_dist: i64,
}

#[derive(Serialize)]
pub struct KeyDetail {
    pub key_code: String,
    pub count: i64,
}

#[derive(Serialize)]
pub struct AppRank {
    pub app_bundle_id: String,
    pub app_name: String,
    pub bucket_count: i64,
    pub total_sec: i64,
}

/// 一小时的聚合活跃度。
/// hour_start 已按 **本地时区** 对齐到整点（ms 时间戳），
/// 前端拿去分派到 (day-of-week, hour-of-day) 网格即可。
#[derive(Serialize)]
pub struct HourBucket {
    pub hour_start: i64,
    pub key_total: i64,
    pub mouse_clicks: i64,
    pub mouse_move_dist: i64,
    pub scroll_dist: i64,
    pub duration_ms: i64,
}

fn open(state: &State<'_, DbPath>) -> Result<Connection, String> {
    Connection::open(&state.0).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_buckets(state: State<'_, DbPath>) -> Result<Vec<Bucket>, String> {
    let conn = open(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, bucket_start, duration_ms, app_name, app_bundle_id,
                    key_total, mouse_left, mouse_right, mouse_middle,
                    mouse_back, mouse_forward,
                    mouse_move_dist, scroll_dist
             FROM activity_buckets
             ORDER BY bucket_start DESC
             LIMIT 1000",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Bucket {
                id: row.get(0)?,
                bucket_start: row.get(1)?,
                duration_ms: row.get(2)?,
                app_name: row.get(3)?,
                app_bundle_id: row.get(4)?,
                key_total: row.get(5)?,
                mouse_left: row.get(6)?,
                mouse_right: row.get(7)?,
                mouse_middle: row.get(8)?,
                mouse_back: row.get(9)?,
                mouse_forward: row.get(10)?,
                mouse_move_dist: row.get(11)?,
                scroll_dist: row.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_key_details(
    state: State<'_, DbPath>,
    bucket_id: i64,
) -> Result<Vec<KeyDetail>, String> {
    let conn = open(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT key_code, count FROM key_details
             WHERE bucket_id = ?1
             ORDER BY count DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([bucket_id], |row| {
            Ok(KeyDetail {
                key_code: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_today_key_total(state: State<'_, DbPath>) -> Result<i64, String> {
    let conn = open(&state)?;
    let total: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(key_total), 0) FROM activity_buckets
             WHERE date(bucket_start/1000, 'unixepoch', 'localtime')
                 = date('now', 'localtime')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(total)
}

/// 范围内的原始桶（按时间正序，方便前端做会话合并）。
#[tauri::command]
pub fn get_buckets_in_range(
    state: State<'_, DbPath>,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<Bucket>, String> {
    let conn = open(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, bucket_start, duration_ms, app_name, app_bundle_id,
                    key_total, mouse_left, mouse_right, mouse_middle,
                    mouse_back, mouse_forward,
                    mouse_move_dist, scroll_dist
             FROM activity_buckets
             WHERE bucket_start >= ?1 AND bucket_start < ?2
             ORDER BY bucket_start ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([start_ms, end_ms], |row| {
            Ok(Bucket {
                id: row.get(0)?,
                bucket_start: row.get(1)?,
                duration_ms: row.get(2)?,
                app_name: row.get(3)?,
                app_bundle_id: row.get(4)?,
                key_total: row.get(5)?,
                mouse_left: row.get(6)?,
                mouse_right: row.get(7)?,
                mouse_middle: row.get(8)?,
                mouse_back: row.get(9)?,
                mouse_forward: row.get(10)?,
                mouse_move_dist: row.get(11)?,
                scroll_dist: row.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 范围内 key_details 的 SUM(count) by key_code，直接返回聚合结果。
/// 前端不用再自己 join 桶了。
#[tauri::command]
pub fn get_key_details_in_range(
    state: State<'_, DbPath>,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<KeyDetail>, String> {
    let conn = open(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT kd.key_code, SUM(kd.count) AS c
             FROM key_details kd
             JOIN activity_buckets ab ON ab.id = kd.bucket_id
             WHERE ab.bucket_start >= ?1 AND ab.bucket_start < ?2
             GROUP BY kd.key_code
             ORDER BY c DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([start_ms, end_ms], |row| {
            Ok(KeyDetail {
                key_code: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 范围内按 app_bundle_id 聚合的时长与桶数。
#[tauri::command]
pub fn get_app_ranking_in_range(
    state: State<'_, DbPath>,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<AppRank>, String> {
    let conn = open(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT app_bundle_id,
                    MAX(app_name) AS app_name,
                    COUNT(*) AS bucket_count,
                    COALESCE(SUM(duration_ms), 0) / 1000 AS total_sec
             FROM activity_buckets
             WHERE bucket_start >= ?1 AND bucket_start < ?2
             GROUP BY app_bundle_id
             ORDER BY total_sec DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([start_ms, end_ms], |row| {
            Ok(AppRank {
                app_bundle_id: row.get(0)?,
                app_name: row.get(1)?,
                bucket_count: row.get(2)?,
                total_sec: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 范围内按 **本地时区整点** 聚合的活跃度：每小时一行，含键鼠总量与总时长。
/// hour_start 是该整点的 UTC ms 时间戳（`strftime('%s', ..., 'localtime') * 1000` 拿到的
/// 是本地墙钟对应的秒数；前端 `new Date(hour_start).getHours()` 可直接得到本地小时）。
#[tauri::command]
pub fn get_hourly_activity(
    state: State<'_, DbPath>,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<HourBucket>, String> {
    let conn = open(&state)?;
    // 分档过程：
    //   1) bucket_start/1000 → UTC 秒 → `datetime(..., 'unixepoch', 'localtime')` 得到本地时间字符串
    //   2) 用 `strftime('%Y-%m-%d %H:00:00', ...)` 把它截到整点，仍是"本地字符串"
    //   3) `strftime('%s', 那串, 'utc')` 把这个"本地字符串"当本地时间转回 UTC 秒
    //   4) *1000 → UTC ms。前端 `new Date(hour_start).getHours()` 直接是本地小时。
    let mut stmt = conn
        .prepare(
            "SELECT
                CAST(strftime('%s',
                    strftime('%Y-%m-%d %H:00:00',
                        datetime(bucket_start/1000, 'unixepoch', 'localtime')),
                    'utc') AS INTEGER) * 1000 AS hour_start,
                COALESCE(SUM(key_total), 0),
                COALESCE(SUM(mouse_left + mouse_right + mouse_middle), 0),
                COALESCE(SUM(mouse_move_dist), 0),
                COALESCE(SUM(scroll_dist), 0),
                COALESCE(SUM(duration_ms), 0)
             FROM activity_buckets
             WHERE bucket_start >= ?1 AND bucket_start < ?2
             GROUP BY hour_start
             ORDER BY hour_start ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([start_ms, end_ms], |row| {
            Ok(HourBucket {
                hour_start: row.get(0)?,
                key_total: row.get(1)?,
                mouse_clicks: row.get(2)?,
                mouse_move_dist: row.get(3)?,
                scroll_dist: row.get(4)?,
                duration_ms: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// ─── Settings commands ────────────────────────────────────────────────────────

use crate::settings::{Settings, SettingsState};

#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> Settings {
    state.get()
}

#[tauri::command]
pub fn save_settings(state: State<'_, SettingsState>, settings: Settings) {
    state.apply(&settings);
}

// ─── DB info / export / clear ─────────────────────────────────────────────────

#[derive(Serialize)]
pub struct DbInfo {
    pub path: String,
    pub size_bytes: u64,
}

#[tauri::command]
pub fn get_db_info(state: State<'_, DbPath>) -> DbInfo {
    let path = state.0.to_string_lossy().to_string();
    let size_bytes = std::fs::metadata(&state.0).map(|m| m.len()).unwrap_or(0);
    DbInfo { path, size_bytes }
}

#[derive(serde::Deserialize)]
pub struct ClearRange {
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
}

#[tauri::command]
pub fn clear_data(state: State<'_, DbPath>, range: ClearRange) -> Result<u64, String> {
    let conn = Connection::open(&state.0).map_err(|e| e.to_string())?;
    let affected = match (range.start_ms, range.end_ms) {
        (Some(s), Some(e)) => {
            conn.execute(
                "DELETE FROM key_details WHERE bucket_id IN (SELECT id FROM activity_buckets WHERE bucket_start >= ?1 AND bucket_start < ?2)",
                rusqlite::params![s, e],
            ).map_err(|e| e.to_string())?;
            conn.execute(
                "DELETE FROM activity_buckets WHERE bucket_start >= ?1 AND bucket_start < ?2",
                rusqlite::params![s, e],
            ).map_err(|e| e.to_string())?
        }
        _ => {
            conn.execute("DELETE FROM key_details", []).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM activity_buckets", []).map_err(|e| e.to_string())?
        }
    };
    Ok(affected as u64)
}

#[derive(Serialize)]
pub struct ExportRow {
    pub bucket_start: i64,
    pub duration_ms: i64,
    pub app_name: String,
    pub app_bundle_id: String,
    pub key_total: i64,
    pub mouse_left: i64,
    pub mouse_right: i64,
    pub mouse_move_dist: i64,
    pub scroll_dist: i64,
}

#[tauri::command]
pub fn export_data(
    state: State<'_, DbPath>,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
) -> Result<Vec<ExportRow>, String> {
    let conn = Connection::open(&state.0).map_err(|e| e.to_string())?;
    let base = "SELECT bucket_start,duration_ms,app_name,app_bundle_id,key_total,mouse_left,mouse_right,mouse_move_dist,scroll_dist FROM activity_buckets";
    match (start_ms, end_ms) {
        (Some(s), Some(e)) => {
            let sql = format!("{} WHERE bucket_start>=?1 AND bucket_start<?2 ORDER BY bucket_start", base);
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt.query_map(rusqlite::params![s, e], |r| Ok(ExportRow {
                bucket_start: r.get(0)?, duration_ms: r.get(1)?,
                app_name: r.get(2)?, app_bundle_id: r.get(3)?,
                key_total: r.get(4)?, mouse_left: r.get(5)?,
                mouse_right: r.get(6)?, mouse_move_dist: r.get(7)?,
                scroll_dist: r.get(8)?,
            })).map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        }
        _ => {
            let sql = format!("{} ORDER BY bucket_start", base);
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |r| Ok(ExportRow {
                bucket_start: r.get(0)?, duration_ms: r.get(1)?,
                app_name: r.get(2)?, app_bundle_id: r.get(3)?,
                key_total: r.get(4)?, mouse_left: r.get(5)?,
                mouse_right: r.get(6)?, mouse_move_dist: r.get(7)?,
                scroll_dist: r.get(8)?,
            })).map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
pub fn get_recent_apps(state: State<'_, DbPath>) -> Result<Vec<String>, String> {
    let conn = Connection::open(&state.0).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT DISTINCT app_bundle_id FROM activity_buckets ORDER BY bucket_start DESC LIMIT 50"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_app_ranking(state: State<'_, DbPath>) -> Result<Vec<AppRank>, String> {
    let conn = open(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT app_bundle_id,
                    MAX(app_name) AS app_name,
                    COUNT(*) AS bucket_count,
                    COALESCE(SUM(duration_ms), 0) / 1000 AS total_sec
             FROM activity_buckets
             GROUP BY app_bundle_id
             ORDER BY bucket_count DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(AppRank {
                app_bundle_id: row.get(0)?,
                app_name: row.get(1)?,
                bucket_count: row.get(2)?,
                total_sec: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}


#[tauri::command]
pub fn get_app_icon(
    bundle_id: String,
    cache: State<'_, crate::icon_cache::IconCache>,
) -> Result<Option<String>, String> {
    Ok(cache.get_icon(&bundle_id))
}
