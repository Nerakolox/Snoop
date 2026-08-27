// 分类命令的薄封装。所有写入口都要在调用方之后走 store.invalidateCategories()，
// 否则按分类聚合的页面与缓存会留着旧结论。

import { invoke } from "@tauri-apps/api/core";
import type { Category, CategoryRow, DeleteImpact } from "./types";

/** 全部分类（**含已归档**）。归档项要用来还原「原 XX，已归档」的显示。 */
export function listCategories(): Promise<CategoryRow[]> {
  return invoke<CategoryRow[]>("list_categories");
}

export function createCategory(
  name: string,
  description: string,
  hue: number,
  customColor: string | null = null,
): Promise<Category> {
  return invoke<Category>("create_category", { name, description, hue, customColor });
}

/** 改名 / 改说明 / 改色。`customColor = null` 即清空自定义色，回到跟随主题的 hue。 */
export function updateCategory(
  id: string,
  name: string,
  description: string,
  hue: number,
  customColor: string | null = null,
): Promise<Category> {
  return invoke<Category>("update_category", { id, name, description, hue, customColor });
}

/** 归档 / 恢复。归档不动任何归类数据，恢复后其下应用自动回来。 */
export function setCategoryArchived(id: string, archived: boolean): Promise<Category> {
  return invoke<Category>("set_category_archived", { id, archived });
}

/** 永久删除前的影响面。确认弹窗必须如实显示这三个数。 */
export function getCategoryDeleteImpact(id: string): Promise<DeleteImpact> {
  return invoke<DeleteImpact>("get_category_delete_impact", { id });
}

/** 永久删除（只对已归档的非系统分类可用）。不可撤销。 */
export function deleteCategory(id: string): Promise<DeleteImpact> {
  return invoke<DeleteImpact>("delete_category", { id });
}

export function reorderCategories(ids: string[]): Promise<void> {
  return invoke("reorder_categories", { ids });
}
