/**
 * 键盘度量单一真源。
 * 任何键盘渲染相关的像素/缩放常量都从这里取，禁止在别处出现字面量。
 */

/** 1U 的设计像素（键在 scale=1 时的原始尺寸基准）。 */
export const KEY_UNIT = 44;

/** 键帽相对其 U 格子的收缩量（即键间视觉间隙）。 */
export const KEY_GAP = 5;

/** 缩放下限：低于此值不再缩，改为横向滚动。 */
export const MIN_SCALE = 0.55;

/** 缩放上限：键盘是输入页的主角，宽屏下按可用宽等比放大到此倍数为止。
 *  不设为无穷 —— 键帽文字靠 transform 放大，倍率越高越依赖浏览器重新栅格化，
 *  1.35 是「明显变大」与「文字仍锐利」的折中。 */
export const MAX_SCALE = 1.35;

/** 键盘高度预算：缩放后的键盘高不超过窗口高的这一比例。
 *  宽而矮的窗口里单看宽度会把键盘撑到顶掉下方的详情条与辅助区，
 *  故最终 scale 取「宽度约束 / 高度预算 / MAX_SCALE」三者最小值。 */
export const HEIGHT_BUDGET_RATIO = 0.46;

/** .kle-scaler 左右各留的水平内边距（px），用于容纳键 hover 时向外扩散的
 *  box-shadow，避免被 .kle-viewport 裁掉右侧一圈。可用宽计算需扣除左右共 2 倍。 */
export const SCALER_PAD_X = 8;

/** 键帽内文字两侧的安全内边距（px，未缩放坐标系）。标签适配算法用它算可用宽：
 *  可用宽 = key.w * KEY_UNIT - KEY_GAP - 2 * KEY_PADDING。 */
export const KEY_PADDING = 4;
