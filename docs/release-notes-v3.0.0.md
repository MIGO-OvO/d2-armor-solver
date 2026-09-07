# v3.0.0

这是 Solver V3 的正式稳定版本。v3 建立并收紧了解题与展示之间的正确性边界，并在此基础上加入了分阶段搜索、渐进式结果与更大的库存搜索预算——所有结果语义都保持诚实：有界搜索永远不会伪装成全局穷举。

## Solver V3

- 四条求解入口（从零配装、库存搜索、优化现有配装、理论可达范围）共享同一整数约束模型、canonical 比较器与结果证书。
- Witness 校验与 sealing 成为标准路径：证书是数学结果的唯一真值，结果在被 UI 使用前经过验证，而不是由 UI 自行用 legacy heuristic 推断是否真实满足规则。
- UI 只把证书状态与属性结果投影到界面；分数、legacy 达标标记、顶层别名等不能把未证明的结果“提升”为正确结论。展示数量限制只在正确性结论产生之后应用。
- 回归覆盖包括 120 组种子化生成可达 witness 的独立重建、证书损坏拒绝（模组 / 碎片 / 身份 / 基础 / 缺失护甲）、256 组保留实例分配漂移检查与 16 组小规模全域对照等。

## 分阶段搜索：Fast / Balanced / Deep

Fast、Balanced、Deep 解决的是**同一个数学问题**，只改变搜索预算与证明深度，不改变任何游戏规则：

- **Fast**：低时延、有界搜索，尽快给出经过验证的当前最优 witness。
- **Balanced**：默认档位，在可用预算内进行渐进式候选搜索。
- **Deep**：获得更大的搜索预算，对库存搜索优先尝试完成整个搜索域；对从零求解启用更深的 fuzzy 证明。

预算内的检查点是同一次运行的进度节点，不是从零重跑多次。Fast 在预算内未找到解时**不会**错误声明不可行——没有合格 witness 时不会编造一个。任何档位都可能在复杂输入上耗尽预算并返回 `SEARCH_LIMIT_REACHED`；档位选择只改变预算与深度，不改变“证书成立即数学结论成立”的边界。

## Proof semantics

主要结果类型：

- `EXACT_TARGET_PROVEN`：返回的 config、Tuning 与属性模组可重算出精确目标。
- `RULE_FEASIBLE_PROVEN`：witness 满足全部硬规则。
- `INFEASIBLE_PROVEN`：只在完整穷尽搜索之后出现。
- `SEARCH_LIMIT_REACHED`：只表示当前最佳 witness，不能解读为“没有精确方案”或“全局最接近”。

**只有完整可信证明才能产生 `INFEASIBLE_PROVEN`；预算耗尽只能产生 `SEARCH_LIMIT_REACHED`。** 预算或资源上限永远不会反向生成不可行证明。执行能力（`VERIFIED` / `UNVERIFIED` / `BLOCKED`）与数学结论分开展示：算法可行不等于可以一键装备。

## Inventory Solver

- 大型库存搜索把 retained states、nodes、evaluations 分开计量与管理，避免超大库存把内存和时间消耗在不必要的物化上。
- Deep 档位因此真正获得更大的库存搜索预算，而不是与其他档位共用同一小预算。
- 发布回归包含 1300 件库存 benchmark 场景（含 Upgrade 路径）以及 exact witness 独立重建验证。

需要如实说明：**大型库存仍然是有预算上限的搜索**。只有实际完成整个搜索域时，结果才携带 exhaustive proof；预算耗尽时结果明确标记为 `SEARCH_LIMIT_REACHED`，不宣称“1300 件库存全部可以穷举”。

## Progressive Search / Worker

- 搜索过程中逐步发布经过验证的中间结果，界面可实时看到已确认的可行解，而不是只能等最终结论。
- 支持取消：切换目标、模式或发起新请求都会终止旧请求对应的 Worker；请求带独立 id 与 generation，旧的过期结果不会覆盖新结果。
- 停止 / 过期结果会明确标注，界面不会把上一个请求的证书复用到新的心跳或结果上。

## Reachability / Upgrade

- 可达范围（Reachability）与 Upgrade 路径共享同一 V3 correctness boundary：协作式取消、取消时保持已有证明的完整性，不会用部分搜索冒充完整结论。
- “优化现有配装”的内部从零 fallback 使用与主搜索一致的证明边界（Deep 档位下为 `proveFuzzy`），modifier reassignment 等路径保持有界并如实标记。

## Bungie

- 新增已拥有护甲的单件拉取 / 装备操作与目标选择（single-piece owned-armor pull / equip）。
- 每次写入后执行 read-back 核对：返回 verified / failed（观察到不一致）/ unverified（数据缺失或读取失败），对陈旧档案数据做一次重试。
- 非成功或模糊的写入结果也会被对账；**不确定的写入绝不盲目重复执行**来猜测超时是否成功。界面只在拿到 verified 服务器快照后才更新拥有 / 装备状态。

## Reliability

- 318 项 Node 测试全部通过（在本次发布 commit 上实测），无失败、无跳过。
- `npm run check`（lint + Node 测试 + upgrade 计划验证 + build）、浏览器 smoke（built Worker 渐进结果、generation 隔离、Fast/Deep 控制、取消、390px 布局、mocked Bungie 请求隔离）、`verify:offline`（`file://` 离线构建）均通过。
- 1300 件库存 benchmark 场景矩阵与 witness 一致性回归通过。

## Known limitations

- Fast / Balanced 的 fuzzy 搜索是有界的；Fast 特别以低时延优先，未找到解不代表不可行。
- Deep 也有资源上限（时间与节点预算），复杂输入仍可能以 `SEARCH_LIMIT_REACHED` 结束。
- 大型 Inventory 不保证总能完成全域证明；未完成时结果不带 exhaustive proof。
- modifier reassignment 的部分路径仍可能是有界搜索。
- Upgrade fallback 并非所有情况下的全局 exhaustive optimization，其结论范围由证书与预算如实标注。
