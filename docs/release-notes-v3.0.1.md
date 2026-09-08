# v3.0.1

这是一次热修复，只包含 v3.0.0 之后的两项修复，没有新增功能，也没有重构。

- 修复 Upgrade Search 在可见属性 0/200 边界以及搜索预算下可能漏掉可行精确方案的问题。
- 修复库存交互状态、planned tuning 展示、未拥有异域预留与职业套装计数。

## Upgrade Search：可见 0/200 边界

界面上把精确目标钳制到可见边界时（「至多 0」/「至少 200」），Upgrade Search 过去会退回有界启发式搜索，因此可能漏掉一份预算内可行的精确方案。

- 这类钳制后的精确可见规则现在按**精确可见目标**处理，使用与从零求解（Build from Scratch）相同的钳制原像，而不是降级成模糊目标。
- 因此边界目标不再被启发式搜索静默漏掉：只要预算内存在可行精确方案，Upgrade 路径就会找到它，并给出可执行的替换计划。
- 固定实例（`locked`）保持固定，替换搜索的证明语义与 V3 证书边界一致。
- 回归：新增 `tests/upgrade-v3-budget.test.mjs`，在含固定异域的 0/200 边界目标下对照 Build from Scratch 与 Upgrade 两条路径。

## Upgrade Search：搜索预算下的可行性

- 先在交互预算内建立一份**经过验证的可行替换方案**（feasibility upper bound）并立即发布，再在剩余预算里最小化替换件数（`maxReplacements = 可行方案替换件数 - 1`）。
- 预算耗尽不再等于「可行方案被藏起来」：已经证明可行的方案一定会展示；`replacementProof` 会如实标注为可行上界（`complete: false`，limitation 为 `feasible upper bound; smaller replacement counts are still being searched`），而不是伪装成「最少替换」的证明。
- 结论语义不变：只有完整可信证明才声明最少替换；预算内的可行性结论与最少性结论分开陈述。

## 库存交互状态

- 库存方案重排（被动刷新或重新排序）后，已展开的折叠区按内容身份（`data-disclosure-key`）恢复，不再因为 DOM 顺序变化而全部收起。
- 正在查看的方案会被保留：重新排序不会把你正在读的方案替换成列表里的第一项。
- 原生 `<select>` 正在交互时，被动的 Bungie 库存轮询会延后到下一次轮询，不再因为替换 DOM 节点而中断选择。

## Planned tuning 展示

- 已有护甲行同时显示**方案要求的调整方向**与**当前实际安装的调整模组**，两者不一致时明确提示需要更换调整模组。
- 渲染只读取库存数据，不会把方案要求的调整写回库存记录。

## 未拥有异域预留

- 新增「任意异域（待获取）」选项：该部位被预留给尚未拥有的异域，已有传说护甲或其他异域不会静默顶替它。
- 预留状态随草稿保存并在刷新后恢复，方案会把该部位列为待获取的刷取要求。

## 职业套装计数

- 套装选择器里的「已拥有」件数只统计当前所选职业的护甲，不再把其他职业的件数算进来。

## 界面文案

- 面向玩家的文案不再使用 witness 术语，改用「当前最佳配装 / 可行替换配装 / 最接近目标的搭配」等直白说法；`tests/ui-localization-contract.test.mjs` 增加了对应契约。

## Reliability

- `npm run check`（lint + 322 项 Node 测试 + upgrade 计划验证 + build）全部通过。
- `npm run test:browser`（浏览器 smoke）、`npm run verify:offline`（`file://` 离线构建）与 `npm run test:consistency`（witness 一致性 + V3 差分）全部通过。
- 1300 件库存 benchmark 矩阵与 witness 独立重建回归通过。

## Known limitations

- Upgrade 的可行上界不代表全局最少替换：预算耗尽时结果如实标记为可行上界，仍可能找到替换件数更少的方案。
- Fast / Balanced 的 fuzzy 搜索仍然是有界的；未找到解不代表不可行。
- 大型库存搜索仍然是有预算上限的搜索，未完成全域时结果不带 exhaustive proof。
