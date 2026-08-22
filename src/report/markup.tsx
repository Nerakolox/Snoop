/**
 * 报告叙事段的轻量标记渲染 —— 摘要卡与海报共用的唯一解析器。
 *
 * 叙事串由后端换行分隔（一条 quip 一行），标记只有两种：
 *   - `{{n:数字/时长}}` → 数字强调（等宽 + 加粗 + 略放大 + 深色）
 *   - `{{em:语气重点}}` → 品牌紫 + 加粗
 *
 * 模型对花括号数量的遵守不稳定，**单花括号 `{n:...}` 与双花括号 `{{n:...}}` 都吃**。
 * prompt 示例统一用双花括号（首选格式），但解析器不依赖它，今天漏一个明天也不会漏到界面上。
 *
 * 安全与降级（顺序：先靠 React 文本节点天然 HTML 转义，再做标记替换，防注入）：
 *   - 文本一律作为 React 文本节点插入，天然转义（含海报 foreignObject → XMLSerializer
 *     二次转义的路径），标记内容永远进不了 HTML 结构。
 *   - 未知类型（如 `{b:xxx}` / `{{b:xxx}}`）剥掉标记壳保留文字，**绝不把花括号漏到界面上**。
 *   - 未闭合的标记只剥掉开括号，剩下的当普通文字继续扫，坏标记顶多平铺，不会整段消失。
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

/** 解析结果：`kind` 是标记名（n/em/未知），`content` 是标记内文字，`next` 是下一个扫描位置。 */
type ParsedMarkup = { kind: string; content: string; next: number } | null;

/**
 * 尝试从 `text[i]` 解析一个标记。单双花括号都吃：`{n:...}` / `{{n:...}}` / `{em:...}` / `{{em:...}}`。
 *
 * 判定规则：`{`（可多个）后紧跟 `单词:` 结构才算标记；否则当普通字符，不干扰正文里偶发的 `{`。
 * 闭合括号数量不要求与开括号严格对齐（`{n:x}}` / `{{n:x}` 这类错位也按内容剥壳）。
 */
function tryParseMarkup(text: string, i: number): ParsedMarkup {
  // 数开括号（1 或 2；更多也只按这一档处理）。
  let openLen = 0;
  while (text[i + openLen] === "{") openLen += 1;

  // 开括号后须紧跟 `单词:` 结构，否则不是标记。
  const after = text.slice(i + openLen);
  const head = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:/.exec(after);
  if (!head) return null;
  const kind = head[1];
  const contentStart = i + openLen + head[0].length;

  // 找第一个闭合 `}`，并吞掉紧随其后的连续 `}`（容忍开闭数量错位）。
  const firstClose = text.indexOf("}", contentStart);
  if (firstClose === -1) {
    // 未闭合：只剥掉开括号，剩下的当普通文字继续扫（不漏花括号到界面）。
    return { kind, content: "", next: i + openLen };
  }
  let closeEnd = firstClose;
  while (text[closeEnd] === "}") closeEnd += 1;

  return { kind, content: text.slice(contentStart, firstClose), next: closeEnd };
}

/** 把一段文本里的 `{n:...}` / `{em:...}`（单双花括号都吃）替换成带样式的 span，其余平铺为文本。 */
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
    if (text[i] === "{") {
      const parsed = tryParseMarkup(text, i);
      if (parsed) {
        flush();
        if (parsed.kind === "n" || parsed.kind === "em") {
          out.push(
            <span key={key++} className={`${base}-${parsed.kind}`}>
              {parsed.content}
            </span>,
          );
        } else {
          // 未知类型：剥掉标记壳，保留内部文字。
          buf += parsed.content;
        }
        i = parsed.next;
        continue;
      }
      // 不是标记（无 `单词:` 结构）→ 当普通字符。
      buf += "{";
      i += 1;
    } else {
      buf += text[i];
      i += 1;
    }
  }
  flush();
  return out;
}
