/**
 * 当前运行的版本号。权威来源是后端 `get_app_version`（读 `CARGO_PKG_VERSION`），
 * 不是 package.json —— 打包后前端那份只是构建时烧进去的字符串，发版若漏改某一处，
 * 两边会不一致。以 Rust 侧为准，那里也是自更新比较的同一份数字。
 *
 * 模块级缓存：设置页和更新日志弹窗都要用，不该各 invoke 一次。
 */

import { invoke } from "@tauri-apps/api/core";

let cache: string | null = null;
let inflight: Promise<string> | null = null;

/** 读版本号；失败返回空串（调用方按「未知」处理，不阻塞任何 UI）。 */
export function loadAppVersion(): Promise<string> {
  if (cache !== null) return Promise.resolve(cache);
  if (!inflight) {
    inflight = invoke<string>("get_app_version")
      .then((v) => {
        cache = v;
        return v;
      })
      .catch(() => "")
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
