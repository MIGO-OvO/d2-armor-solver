# v3.1.3

V3.1.3 是 v3.1.2 稳定通道上的功能版本，包含 `v3.1.2..develop` 的改动。核心变化是给库存规划器
（Inventory Planner）引入**宏观等价匹配**：理论求解器给出的见证，不再只按「完全一致的槽位排列」
才能算作已拥有，而是允许在保持数学结论与全部硬约束的前提下重新配对、重新落位。

本版**不改动游戏规则，也不放宽 Solver V3 的证明、证书与见证校验边界**。所有最终方案仍然要经过
`verifyMacroEquivalent` → `sealWitness` → `satisfiesConstraintModel` → `createResultCertificate` 的完整边界，
源见证永不改写。

## 背景：为什么需要宏观等价

此前库存匹配（`src/core/inventory-plan.mjs`）本质上是「精确模板搜索」：把理论见证的五件配置按合法
槽位排列逐一回放，能一字不差对上才算拥有，对不上就落到有界残差重解。这带来一个明显偏差——
一个玩家在数学上已经凑齐的配装，只是因为框架落在了别的部位、或第三属性与框架换了配对方式，
就被判成需要再刷。

实际上五件护甲的护甲域总贡献可以分解为：

```
totals = Σ 固定件基座
       + Σ_可动 f(archetype, tertiary)
       + Σ 方向性 Tuning (from → to)        每个 ±5
       + Σ +3 大师杰作贡献                   每件 +1 × 3 个属性
       + Σ Armor Mods                       +5 / +10
```

其中 T5 传说的基座分布为 `f = 5·全属性 + 25·主属性 + 20·副属性 + 15·第三属性`。因此可动部分的贡献
只取决于两个 multiset：**框架 archetype 的多重集**与**第三属性的多重集**，与它们如何配对、落在哪个
物理槽位无关。这就是宏观等价的数学基础，详细推导见 [`docs/plan-equivalence.md`](plan-equivalence.md)。

## 新增：宏观等价层 `src/core/plan-equivalence.mjs`

新增纯函数模块，负责宏观画像的提取与比较：

- `PlanMacroProfile` / `PlanMacroId`：Inventory Planner **专用**的等价身份，**不**与全局
  `createCanonicalId`、`mathEquivalenceKey`、Top-K 去重或见证证书混用——后者描述一个具体方案，
  而宏观画像描述「能实现该方案的一类库存」。
- 固定件（pinned）保持槽位、身份与精确基座 roll，不进入自由交换池。判定条件：职业金 perk 配置、
  被标记为 `exotic` 的配置、携带 `sourceId` 的已绑定件、占用指定固定异域槽的件。
- `+3` 按**六维聚合贡献向量**比较，而不只是比较 `numPlus3`：不同件的 masterwork 集合不同，
  同样数量的 `+3` 可以产生不同的最终属性。
- 方向性 Tuning 按无序 `(from, to)` multiset 比较，但落位必须受真实能力约束（传说的不可变
  `tunedStat`，异域的 `allowedTuningStats`）；待刷件假定可刷出所需 roll，最终见证仍需校验。
- Armor Mods 是全局资源，只有 `(size, stat)` multiset 是不变量，当前装在哪个插槽上属于执行状态。
- `comparePlanMacroProfiles(source, candidate)` 是**对齐式**比较：必须先用 source 的 pinned 描述符
  在 candidate 中匹配，剩余的才构成可动 bag。直接按「有 `sourceId` 即 pinned」独立建画像会导致
  bag 结构性不等。

## 三层匹配管线

`rankInventoryPlans` 现在对每个理论见证执行三个阶段：

1. **精确模板快路径**（`searchSlots` + `chooseBestAssignment`）——保留原有窄语义「回放，不重优化」。
2. **宏观等价匹配**（`matchMacroEquivalentPlan`）——消费可动的框架/第三属性 bag，解析固定身份，
   为待刷槽重新合法配对，按真实能力重新落位方向性 Tuning，复现 +3 贡献向量并重分配 Armor Mods。
   五件规模下搜索是穷尽的，且使用**自己的预算**，结论不受 `residualSearchLimits` 影响。
3. **残差约束重解**（`reoptimizeConstraintPlan`）——对原始 `problemSpec`/`constraintModel` 的有界重解。
   它可能给出同一问题下的另一个方案（不同的宏观组成），而不是源方案的宏观等价实现，结果始终
   标记为未完成。

同一拥有层级内用 `compareMacroCandidates` 择优：规则可行性 → 套装覆盖 → 更省的 Tuning/Armor Mod
分配 → 稳定 identity。Armor Mod 按件已装模组优先归位，在不改变数学结论的前提下降低
`changedSocketCount`。

认证候选很贵（一次见证 seal + 证书 + 宏观比较），因此叶搜索只用廉价指标排序，每个拥有层级只对
少量短名单做完整认证（`MACRO_CERTIFY_ATTEMPTS`），诊断中以 `diagnostics.certifications` 统计。

## 搜索预算与调度

每个源方案拥有独立的宏观搜索会话：

- 每方案的节点计数与时间片在**进入阶段 2 时才开始**，阶段 1 的模板搜索与认证时间不会消耗它们；
- 批次级节点计数与「宏观工作累计时间」上限（不是整次调用的物理时钟），保证 50 个方案的批次不会卡死，
  单个无望方案也吃不掉全部预算。

默认值为 20k 节点/方案、300k 节点/批、900ms/方案、900ms/批，`macroSearchLimits` 可为测试与基准注入。
被截断的搜索会记录是哪一项预算终止了它（`solution-nodes` / `solution-time` / `batch-nodes` / `batch-time`），
`rankInventoryPlans` 在返回数组上暴露 `macroDiagnostics`（`solutionsAttempted/Completed/Limited`、`nodes`、
`maxSolutionNodes`、`timeMs`、`certifications`、`limitReasons`）供审计；诊断挂在数组上，worker 传输会
自然丢弃，不额外付出结构化克隆成本。

## `matchingProof` 语义

```js
// 宏观等价命中（阶段 2 成功）
{
  scope: "source-macro-equivalence",
  complete: true,
  slotIndependent: true,
  equivalence: {
    frameworkMultiset: true, tertiaryMultiset: true, armorModMultiset: true,
    directionalTuningMultiset: true, plus3Contribution: true,
  },
  sourceMacroId, candidateMacroId,
}

// 残差重解替换了方案
{
  scope: "original-constraint-model",
  complete: false, macroEquivalent: false, residualResolve: true,
}

// 拥有度搜索被截断
{
  scope: "provided-theoretical-witness",   // 或 source-macro-equivalence
  complete: false,
  macroSearchLimited: true,
  macroSearchLimitReason: "solution-nodes" | "solution-time" | "batch-nodes" | "batch-time",
}
```

一次完整的宏观搜索即为该方案定下「已拥有 / 待刷」结论，即使阶段 1 与阶段 3 被截断
（`macroEquivalenceSearched`）。有界的残差未命中**不会降级**已证明的宏观/模板结论，只追加
`residualSearchLimited`。

## provisional 与 settled 缓存

`isOwnedPlanSettled(plan)` 是唯一权威：`matchingProof.complete !== false` 即为已定。已完成的宏观证明
即使残差搜索被截断也保持 settled；完全拥有的方案不需要任何提示。

provisional 条目照常服务列表，但绝不是最终结果：用户点开该方案时，应用会为该方案单独发起一次
前台重试（新的宏观会话，而非共享的批次时间片）并用 settled 结果替换条目。每个输入 revision 最多
一次自动重试，避免渲染/重试循环；库存、筛选或约束变化会重新启用。UI 只在拥有/待刷结论确实
provisional 时显示「库存适配搜索未完成」。

## 剪枝修正

宏观 DFS 增加了全 bag 的 `+3` 子集和预检（不可行直接短路）。同时修正了一处会误杀合法方案的缺陷：
能力 Hall 界必须把**已决定的待刷槽**算作通配（`wildcardPieces`），否则带 farm 叶子的合法方案会被剪掉。

## 验证

- 新增 `tests/plan-equivalence.test.mjs`（宏观画像与对齐式比较，含 multiset 不等、+3 贡献向量不等、
  pinned 身份不等的反向用例）与 `tests/helpers/macro-fixtures.mjs`。
- 新增 `tests/inventory-plan-batch.test.mjs`（两级预算、截断原因、批次诊断）、
  `tests/owned-plan-settlement.test.mjs`（provisional → settled 的单次重试语义）。
- 扩展 `tests/inventory-plan.test.mjs`（+546 行）、`tests/inventory-plan-residual.test.mjs`、
  `tests/inventory-export-guard.test.mjs`、`tests/unified-results-state.test.mjs`、
  `tests/inventory-plan-correctness.test.mjs`。
- `scripts/browser-smoke.mjs` 的库存规划冒烟按新的三层匹配语义更新。
- 全量 Node 测试 **591 项通过**（v3.1.2 为 543 项，新增 48 项）；lint、生产构建、升级计划检查
  （49 个方案校验）均通过。离线自包含构建与桌面前端构建不受影响。

## 已知限制

- 宏观等价是**数学层面**的等价陈述，刻意忽略已装插槽、能量、当前装备的模组与 Tuning 安装位置——
  这些属于执行预检（`assignArmorMods`、`executionKnown`），会在用户选中的具体方案上重新运行。
- 传说的候选只接受 canonical T5 基座（`optimizationBaseStats` 等于 `BASE_CONFIGS` 基座）；
  烘焙了 Tuning 或非规范基座的件只能走残差路径。
- 固定异域的槽位 roll 是身份的一部分：只有框架与源配置相同的已拥有异域才能占用该槽，否则记为待刷。
- `PlanMacroProfile` / `PlanMacroId` 仅在 Inventory Planner 作用域内有效，不得用于全局去重或证书身份。
- 本版不修改 OAuth 配置、Bungie 写入行为，也不放宽可行性判定或证伪边界。
