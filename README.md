# Destiny 2 T5 Armor Solver

[![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)](https://developer.mozilla.org/docs/Web/HTML)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/docs/Web/JavaScript)
[![No build step](https://img.shields.io/badge/build-none-2ea44f)](#getting-started)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Overview

一个面向《命运 2》Armor 3.0 的 T5 六维属性配装计算器。输入目标属性、碎片变化和模组预算后，工具会枚举五件护甲的可行组合，给出实际总属性、理论可达范围和需要刷取的护甲框架。

项目是一个可直接打开的单文件网页，不依赖后端、打包器或第三方运行时。界面支持简体中文、繁体中文和 English；草稿、已保存方案和已有护甲信息保存在当前浏览器的 `localStorage` 中。

## Features

- 输入六维目标：生命、近战、手雷、超能、职业和武器。
- 根据碎片、+5/+10 模组以及可选的免费 +3 调整模式计算配装。
- 可锁定单项目标，实时检查六维目标是否可达，并显示每项的可达范围。
- 支持异域职业物品模式：选择职业及左右栏特性，锁定异域框架后计算其余四件传奇护甲。
- 显示目标与实际属性对比、理论极限、调整建议和逐件护甲框架需求。
- 录入已有护甲的第三属性与调整方向后，可按已拥有程度重新排序方案。
- 保存、加载和清空配装方案；页面刷新后恢复当前草稿。
- 提供键盘焦点样式、跳转链接、`aria-live` 状态播报和 `prefers-reduced-motion` 支持。

## Getting Started

按下面的安装和使用说明即可在本地运行；项目没有额外依赖或构建步骤。

## Installation

### Run locally

无需安装依赖。克隆仓库后，直接在浏览器中打开 `destiny2-armor-solver.html`：

```bash
git clone https://github.com/MIGO-OvO/d2-armor-solver.git
cd d2-armor-solver
```

也可以使用任意静态文件服务器（可选）：

```bash
python -m http.server 8000
```

然后访问 <http://localhost:8000/destiny2-armor-solver.html>。

## Usage

### Basic workflow

1. 输入六维目标值；需要精确满足的属性可以勾选锁定。
2. 填写碎片变化，并设置 +5/+10 或 +3 模式。
3. 如需计算异域职业物品，打开异域模式并选择职业与特性。
4. 点击“求解最佳配装”。
5. 查看目标对比、可达范围、逐件框架需求，并在需要时录入已有护甲后重新排序。
6. 使用“保存当前配装”保留方案。

## Repository Structure

```text
d2-armor-solver/
├── destiny2-armor-solver.html  # 完整的界面、数据和求解器逻辑
├── PRODUCT.md                   # 产品目标与设计约束
├── .impeccable.md               # 视觉与交互设计说明
├── .impeccable/                 # 设计参考截图与配置
└── README.md                    # 项目说明
```

## Technical Notes

- 求解器使用原生 JavaScript，在浏览器内完成护甲框架组合、调整分配、可达范围和方案排序。
- 运行时不向远端发送目标属性、保存方案或已有护甲数据。
- 清除浏览器站点数据会同时清除草稿和已保存方案。
- 由于项目没有自动化测试或构建脚本，修改后建议在桌面和移动尺寸下手动验证输入、求解、保存/加载和语言切换流程。

## Contributing

欢迎提交 Issue 或 Pull Request。请在变更说明中写清楚：

- 修改影响的计算规则或 UI 流程；
- 可复现问题的输入条件和预期结果；
- 是否验证了简体中文、繁体中文和英文界面；
- 是否验证了移动端布局和可达性提示。

## Reporting Issues

请前往 [GitHub Issues](https://github.com/MIGO-OvO/d2-armor-solver/issues) 提交问题或建议。涉及计算错误时，请附上目标六维、碎片、模组、异域设置和实际结果。

## License

本项目使用 [MIT License](LICENSE) 发布。你可以自由使用、复制、修改、合并、发布、分发、再许可和销售本软件，但须在副本中保留版权和许可声明。

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
