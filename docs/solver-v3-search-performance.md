# Solver V3 搜索排序与资源调度审计

基线：`develop@07915dbd093a2eae30fc7d70a3c7fb32ad2eef0f`，开始时本地与
`origin/develop` 一致、工作区干净。无新增依赖，无模型、Oracle、剪枝或证书规则变更。

## 1. 当前瓶颈与 proof boundary

`inventory-solver.mjs` 的 exact reassignment 查询先遍历 mathematical quotient，
然后才运行 bounded physical ranking。`search-session.mjs` 对
`phase: exact-inventory` 明确豁免时间/节点预算；它不是一个 200 ms 或 3 s 的
有界否定查询。正常终止条件是找到可复核 witness，或者穷尽该 shard 的 quotient。
Worker termination 是运行中的取消机制。同步 fallback 无法在 JS 不让出线程时处理
DOM 取消，因此仍可能长时间阻塞。这不是本次引入的新保证。

每个候选保留真实 base、immutable tuning、class/set/Exotic/slot 和验证证据。
第一物理行先按身份 hash 分片，再压缩 quotient；不能先选全局代表再丢掉其它 shard
的实例。数学失败可以复用，数学成功需要还原物理实例并验证。Unknown 数据仍不能
获得完整负证明。Exact 存在性不是全局 ranking 最优性；`exactExistence: exhausted`
也没有被升级成一个新的 `INFEASIBLE_PROVEN` producer。

已审计调用链：Inventory → Upgrade evaluator → fixed-target / interval Oracle →
empty-tuning mask transformation；residual signed support bounds、modulo-5 residue
bounds、profile/session、client merge 和 worker adapter。Balanced 的 +1 来自三个
masterwork stats；directional 是同一个 +5/-5 耦合动作。0/200 是 clamp 的区间
preimage，Fragment 已由 contract 转换到 armor-domain bounds。

测得/确认的瓶颈：

- quotient 遍历依赖 Map 插入顺序，反转 inventory 可改变首个 witness 的位置。
- 原 UI 截到 4 Worker，client 再限制 1–8；两处都是资源政策，不是数学要求。
- 冷 Worker、传输、重复构建数学缓存、全库 witness merge/verification 的成本可超过
  小任务实际搜索成本。大 vault 不等于大 mathematical domain。
- 首次 `localeCompare` 在本机花 7–10 ms。内部排序键不需要启动 locale collation。
- 精细分片会再次构建 bounds/cache，并增加每-shard 总预算，不能免费视为提速。

## 2. Dynamic Pressure 模型与 rank

实现：`src/core/stat-pressure.mjs`。只接入 exact quotient 的 sibling traversal，
没有替换已经建立的 bounded ranking 排序，也没有增加 pruning。

对每个 DFS prefix、每个 stat：

1. 用当前 prefix 的 min/max 中点，加剩余 suffix min/max 中点，估计未分配贡献。
2. 相对 `armorMinimum/armorMaximum` 计算 deficit / surplus；null 表示没有该方向
   的约束，保留 Fragment 与 0/200 clamp 语义。
3. 把**一个 build 的 Mod 总量**按正 deficit 比例分摊到 target context。没有把
   50 点 Mod 预算加到每件 armor 上；分数分摊只是排序估计，不是合法赋值。
4. 用剩余 envelope 宽度归一化。中央半区内不给方向性压力，以免普通目标受到
   噪声引导。超出中央半区的距离产生带符号权重。
5. Candidate score 为真实 base 的 weighted sum，加上一个合法 Tuning 动作的最大
   weighted contribution：empty、Balanced，或合法 destination 对应的 +5/-5。
   使用解析 support 计算，避免枚举/分配大量临时向量。

最终 rank 是 `(-coupledPressureSupport, identityCodePointOrder)`。不是按框架名称或
Weapons=200 写分支。30/25/20/5 仅通过真实配置和 base 进入计算。高 stat 与低 stat、
多个高 stat 同时进入权重。显式 Balanced count=0/5 会关闭不可能的动作；1–4 的
共享数量在排序里只是 capability relaxation，准确的数量仍由原 Oracle 负责。

比较过逐候选的 worst-normalized-gap / squared-gap / preferred-distance 三元组：
极端状态数减少，但普通目标和排序开销回退，因此删除该实现。最终保留轻量 scalar
support 加确定性 tie-break。用于 A/B 的 `searchOrdering: baseline` 仅选择旧遍历，
不改变 ProblemSpec、搜索域或证据。

## 3. 为什么不影响 completeness

排序器只返回原 groups 的一个 permutation，不移除候选、equivalence class 或 branch。
原来的 physical ownership、unknown-data handling、residual/residue、class、Exotic、
4pc/2+2 判断以及 Oracle 全部保留。Pressure 不向 `canReach`、proof 或 certificate
传递任何数值。构造 suffix/quotient 的 domain 也没有改变。找到 witness 后停止 exact
existence 的行为是基线已有行为，不意味着物理 frontier complete。

完整固定赋值 enumeration 的 canonical Top-K 跨 input order / shard 数一致。
有预算/首个 witness 停止的查询只保证各 witness 的 canonical identity 和数学正确性，
不承诺不同 Worker 数会返回同一批 physical Top-K：基线本来就没有这个全局最优保证。

## 4. Adaptive Worker Scheduling

实现：`src/core/worker-scheduler.mjs`，UI 不再传固定 4，client 不再有正常 8-worker 上限。

`requestedWorkers` 默认取以下限制的最小值，至少保留一个执行路径：

- CPU hint 减余量：Fast 预留一半，Balanced 四分之一，Deep 八分之一，至少预留 1。
  `hardwareConcurrency` 只按 logical hint 使用，未知时按 2，不声称是物理核心数。
- Memory admission：每个 Worker 估计 `32 + itemCount * 0.025` MiB，来自冷线程与
  1300-item vault 的测量；最多借用 `deviceMemory / 8`，无 hint 时采用 512 MiB。
  这不是可用 RAM 或峰值内存保证。
- Task amortization：exact-first 使用 quotient-signature product 估算低成本访问；
  Deep/fuzzy 使用 physical product 估算完整 traversal。基线校准约为 0.002 ms / quotient
  combination 与 0.24 ms / physical evaluation。`sqrt(work / overhead / profileFactor)`
  选择可摊销的池规模；Fast/Balanced/Deep 的摊销因子分别为 8/3/1。
- Overhead 使用冷启动 100 ms、merge 10 ms 起始估计，并利用本 session 的实际 startup /
  merge 样本做 EWMA 更新。不会修改 solver 数学输入或 profile 预算。
- 首行可切分 domain；Worker 永远不多于 shard 数。显式 `parallelism` 可覆盖成本模型
  做 benchmark，但也不能超过估算的物理 domain。`shardCount` 可独立指定。

Scheduling signature 是便宜的 task-size 估计，**不是数学 equivalence key**。估计
错误最多造成调度不理想，不会删除搜索空间。256 是独立 emergency guard，防止坏 hint /
调用参数分配无限数组；不是正常硬件政策。高端机器没有固定 8-worker 政策。

这些参数是首版保守成本模型，不是已经在所有硬件上拟合出的万能公式。Device memory
hint 缺失/隐私取整时可能保守；UI responsiveness、OS scheduler 和真实可用内存不能从
浏览器 hints 精确预测。

## 5. Pool、故障、取消与 shard balance

先 admission/创建池，再分配原 shard coordinates。构造部分失败后停止继续扩池，已创建
Worker 继续领取原任务。Worker 可顺序处理多个 shard，池与 shard 数不再强制绑定。

- Worker API 不存在/file-offline → 原 inline adapter。
- 部分 constructor 失败 → 保留已创建池；未执行 shard 不丢失。
- error / messageerror / postMessage failure → 丢弃失败 attempt 的 coverage，重派该 shard
  给存活 Worker；记录 failed attempt effort。
- 全部 transport 失败 → 单个 sequential inline consumer 完成原分片。
- 10 秒仅是**启动 acknowledgement** deadline。Worker 在开始同步求解前确认启动，
  acknowledged exact query 没有新增运行超时。
- 显式 cancellation → AbortError、终止池、丢弃待派队列、屏蔽 stale replies；不能把
  cancellation 当作可重试 worker fault。
- 正常 solver 异常仍向调用者报告，不能隐藏为 transport 降级。

同一个成功 shard 不会重复执行。失败 shard 从头重试可能重复失败 attempt 已做的部分
工作，这是恢复代价，不是额外 coverage。每个 shard 仍拥有**完整原 profile 预算**。
增加 shard 数或重试会增加 aggregate effort；它们都不能升级负证明。

默认不增加 shard 数：测量尚未证明额外 bounds/cache/clone/verification 成本值得。
独立队列支持显式 finer partition 和降级，不实现递归 work stealing。物理 hash 仍可能
把同一个 mathematical class 分到多个 shard，形成重复数学工作；不能以“去重”为由
删除别的 shard 的 physical alternatives。

没有实现 firstExact 后取消 sibling 的新政策。Deep 继续搜索，其它 profile 保持原
exact-witness-quota/ranking 边界。单 Worker 保留原单 Worker 的完整结果/证明边界，
不为只有一个结果额外导入主线程 engine 或重复做跨-shard merge。

## 6. Web / Tauri / Offline

- Web：module Worker URL 仍由 Vite 从 `new URL(..., import.meta.url)` 打包。
- Tauri dev/production：`desktop/vite.config.mjs` 本来就是 `__OFFLINE_MODE__ = false`；
  CSP 本来允许 `worker-src 'self' blob:`，没有桌面版强制单线程的代码缺陷。
- Desktop production bundle + 实际 CSP 的浏览器验证通过，确认创建 Worker。
  没有声称运行了原生 Tauri/WebView2 安装包；不同 WebView2 版本仍需发布平台复测。
- 单文件 `file://` offline 包：仍强制同步。构建器把 lazy engine import 改为静态并
  内联资源，规避 file-origin module/Worker 限制。实际 Chrome/Edge file verify 通过。
  本次没有未经测量引入 blob bundle loader 或 Rust 重写。

## 7. Benchmark 方法与原始证据

Windows，Node 24.20.0，16 logical hardware hint，31.31 GiB 系统 RAM。
数据为合成 vault 和仓库既有 DIM fixture，不读取账号。原始 JSON 包含每轮数据。

先在未改核心代码时保存 `search-pressure-baseline.json` 和
`search-workers-baseline.json`。后续增加成对冷进程 A/B，交替 baseline/pressure 顺序，
抵消机器负载/冷启动漂移。最终基线开关运行完全相同数学代码，只有 ordering 不同。
早期 `late` fixture 与普通目标过于接近，最终改为 Balanced residue 的深序 witness；
因此最终成对数据为准，不能把两个不同版本的 late fixture 横向混算。

每例三次，pressure 默认相同 200 ms / 100k nodes / 10k states / 3k evaluations，
exact 阶段仍按已有 contract 穷尽或返回 witness。Worker 使用真正 Node worker_threads
适配器运行 production client + worker 代码；不是浏览器 Worker 吞吐的替代证明。
测试点由硬件生成：本机 1/2/4/6/8/10/12/14，另有 auto。

指标包括 firstExact/firstFeasible、exactStates、statesExamined、math evaluations/cache
hits、residue prunes、wall、aggregate nodes/rates、per-shard imbalance、startup、clone、
progressive/final merge、event-loop delay、进程 CPU 和 RSS。`mergeIncludesWitnessVerification`
明确 merge 时间包含全库复核，未把它伪装成单独精确的 verifier-only 时间。
RSS growth 是结束样本，maxRSS 是进程 OS high-water；不是 JS 每个 Worker 的独立峰值。
Timer delay 也是 event-loop proxy，不是 Chrome Long Tasks/逐帧性能 trace。

最终结果见下方表格及 `docs/benchmarks` 中 release 数据。前期 tuple/simple/final/control
文件是探索记录，不是另一次成功验收；其中非隔离试跑不作为最终 headline 数字。

## 8. Pressure 成对结果

`search-pressure-paired-release.json`，firstExact 为 core admission 时间，不含 client
启动/merge。没有 witness 的 firstExact 为 null；不得当作 0 ms 成功。

| Case | Exact states 旧→新 | firstExact 中位 ms 旧→新 |
| --- | ---: | ---: |
| Weapons 200 | 41→6 | 23.6→23.6 |
| Grenade 200 | 41→6 | 20.6→21.5 |
| Melee 200 | 41→6 | 22.6→22.0 |
| Weapons 180 + Grenade 180 | 41→6 | 18.4→17.9 |
| High Weapons / Super 0 + Fragment | 41→6 | 18.5→19.3 |
| Balanced target | 11→9 | 18.6→21.1 |
| Crowded duplicates | 6→7 | 44.7→45.3 |
| Late Balanced witness | 481→473 | 50.4→53.6 |
| No exact | 1→1 | —→— |
| Fixed Exotic + 4pc | 6→7 | 40.4→44.3 |
| 2+2 | 6→7 | 40.7→43.5 |
| Balanced Tuning | 481→473 | 53.7→52.5 |
| Directional | 11→9 | 18.0→18.8 |
| Empty Tuning | 11→6 | 39.3→31.0 |
| 1300 items | 11→9 | 149.8→161.8 |
| 5 items | 6→6 | 13.0→14.8 |
| Reversed inventory | 6→9 | 19.7→18.9 |

极端/multi-pressure 状态数下降 85.4%，但这些用例原本只需要一次昂贵 math evaluation，
所以不能声称 firstExact 普遍显著下降。普通目标约几毫秒差异；1300-item 用例有约
8% firstExact 回退，wall 中位为 299.0→307.9 ms。Empty Tuning 的 firstExact 改善约
21%。不同 input order 的新遍历状态数一致，原基线反转后偶然排中 witness 的优势
不再被当作稳定性能。No-exact 的结果/证明边界一致，排序没有减少合法搜索域。

## 9. Worker / Combined 结果

Fast 最终 `search-workers-release-fast.json`，三次中位。Auto 表示 scheduler
自行选择，不是强制 1。下表 firstExact 取 `search.firstExactMs`，包含启动/发布/复核。
早期 harness 把 core `searchStats.firstExactMs` 展开在顶层同名字段之后，因此单 shard
顶层值曾覆盖 client 时间；原始 `search.firstExactMs` 正确，harness 已修正字段顺序。

| Case / requested | effective | wall ms | client firstExact ms | RSS growth MiB | merge+verify ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small / auto | 1 | 257 | 115 | 24 | 0 |
| Small / 4 shards | 1 | 257 | 159 | 32 | 18 |
| Large / auto | 1 | 388 | 368 | 66 | 0 |
| Large / 4 | 4 | 612 | 579 | 328 | 129 |
| Large / 8 | 8 | 770 | 723 | 602 | 123 |
| Large / 14 | 14 | 1056 | 1007 | 1065 | 204 |
| Duplicates / auto | 1 | 292 | 146 | 43 | 0 |
| Duplicates / 4 | 4 | 345 | 255 | 143 | 58 |
| Duplicates / 14 | 14 | 517 | 484 | 437 | 66 |

这三种 Fast 任务均不值得过度并行。Large 强制 14 Worker 的 event-loop delay 中位
约 417 ms，默认 auto 约 29 ms。不能宣称强制高并行已经消除了主线程卡顿。
原 develop 的 10/12/14 测试点全部被 8 上限拒绝；现在真实线程能创建并正常完成。
小 inventory 的 explicit shard 数可以大于其有效 Worker 数，但不会为一件首行 armor
创建十四个同时工作的 Worker。

Deep 最终 `search-workers-verified-deep.json`：40-item fixed-assignment fuzzy 目标，
返回 verified positive，完整遍历 37,448 节点。所有组用同一 Deep profile，没有加预算。

| Requested | effective | wall ms | aggregate nodes | process CPU seconds | RSS growth MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| auto | 8 | 424 | 37448 | 3.313 | 204 |
| 1 | 1 | 1058 | 37448 | 1.233 | 29 |
| 2 | 2 | 675 | 37448 | 1.827 | 65 |
| 4 | 4 | 423 | 37448 | 2.078 | 107 |
| 6 | 6 | 515 | 37448 | 2.735 | 155 |
| 8 | 8 | 433 | 37448 | 3.469 | 204 |
| 10 | 8 | 415 | 37448 | 3.407 | 208 |
| 12 | 8 | 506 | 37448 | 3.484 | 213 |
| 14 | 8 | 447 | 37448 | 3.516 | 215 |

Auto 的 wall 改善约 2.5 倍，但总 CPU 花费约 2.7 倍。这是硬件利用，不是剪掉搜索域。
4 Worker 与 8 Worker 在该任务上接近，4 的 CPU/memory tradeoff 更好；Deep 的策略
选择 throughput 侧，仍有进一步校准空间。6/12/14 shard 的首行 hash 分布不整齐，
imbalance 分别约 1.5/1.5/1.75；queue 能复用 Worker，但不能拆开正在运行的重 shard。
没有因此在默认策略里额外增加 shards。

`search-workers-verified-balanced.json` 使用同一 fixture 的原 Balanced profile。
单 Worker 在 exact-witness-quota 停止：182 ms、297 nodes、firstExact 176 ms；
auto 4 Worker：458 ms、19,757 nodes、firstExact 292 ms。它提高覆盖而牺牲 latency，
并非毫无代价的优化。该差别包含每-shard quota/domain 影响，不可当作算法速度比。

历史 `search-workers-deep.json` 是较昂贵的未命中目标探索记录（约 74,896 nodes），
曾测得 11.2 s→3.5 s；但其中 fixture 的 modifier budget 不适用于 positive witness
验证，且开发中 scheduler 元数据曾变动。**不把它作为最终验收的性能证据**。
`search-workers-release-deep.json` 是零目标的中间校准；最终 Deep/ Balanced 采用
`verified-*` 数据。保留这些试验是为了审计，不挑最好看的数字当最终结论。

Combined 结果因此是：极端目标 search-order states 明显下降；Fast 自动避免无益的
多核开销；Deep 完整覆盖获得实际 wall throughput 提升。没有满足“所有 firstExact
都更快”的强表述，也没有证明所有高端 CPU 上当前调度公式都最优。

## 10. 验证、剩余边界与后续

最终完整 Node suite 已通过 **451/451**（161.4 秒，零失败/跳过）；新测试覆盖 pressure permutation、真实 tuning vectors、
Balanced 数量、反转 input/object keys、exact/no-exact、硬件/内存 hints、多 shard、
部分构造失败、runtime/postMessage/startup 失败、全失效 fallback、取消、12 Worker。
既有固定 Exotic、4pc、2+2、unknown、空 Tuning、96 个生成 exact witness 和独立穷举
测试继续通过。Upgrade 复核 50 plans；lint、Web build/browser smoke、desktop frontend /
CSP worker smoke、file-offline build/verify 均通过。最终 targeted suite 24/24；最终
Web build、desktop:test、verify:offline 和 lint 复跑通过。`git diff --check` 通过。
构建仍有既有大 chunk 警告，以及 offline 静态/动态导入合并警告，不影响验证通过。
没有执行 git commit/push，也没有变更账号数据或系统配置。

未宣称全面达到所有理想验收指标：

- Exact existence 最坏情况仍可能长时间运行，特别是无解且 bounds 不强时。
- 每个 Worker 仍复制 vault、Oracle/cache/residue 结构；不是零复制架构。
- 强制大量 Worker 的大库 merge 仍可能阻塞主线程，默认 admission 只降低风险。
- 内存 hints 不等于 free memory；OS 直接杀死整个 renderer 时，JS 不能保证恢复。
- 均衡目标、低压目标、不同硬件不保证单调提速。自动策略仍需更多真实机器校准。
- 目前只在一台 16-thread 主机测量 scaling，其它硬件是 scheduler simulation tests。
- Serialized shard evidence 不能合成为全局负证书；bounded Top-K 不具有跨预算的
  全局 deterministic optimum 保证。

Explore 可以在明确 enumeration/coverage contract 后复用独立 shard queue，前提是先
解决更细粒度工作分配的初始化代价和全库复核成本。当前 JS Worker 已显示可利用多核，
尚无证据要求 Rust/Rayon migration；先做浏览器/原生 WebView2 性能 trace、共享只读
prepared inventory、可恢复 exact cursor，会比立即重写数学模型更容易审计。

复现命令：

```text
npm test
npm run lint
npm run test:upgrade
npm run test:browser
npm run desktop:test
npm run verify:offline
node scripts/benchmark-search-performance.mjs pressure-paired release
node scripts/benchmark-search-performance.mjs workers release-fast
```

Worker benchmark 可设置 `BENCH_AUTO=1` 加自动调度，`BENCH_PROFILE=deep` 或 `balanced`
选择原 profile，`BENCH_CASES=throughput` 选择完整物理遍历，`BENCH_TRIALS=3` 控制重复。
一次只运行一个性能测量任务，不并发运行 tests/build。显式更改 shard 数会改变总 effort，
比较报告必须保留 `budgetScope: per-shard`。
