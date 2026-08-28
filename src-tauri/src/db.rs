use rusqlite::{Connection, Result};
use std::path::PathBuf;

/// 「有输入桶」的 SQL 判定式 —— 概览分类占比 / 报告时长共用的单一来源，
/// 保证「有输入」只有一个定义，别再在别处各写一份（那正是分类占比口径分叉的成因）。
///
/// 与 [`crate::report::common::RawBucket::is_active`] 是同一判定的 SQL 版 / Rust 版，
/// 改一边必须同步另一边。`mouse_move_dist` 故意不计：纯位移是连续信号，计入会让
/// 「只晃鼠标不点击」被当成活跃，挂机判定就失效了。
pub(crate) const ACTIVE_PREDICATE: &str = "(key_total > 0 OR mouse_left > 0 OR mouse_right > 0 \
    OR mouse_middle > 0 OR mouse_back > 0 OR mouse_forward > 0 OR scroll_dist > 0)";

pub struct Database {
    conn: Connection,
    db_path: PathBuf,
}

impl Database {
    pub fn new(db_path: PathBuf) -> Result<Self> {
        let conn = Connection::open(&db_path)?;

        // WAL 模式是数据库级持久设置，只需在连接建立时执行一次；
        // 不要放在高频写入路径（如每次写桶）里重复调用。
        conn.pragma_update(None, "journal_mode", "WAL")?;

        Ok(Database { conn, db_path })
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

            -- 未映射按键：翻译不到 W3C code 的平台原始键（媒体键 / Fn / Unknown 等），
            -- 按 raw 值累计计数，供设置页「未识别按键」展示（见 key_code.rs / 采集层）。
            CREATE TABLE IF NOT EXISTS unmapped_keys (
                raw_value TEXT PRIMARY KEY,
                count     INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS heartbeats (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_heartbeat_timestamp
            ON heartbeats(timestamp);

            -- AI 调用审计日志（隐私承诺的兑现方式，也是调试主要手段）
            CREATE TABLE IF NOT EXISTS ai_audit_log (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at_ms     INTEGER NOT NULL,
                feature_id        TEXT NOT NULL,
                tier              TEXT NOT NULL,
                sent              INTEGER NOT NULL,
                request_json      TEXT,
                response_len      INTEGER,
                success           INTEGER NOT NULL,
                error_kind        TEXT,
                prompt_tokens     INTEGER,
                completion_tokens INTEGER,
                total_tokens      INTEGER,
                duration_ms       INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_ai_audit_created
            ON ai_audit_log(created_at_ms);

            -- 应用分类（F4）。只落 manual/ai 两类持久化来源，builtin 由规则表计算。
            -- 优先级 hard 规则 manual > builtin > ai 在 store 层读写两处强制。
            -- category 存的是 categories.id，**不是名称**：名称是可改的显示名，
            -- 改名不该动历史数据。
            CREATE TABLE IF NOT EXISTS app_categories (
                app_id           TEXT PRIMARY KEY,
                category         TEXT NOT NULL,
                source           TEXT NOT NULL,
                confidence       REAL,
                classified_at_ms INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_app_categories_source
            ON app_categories(source);

            -- 一次性迁移/播种的标记位。没有 user_version 机制，用这张表记
            -- 「这批种子灌过了」，避免用户删掉的分类/规则下次启动又长回来。
            CREATE TABLE IF NOT EXISTS app_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- 分类表。分类是**用户可管理的数据**，不再是固定枚举。
            -- id 创建后永不变更，是所有引用（归类、手动覆盖、规则、报告 JSON）的锚点。
            -- 只持久化 hue（OKLCH 色相角）：深浅主题下的 L/C 由主题层各自套用固定值，
            -- 所以切主题分类色自动适配。custom_color 非空时优先，且不再参与主题适配。
            CREATE TABLE IF NOT EXISTS categories (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                description  TEXT NOT NULL DEFAULT '',
                hue          REAL NOT NULL,
                custom_color TEXT,
                is_system    INTEGER NOT NULL DEFAULT 0,
                is_archived  INTEGER NOT NULL DEFAULT 0,
                sort_order   INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_categories_sort
            ON categories(is_archived, sort_order);

            -- 内置规则表。原先是 Rust 静态数组，改成表是因为「永久删除分类」
            -- 要求清掉指向它的规则——静态数组做不到。
            CREATE TABLE IF NOT EXISTS builtin_rules (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                keyword     TEXT NOT NULL,
                category_id TEXT NOT NULL,
                sort_order  INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_builtin_rules_category
            ON builtin_rules(category_id);

            -- 批量 AI 分类的批次快照，供「撤销本次分类」还原。
            -- 只保留最近一个批次：写入新批次或用户手改任一 App 归类时，旧批次即失效。
            CREATE TABLE IF NOT EXISTS classify_batches (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at_ms INTEGER NOT NULL,
                scope         TEXT NOT NULL,
                affected      INTEGER NOT NULL,
                snapshot_json TEXT NOT NULL
            );

            -- 日报存储（批次 4a）。同 (report_date, report_type) 唯一。
            -- status: 'ok'（正常报告）| 'too_little'（记录太少，不调 AI、无叙事）。
            -- snapshot_json: 生成那一刻的分类显示名 / 颜色 / 聚合结果（见 report::snapshot）。
            -- 允许为 NULL，只为兼容加列之前就存在的历史报告——首次打开时补写。
            CREATE TABLE IF NOT EXISTS daily_reports (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                report_date      TEXT NOT NULL,
                report_type      TEXT NOT NULL DEFAULT 'day',
                status           TEXT NOT NULL DEFAULT 'ok',
                generated_at_ms  INTEGER NOT NULL,
                active_ms        INTEGER NOT NULL,
                foreground_ms    INTEGER NOT NULL,
                data_json        TEXT NOT NULL,
                narrative        TEXT,
                narrative_source TEXT,
                snapshot_json    TEXT,
                UNIQUE(report_date, report_type)
            );
            ",
        )?;

        self.migrate_duration_column()?;
        self.migrate_mouse_side_buttons()?;
        self.migrate_snoop_bundle_id()?;
        // 必须在建唯一索引之前跑：存量库里已有重复行，索引创建会因
        // UNIQUE 冲突直接失败，导致老用户升级后启动崩溃。
        self.migrate_dedup_buckets()?;
        self.migrate_unique_index()?;
        self.migrate_category_seed()?;
        self.migrate_report_snapshot()?;
        self.migrate_key_codes()?;
        Ok(())
    }

    /// 把改造前的 11 个固定枚举分类灌进 `categories` 表，并把内置规则从
    /// Rust 静态数组灌进 `builtin_rules` 表。
    ///
    /// **迁移是无损的，且不需要改写任何历史数据**：新分类的 id 直接沿用旧枚举的
    /// snake_case 字符串（`development` / `ai_assistant` / `other` …），所以
    /// `app_categories.category` 里已有的归类结果和手动覆盖天然就指向正确的
    /// 分类 id，一行都不用动。
    ///
    /// 两批种子各自打标记，只灌一次：用户删掉的分类或规则不会下次启动又长回来。
    fn migrate_category_seed(&self) -> Result<()> {
        use crate::app_classify::{builtin, SEED_CATEGORIES};

        let seeded = |key: &str| -> Result<bool> {
            self.conn
                .prepare("SELECT 1 FROM app_meta WHERE key = ?1")?
                .exists([key])
        };
        let mark = |key: &str| -> Result<()> {
            self.conn.execute(
                "INSERT OR REPLACE INTO app_meta (key, value) VALUES (?1, '1')",
                [key],
            )?;
            Ok(())
        };

        if !seeded("categories_seeded")? {
            for (i, c) in SEED_CATEGORIES.iter().enumerate() {
                self.conn.execute(
                    "INSERT OR IGNORE INTO categories
                        (id, name, description, hue, custom_color, is_system, is_archived, sort_order)
                     VALUES (?1, ?2, ?3, ?4, NULL, ?5, 0, ?6)",
                    rusqlite::params![c.id, c.name, c.description, c.hue, c.is_system as i64, i as i64],
                )?;
            }
            mark("categories_seeded")?;
            println!("✓ 已初始化 {} 个内置分类", SEED_CATEGORIES.len());
        }

        if !seeded("builtin_rules_seeded")? {
            for (i, (kw, cat)) in builtin::SEED_RULES.iter().enumerate() {
                self.conn.execute(
                    "INSERT INTO builtin_rules (keyword, category_id, sort_order)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![kw, cat, i as i64],
                )?;
            }
            mark("builtin_rules_seeded")?;
            builtin::invalidate();
            println!("✓ 已初始化 {} 条内置分类规则", builtin::SEED_RULES.len());
        }

        Ok(())
    }

    /// 删除 (bucket_start, app_bundle_id) 完全重复的历史桶，保留 id 较小者
    /// （更早写入的那一行携带 key_details，后写入的重复行没有）。
    fn migrate_dedup_buckets(&self) -> Result<()> {
        let dup_rows: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM activity_buckets a
             WHERE EXISTS (
                 SELECT 1 FROM activity_buckets b
                 WHERE b.bucket_start = a.bucket_start
                   AND b.app_bundle_id = a.app_bundle_id
                   AND b.id < a.id
             )",
            [],
            |row| row.get(0),
        )?;

        if dup_rows == 0 {
            return Ok(());
        }

        // 重复行的 key_details 本就为空（写入时被计数清空），无需额外清理子表，
        // 但以防万一，仍先删子表再删主表。
        self.conn.execute_batch(
            "
            DELETE FROM key_details WHERE bucket_id IN (
                SELECT a.id FROM activity_buckets a
                WHERE EXISTS (
                    SELECT 1 FROM activity_buckets b
                    WHERE b.bucket_start = a.bucket_start
                      AND b.app_bundle_id = a.app_bundle_id
                      AND b.id < a.id
                )
            );
            DELETE FROM activity_buckets WHERE id IN (
                SELECT a.id FROM activity_buckets a
                WHERE EXISTS (
                    SELECT 1 FROM activity_buckets b
                    WHERE b.bucket_start = a.bucket_start
                      AND b.app_bundle_id = a.app_bundle_id
                      AND b.id < a.id
                )
            );
            ",
        )?;

        println!("✓ 清理历史重复桶：{} 行", dup_rows);
        Ok(())
    }

    fn migrate_unique_index(&self) -> Result<()> {
        self.conn.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_bucket_unique
             ON activity_buckets(bucket_start, app_bundle_id);",
        )?;
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

    /// 给存量库的 `daily_reports` 补上 `snapshot_json` 列。
    ///
    /// 不回填内容：历史报告的快照按「首次打开时按当时的分类聚合一次再固化」补
    /// （见 `report::commands::get_report`）。启动时全表回填要为每份历史报告解一遍
    /// 分类，成本压在启动路径上，而绝大多数历史报告用户再也不会打开。
    fn migrate_report_snapshot(&self) -> Result<()> {
        let has_col: bool = self
            .conn
            .prepare("SELECT 1 FROM pragma_table_info('daily_reports') WHERE name='snapshot_json'")?
            .exists([])?;

        if !has_col {
            self.conn
                .execute_batch("ALTER TABLE daily_reports ADD COLUMN snapshot_json TEXT;")?;
            println!("✓ 已添加报告快照字段 snapshot_json");
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

    /// 按键身份迁移：把历史 `key_details.key_code` 从旧印字/rdev Debug 名统一成 W3C `code`。
    ///
    /// 旧采集层写的是 `format!("{:?}", key)`（rdev Debug 名，如 "Num1" / "Dot" / "ShiftLeft"），
    /// 新采集层写 W3C `code`（"Digit1" / "Period" / "ShiftLeft"）。两套都能落到同一张
    /// `translate_debug_name` 表：恒等映射（"KeyA"→"KeyA"、"ShiftLeft"→"ShiftLeft"）不动，
    /// 需要改名的（"Num1"→"Digit1"、"Dot"→"Period"、"Kp1"→"Numpad1" …）直接 UPDATE。
    ///
    /// 翻译失败（媒体键 / Fn / Unknown 等旧记录，它们本不该出现在配列里）不静默丢弃，
    /// 而是按 raw 值合计归入 `unmapped_keys`，再从 key_details 删除，见【四】未映射兜底。
    ///
    /// 迁移不可逆：动手前先 `VACUUM INTO` 出一份 `.bak` 快照（同级目录）供用户回滚，
    /// 再以标记位 `key_codes_migrated` 保证只跑一次。整个 UPDATE/DELETE 包在一个事务里，
    /// 中途失败整体回滚、不落标记，下次启动重跑。
    fn migrate_key_codes(&self) -> Result<()> {
        use crate::key_code::translate_debug_name;

        let migrated: bool = self
            .conn
            .prepare("SELECT 1 FROM app_meta WHERE key = 'key_codes_migrated'")?
            .exists([])?;
        if migrated {
            return Ok(());
        }

        // 备份：先快照，再做不可逆改写。失败只告警不阻断（宁可无备份也要继续迁移，
        // 否则老库永远停在旧身份、输入页对不上配列）。
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let stem = self
            .db_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "snoop".to_string());
        let backup = self
            .db_path
            .with_file_name(format!("{stem}.pre-keycodes-{ts}.bak"));
        let backup_sql = backup.to_string_lossy().replace('\'', "''");
        if let Err(e) = self
            .conn
            .execute_batch(&format!("VACUUM INTO '{backup_sql}';"))
        {
            eprintln!("⚠️ 按键身份迁移前备份失败（继续迁移）：{e}");
        }

        let codes: Vec<String> = {
            let mut stmt = self
                .conn
                .prepare("SELECT DISTINCT key_code FROM key_details")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let mut renamed = 0usize;
        let mut collected = 0usize;
        self.conn.execute_batch("BEGIN;")?;
        let result = (|| -> Result<()> {
            for code in &codes {
                match translate_debug_name(code.as_str()) {
                    Some(new_code) if new_code != code.as_str() => {
                        self.conn.execute(
                            "UPDATE key_details SET key_code = ?1 WHERE key_code = ?2",
                            rusqlite::params![new_code, code.as_str()],
                        )?;
                        renamed += 1;
                    }
                    Some(_) => {} // 恒等映射，已是新 code，无需动
                    None => {
                        let total: i64 = self.conn.query_row(
                            "SELECT COALESCE(SUM(count), 0) FROM key_details WHERE key_code = ?1",
                            [code.as_str()],
                            |row| row.get(0),
                        )?;
                        self.conn.execute(
                            "INSERT INTO unmapped_keys (raw_value, count) VALUES (?1, ?2)
                             ON CONFLICT(raw_value) DO UPDATE SET count = count + excluded.count",
                            rusqlite::params![code.as_str(), total],
                        )?;
                        self.conn
                            .execute("DELETE FROM key_details WHERE key_code = ?1", [code.as_str()])?;
                        collected += 1;
                    }
                }
            }
            self.conn.execute(
                "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('key_codes_migrated', '1')",
                [],
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => self.conn.execute_batch("COMMIT;")?,
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                return Err(e);
            }
        }

        println!(
            "✓ 按键身份迁移完成：重命名 {} 个，归入未映射 {} 个（备份：{}）",
            renamed,
            collected,
            backup.display()
        );
        Ok(())
    }

}
