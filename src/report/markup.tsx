/**
 * 报告叙事段的轻量标记渲染 —— 摘要卡与海报共用的唯一解析器。
 *
 * 叙事串由后端换行分隔（一条 quip 一行），标记只有两种：
 *   - `{{n:数字/时长}}` → 数字强调（等宽 + 加粗 + 略放大 + 深色）
 *   - `{{em:语气重点}}` → 品牌紫 + 加粗
 *
 * 安全与降级：
 *   - 文本一律作为 React 文本节点插入，天然 HTML 转义，防注入（含海报
 *     foreignObject → XMLSerializer 二次转义的路径）。
 *   - 未知类型（如 `{{x:foo}}`）剥掉标记壳保留文字；未闭合的 `{{` 只剥开壳，
 *     不丢整条。这样坏标记顶多变成平铺文字，不会整段消失。
 */

import type { ReactNode } from "react";

export type NarrativeVariant = "card" | "summary";

const PREFIX: Record<NarrativeVariant, string> = {
  card: "report-card__narrative",
  summary: "report-summary__narrative",
};

/** 把换行分隔的叙事串渲染成一列段落（每段内部再解析标记）。 */
export function renderQuips(text: string, variant: NarrativeVariant): ReactNode {
  const base = PREFIX[variant];
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return (
    <>
      {lines.map((line, i) => (
        <p key={i} className={`${base}-line`}>
          {renderMarkup(line, base)}
        </p>
      ))}
    </>
  );
}

/** 把一段文本里的 `{{n:...}}` / `{{em:...}}` 替换成带样式的 span，其余平铺为文本。 */
function renderMarkup(text: string, base: string): ReactNode {
  const out: ReactNode[] = [];
  let key = 0;
  let i = 0;
  let buf = "";
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = "";
    }
  };

  while (i < text.length) {
    if (text.startsWith("{{", i)) {
      const close = text.indexOf("}}", i + 2);
      if (close === -1) {
        // 未闭合：剥掉开壳「{{」，剩下的当普通文字继续扫。
        i += 2;
        continue;
      }
      const inner = text.slice(i + 2, close);
      const m = /^(n|em):([\s\S]*)$/.exec(inner);
      if (m) {
        flush();
        const kind = m[1] === "n" ? "n" : "em";
        out.push(
          <span key={key++} className={`${base}-${kind}`}>
            {m[2]}
          </span>,
        );
      } else {
        // 未知类型：剥掉标记壳，保留内部文字。
        buf += inner;
      }
      i = close + 2;
    } else {
      buf += text[i];
      i += 1;
    }
  }
  flush();
  return out;
}
