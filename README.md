# Destiny 2 Armor Solver v2

[English](README.en.md) · [简体中文](README.md)

[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/docs/Web/JavaScript)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Deploy GitHub Pages](https://github.com/MIGO-OvO/d2-armor-solver/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/MIGO-OvO/d2-armor-solver/actions/workflows/deploy-pages.yml)
[![GitHub Pages](https://img.shields.io/badge/在线使用-GitHub%20Pages-222?logo=github)](https://migo-ovo.github.io/d2-armor-solver/)
[![Release](https://img.shields.io/github/v/release/MIGO-OvO/d2-armor-solver?display_name=tag&sort=semver)](https://github.com/MIGO-OvO/d2-armor-solver/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## Overview / 项目概览

面向《命运 2》Armor 3.0 的六维属性配装求解器。可以只算理论框架，看目标属性是否可达；也可以导入 DIM 护甲清单，或者登录 Bungie 直接读取库存，从已有装备里挑出最佳组合、守住套装约束，并列出还需刷取的护甲。

纯静态的浏览器应用，不需要注册本项目账号，也不需要后端。根路径是门户，提供在线和离线两个入口；求解器在 `app/` 子路径。目标属性、DIM 清单和保存的方案都只存在当前浏览器里。登录 Bungie 只是用来读取真实库存；方案完全由已有装备组成时，可以直接一键装备到游戏里。

## Live Site / 在线使用

门户：[https://migo-ovo.github.io/d2-armor-solver/](https://migo-ovo.github.io/d2-armor-solver/)

直接进入求解器：[https://migo-ovo.github.io/d2-armor-solver/app/](https://migo-ovo.github.io/d2-armor-solver/app/)

开发测试版：[https://migo-ovo.github.io/d2-armor-solver/dev/app/](https://migo-ovo.github.io/d2-armor-solver/dev/app/)

> `main` 对应稳定版，`develop` 对应开发测试版。两个在线版本共用语言偏好，但草稿、已保存方案和 Bungie 登录状态使用独立存储键，不会互相覆盖；其他部署来源之间也不会自动迁移浏览器数据。

![Destiny 2 Armor Solver 配装工作台](./asset/web-input.png)

## 离线使用 / Offline Use

完全离线的独立构建，无需 Node、npm 或服务器：

1. 直接下载 [最新 Release 离线包](https://github.com/MIGO-OvO/d2-armor-solver/releases/latest/download/d2-armor-solver-offline-v2.0.5.zip)，或在任意一次 push 的 [Actions](https://github.com/MIGO-OvO/d2-armor-solver/actions/workflows/deploy-pages.yml) 工件中获取抢先构建。
2. 解压后双击 `index.html`，通过 `file://` 协议在浏览器中打开即可使用。

离线包和在线版功能一致，只有一处不同：构建时不注入 Bungie secrets，登录入口因此是隐藏的。DIM CSV 导入、求解、保存方案都能完全离线跑；DIM Loadout 导出链接只是一段 URL，打开它仍然要联网。

浏览器支持：

- Chrome / Edge 完全支持。
- Firefox 通过 `file://` 打开时 `localStorage` 不可用，草稿和已保存方案不会在刷新后保留，应用其余功能不受影响。

离线构建走主线程（`__OFFLINE_MODE__` 下不会启动 Web Worker），重型库存求解时界面可能短暂卡住，属预期行为。数据 100% 留在本机，和在线版一样；离线版不访问任何 CDN。

## Changelog / 更新日志

### v2.0.5（最新版）

- 修复属性“至多 / 区间上限”规则：当目标总和低于预算、必须把溢出点数分配到别处时，被限制的属性不再被当作“差额最小”的倾倒目标，上限约束严格生效。
- 修复 2+2 双套装约束：两个套装选择器改为各自的选项，“另一个套装”的选择在重新渲染后保持不变，可以正常选择第二个套装效果。

### v2.0.4

- 修复目标属性规则执行：优先级与模糊约束（精确 / 至少 / 至多 / 区间）严格生效，替换规划优先把可刷护甲分配给必须达标属性，且不会为减少替换件数而破坏必须达标约束。
- 修复调整模组匹配：传说护甲的 `+5` 调整必须与方案一致，不一致时降级为待刷；异域护甲的 `+5` 方向仍可自由选择。
- 修复 Bungie 一键装备：角色栏位已满时自动把非方案装备移开；逐件装备失败按单件记录而非整体中止，逐插槽写入失败软处理；应用后回读档案校验实际插槽。

### v2.0.3

- 新增门户首页，求解器迁移到 `app/` 子路径；根路径门户提供在线 / 离线双入口与三语切换。
- 新增 Bungie OAuth 登录与真实库存：跨平台存档解析、护甲目录预生成与库存去重，完全由已有实例组成的方案可一键装备到游戏。
- 从零配装为六维目标新增优先级（高 / 中 / 低）与模糊约束（精确 / 至少 / 至多 / 区间），按优先级顺序最大化可达值并兼顾其余属性。
- 重构属性模式控件：符号徽章改为带标签的优先级 / 规则控件，库存同步移出账号菜单并每 10 秒自动刷新。
- 修复 Bungie 库存的模组重复计数、实际总属性与 DIM 导出对齐、跳过模组、单异域约束与保险库栏位恢复等问题。

### v2.0.2 算法优化

- 优化已有配装替换规划：必须达标属性满足后，优先选择更少替换件的方案。
- 规划种子保留已有护甲，确保精确替换组合能被找到。
- 新增“仅 +5/-5 调整”选项。

### v2.0.1 优化版

- 更名“命运2 T5配装求解器·优化版”，更新页脚署名（Ver 2.0.1）。
- 修复 DIM 导入：无调整 / 属性模组的裸护甲正确解析固定 +5 属性。
- 异域职业物品按固定 `30/25/20` 框架（框架 + 第三属性）识别。
- 规划匹配不再因 +5 属性差异拒绝已有件；以整组可行性判定（固定 +5、自由 -5、自由模组）决定匹配，不可行件降级为待刷。

### v2.0.0 库存规划

v2 围绕“真实库存配装”做了大幅升级：

- 支持导入 DIM Armor CSV，识别职业、栏位、Tier、异域、当前穿戴、基础属性、套装和大师等级。
- 从 DIM 显示属性中推断已安装的 `+3` / `+5/-5` 调整与 `+5` / `+10` 属性模组。
- 新增已有护甲求解：优先使用库存中的精确匹配件，并明确显示仍需刷取的栏位、框架和调整方向。
- 支持普通异域固定、异域职业物品，以及同名异域多件之间的最接近属性比较。
- 支持指定套装 `4 件套`、`2 件套` 和 `2+2` 双套装约束；内置 56 组 Bungie Manifest 套装数据。
- 已有护甲方案可导出为 DIM 配装链接，并携带护甲实例、属性模组和调整模组设置。
- “优化现有配装”支持必须达标属性、真实护甲分布、固定件和按收益排序的替换计划。
- 重做 DIM 导入、库存结果和替换规划界面，完善桌面端、390px 窄屏、键盘焦点和状态反馈。
- 求解、可达范围、库存搜索和替换分析均通过 Web Worker 执行，避免阻塞主界面。

完整版本说明见 [v2.0.0 Release](https://github.com/MIGO-OvO/d2-armor-solver/releases/tag/v2.0.0)。

## 核心功能

### 从零配装

- 设置生命、近战、手雷、超能、职业和武器六维目标。
- 为每个属性设置优先级（高 / 中 / 低）与模糊约束（精确 / 至少 / 至多 / 区间），求解器按优先级顺序最大化可达值并兼顾其余属性。
- 应用碎片属性变化、`+5` / `+10` 属性模组和 `+3` / `+5/-5` 调整。
- 可锁定目标，或限定方案只使用 `+5/-5` 调整。
- 枚举五件护甲框架，显示目标差值、理论可达范围和刷取需求。
- 支持异域职业物品的职业、左右栏特性及固定 `30/25/20` 框架。

### DIM 库存规划

- 按职业和 Tier 5 筛选已导入护甲。
- 优先匹配已有护甲，再按刷取件数和属性接近程度排序方案。
- 固定普通异域的部位与名称；同名多件会自动比较框架、第三属性和调整。
- 为目标方案指定套装要求，并确保库存组合或刷取建议满足件数约束。
- 查看完全由已有护甲组成的方案，或查看“已有 + 待刷”的混合规划。

### 优化现有配装

- 从 DIM 当前穿戴自动填入五件护甲，也可以逐件手动配置。
- 异域或不希望替换的装备可固定保留。
- 为关键属性勾选“必须达标”，优先满足硬约束后再比较总缺口。
- 输出当前状态、替换后六维、逐步替换顺序、调整分配和属性模组分配。
- 当现有装备已经足够时，会明确给出无需刷取的保留方案。

### Bungie 一键装备（在线版）

- Bungie 登录并导入真实库存后，完全由已有实例组成的方案会显示“装备到游戏”。同职业有多个角色时可选择目标角色。
- 点击前会检查五件实例、职业、异域职业物品词条、模组解锁状态、精确插槽和护甲能量；能量不足的属性模组会明确列为跳过项。
- 自定义求解结果按 `TransferItem → EquipItems → InsertSocketPlugFree` 应用。Bungie 公共 API 不提供创建任意游戏内配装的端点；`EquipLoadout` 仅用于直接应用玩家已经在游戏内保存的配装。
- 游戏内已保存配装会从 `CharacterLoadouts` 读入，可直接应用，也可把其中的护甲、模组与碎片属性载回优化器编辑。
- 自定义方案会保持目标角色当前的副职业、星象和碎片。当前 UI 只保存碎片属性总和，无法无歧义反推出具体碎片，因此仅当总和与该角色当前精确配置一致时允许直装；需要完整切换副职业配置时请直接应用游戏内已保存配装。

使用限制：

- 角色必须在轨道、社交空间或离线；活动中 Bungie 会拒绝装备写入。
- 写操作依赖 Bungie 应用后台启用 `MoveEquipDestinyItems`。Bungie OAuth URL 不接受 `scope` 参数，权限由应用注册固定。
- 能量不足时对应模组会被跳过并显示数量；应用不会主动更换护甲元素，也不会承诺涉及材料消耗的操作成功。
- 异域职业物品只能穿戴词条完全匹配的现有实例，不能改写随机词条。
- 只处理五个护甲槽与护甲模组，不处理武器、幽灵等其他槽位。手动序列中若中途发生 API 错误，界面会明确提示可能已经完成部分转移或穿戴，避免误报为整套成功。

### 其他能力

- 简体中文、繁体中文和 English 界面。
- 草稿、语言、模式和命名方案自动保存在 `localStorage`。
- 支持减少动态效果、键盘操作、清晰焦点和 `aria-live` 状态播报。
- GitHub Pages 与 Cloudflare Workers Static Assets 使用同一份生产构建。

## Usage / 导入与导出 DIM

### 导入护甲清单

在 DIM 中依次进入：

```text
DIM → Settings → Spreadsheets → Armor → Export CSV
```

回到求解器后点击“选择 DIM CSV”。文件仅在浏览器内解析，不会上传到服务器。

导入后建议依次完成：

1. 选择职业并决定是否只使用 Tier 5 护甲。
2. 如需固定普通异域，选择异域部位和名称。
3. 设置六维目标、碎片和套装约束。
4. 运行求解，比较已有件和待刷件。

### 导出 DIM 配装

完全由已有护甲组成的方案可以生成 DIM Loadout 链接。链接包含 DIM 实例 ID、属性模组和调整模组；打开前请确保浏览器已经登录 DIM。

DIM 会忽略账号未拥有的模组，应用模组前护甲也需要满足游戏内能量与大师等级要求。

## Getting Started / 本地运行

### 环境要求

- Node.js `22.13.0` 或更高版本
- npm
- 可选：Chrome 或 Edge，用于浏览器回归测试

### Installation / 安装

```bash
git clone https://github.com/MIGO-OvO/d2-armor-solver.git
cd d2-armor-solver
npm ci
```

### 开发服务器

```bash
npm run dev
```

根据终端提示打开本地地址。Windows 用户也可以运行 `start_windows.bat`，脚本会安装缺失依赖并打开浏览器。

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动 Vite 开发服务器 |
| `npm run build` | 生成 `dist/` 生产构建 |
| `npm run build:offline` | 生成只含求解器的 `dist-offline/` 离线构建 |
| `npm run preview` | 本地预览生产构建 |
| `npm run lint` | 运行 ESLint |
| `npm test` | 运行确定性算法测试 |
| `npm run test:upgrade` | 运行随机替换规划回归测试 |
| `npm run test:browser` | 使用本机 Chrome/Edge 验证 Worker、交互和 390px 布局 |
| `npm run verify:offline` | 构建并通过 `file://` 验证离线版 |
| `npm run check` | 依次执行 lint、测试、替换回归和构建 |
| `npm run deploy` | 使用 Wrangler 部署 Cloudflare 静态资源 |

## 项目结构

```text
d2-armor-solver/
├─ .github/workflows/        # GitHub Pages 持续部署
├─ app/
│  └─ index.html             # 在线求解器页面（/app/）
├─ asset/                    # 图标源文件与 README 配图
├─ docs/architecture.md      # 模块、Worker 与存储边界说明
├─ scripts/
│  ├─ build.mjs              # 生产构建与静态资源处理
│  ├─ build-offline.mjs      # 单入口、可通过 file:// 运行的离线构建
│  ├─ verify-offline.mjs     # 离线包浏览器验证
│  ├─ browser-smoke.mjs      # 浏览器端回归检查
│  └─ fetch-armor-mod-data.mjs
├─ src/
│  ├─ portal.mjs             # 门户三语切换
│  ├─ app.mjs                # 浏览器工作台与界面编排
│  ├─ core/
│  │  ├─ armor-engine.mjs    # 求解器统一接口
│  │  ├─ dim-csv.mjs         # DIM CSV 解析与模组推断
│  │  ├─ inventory-solver.mjs # 已有护甲组合搜索
│  │  ├─ inventory-plan.mjs  # 已有/待刷混合规划
│  │  ├─ bungie-api.mjs      # OAuth、请求、限流与错误分类
│  │  ├─ bungie-inventory.mjs # Bungie 库存与实例/插槽映射
│  │  ├─ bungie-loadout.mjs  # 装备预检、写入序列与已保存配装
│  │  ├─ armor-sets.mjs      # 套装目录与激活规则
│  │  └─ upgrade-optimizer.mjs
│  ├─ workers/               # 非阻塞算法 Worker
│  └─ styles/
│     ├─ portal.css          # 门户视觉与响应式样式
│     └─ app.css             # 求解器响应式界面样式
├─ tests/                    # 算法、DIM、库存和结构测试
├─ index.html                # 根路径门户页面
└─ package.json
```

更详细的模块关系见 [架构说明](./docs/architecture.md)。

## 部署

推送后，[Deploy stable and development Pages](.github/workflows/deploy-pages.yml) 会：

1. 每个分支的 push 都构建离线 zip，并作为保留 14 天的 Actions 工件上传，供抢先体验。
2. `main` 与 `develop` 分别安装锁定依赖并执行 `npm run check`，构建时注入各自的通道名和提交号。
3. 将 `main` 的门户与求解器放在根路径和 `/app/`，将 `develop` 的完整构建放在 `/dev/`；门户的“在线使用”始终指向稳定版，并额外提供开发测试版入口。
4. 验证两套入口、兼容跳转、静态资源与 `versions.json` 后，将组合产物发布到同一个 GitHub Pages 站点；发布 Release 时，离线 zip 会自动附加到该 Release。

分支约定：日常开发提交到 `develop`，实机验证通过后再合并到 `main`。任一通道发布失败时，GitHub Pages 会继续保留上一次成功部署，不会用不完整产物覆盖在线版本。

Cloudflare 部署使用：

```bash
npx wrangler login
npm run deploy
```

`dist/`、`node_modules/`、Wrangler 本地状态和 Agent 工作文件均被排除在版本控制之外。

## 数据来源、隐私与免责声明

- 护甲套装、物品哈希和模组数据来自 Bungie Manifest；生成后的静态数据随版本发布。
- Destiny、Destiny 2、相关名称、商标和游戏美术资源归 Bungie 及其权利人所有。
- 本项目与 Bungie、Destiny Item Manager 没有隶属或官方认可关系。
- 应用运行时不会把目标、清单或配装发送到项目服务器。
- 清除当前站点的浏览器数据会同时删除草稿和已保存方案。

## Bungie 登录设置

Bungie 登录（OAuth）用于获取真实库存，需要部署侧预先配置。注册与配置由仓库维护者手动完成，步骤如下：

1. 打开 [bungie.net/en/Application](https://www.bungie.net/en/Application) 创建 Bungie 应用：
   - 客户端类型选择 `Confidential`。
   - Redirect URL 注册 `https://migo-ovo.github.io/d2-armor-solver/app/` 与 `http://localhost:5173/app/`。
   - Origin 注册 `https://migo-ovo.github.io` 与 `http://localhost:5173`。Origin 只包含协议、主机和端口，不包含 `/d2-armor-solver/app/` 路径；浏览器发起请求时的 Origin 必须与登记值一致（不支持通配符），否则 Bungie 会以 CORS 拒绝。
   - 从旧版升级时，必须把原先指向仓库根路径的 Redirect URL 改为上述 `app/` 子路径，否则 OAuth 回调会落到门户而无法完成登录。
2. 从应用页面取得三件套：`API Key`、`OAuth Client ID`、`OAuth Client Secret`。
3. 在应用后台启用 `MoveEquipDestinyItems` 权限；未启用时库存读取仍可成功，但转移、穿戴和写入模组会返回权限错误。修改权限后让玩家重新登录。
4. 在 GitHub 仓库 → `Settings → Secrets and variables → Actions` 添加稳定版 secrets：`BUNGIE_API_KEY`、`BUNGIE_OAUTH_CLIENT_ID`、`BUNGIE_OAUTH_CLIENT_SECRET`。
5. 开发测试版复用上述 Bungie 应用与 GitHub Secrets。Bungie 仍回调已登记的稳定路径 `/app/`；组合发布产物会识别带 `develop.` 前缀的 OAuth state，并立即把授权码与 state 原样转发到 `/dev/app/`，再由开发版完成原有 state 校验。稳定版 state 不会被转发。
6. Cloudflare 部署默认不启用 Bungie 登录（该来源未在门户注册）。构建未配置对应 secrets 时仍然成功，登录与“装备到游戏”入口自动隐藏；离线构建会强制清空这些配置。

> 请勿在仓库、Issue 或任何文档中提交真实 secret 值；GitHub Secrets 只在 Actions 运行期间注入构建过程。

## 质量保证

发布前质量门禁覆盖：

- 护甲规则、预算平衡、可达范围和替换规划。
- DIM CSV 的 BOM、引号、CRLF、多语言字段和真实属性推断。
- 套装成员、`2 件 / 4 件 / 2+2` 约束和固定异域。
- 同哈希不同实例、已有件优先级和待刷建议。
- Worker 请求、模式切换、目标同步和 390px 响应式布局。
- Bungie 写入请求体、部分应用错误、能量跳过、已保存配装，以及浏览器端写入路由 mock。

## Issues and Contributing / 反馈与贡献

欢迎通过 [GitHub Issues](https://github.com/MIGO-OvO/d2-armor-solver/issues) 报告问题或提出建议。计算错误请尽量附上：

- 六维目标与碎片变化
- 模组、异域和套装设置
- DIM CSV 中相关装备的栏位与属性
- 预期结果和实际结果
- 浏览器与操作系统版本

提交 Pull Request 前请运行：

```bash
npm run check
npm run test:browser
```

## License

本项目使用 [MIT License](./LICENSE) 发布。

## Acknowledgements / 致谢

- [liheng-Huang](https://github.com/liheng-Huang) 提供初始版本与源仓库。
- [MIGO-OvO](https://github.com/MIGO-OvO) 维护当前 fork 与后续版本。
- [Destiny Item Manager](https://destinyitemmanager.com/) 提供护甲清单导出与 Loadout 工作流。
- Bungie 提供 Destiny 2 Manifest 与游戏数据接口。

## Contact / 联系方式

维护者：[@MIGO-OvO](https://github.com/MIGO-OvO)

功能和计算规则讨论请优先使用 [GitHub Issues](https://github.com/MIGO-OvO/d2-armor-solver/issues)。
