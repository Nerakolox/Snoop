# Snoop - 活动追踪系统

## ✅ 已完成功能

### 核心逻辑
- **5秒聚合桶**：每5秒为一个时间桶，桶结束时写入数据库
- **前台应用追踪**：记录桶开始时的前台应用名称和 Bundle ID
- **键鼠统计**：实时统计键盘按键、鼠标点击、移动距离、滚轮量
- **批量事务写入**：一个桶的主表行 + N条明细行在一个事务中提交

### 数据库结构

#### activity_buckets (主表)
```sql
CREATE TABLE activity_buckets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket_start    INTEGER NOT NULL,      -- 桶开始的毫秒时间戳
    duration_sec    INTEGER NOT NULL,      -- 固定为 5
    app_name        TEXT NOT NULL,         -- 前台应用名称
    app_bundle_id   TEXT NOT NULL,         -- Bundle ID
    key_total       INTEGER NOT NULL,      -- 所有键次数之和
    mouse_left      INTEGER NOT NULL,      -- 左键点击次数
    mouse_right     INTEGER NOT NULL,      -- 右键点击次数
    mouse_middle    INTEGER NOT NULL,      -- 中键点击次数
    mouse_move_dist INTEGER NOT NULL,      -- 鼠标移动距离（像素）
    scroll_dist     INTEGER NOT NULL       -- 滚轮滚动量
);
```

#### key_details (明细表)
```sql
CREATE TABLE key_details (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket_id INTEGER NOT NULL,            -- 外键关联到 activity_buckets.id
    key_code  TEXT NOT NULL,               -- 按键代码（如 "KeyW", "Space"）
    count     INTEGER NOT NULL,            -- 该键在这个桶内的按压次数
    FOREIGN KEY(bucket_id) REFERENCES activity_buckets(id)
);
```

### 数据流

```
1. [桶开始] 记录当前前台应用 + 清空计数器
   ↓
2. [5秒内] rdev 监听键鼠事件 → 更新内存计数器
   ↓
3. [桶结束] 读取内存快照
   ↓
4. [写数据库 - 事务开始]
   - INSERT activity_buckets (获取 bucket_id)
   - 批量 INSERT key_details (关联 bucket_id)
   [事务提交]
   ↓
5. 清空内存计数器，进入下一个桶
```

## 📊 验证方法

### 1. 查看最新桶
```bash
./verify_db.sh
```

### 2. 实时监控（每5秒刷新）
```bash
chmod +x ./monitor_db.sh
./monitor_db.sh
```

### 3. 手动查询
```bash
sqlite3 ~/Library/Application\ Support/com.snoop.app/snoop.db
```

```sql
-- 查看最近10个桶
SELECT 
    id,
    datetime(bucket_start/1000, 'unixepoch', 'localtime') as time,
    app_name,
    key_total,
    mouse_left + mouse_right + mouse_middle as clicks
FROM activity_buckets 
ORDER BY id DESC 
LIMIT 10;

-- 查看某个桶的按键明细
SELECT key_code, count 
FROM key_details 
WHERE bucket_id = 12;

-- 验证 key_total 一致性
SELECT 
    b.id,
    b.key_total as declared,
    SUM(k.count) as actual
FROM activity_buckets b
LEFT JOIN key_details k ON b.id = k.bucket_id
GROUP BY b.id
HAVING b.key_total > 0
LIMIT 5;
```

## ⚠️ 重要说明

### macOS 权限要求
rdev 需要 **辅助功能权限** 才能捕获键鼠事件：

1. 打开 **系统设置** → **隐私与安全性** → **辅助功能**
2. 添加 Terminal.app（如果从命令行运行）
3. 或添加 Snoop.app（如果打包后运行）
4. 重启应用

**未授权时的表现**：
- 前台应用追踪正常工作 ✓
- 键鼠计数全为 0（因为 rdev 无法监听事件）

### 验收标准 ✓

- [x] 每 5 秒稳定写入一行 activity_buckets
- [x] app_name 和 app_bundle_id 准确反映桶开始时的前台应用
- [x] key_total = SUM(key_details.count) 数值一致
- [x] key_details 包含每个键的具体按压次数
- [x] 批量事务提交（一个桶的所有数据在一个事务内）

## 🚀 运行应用

```bash
cd src-tauri
cargo run
```

应用会在系统托盘显示图标，每5秒控制台输出一行桶写入日志：
```
✓ 写入桶: Google Chrome | com.google.Chrome | 键:15 鼠:3/0/0 移:1234px 滚:567
```

## 📁 文件结构

```
src-tauri/src/
├── activity_tracker.rs  # 核心：5秒桶 + 键鼠监听 + 前台应用 + 数据库写入
├── db.rs               # 数据库初始化和测试数据
├── lib.rs              # Tauri 应用入口，启动 activity_tracker
└── main.rs             # 程序入口

工具脚本：
├── verify_db.sh        # 一次性验证数据库内容
└── monitor_db.sh       # 实时监控数据库（每5秒刷新）
```

## 🔧 技术栈

- **Tauri** - 跨平台桌面应用框架
- **rdev** - 全局键鼠事件监听
- **cocoa/objc** - macOS 前台应用 API (NSWorkspace)
- **rusqlite** - SQLite 数据库
- **Rust std::sync** - 线程安全的共享状态

## 📝 下一步扩展方向

1. **权限检测**：启动时检测辅助功能权限，提示用户授权
2. **数据聚合**：按小时/天/周统计各应用使用时长
3. **可视化面板**：Web UI 展示活动热力图、按键分布
4. **窗口标题追踪**：记录浏览器标签/文档标题（更细粒度）
5. **导出功能**：CSV/JSON 格式导出数据
