# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing codebase: static browser app built with Vite, no backend. Root `index.html` (app) will move to `app/index.html`; a new portal `index.html` takes the root. Portal is plain static HTML/CSS/JS (no framework), trilingual like the app.

## Users

《命运 2》玩家规划 Armor 3.0 六维属性配装，以简体中文用户为主。两类场景：

- 在线用户：直接打开网页使用，希望零安装、零配置，Bungie OAuth 登录获取真实库存。
- 离线用户：网络受限、希望数据 100% 留在本机、或在意隐私，下载离线 zip 后通过 `file://` 使用。

## Product Purpose

在根路径提供一个「官网主页式」门户页：让访客一眼理解这个工具是什么、为何可信，并在「在线使用」与「本地下载」两条路径间做出选择。求解器本体仍由现有应用承担，门户不重复求解功能。

## Positioning

命运 2 配装求解器中极少数同时提供「在线零安装」与「完全离线免服务器」两种使用方式的产品。离线版不访问任何 CDN、数据不出本机，是隐私诉求玩家的明确卖点。免费且带防骗警示（"如果你付费购买，说明你被骗了"）是既有品牌承诺。

## Operating Context

- GitHub Pages 根路径部署门户，应用在 `app/` 子路径。
- Bungie OAuth 重定向 URL 需从根路径改为 `app/` 子路径（用户需在 Bungie 应用后台重新注册；Cloudflare 部署不启用登录）。
- 离线包发布渠道：GitHub Releases（正式版，主入口）+ GitHub Actions 构建产物（每次 push，抢先体验，次入口）。
- 门户与应用同仓库同构建；应用保持三语（简中/繁中/英文）。

## Capabilities and Constraints

- 门户需支持简中/繁中/英文三语切换，与应用一致。
- 门户只做导航与说明，不内嵌求解逻辑。
- 在线入口跳转 `app/`；下载入口指向 Releases 最新离线 zip，次级指向 Actions 构建产物。
- 既有离线构建脚本假设根目录 `index.html` 是应用——应用移动到子路径后需同步调整构建脚本。
- 门户不能依赖构建注入的 secrets；Bungie 登录只在应用内。

## Brand Commitments

- 名称：命运2 T5配装求解器（Destiny 2 Armor Solver）。
- 完全免费；防骗警示是既有文案，必须保留。
- 视觉身份：深色「研究台 / loadout lab」，暖琥珀 `#f4b53d` 为唯一行动强调色，六维属性语义色（生命红、近战蓝、手雷绿、超能黄、职业紫、武器琥珀）。避免宣传页式大标题、花哨动效、过度圆角、游戏皮肤堆叠。
- 维护者 MIGO-OvO；原版作者与 QQ 群的致谢信息保留。

## Evidence on Hand

- `asset/web-input.png`：应用界面截图，可用于门户展示。
- `asset/PNG_51px/`：六维属性图标源文件。
- `README.md`：完整功能列表、部署说明、Bungie 登录配置步骤（OAuth 重定向变更需同步更新此文档）。
- 注意：README 引用的 `asset/web-*.png` 等图片已在工作区被删除（`git status` 显示 deleted），门户不应依赖这些缺失文件。

## Product Principles

1. 两条路径（在线使用 / 本地下载）必须在首屏一眼可辨，主次分明。
2. 免费 + 防骗是用户信任的锚点，优先于任何营销话术。
3. 门户保持与应用一致的深色实验室身份，不引入第二套视觉语言。
4. 下载渠道主次清晰：Releases 为主，Actions 抢先版为次。
5. 语言切换行为与应用一致，三语并存。

## Accessibility & Inclusion

- 与现有应用一致：键盘可操作、清晰焦点、`aria-live` 状态播报、390px 窄屏适配、WCAG AA。
- 支持减少动态效果偏好（`prefers-reduced-motion`）。
