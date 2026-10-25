/**
 * 版本号比较。只做更新日志需要的那点事：判断「比当前版本新/旧/相同」。
 *
 * 不引入 semver 包（项目约定不新增依赖），也不处理完整语义化规范里的
 * 预发布优先级。这里只取数字段逐个比，`0.2.2` 与 `v0.2.2` 视为相同，
 * `0.2.2-beta.1` 与 `0.2.2` 也视为相同——更新日志的条目本来就是按正式版写的。
 */

/** 抽出数字段。非法输入返回空数组，比较时两侧都空即判定相等。 */
export function parseVersion(v: string): number[] {
  const m = /^\s*v?(\d+(?:\.\d+)*)/i.exec(v);
  if (!m) return [];
  return m[1].split(".").map(Number);
}

/** a > b 返回正数，a < b 返回负数，相等或无法比较返回 0。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa.length === 0 || pb.length === 0) return 0;
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
