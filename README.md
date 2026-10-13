# 诊断学临床思维训练 · 答案对照站

一个静态、零依赖的单页应用，用于对照「临床思维训练系统」整体思维训练 4 例病例的
标准答案，并在本地做闭卷练习与评分。支持答案模式（逐层「寻血」标记）、练习模式
（百分制评分 + 超额扣分 + 提交锁定）、移动端适配与本地进度持久化。

> 本项目为个人学习用途。校内系统的账号、密码与内网端点等凭据**不在此仓库中**，
> 相关爬虫与运维脚本亦已排除，请勿在公开场合分享。

## 目录结构

```
site/
  index.html               入口页（<script type="module">）
  serve.js                 零依赖本地静态服务器（默认只监听 127.0.0.1）
  assets/
    app.js                 UI 与交互（ES Module）
    style.css              样式
    js/
      package.json         {"type":"module"}，让 Node 也按 ESM 载入这一子树
      domain/
        case.js            键生成与条目枚举（渲染/评分/持久化共用同一份键）
        scoring.js         评分引擎（纯函数：病例 + 答卷 + 规则表）
        answer.js          应用状态 → 单份答卷的投影
        history-replay.js  病史「检查记录」增量重放（前端与构建脚本共用）
      data/
        schema.js          病例结构校验 + 加载失败分类
        persistence.js     localStorage 读写、版本迁移、脏数据丢弃
        case-registry.js   病例 ↔ 原始导出文件的配对（按内容，不按目录顺序）
  data/
    history_records.json   病史重放数据（再生数据，未纳入版本库）
    cases.json / diaglib.json  大体量生成数据，见「数据再生」
tests/                     node:test 回归套件（52 项）
build_site_data.js         生成 cases.json / diaglib.json
build_history_records.js   生成 history_records.json
```

## 本地运行

```bash
node site/serve.js         # http://127.0.0.1:8787 ，PORT/HOST 可覆盖
npm start                  # 同上
npm test                   # 跑回归测试
```

前端是 ES Module，必须经 HTTP 打开，`file://` 直接双击会被浏览器的模块跨域策略拦住；
页面会把这种失败单独识别为 `NETWORK_ERROR` 并说明原因。

## 测试

`npm test` 只依赖 Node 内置的 `node:test`（建议 Node ≥ 22.12）。
其中「真实四例」相关用例会自动跳过，直到你按下面的步骤生成 `site/data/cases.json`。

覆盖的回归点：静态服务器的目录越界与非法 URL、评分覆盖与超额扣分、
惩罚明细与实扣金额对账、诊断分类持久化与未分类语义、跨模式筛选不穿透、
病史/治疗条目键唯一性、重放内容与终态一致、病例配对不受文件顺序影响、
本地存储的版本迁移与脏数据丢弃。

## 数据再生

`site/data/cases.json`（约 8MB，4 例完整数据）与 `diaglib.json`（约 1.5MB，诊断库）
体积过大且属于再生数据，不纳入版本库；`history_records.json` 同理。
需要本地跑完整站点时，用私有爬虫与构建脚本再生：

```bash
node build_site_data.js          # 读 overall_cases/ 与 recon/，写 cases.json + diaglib.json
node build_history_records.js    # 读 recon/incr_c*.json，写 history_records.json
```

两个脚本都会**先自检再落盘**：

- `build_site_data.js` 写出前用前端同一份 `schema.js` 校验；出现 error 即中止，不产出文件。
- `build_history_records.js` 比较「重放全部步骤」与终态记录；内容不一致即抛错中止。
- 病例与原始导出按 `meta.name` 配对，配不上或出现同名/多余文件都会报错——
  不再依赖目录枚举顺序（顺序变了会静默串病例）。

## 评分规则

百分制，权重沿用官网口径：**病史 10% · 体格 10% · 辅助 70% · 诊断 10% · 治疗 0%**
（治疗不计入满分门槛）。

```
S = Σ  weight_m × clamp( 必要项覆盖率_m × (1 − 超额惩罚_m) )
```

- `limits` 里的 `standard / reasonable / max`（以及辅助的 `costStandard/costReasonable/costMax`）
  直接来自官网导出的真实阈值：`reasonable = standard × 1.5`、`max = standard × 2`。
- 进度条与评分**共用同一份统计**（`limitMetrics`）：超过扣分线一定会在分数上体现，
  评分卡逐条列出「哪个模块、哪条指标、实际值、扣分线、扣了多少分」。
- 同一模块的次数惩罚与花费惩罚**取最重一条，不叠加**。
- 多写一个本病例标准答案里没有的诊断 = 过度诊断，按诊断模块折算扣分。
- 诊断**不分类就是未分类**：站点不再把「主要诊断」当默认值塞给学生，未分类会扣分并列出清单。
- 证据「支持/不支持」判读目前作为**独立维度输出**（显示命中率），不计入总分。

### ⚠ 扣分曲线是占位实现

官网只导出了阈值（标准线/扣分线/上限），**没有导出「超过扣分线后每超一项扣几分」的曲线**。
现实现为线性：`惩罚 = clamp((实际值 − reasonable) / (max − reasonable), 0, 1)`，
到硬上限时该模块按 0 折算。这条线性形状是**站点自定义的假设**，不是官网公式。

实测到真实曲线后，只需要改 `site/assets/js/domain/scoring.js` 里的 `DEFAULT_RULES`
一张常量表（`excess.maxFraction` / `overdiagnosis.perItem` / `combine`），
计算逻辑与调用方都不用动；回归测试里的 `惩罚系数表可整体替换` 一条会守住这个边界。

一个已经用真实数据验证过的性质：**只选全部必要项时四例均为 100 分**
（各板块必要项数量都 ≤ 官网 standard 或 ≤ reasonable），所以占位曲线不会冤枉「精准作答」。

## 已知限制

- 数据再生依赖私有爬虫（源系统与 `recon/` 增量导出不在仓库内）。
- 练习模式的选项提交后不可撤销，这是模拟考试语义下的有意设计。
- `history_records.json` 中 case1 为「终态比例还原」的估算轨迹，页面会明确标注它仅用于演示。
- 移动端报告抽屉在关闭时对整个面板置 `inert`；窄屏判定用 `max-width: 860px`。
