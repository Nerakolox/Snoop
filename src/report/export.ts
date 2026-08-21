// 报告导出成图（批次 7）—— 前端自截图工具。
//
// 方案（已确认）：SVG <foreignObject> 包真实 DOM → <canvas> → PNG 字节。
// Tauri 2 / wry 均无窗口截图 API，官方插件是新依赖且不支持隐藏窗口；foreignObject 是
// 唯一零依赖、跨平台、像素精确（canvas 位图定死，免疫系统 DPI 缩放）的路径。
// 导出图所有资源都是 data URI（app 图标 / Snoop 图标 ?inline / 二维码 ?inline），canvas 不会被污染。

export interface ExportSizeSpec {
  width: number;
  height: number;
  label: string;
}

export type ExportSize = "vertical" | "square";

export const EXPORT_SIZES: Record<ExportSize, ExportSizeSpec> = {
  vertical: { width: 1080, height: 1920, label: "竖版 1080×1920" },
  square: { width: 1080, height: 1350, label: "方版 1080×1350" },
};

/** Uint8Array → base64（JSON IPC 传给 Rust 写盘，比直接传数字数组省、稳）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000; // 8KB 一块，避免超大数组把 String.fromCharCode 撑爆栈
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function nextTwoFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("导出图 SVG 渲染失败"));
    img.src = url;
  });
}

function buildSvg(node: HTMLElement, width: number, height: number, css: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<foreignObject width="${width}" height="${height}">`,
    `<div xmlns="http://www.w3.org/1999/xhtml">`,
    `<style>${css}</style>`,
    node.outerHTML,
    `</div>`,
    `</foreignObject>`,
    `</svg>`,
  ].join("");
}

/**
 * 把已布局好的 DOM 节点渲染成固定像素的 PNG（返回原始字节）。
 *
 * 时序（本批最容易出错处，**绝不用 setTimeout 当完成信号**）：
 *   document.fonts.ready → 节点内所有 <img> decode/complete → 两帧 rAF → foreignObject → canvas。
 * 任何一条没等到就截图，产出的图会缺字体或空白图标。
 *
 * @param css 导出卡的自包含样式文本（`export.css?inline`）。foreignObject 独立渲染，
 *            拿不到主文档的 <style>，必须把样式连同 box-sizing / 字体栈一起内嵌。
 */
export async function captureNodeAsPng(
  node: HTMLElement,
  width: number,
  height: number,
  css: string,
): Promise<Uint8Array> {
  // 1. 字体就绪（当前只有系统字体栈，秒回；保留以防未来引入 webfont）
  await document.fonts.ready;

  // 2. 节点内所有图片解码完成（图标已预解析为 data URI，这里兜底；单张失败不阻塞整体）
  const imgs = Array.from(node.querySelectorAll("img"));
  await Promise.all(
    imgs.map((img) => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return img.decode().catch(() => {});
    }),
  );

  // 3. 布局稳定：嵌套两层 rAF
  await nextTwoFrames();

  // 4. 序列化 DOM → foreignObject SVG
  const svg = buildSvg(node, width, height, css);
  const svgUrl = URL.createObjectURL(
    new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
  );

  try {
    const img = await loadImage(svgUrl);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建 canvas 2D 上下文");

    // 设备像素比：canvas 的 width/height 属性直接定 bitmap 原始像素，与 CSS 尺寸无关；
    // drawImage 按目标尺寸铺满，输出 PNG 即精确 width×height。显式断言，不假设。
    if (canvas.width !== width || canvas.height !== height) {
      throw new Error(
        `canvas 尺寸异常：期望 ${width}×${height}，实际 ${canvas.width}×${canvas.height}`,
      );
    }

    ctx.drawImage(img, 0, 0, width, height);

    // 5. 显式验证 canvas 未被污染（getImageData 对被污染 canvas 会同步抛 SecurityError）。
    //    所有 <img> 都是 data URI，正常不触发；若未来引入跨域图片，这里给明确报错而非静默。
    try {
      ctx.getImageData(0, 0, 1, 1);
    } catch {
      throw new Error("导出图 canvas 被污染：存在跨域图片资源");
    }

    const blob = await canvasToBlob(canvas);
    const buf = await blob.arrayBuffer();
    return new Uint8Array(buf);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("canvas 转 PNG 失败"));
      },
      "image/png",
    );
  });
}
