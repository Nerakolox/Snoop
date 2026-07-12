/**
 * KLE 配列选择器
 * 动态加载 src/assets/keyboards 目录下的所有配列，带左右翻页导航
 */

import { useState, useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { parseKLE, type KLEKey } from "../kleParser";
import KLELayoutPreview from "./KLELayoutPreview";

export type LayoutDefinition = {
  id: string;
  name: string;
  fileName: string;
};

const LAYOUT_STORAGE_KEY = "snoop-kle-layout";

type KLELayoutPickerProps = {
  value: string;
  onChange: (layoutId: string) => void;
};

/** 从文件名推导配列名称（优先级：文件内元数据 > 文件名推断） */
function inferLayoutName(fileName: string): string {
  const base = fileName.replace(/\.json$/i, "");

  // 特殊命名映射
  const nameMap: Record<string, string> = {
    "40": "40%",
    "60": "60%",
    "68": "68%",
    "84": "75%",
    "87": "TKL",
    "98": "98%",
    "104": "100%",
    "apple-wireless": "Apple",
  };

  return nameMap[base] || base;
}

export default function KLELayoutPicker({ value, onChange }: KLELayoutPickerProps) {
  const [layouts, setLayouts] = useState<LayoutDefinition[]>([]);
  const [layoutPreviews, setLayoutPreviews] = useState<Map<string, KLEKey[]>>(new Map());
  const [currentPage, setCurrentPage] = useState(0);

  // 每页显示的配列数量
  const itemsPerPage = 5;
  const totalPages = Math.ceil(layouts.length / itemsPerPage);
  const visibleLayouts = layouts.slice(currentPage * itemsPerPage, (currentPage + 1) * itemsPerPage);

  // 动态扫描并加载所有配列
  useEffect(() => {
    async function scanLayouts() {
      try {
        // 扫描目录（通过尝试加载已知文件名列表）
        const knownFiles = [
          "40.json", "60.json", "68.json", "84.json", "87.json",
          "98.json", "104.json", "apple-wireless.json"
        ];

        const foundLayouts: LayoutDefinition[] = [];
        const previews = new Map<string, KLEKey[]>();

        for (const fileName of knownFiles) {
          try {
            const response = await fetch(`/src/assets/keyboards/${fileName}`);
            if (!response.ok) continue;

            const kleJson = await response.json();
            const id = fileName.replace(/\.json$/i, "");
            const name = inferLayoutName(fileName);

            foundLayouts.push({ id, name, fileName });

            // 同时加载预览
            const keys = parseKLE(kleJson);
            previews.set(id, keys);
          } catch (e) {
            // 文件不存在或加载失败，跳过
          }
        }

        setLayouts(foundLayouts);
        setLayoutPreviews(previews);
      } catch (e) {
        console.error("Failed to scan layouts:", e);
      }
    }

    scanLayouts();
  }, []);

  // 当前选中的配列在哪一页
  useEffect(() => {
    const index = layouts.findIndex(l => l.id === value);
    if (index >= 0) {
      const targetPage = Math.floor(index / itemsPerPage);
      setCurrentPage(targetPage);
    }
  }, [value, layouts, itemsPerPage]);

  function goToPrevPage() {
    setCurrentPage(p => Math.max(0, p - 1));
  }

  function goToNextPage() {
    setCurrentPage(p => Math.min(totalPages - 1, p + 1));
  }

  return (
    <div className="kle-layout-picker">
      <label className="kle-layout-label">配列</label>
      <div className="kle-layout-carousel">
        {totalPages > 1 && (
          <button
            type="button"
            className="kle-carousel-btn"
            onClick={goToPrevPage}
            disabled={currentPage === 0}
            title="上一页"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        <div className="kle-layout-options">
          {visibleLayouts.map((layout) => {
            const previewKeys = layoutPreviews.get(layout.id) || [];

            return (
              <button
                key={layout.id}
                type="button"
                className={`kle-layout-option${value === layout.id ? " is-active" : ""}`}
                onClick={() => onChange(layout.id)}
                title={layout.name}
              >
                <div className="kle-layout-preview">
                  {previewKeys.length > 0 ? (
                    <KLELayoutPreview keys={previewKeys} width={64} height={26} />
                  ) : (
                    <div style={{ width: 64, height: 26 }} />
                  )}
                </div>
                <div className="kle-layout-name">{layout.name}</div>
              </button>
            );
          })}
        </div>
        {totalPages > 1 && (
          <button
            type="button"
            className="kle-carousel-btn"
            onClick={goToNextPage}
            disabled={currentPage >= totalPages - 1}
            title="下一页"
          >
            <ChevronRight size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 加载 KLE JSON 配列文件
 * @param layoutId 配列 ID
 * @returns KLE JSON 数据
 */
export async function loadLayoutJSON(layoutId: string): Promise<any> {
  const fileName = layoutId.endsWith(".json") ? layoutId : `${layoutId}.json`;
  const response = await fetch(`/src/assets/keyboards/${fileName}`);
  if (!response.ok) {
    throw new Error(`Failed to load layout: ${fileName}`);
  }

  return response.json();
}

/**
 * 从 localStorage 读取保存的配列选择
 */
export function getSavedLayout(): string {
  return localStorage.getItem(LAYOUT_STORAGE_KEY) || "104";
}

/**
 * 保存配列选择到 localStorage
 */
export function saveLayout(layoutId: string): void {
  localStorage.setItem(LAYOUT_STORAGE_KEY, layoutId);
}
