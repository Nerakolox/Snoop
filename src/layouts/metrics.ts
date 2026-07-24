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

/** .kle-scaler 左右各留的水平内边距（px），用于容纳键 hover 时向外扩散的
 *  box-shadow，避免被 .kle-viewport 裁掉右侧一圈。可用宽计算需扣除左右共 2 倍。 */
export const SCALER_PAD_X = 8;

/** 键帽内文字两侧的安全内边距（px，未缩放坐标系）。标签适配算法用它算可用宽：
 *  可用宽 = key.w * KEY_UNIT - KEY_GAP - 2 * KEY_PADDING。 */
export const KEY_PADDING = 4;
