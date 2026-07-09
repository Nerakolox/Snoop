#!/bin/bash

DB_PATH="$HOME/Library/Application Support/com.snoop.app/snoop.db"

echo "📊 数据库验证报告"
echo "===================="
echo ""

echo "1️⃣ 活动桶总数:"
sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM activity_buckets;"
echo ""

echo "2️⃣ 最近10个桶（含时间戳）:"
sqlite3 "$DB_PATH" <<EOF
.mode column
.headers on
SELECT
    id,
    datetime(bucket_start/1000, 'unixepoch', 'localtime') as time,
    duration_ms as dur_ms,
    app_name,
    key_total as keys,
    mouse_left + mouse_right + mouse_middle as clicks,
    mouse_move_dist as move,
    scroll_dist as scroll
FROM activity_buckets
ORDER BY id DESC
LIMIT 10;
EOF
echo ""

echo "3️⃣ 按键明细总数:"
sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM key_details;"
echo ""

echo "4️⃣ 示例：某个桶的按键明细（来自测试数据）:"
sqlite3 "$DB_PATH" <<EOF
.mode column
.headers on
SELECT
    b.id as bucket_id,
    b.app_name,
    b.key_total,
    k.key_code,
    k.count
FROM activity_buckets b
LEFT JOIN key_details k ON b.id = k.bucket_id
WHERE b.key_total > 0
LIMIT 10;
EOF
echo ""

echo "5️⃣ 验证：key_total = SUM(key_details.count)"
sqlite3 "$DB_PATH" <<EOF
SELECT
    b.id,
    b.app_name,
    b.key_total as declared_total,
    COALESCE(SUM(k.count), 0) as actual_sum,
    CASE
        WHEN b.key_total = COALESCE(SUM(k.count), 0) THEN '✓ 一致'
        ELSE '✗ 不一致'
    END as status
FROM activity_buckets b
LEFT JOIN key_details k ON b.id = k.bucket_id
WHERE b.key_total > 0
GROUP BY b.id
LIMIT 5;
EOF
echo ""

echo "✅ 验证完成"
