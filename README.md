# Destiny 2 T5 Armor Solver

[![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)](https://developer.mozilla.org/docs/Web/HTML)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/docs/Web/JavaScript)
[![Vite 8](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![GitHub Pages](https://img.shields.io/badge/在线使用-GitHub%20Pages-222?logo=github)](https://migo-ovo.github.io/d2-armor-solver/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## Overview

一个面向《命运 2》Armor 3.0 的 T5 六维属性配装计算器。输入目标属性、碎片变化和模组预算后，工具会枚举五件护甲的可行组合，给出实际总属性、理论可达范围和需要刷取的护甲框架。

项目是一个无后端、无前端框架的结构化静态站点。源码使用原生 ES Module，Vite 负责开发服务器与生产构建；
高开销求解在 Web Worker 中执行。界面支持简体中文、繁体中文和 English；草稿、已保存方案和已有护甲信息保存在当前浏览器的 `localStorage` 中。

## 在线使用

访问 GitHub Pages：[https://migo-ovo.github.io/d2-armor-solver/](https://migo-ovo.github.io/d2-armor-solver/)

浏览器数据按站点来源隔离。在 GitHub Pages、Cloudflare 部署地址和本地开发地址之间切换时，草稿及已保存方案不会自动迁移。

## Features

- 输入六维目标：生命、近战、手雷、超能、职业和武器。
- 根据碎片、+5/+10 模组以及可选的免费 +3 调整模式计算配装。
- 可锁定单项目标，实时检查六维目标是否可达，并显示每项的可达范围。
- 支持异域职业物品模式：选择职业及左右栏特性，锁定异域框架后计算其余四件传奇护甲。
- 显示目标与实际属性对比、理论极限、调整建议和逐件护甲框架需求。
- 录入已有护甲的第三属性与调整方向后，可按已拥有程度重新排序方案。
- 提供“优化现有配装”模式：录入当前五件 T5 护甲后，逐槽位计算单件替换收益，并给出优先替换、六维变化和模组重排建议。
- 保存、加载和清空配装方案；页面刷新后恢复当前草稿。
- 提供键盘焦点样式、跳转链接、`aria-live` 状态播报和 `prefers-reduced-motion` 支持。

## Getting Started

需要 Node.js 22.13.0 或更高版本。安装开发依赖后，可使用 Vite 启动本地服务器。

## Installation

### Run locally

克隆仓库并安装依赖：

```bash
git clone https://github.com/MIGO-OvO/d2-armor-solver.git
cd d2-armor-solver
npm install
```

Windows 用户可以直接双击项目根目录下的 `start_windows.bat`。脚本会在首次运行时自动安装依赖、启动本地服务器并打开浏览器；使用期间请保持脚本窗口开启，按 `Ctrl+C` 可停止服务器。

启动开发服务器：

```bash
npm run dev
```

按终端提示访问本地地址。ES Module 需要通过 HTTP 提供，因此不再支持直接双击源码 HTML；旧的 `destiny2-armor-solver.html` 路径保留为部署后的兼容跳转页。

### Deploy with GitHub Pages

推送到 fork 的 `main` 分支后，`.github/workflows/deploy-pages.yml` 会自动执行以下流程：

1. 使用 Node.js 22 安装锁定依赖；
2. 运行 lint、单元测试和替换规划回归；
3. 生成并检查 `dist/` 静态产物；
4. 将同一份 `dist/` 部署到 GitHub Pages。

也可以在 GitHub 仓库的 Actions 页面手动运行 `Deploy GitHub Pages` 工作流。当前 fork 的线上地址为 [https://migo-ovo.github.io/d2-armor-solver/](https://migo-ovo.github.io/d2-armor-solver/)。

### Deploy with Cloudflare Wrangler

项目已配置为通过 Cloudflare Workers Static Assets 部署。首次使用时安装依赖并登录 Cloudflare：

```bash
npm install
npx wrangler login
```

本地开发：

```bash
npm run dev
```

预览生产构建：

```bash
npm run build
npm run preview
```

部署到 Cloudflare：

```bash
npm run deploy
```

构建脚本会创建忽略版本控制的 `dist/` 目录，输出压缩且带内容哈希的 JavaScript/CSS、独立 Worker 和兼容跳转页，并复制静态资源。
GitHub Pages 和 Wrangler 使用完全相同的构建产物。Wrangler 按预构建静态站点处理 HTML 路径，并对不存在的资源返回 404；
配置中的项目名为 `d2-armor-solver`，如该名称已被当前 Cloudflare 账户中的其他 Worker 使用，请先修改 `wrangler.jsonc` 中的 `name`。

## Usage

### Basic workflow

1. 输入六维目标值；需要精确满足的属性可以勾选锁定。
2. 填写碎片变化，并设置 +5/+10 或 +3 模式。
3. 如需计算异域职业物品，打开异域模式并选择职业与特性。
4. 点击“求解最佳配装”。
5. 查看目标对比、可达范围、逐件框架需求，并在需要时录入已有护甲后重新排序。
6. 使用“保存当前配装”保留方案。

### Optimize an existing loadout

1. 切换到“优化现有配装”，逐件录入护甲框架、第三属性、调整和属性模组。
2. 将异域或不希望替换的护甲标记为固定。
3. 填写碎片变化和希望至少达到的六维目标。
4. 选择是否允许重新分配五件护甲的调整与属性模组。
5. 点击“分析优先替换”，查看无需换件判断、优先替换槽位、属性差值、刷取条件和单件收益排名。

## Repository Structure

```text
d2-armor-solver/
├── .github/workflows/deploy-pages.yml # GitHub Pages 检查与部署
├── index.html                         # 静态页面壳与语义化内容
├── src/
│   ├── app.mjs                        # 浏览器 UI Adapter 与工作台编排
│   ├── core/
│   │   ├── armor-engine.mjs           # 三个高层算法 Interface
│   │   ├── armor-model.mjs            # 护甲规则、目录和多语言数据
│   │   ├── solver.mjs                 # 配装求解 Implementation
│   │   ├── reachability.mjs           # 可达范围 Implementation
│   │   ├── upgrade-optimizer.mjs      # 替换规划 Implementation
│   │   ├── budget.mjs                 # 预算平衡动态规划
│   │   └── build-repository.mjs       # 版本化浏览器存储 Module
│   ├── workers/
│   │   └── armor-engine.worker.mjs    # 非阻塞算法 Adapter
│   └── styles/
│       └── app.css                    # 保持既有级联顺序的外部样式
├── tests/                              # Node 内置测试运行器测试
├── scripts/build.mjs                  # Vite 构建与静态资源复制
├── start_windows.bat                  # Windows 双击启动与自动打开浏览器
├── vite.config.mjs                    # 相对路径静态部署配置
├── wrangler.jsonc                     # Cloudflare 静态资源配置
├── CONTEXT.md                         # 领域词汇与不变量
└── docs/architecture.md               # Module、Interface 与依赖说明
```

## Technical Notes

- 求解器使用原生 JavaScript，在 Worker 中完成护甲框架组合、调整分配、可达范围和方案排序，避免阻塞主线程。
- `ArmorEngine` 仅暴露标准求解、可达范围和替换分析三个高层 Interface；算法 Module 不依赖 DOM 或浏览器存储。
- Vite 仅用于开发和构建，生产物仍是可部署到任意静态托管平台的 HTML/CSS/JavaScript。
- 运行时不向远端发送目标属性、保存方案或已有护甲数据。
- 清除浏览器站点数据会同时清除草稿和已保存方案。
- `npm test` 运行快速单元测试，`npm run test:upgrade` 运行完整随机替换规划回归；
  `npm run test:browser` 使用本机 Chrome/Edge 执行 Worker 与 390px 布局冒烟测试；
  `npm run check` 依次执行 lint、单元测试、替换规划回归和生产构建。

- UI 修改后仍应在桌面和 390px 窄屏下验证输入、求解、保存/加载和语言切换流程。

## Contributing

欢迎提交 Issue 或 Pull Request。请在变更说明中写清楚：

- 修改影响的计算规则或 UI 流程；
- 可复现问题的输入条件和预期结果；
- 是否验证了简体中文、繁体中文和英文界面；
- 是否验证了移动端布局和可达性提示。

## Reporting Issues

请前往 [GitHub Issues](https://github.com/MIGO-OvO/d2-armor-solver/issues) 提交问题或建议。涉及计算错误时，请附上目标六维、碎片、模组、异域设置和实际结果。

## License

本项目使用 [MIT License](./LICENSE) 发布。你可以自由使用、复制、修改、合并、发布、分发、再许可和销售本软件，但须在副本中保留版权和许可声明。

## Acknowledgements

- 《命运 2》及其 Armor 3.0 游戏规则资料；
- Web 平台原生 HTML、CSS 和 JavaScript；
- [Shields.io](https://shields.io/) 提供 README 徽章。

## Contributors

- **[liheng-Huang](https://github.com/liheng-Huang)** — 此前版本及源仓库作者。
- **[MIGO-OvO](https://github.com/MIGO-OvO)** — fork 维护者及后续贡献者，负责异域装备求解、可达范围分析、响应式 UI/UX 优化、多语言、已有护甲流程、无障碍改进、项目文档和 MIT 许可等工作。

## Contact

项目维护者：[@MIGO-OvO](https://github.com/MIGO-OvO)

如需讨论功能或计算规则，优先使用 [Issues](https://github.com/MIGO-OvO/d2-armor-solver/issues)。
