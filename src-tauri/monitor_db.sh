#!/bin/bash

DB_PATH="$HOME/Library/Application Support/com.snoop.app/snoop.db"

echo "🔄 实时监控数据库（每5秒刷新）"
echo "按 Ctrl+C 退出"
echo ""

while true; do
    clear
    echo "📊 最新3个活动桶"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    sqlite3 "$DB_PATH" <<EOF
.mode column
.headers on
SELECT
    id,
    datetime(bucket_start/1000, 'unixepoch', 'localtime') as time,
    app_name,
    app_bundle_id,
    key_total as keys,
    mouse_left as L,
    mouse_right as R,
    mouse_middle as M,
    mouse_move_dist as move_px,
    scroll_dist as scroll
FROM activity_buckets
ORDER BY id DESC
LIMIT 3;
EOF
    echo ""
    echo "🔑 最新按键明细（如果有的话）"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    sqlite3 "$DB_PATH" <<EOF
.mode column
.headers on
SELECT
    k.bucket_id,
    b.app_name,
    k.key_code,
    k.count
FROM key_details k
JOIN activity_buckets b ON k.bucket_id = b.id
ORDER BY k.id DESC
LIMIT 10;
EOF

    echo ""
    echo "⏰ 更新时间: $(date '+%Y-%m-%d %H:%M:%S')"

    sleep 5
done
