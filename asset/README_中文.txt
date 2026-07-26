Destiny 2 Armor 3.0 六维属性图标资源包
=====================================

包含图标
--------
武器 Weapons
生命 Health
职业 Class
近战 Melee
手雷 Grenade
超能 Super

目录说明
--------
PNG_51px/       51×51 透明 PNG，游戏 UI 原尺寸
PNG_512px/      512×512 透明 PNG，便于排版（最近邻放大，不是官方高清源）
SVG_Trace/      可编辑的单色矢量描摹版（不是 Bungie 官方 SVG）
Source_Proxy_WebP/  为透明通道恢复保留的代理源文件
preview.png     六图标预览
metadata.json   Stat Hash、CDN 路径、校验值和获取方式
Official_CDN_Links.txt  官方 CDN 直链清单

来源与准确性
------------
定义来源：DestinyStatDefinition
Manifest 版本：236192.25.08.13.2000-2-bnet.61421（2025-08-19）
截至 Manifest.Report 可见的 2026-02-10 历史记录，这六项定义没有再次修改。

Health、Grenade、Weapons 的 PNG 为 Bungie CDN 直接下载文件。
Super、Class、Melee 因下载代理限制，使用指向同一 Bungie CDN 文件的透明 WebP 代理；
经对照测试，代理保留的 alpha 通道与可直接下载的官方 PNG alpha 完全一致，随后重新编码为白色透明 PNG。
因此三者图形轮廓和抗锯齿透明度一致，但文件字节不等同于 Bungie 原始 PNG。

SVG 说明
--------
SVG_Trace 内文件由 51px PNG 的透明通道轮廓自动描摹，适合 Figma、Illustrator、网页或排版编辑。
它们是本资源包生成的衍生矢量，不是 Bungie 发布的官方矢量源文件。

版权
----
Destiny、Destiny 2、相关名称、商标及游戏美术资源归 Bungie 及其权利人所有。
本包仅整理资源来源与格式，使用时请遵守适用的 Bungie 品牌、内容和知识产权政策。
