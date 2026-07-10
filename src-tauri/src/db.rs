use rusqlite::{Connection, Result};
use std::path::PathBuf;

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new(db_path: PathBuf) -> Result<Self> {
        let conn = Connection::open(db_path)?;
        Ok(Database { conn })
    }

    pub fn init_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS activity_buckets (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                bucket_start    INTEGER NOT NULL,
                duration_ms     INTEGER NOT NULL,
                app_name        TEXT NOT NULL,
                app_bundle_id   TEXT NOT NULL,
                key_total       INTEGER NOT NULL,
                mouse_left      INTEGER NOT NULL,
                mouse_right     INTEGER NOT NULL,
                mouse_middle    INTEGER NOT NULL,
                mouse_move_dist INTEGER NOT NULL,
                scroll_dist     INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_bucket_start
            ON activity_buckets(bucket_start);

            CREATE TABLE IF NOT EXISTS key_details (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                bucket_id INTEGER NOT NULL,
                key_code  TEXT NOT NULL,
                count     INTEGER NOT NULL,
                FOREIGN KEY(bucket_id) REFERENCES activity_buckets(id)
            );

            CREATE INDEX IF NOT EXISTS idx_bucket_id
            ON key_details(bucket_id);
            ",
        )?;

        self.migrate_duration_column()?;
        Ok(())
    }

    fn migrate_duration_column(&self) -> Result<()> {
        let has_duration_sec: bool = self
            .conn
            .prepare("SELECT 1 FROM pragma_table_info('activity_buckets') WHERE name='duration_sec'")?
            .exists([])?;

        if has_duration_sec {
            self.conn.execute_batch(
                "
                ALTER TABLE activity_buckets RENAME COLUMN duration_sec TO duration_ms;
                UPDATE activity_buckets SET duration_ms = duration_ms * 1000;
                ",
            )?;
            println!("✓ 已迁移 duration_sec -> duration_ms");
        }
        Ok(())
    }

    pub fn insert_test_data(&self) -> Result<()> {
        let existing: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM activity_buckets",
            [],
            |row| row.get(0),
        )?;
        if existing > 0 {
            return Ok(());
        }

        let now_millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        self.conn.execute(
            "INSERT INTO activity_buckets
            (bucket_start, duration_ms, app_name, app_bundle_id,
             key_total, mouse_left, mouse_right, mouse_middle,
             mouse_move_dist, scroll_dist)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                now_millis,
                5000,
                "测试应用",
                "com.example.test",
                42,
                10,
                2,
                1,
                1500,
                800
            ],
        )?;

        let bucket_id = self.conn.last_insert_rowid();

        self.conn.execute(
            "INSERT INTO key_details (bucket_id, key_code, count) VALUES (?1, ?2, ?3)",
            rusqlite::params![bucket_id, "KeyW", 15],
        )?;

        self.conn.execute(
            "INSERT INTO key_details (bucket_id, key_code, count) VALUES (?1, ?2, ?3)",
            rusqlite::params![bucket_id, "Space", 8],
        )?;

        self.conn.execute(
            "INSERT INTO key_details (bucket_id, key_code, count) VALUES (?1, ?2, ?3)",
            rusqlite::params![bucket_id, "Enter", 3],
        )?;

        Ok(())
    }

    pub fn verify_test_data(&self) -> Result<()> {
        let mut stmt = self.conn.prepare(
            "SELECT id, app_name, key_total FROM activity_buckets ORDER BY id DESC LIMIT 1"
        )?;

        let bucket = match stmt.query_row([], |row| {
            let id: i64 = row.get(0)?;
            let app_name: String = row.get(1)?;
            let key_total: i64 = row.get(2)?;
            Ok((id, app_name, key_total))
        }) {
            Ok(b) => b,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                println!("- 数据库为空，跳过验证");
                return Ok(());
            }
            Err(e) => return Err(e),
        };

        println!("✓ 读取到 bucket: id={}, app_name={}, key_total={}",
                 bucket.0, bucket.1, bucket.2);

        let mut stmt = self.conn.prepare(
            "SELECT key_code, count FROM key_details WHERE bucket_id = ?1"
        )?;

        let keys: Vec<(String, i64)> = stmt
            .query_map([bucket.0], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<Result<Vec<_>>>()?;

        println!("✓ 读取到 {} 个按键记录:", keys.len());
        for (key_code, count) in keys {
            println!("  - {}: {} 次", key_code, count);
        }

        Ok(())
    }
}
