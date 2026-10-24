# Cherry Profile 键帽参数化建模说明（供 Claude Code）

> 目标：构建四排 Cherry Profile（R1/R2/R3/R4）的 1U 键帽三维模型，使用 Cherry MX 十字接口。优先以真实 STEP/CAD 为几何基准，而非凭网上外观图猜测角度。文件单位统一为毫米。
>
> 重要：Cherry Profile（键帽高度/轮廓）与 Cherry MX（轴体十字接口）是两个不同概念。Cherry Profile 在各厂商之间并非完全一致的统一加工图纸。下文明确标注「原厂接口规格」「厂商参考值」「初始设计值」。

## A. 权威来源与参考资料（请优先查阅）

1. **Cherry 原厂 1983 年 1×1 键帽工程图**（修订于 1987 年；原始历史键帽图纸，不是现今 R1–R4 的完整公差标准）：  
   https://deskthority.net/wiki/images/c/c8/Cherry_MX_1%C3%971_keycap_specification_(1983).pdf
2. **Keychron Cherry Profile STEP 参考模型**（厂商仓库，优先采用真实模型提取逐排轮廓、顶面曲面与轴心高度）：  
   https://github.com/Keychron/Keychron-Keyboards-Hardware-Design/blob/main/Keycap%20Profiles/Cherry%20Profile/README.md  
   文件名 `cherry_profile_20260410.stp`，下载由仓库 README 链接指向 Keychron 自有服务器；若链接不可用，说明阻碍，不要假设文件已存在。
3. **Keychron 实际售卖的 Cherry Profile 键帽**（四排高度图）：  
   https://keychron.com.au/products/double-shot-pbt-cherry-full-set-keycap-set-grey-white-and-blue
4. **Jelly Key Cherry Profile 实物尺寸**（一款 R1 的参考值，不是普遍标准）：  
   https://www.jellykey.com/blog/a-fresh-update-on-our-treasured-cherry-profiles/
5. **MX 十字接口与过盈分析**：  
   https://telcontar.net/KBK/Cherry/MX
6. **参数化键帽建模参考（OpenSCAD，GPL-3.0；支持 Cherry MX 轴体，但不能把其 OEM/DCS 等预设混作 Cherry Profile）**：  
   https://github.com/rsheldiii/Keyv2
7. **Cherry MX 键帽开源 CAD 参考（MIT；源项目使用 WASD 的尺寸，其轮廓不应未经验证就认作纯正 Cherry Profile）**：  
   https://github.com/ConstantinoSchillebeeckx/cherry-mx-keycaps

## B. 几何基准和坐标约定

- `x`：键位左右方向；`y`：键盘前后方向（正 y 朝键盘后方/功能排）；`z`：垂直向上。
- 键帽底缘基准平面：`z = 0`。
- 标准 1U 中心坐标：`x = y = 0`；MX 支撑柱与标准 1U 键位中心同心。
- 键中心距（pitch）：**19.05 mm / 1U**（常见键位间距）。
- 1U 外底轮廓：**18.0 × 18.0 mm**（可调初始设计值；并非全部厂商严格如此）。
- 同一行相邻底缘的理论空隙：`19.05 - 18.0 = 1.05 mm`。
- 倾角统一定义为：键帽顶面局部参考平面相对 `xy` 平面的绕 `x` 轴旋转角；正负方向在程序中写清楚。不得混用网上不同朝向/行号体系。
- 圆角、锥度和表面凹陷都应做为参数，不得直接把几个长方体差集当成最终 Cherry 外形。

## C. 每行 Cherry Profile 外形（厂商参考，不是原厂公差规范）

以下数值见 Keychron / Akko 的 Cherry Profile 高度示意；请优先使用 Keychron STEP 复核高度的具体测量基准：

| 行号 | 键位 | 公开参考高度（mm） |
| --- | --- | ---: |
| R1 | F / 数字排 | 9.81 |
| R2 | QWERTY | 7.85 |
| R3 | ASDF | 7.22 |
| R4 | ZXCV / 底排 | 8.59 |

- 常见六排映射：`R1 / R1 / R2 / R3 / R4 / R4`。
- 不要沿用其他资料的反向 R1/R4 编号。
- 四排有不同的侧壁前后高度、顶面倾角、顶面相对底面偏移量（top skew）；**倾角的精确度数应该直接从选定 STEP/CAD 样本测量**。不要把不同网站互相矛盾的角度与高度拼成所谓「原厂标准」。
- Cherry 顶面为 **cylindrical dish（单轴内凹曲面）**；通常以左右凹弧为主，不得错误做成 SA 式四向球面凹碗。弧面半径/凹陷深度作为可调参数，经参考 CAD 核对。
- 顶面较底面收缩，四壁有锥度；上下环轮廓圆角过渡，而非尖角梯台。

## D. 1U 初始尺寸（原型阶段）

| 项目 | 初始值/范围 | 依据与身份 |
| --- | --- | --- |
| 1U pitch | 19.05 mm | 键盘通行尺寸 |
| 底部外框 | 18.0 × 18.0 mm | 建模建议初值，验证后调整 |
| R1 参考顶面 | 约 10.7 × 14 mm | Jelly Key 某 R1 实物：底部约 18.5 × 18 mm，顶面 10.7 × 14 mm，最高约 10.2 mm |
| 顶面宽度可调范围 | 约 10.7–12.5 mm | 外形原型范围，非标准 |
| 壁厚 | 1.2–1.5 mm | 打印/结构原型建议，依工艺调整 |
| 顶面凹深 | 参数化，不固定 | 从参考 CAD / 实物确认 |
| 边缘圆角 | 参数化，不固定 | 从参考 CAD / 实物确认 |

注：不同产品存在不同壁厚、曲面、顶面尺寸，完整 Cherry 外形不可只凭几个常数还原。

## E. Cherry MX 十字插孔（重点）

| 参数 | 数值 | 属性 |
| --- | ---: | --- |
| 插孔「+」总跨度（X、Y 方向） | **4.10 mm，公差 +0.05 mm** | Cherry 原始插孔工程规格 |
| 十字臂的槽宽 | **1.17 mm，公差 ±0.02 mm** | Cherry 原始插孔工程规格 |
| 插孔轴向有效深度 | 初值 3.8–4.0 mm | 经验 CAD 值，必须验证 |
| 内部十字支撑柱外径 | 初值约 5.5 mm | 开源 CAD 常用参考，非原厂强制数值 |
| 轴孔公差补偿 | 独立可调，分 0.05 mm 档校准 | 不同工艺 / 材料需要验证 |

- 这是**键帽内部插孔**的规格，并不是一根完全对称的、刚好 4.10 × 1.17 mm 的实体轴；轴体真实十字的东西和南北两组臂宽不同，压入后局部产生过盈。
- 插孔应为支撑柱中的**盲孔**；不能贯穿顶面。
- 插孔 X/Y 总跨度和臂宽分别做独立参数，不能简单套用同一个缩放系数。
- 请生成至少三种小型 MX 插孔公差测试样（名义、略宽、再略宽），按 0.05 mm 档比较实物装配、拔出力和开裂情况；不可仅靠 CAD 判定适配。

## F. 结构与大键

- 第一阶段只建 **1U 的 R1–R4**；键帽外壳、顶面曲面、内部支撑柱、盲十字槽必须为有效实体。
- 第二阶段支持 1.25U、1.5U、1.75U、2U、2.25U、2.75U、6.25U 等；横向外形宽度可采用 `U * 19.05 - 1.05` 作为初值，不可将 1U 的整个模型沿 X 简单等比拉伸（会把侧壁厚度、圆角、轴心尺寸一同拉坏）。
- 宽键需另行定义 stabilizer 轴孔中心距及偏置：例如 WASD 的一种 6.25U 空格键底宽约 118 mm，两辅助支撑位相对主轴各 ±50 mm，但**不同空格与卫星轴规格不通用**。
- Caps Lock 可能存在偏心轴位，ISO Enter 不是简单的长方体；这些特殊键单独作为 profile/shape 配置。

## G. 实施要求（交给 CC）

1. **先获取并检查 Keychron STEP 参考**：定位 1U 四排实例，分析每排高度、顶面前后倾角、前后沿高度、外形收缩、凹面方向/深度、内部轴座相对底缘位置。写一份测量表并注明测量基准。若下载失败，明确说明并退回到参数近似模型。
2. 创建可重复生成的参数化 CAD 项目，优先使用可编辑 B-Rep/实体几何的方案（如 CadQuery、build123d、FreeCAD）；若项目已有建模技术栈则沿用。**不要只输出不可编辑的渲染网格。**
3. 使用共用的底缘轮廓、顶面轮廓、圆角与壁厚规则，通过 loft / shell / Boolean 差集生成空心本体；四排差异由独立 profile 数据对象驱动。
4. 将 MX 轴座建成独立模块，允许 `cross_span`、`cross_arm_width`、`socket_depth`、`post_outer_diameter`、`mount_offset`、`fit_adjustment` 分别配置。
5. 输出 R1–R4 的原生工程文件，以及每个键独立的 STEP、STL；如需网页查看再输出 GLB。所有单位为 mm。
6. 输出正视/侧视/俯视/底视及剖面预览（重点可看单轴凹面和内部十字孔）。
7. 做几何自动检查：watertight/manifold、不存在自交、正体积、实体非零壁厚、MX 插孔不贯穿顶面；按 19.05 mm 间距阵列后不发生不合理干涉，并检查轴体全行程空间。
8. 额外做 MX 插孔的多公差校准小样；最终安装效果必须用真实轴体打印试装验收。
9. 在 `PARAMETERS.md` 中将数值区分为 `verified_original_spec`、`manufacturer_reference`、`design_default` 和 `requires_physical_validation`，避免把初始估值写成行业强制标准。

## H. 验收条件

- 单位、坐标、行号约定明确。
- R1–R4 外形视觉上连贯但互不相同，高度以选定的 Keychron 型号/STEP 为最终参考。
- 上表中的接口值不因整键缩放、宽键扩展而被误改。
- 能独立调整外壳、顶面、轴孔、装配公差，修改参数即可自动再生成文件。
- 给出模型来源和对应许可信息；KeyV2 为 GPL-3.0，而 ConstantinoSchillebeeckx 的模型为 MIT，Cherry 历史工程图版权仍属 Cherry。
