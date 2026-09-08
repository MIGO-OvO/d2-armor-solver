# Windows 离线桌面版

目标平台：Windows 10/11 x64。安装器为 NSIS `-setup.exe`，安装到当前用户，无须安装 Node.js、Rust 或启动本地服务器。没有数字签名，Windows 可能提示未知发布者；正式分发前建议由维护者使用自己的证书签名。

## 构建与开发

开发机需要 Node.js 22.13+、Rust stable（MSVC 工具链）、Visual Studio C++ Build Tools 与 Windows SDK。首次构建需要网络下载 Cargo 依赖和 NSIS，不再下载或捆绑 WebView2 安装器。

```powershell
npm ci
npm run desktop:dev
```

只预览 React 工作台（浏览器内，不启用原生外链功能）：`npm run desktop:ui`。

```powershell
npm run desktop:test
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run desktop:build
```

安装包输出：`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`。
`desktop-windows.yml` 可手动运行，main/develop 的相关代码变更也会构建，产物保留 14 天。新 Release 发布时会独立构建并附加 `d2-armor-solver-windows-x64-setup.exe`；不会更改 Pages 作业。v3.0.1 的离线包已由维护者替换为该安装包（原 HTML 离线 ZIP 从该 Release 移除，免安装 ZIP 改从 Actions 工件获取），原标签保持不变，源码提交在 Release 页面注明。

## 架构与兼容边界

- Rust + Tauri 2：原生窗口、窗口位置/尺寸记忆、安装/卸载和受限系统浏览器外链。
- React + TypeScript：桌面侧栏、工作台状态、三语桌面文案、快捷操作、初始化错误提示。
- `desktop/solver-bridge.ts`：在同一 WebView 中挂载共享 `app/index.html` 的可信静态模板，将语言控件移入左侧栏，参数和结果放入同一单栏内容流，再初始化已有应用。不是 iframe，也不访问在线网站。
- 现有表单和结果仍由 `src/app.mjs` 管理，未声称已将全部旧界面转换成 React 组件；React 不更新这棵 DOM 子树。后续可逐块迁移，避免同时维护两份算法与完整表单。
- 算法、DIM 解析、术语和内置数据继续复用 `.mjs` 模块。求解仍运行在 Web Worker，不是 Rust 算法移植；桌面版无需沿用 file:// ZIP 的主线程降级。
- 网页、原离线 ZIP 构建不变。桌面入口不读取部署环境中的 Bungie 凭证，不提供 OAuth、库存同步或装备到游戏。

## 桌面布局

左侧为固定导航与语言切换，右侧只有一个滚动区域：参数在上、结果在下，方案列表和详情也不再左右分栏。移除内容区重复标题和免费提示条，侧栏底部简短免费声明保留。默认 1440×900，可缩放、最大化，最小窗口 800×600；兼容 Windows 125%/150% 缩放。`Ctrl+Enter` 运行当前模式的搜索，搜索中可使用原停止按钮。颜色、图标与六维语义沿用项目既有设计，网页版 HTML/CSS 不变。

## 数据与离线说明

所有数据和字体资源打包在应用内；草稿、偏好、库存和已保存配装继续使用 WebView2 本地存储，位于此应用标识对应的用户数据目录。与 Chrome/Edge 网页或 file:// ZIP 的存储隔离，不自动迁移旧草稿，库存需要重新导入 DIM CSV。不要删除应用用户数据目录；清理该目录会丢失本地配装。

轻量安装包使用系统已安装的 WebView2 Runtime，`webviewInstallMode` 为 `skip`：不捆绑、不自动下载或升级运行时。目标电脑必须预先安装 WebView2；缺失时应用无法启动，用户需自行安装后再运行。已有运行时的电脑可以断网安装和使用求解器。应用无自动更新器，无运行时 CDN/API 依赖；用户主动点击 DIM、light.gg、GitHub 或作者主页时通过系统浏览器联网，离线时这些外链不可用。WebView2 本身的系统级更新行为不由本应用控制。

建议使用 WebView2 120 或更新版本，避免旧运行时无法正确显示现有界面使用的现代 CSS。安装器不强制检查或更新版本，已移除自定义离线升级脚本，也不设置会调用在线更新器的 `minimumWebview2Version`。生产 npm 依赖审计为零漏洞；原有开发工具依赖仍有 4 项 npm audit 告警（未在此次桌面化中扩大范围升级 Wrangler 等工具）。

CSP 限制网络、框架和插件内容，仅为旧模板及动态结果中的事件属性保留 `script-src-attr 'unsafe-inline'`，不允许任意内联脚本。原生能力仅允许打开列出的 HTTPS 域名，不授予文件系统或 shell 权限，外部网页禁止导航进主 WebView。

## 验证

`desktop:test` 用生产资源和同一 CSP 验证 Worker 求解、保存/恢复、模式切换、三语、CSV 文件选择、快捷键及 1920/1440/1280/1024/800/640 CSS px 下的横向溢出。截图在 `.audit/desktop/`。这些是浏览器回归，不等同于 Windows 10/11 全平台安装验收。

本机完成 `desktop:build` 后还可运行 `node scripts/verify-desktop-native.mjs`，用独立临时 WebView2 数据目录启动编译好的程序，通过临时调试端口验证实际 Tauri IPC、内嵌资源、CSP、Worker 求解和外链域名限制；结束后关闭该测试进程。仅测试进程启用远程调试，不修改分发配置。测试目录留在 `.audit/desktop/`。

发布前还应在预装 WebView2 的 Windows 10、11 虚拟机断网验证：安装、启动、真实 DIM CSV、关闭重开后的数据、125%/150% 缩放、外链和卸载/升级行为。未预装运行时的环境需要单独验证自行安装 WebView2 后的启动行为；安装器本身不会为其安装运行时。不要在主力机器通过删除现有 WebView2 来模拟干净环境。

参考：[Tauri Windows 安装配置](https://v2.tauri.app/distribute/windows-installer/)。
