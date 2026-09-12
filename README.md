![D2 Armor Solver — Optimize your stats. Perfect your build.](./asset/d2-armor-brand.svg)

# Destiny 2 Armor Solver

[简体中文](README.md) · [English](README.en.md)

[![Release](https://img.shields.io/github/v/release/MIGO-OvO/d2-armor-solver?sort=semver)](https://github.com/MIGO-OvO/d2-armor-solver/releases/latest)
[![Checks](https://github.com/MIGO-OvO/d2-armor-solver/actions/workflows/validate.yml/badge.svg?branch=main)](https://github.com/MIGO-OvO/d2-armor-solver/actions/workflows/validate.yml)
[![Vite 8](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8D8?logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

面向《命运 2》Armor 3.0 的 T5 护甲配装工具：从六维目标推导护甲框架，从真实库存寻找组合，
或在现有配装上规划替换路径。支持生命、近战、手雷、超能、职业、武器六项属性，
并将碎片、调整模组、属性模组、异域与套装约束纳入同一求解模型。

**免费使用，无需注册本项目账号。如果你付费购买，说明你被骗了。**
求解在本机执行；Bungie 登录是在线版的可选功能，不是使用求解器的前提。

[开始配装](https://migo-ovo.github.io/d2-armor-solver/app/) ·
[使用说明](https://migo-ovo.github.io/d2-armor-solver/guide/) ·
[下载 Windows 版](https://github.com/MIGO-OvO/d2-armor-solver/releases/latest) ·
[项目门户](https://migo-ovo.github.io/d2-armor-solver/)

## 选择使用方式

| 版本 | 如何获取 | 库存来源 | 运行要求 |
| --- | --- | --- | --- |
| 在线稳定版 | [直接打开](https://migo-ovo.github.io/d2-armor-solver/app/) | DIM CSV；配置好登录的部署支持 Bungie 同步 | 现代浏览器 |
| 在线开发版 | [预览 develop](https://migo-ovo.github.io/d2-armor-solver/dev/app/) | DIM CSV / Bungie | 用于验证新改动，可能不稳定 |
| Windows 桌面版 | [下载 x64 安装包](https://github.com/MIGO-OvO/d2-armor-solver/releases/latest/download/d2-armor-solver-windows-x64-setup.exe) | DIM CSV，不提供 Bungie 登录 | Windows 10/11 x64，预装 WebView2 |
| 浏览器离线包 | [Actions 工件](https://github.com/MIGO-OvO/d2-armor-solver/actions/workflows/deploy-pages.yml)，或本地构建 | DIM CSV，不提供 Bungie 登录 | 解压后打开 `index.html`，推荐 Chrome / Edge |

Windows 安装包不需要 Node.js、Rust 或本地服务器；不捆绑或自动安装 WebView2。
建议使用 WebView2 120 或更新版本。安装器未签名，Windows 可能提示未知发布者；
请只从本仓库 Release 下载。桌面版没有自动更新器，升级需重新下载安装包。
更多要求见 [桌面版说明](docs/desktop.md)。

浏览器免安装 ZIP **不是当前 Release 附件**：push 构建生成的 Actions 工件保留 14 天，
下载通常需要登录 GitHub。解压工件中的 ZIP 后，用 `file://` 打开入口即可。
该版本不启动 Worker，大型库存搜索可能短暂阻塞界面；Firefox 的 `file://` 存储限制
可能导致草稿和保存方案无法持久保留。DIM 导出链接可以离线生成，但打开 DIM 等外链需要联网。

## 快速上手

1. 选择职业。可直接进行理论求解，也可从 DIM 导出 Armor CSV 后导入；在线版还可登录 Bungie 同步库存。
2. 选择「从零配装」或「优化现有配装」。后者可读取当前穿戴，也支持手动编辑五件护甲并固定不想替换的装备。
3. 设置六维目标、每项的优先级与规则：精确、至少、至多或区间；填入碎片属性变化与模组预算。
4. 按需要设置普通异域、异域职业物品特性和套装要求，再选择 Fast / Balanced / Deep 搜索。
5. 查看方案列表与详情，区分已拥有和待刷取的护甲，核对每件的调整、模组及替换步骤。
6. 保存方案，或导出 DIM 配装链接。在线 Bungie 库存方案只有满足执行条件时才可装备到游戏。

完整操作、结果栏解释和 FAQ 见 [三语使用说明](https://migo-ovo.github.io/d2-armor-solver/guide/)
（简体中文 / 繁體中文 / English）。

## 当前能力

- **从零配装**：推导五件护甲框架，计算可达范围、调整与模组分配，并展示目标差值。
- **库存规划**：解析 DIM 实例与已安装调整/模组，比较同名异域的不同实例，生成已有组合或「已有 + 待刷」方案。
- **异域与套装**：支持普通异域固定、待获取异域预留、异域职业物品特性，以及 2 件、4 件和 2+2 套装约束。
- **替换规划**：保留固定件，在硬规则约束下寻找替换路径；已经满足目标时可保留现有护甲。
- **统一结果工作区**：方案按达标情况与拥有度排序，提供五件详情、刷取需求、逐步替换和高级诊断。
- **已保存方案**：搜索、载入、重命名与可撤销删除；过期快照提示重新求解，不自动删除方案。
- **分阶段搜索**：支持进度、取消与预算选择；在线和桌面版通过 Web Worker 执行求解。
- **三语界面**：简体中文、繁體中文、English，配套独立指南和响应式布局。

## 如何理解求解结果

V3.1 复用 Solver V3 的整数约束模型与结果证书。
Fast / Balanced / Deep 只改变搜索预算和证明深度，不改变游戏规则。
**找到可行方案，不等于证明全局最优；搜索用尽预算，也不等于无解。**

| 结果状态 | 含义 |
| --- | --- |
| `EXACT_TARGET_PROVEN` | 返回方案的具体护甲、调整与模组可重算出精确目标 |
| `RULE_FEASIBLE_PROVEN` | 返回方案已满足所有硬规则 |
| `INFEASIBLE_PROVEN` | 已完成可信的搜索域证明，当前约束不可行 |
| `SEARCH_LIMIT_REACHED` | 搜索未穷尽；可能已有可行方案，但不能据此声称无解或全局最优 |
| `INVALID_INPUT` | 输入不符合模型要求，需要修正 |

数学证明和游戏内执行状态分别展示：
`VERIFIED` 表示执行证据完整且通过预检，`UNVERIFIED` 表示资料不足，
`BLOCKED` 表示实例或插槽等预检受阻，`NOT_APPLICABLE` 用于不适用执行检查的理论结果。
主六维展示数学总量；可安装总量属于执行诊断，不会覆盖数学结果。
库存证明与全局搜索完成度也独立记录。

模型、证明边界和搜索限制见 [架构说明](docs/architecture.md)、
[一致性审计](docs/v3-consistency-audit.md) 与 [分阶段搜索](docs/staged-search.md)。

### Bungie 装备到游戏的边界

- 需要在线登录、可用的实际护甲实例与应用写入权限；CSV 或理论框架本身不提供完整执行证据。
- 执行前核对职业、插槽、模组可用性、能量与固定调整；能量不足或不可写入的模组会提示跳过或受阻。
- 自定义方案使用转移、穿戴、写入模组的 API 序列；中途失败可能已完成部分操作，并非整套原子事务。
- 自定义方案保留当前分支职业、星相与碎片；只有碎片属性总和与角色当前配置一致时才允许直装。
- 仅处理护甲与护甲模组，不处理武器；异域职业物品需要特性匹配的真实实例，不能改写随机词条。
- 可读取并应用游戏内已保存配装；这不等于创建任意新的游戏内配装。
- 活动中 Bungie 可能拒绝写入，请在轨道、社交空间或离线状态操作；最终以预检、API 响应与回读结果为准。

## 本地开发

需要 **Node.js 22.13.0 或更新版本**与 npm；CI 使用 Node.js 22，依赖以 `package-lock.json` 为准。

```bash
git clone https://github.com/MIGO-OvO/d2-armor-solver.git
cd d2-armor-solver
npm ci
npm run dev
```

打开终端给出的地址：根路径是门户，`/app/` 是求解器，`/guide/` 是使用说明。
未配置 Bungie 环境变量也可开发和求解，只是不显示登录入口。

| 命令 | 用途 |
| --- | --- |
| `npm run build` / `npm run preview` | 构建到 `dist/` / 预览生产构建 |
| `npm run build:offline` | 构建到 `dist-offline/`，入口可通过 `file://` 打开 |
| `npm run check` | ESLint、Node 测试、替换规划回归、生产构建 |
| `npm run test:consistency` | 见证一致性与 V3 差分测试 |
| `npm run test:browser` | 构建并运行浏览器 smoke 与布局回归 |
| `npm run verify:offline` | 构建并验证 `file://` 离线版本 |
| `npm run benchmark:v3` / `npm run benchmark:inventory` | V3 / 真实规模合成库存性能测试 |
| `npm run desktop:dev` | 启动 Tauri 桌面开发环境 |
| `npm run desktop:test` | 桌面前端构建与浏览器契约验证 |
| `npm run desktop:build` | 构建 Windows x64 NSIS 安装包 |

浏览器测试需要本机 Chrome / Edge；无法自动发现时设置 `CHROME_PATH`。
桌面原生构建还需要 Rust stable MSVC、Visual Studio C++ Build Tools 与 Windows SDK。
安装包输出到 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`；
原生检查和断网验收步骤见 [桌面版说明](docs/desktop.md)。

## 项目结构

```text
d2-armor-solver/
├── index.html              # 门户入口
├── app/                    # 共享求解器 HTML 模板
├── guide/                  # 独立使用说明入口
├── src/
│   ├── app.mjs             # 界面状态与结果编排
│   ├── core/               # 约束、求解、DIM、Bungie、存储与内置数据
│   ├── workers/            # Worker 执行入口
│   └── styles/             # 门户、工作台与指南样式
├── desktop/                # React + TypeScript 桌面壳与共享界面桥接
├── src-tauri/              # Rust + Tauri 2、权限与安装器配置
├── asset/                  # SVG 品牌开屏、图标和静态资源
├── scripts/                # 构建、数据生成、回归与性能测量
├── tests/                  # 算法、库存、执行契约与测试样本
├── docs/                   # 架构、算法审计、基准与发布说明
└── .github/workflows/      # 校验、双渠道 Pages 与 Windows 发布
```

网页版是原生 JavaScript / HTML / CSS + Vite 静态应用。
桌面版使用 React 外壳挂载共享模板与求解模块，不是另一套算法，也没有将求解迁移到 Rust。

## 部署与分支

日常开发在 `develop`，稳定版本在 `main`。
[Pages 工作流](.github/workflows/deploy-pages.yml) 在这两个分支 push 时分别校验、构建，
将稳定版放在根路径、开发版放在 `/dev/`，合并发布到同一个 GitHub Pages 站点。
每个分支的 push 还生成浏览器离线 ZIP 工件，保留 14 天。

[Windows 工作流](.github/workflows/desktop-windows.yml) 在相关代码改动、PR 或手动触发时构建，
并在 Release 发布时附加 Windows 安装包。**Release 不会通过 Pages 工作流附加浏览器 ZIP。**
[校验工作流](.github/workflows/validate.yml) 覆盖 check、V3 benchmark、浏览器、离线与桌面前端验证。

其他静态托管可使用 `npm run build` 的 `dist/`。
仓库也提供 Cloudflare Static Assets 配置，运行 `npx wrangler login` 后可用 `npm run deploy` 发布；
未配置和登记对应来源时不启用 Bungie 登录。

### Bungie 部署配置与安全注意事项

当前构建读取 `BUNGIE_API_KEY`、`BUNGIE_OAUTH_CLIENT_ID`、
`BUNGIE_OAUTH_CLIENT_SECRET`；Pages 工作流从同名 GitHub Actions Secrets 注入。
Bungie 应用需要登记实际 Origin 和回调路径，并为装备操作启用 `MoveEquipDestinyItems`。
稳定站点回调为 `https://migo-ovo.github.io/d2-armor-solver/app/`；
本地开发回调为 `http://localhost:5173/app/`。
Origin 只包含协议、主机与端口，不含路径。

双渠道发布共用配置：开发版授权通过稳定回调转发到 `/dev/app/`，并继续校验 OAuth state。
离线与桌面构建不启用这些凭证。

**安全限制：当前实现将 OAuth client secret 编译进静态前端，访问者能够读取它。**
GitHub Secrets 只能保护构建前的值，不能让已发布的浏览器代码保密。
不要将这个部署方式视为能保守 confidential client secret 的架构；
生产部署应先评估 OAuth 安全方案，需要保密的令牌交换应放在可信服务端。
不要向源码、Issue 或日志提交真实凭证、授权码或访问令牌。本次文档说明不改变现有认证实现。

## 数据与隐私

- 求解在本机运行，不向本项目服务器上传目标、CSV 或方案；Bungie 登录、同步与装备会访问 Bungie 服务。
- 草稿、偏好与已保存方案使用本地存储。**清除站点或桌面应用数据会丢失这些内容。**
- 同源的稳定版与开发版共享语言偏好和已保存方案，草稿、计算模式与 OAuth 状态按渠道隔离。
- 桌面 WebView、不同浏览器与其他部署来源不自动共享或迁移数据。
- 护甲、模组、套装与碎片目录来自 Bungie Manifest，静态数据随项目版本更新，不保证即时跟随游戏热修。

## 版本与技术文档

当前源码版本为 **v3.1.0**：精确目标区间查询、库存搜索优化、统一方案工作区、
跨渠道保存方案与独立三语指南已落地。

- [v3.1.0 发布说明](docs/release-notes-v3.1.0.md) · [全部 Release](https://github.com/MIGO-OvO/d2-armor-solver/releases)
- [V3.1 优化与测量方法](docs/solver-v31-optimization.md) · [原始基准数据](docs/benchmarks/solver-v31.json)
- [算法优化说明](docs/algorithm-optimization.zh-CN.md) · [并行库存验证](docs/parallel-inventory-validation.md)

基准结果用于比较特定数据集与设备上的实现，不代表所有库存的响应时间或全局最优保证。

## 反馈与贡献

通过 [GitHub Issues](https://github.com/MIGO-OvO/d2-armor-solver/issues) 报告问题。
计算问题请提供版本/渠道、浏览器与系统、六维目标和规则、碎片与模组预算、
异域/套装/固定件设置，以及预期与实际结果。可附脱敏的最小 CSV 样本，**不要附 OAuth 令牌或完整认证响应**。

贡献前运行 `npm run check` 和 `npm run test:browser`；
涉及离线或桌面功能时补跑对应验证。建议以 `develop` 为目标分支提交 PR。

维护者：[@MIGO-OvO](https://github.com/MIGO-OvO) · 反馈群：1104108070。

## 许可与致谢

代码采用 [MIT License](LICENSE)。
感谢 [liheng-Huang](https://github.com/liheng-Huang/d2-armor-solver) 提供原始项目，
[Destiny Item Manager](https://destinyitemmanager.com/) 提供 CSV 导出与配装工作流，
以及 Bungie 提供 Manifest 与游戏数据 API。

Destiny、Destiny 2、相关商标和游戏美术归 Bungie 及相应权利人所有。
本项目为社区工具，与 Bungie 或 DIM 无隶属关系，也未获其官方认可。
