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
                mouse_move_dist: row.get(9)?,
                scroll_dist: row.get(10)?,
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
