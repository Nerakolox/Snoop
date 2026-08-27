// 与后端 `app_classify` 对齐的常量。改一边必须同步另一边。

/**
 * 未归档分类数量上限（不含已归档）。
 *
 * 后端 `app_classify::MAX_ACTIVE_CATEGORIES` 是最终裁决方（超限直接拒写），
 * 前端拿它把「新建」入口提前置灰，避免用户填完表单才被拒。
 */
export const MAX_ACTIVE_CATEGORIES = 24;

/**
 * 「未分类」的分类 id。
 *
 * 它是一个**状态**而非归类目标：改分类的下拉里不出现它，AI 分类 prompt 里也没有它。
 * 存储上「未分类」表示为 app_categories 里没有对应行。
 */
export const ID_UNCATEGORIZED = "uncategorized";

/** 「其他」的分类 id。已归档分类下的应用在展示层并入这里。 */
export const ID_OTHER = "other";
