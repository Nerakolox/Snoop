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
                mouse_back      INTEGER NOT NULL DEFAULT 0,
                mouse_forward   INTEGER NOT NULL DEFAULT 0,
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
        self.migrate_mouse_side_buttons()?;
        self.migrate_snoop_bundle_id()?;
        Ok(())
    }

    fn migrate_snoop_bundle_id(&self) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE activity_buckets
             SET app_name = 'Snoop', app_bundle_id = 'org.feedra.snoop'
             WHERE app_bundle_id = 'com.snoop.app'
                OR (app_bundle_id = 'org.feedra.snoop' AND app_name != 'Snoop')",
            [],
        )?;
        if changed > 0 {
            println!("✓ 迁移 Snoop 自身记录到 org.feedra.snoop / 'Snoop'：{} 行", changed);
        }
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

    fn migrate_mouse_side_buttons(&self) -> Result<()> {
        let has_mouse_back: bool = self
            .conn
            .prepare("SELECT 1 FROM pragma_table_info('activity_buckets') WHERE name='mouse_back'")?
            .exists([])?;

        if !has_mouse_back {
            self.conn.execute_batch(
                "
                ALTER TABLE activity_buckets ADD COLUMN mouse_back INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE activity_buckets ADD COLUMN mouse_forward INTEGER NOT NULL DEFAULT 0;
                ",
            )?;
            println!("✓ 已添加鼠标侧键字段 mouse_back, mouse_forward");
        }
        Ok(())
    }

}
