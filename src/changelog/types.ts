// 更新日志的对外契约，与云端 `changelog.json` 一一对应。
//
// 这份数据是**手写**的，不是从 git 自动生成的：commit message 写给自己看，
// 更新日志写给用户看。所以字段刻意少，作者每次发版只需要往 releases 前面
// 追加一个对象。
//
// 渲染层只认这里声明的字段，文件里多出来的键一律忽略（见 source.ts 的解析），
// 老客户端读到新字段不会炸——这也是 schema 字段存在的原因。

/** 条目类型。决定卡片左侧小标签的文案，不参与任何数据统计。 */
export type ChangeKind = "feat" | "fix" | "improve" | "breaking" | "other";

export interface ChangeNote {
  /** 未知值由解析层归到 other，不会让整条记录失效。 */
  kind: ChangeKind;
  /** 一句话说清改了什么，面向用户。别写成 commit message。 */
  text: string;
  /** 可选补充，渲染成第二行小字；讲取舍、讲影响范围，不讲实现。 */
  detail?: string;
}

export interface ChangelogLink {
  label: string;
  url: string;
}

export interface Release {
  /** 纯语义化版本号，不带 v，如 "0.2.2"。与 package.json 一致。 */
  version: string;
  /** 发布日期，YYYY-MM-DD。 */
  date: string;
  /** 一句话主题，可选。有它这张卡片才有一行「标题」，没有就直接列条目。 */
  tagline?: string;
  notes: ChangeNote[];
  links?: ChangelogLink[];
}

export interface ChangelogFile {
  /** 结构版本号，目前恒为 1。加破坏性字段前先升它。 */
  schema: number;
  /** 内容最后编辑时间，ISO 8601。展示为「更新于 X」。 */
  updated_at?: string;
  /** 顺序无所谓，解析层会按版本号倒序排。 */
  releases: Release[];
}
