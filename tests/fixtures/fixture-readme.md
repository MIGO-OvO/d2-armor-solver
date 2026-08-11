# profile-fixture.json 说明（T7 fixture）

## 来源

`profile-fixture.json` 是**真实 Bungie GetProfile 抓包 + 自动脱敏**的产物：

- 通过 OAuth 授权的访问令牌调用 `GET /Destiny2/GetMembershipsForCurrentUser/`
  取得账号档案，再对 cross-save 主号（或首个 membership）调用
  `GET /Destiny2/{membershipType}/Profile/{membershipId}/?components=Profiles,ProfileInventories,Characters,CharacterInventories,CharacterEquipment,ItemInstances,ItemSockets,ItemPlugStates`
  （`ARMOR_COMPONENTS` 的 8 项）。
- 原始响应（含完整 `itemComponents`）经 `scripts/capture-profile-fixture.mjs`
  的 `sanitizeProfileFixture` 脱敏后写入本文件，可安全提交到仓库。
- 该 fixture 是 T8/T9（`src/core/bungie-inventory.mjs`）测试的**唯一数据源**；
  CI 永远不会调用真实 Bungie API。

## 再生成步骤

1. **注册 Bungie 应用**：打开 [bungie.net/en/Application](https://www.bungie.net/en/Application)，
   客户端类型选择 **Confidential**；Redirect URL 与 Origin 注册
   `http://localhost:5173/`（本地开发地址）。取得 **API Key**、**OAuth Client ID**、
   **OAuth Client Secret**。
2. **获取 OAuth 刷新令牌**：本地 `npm run dev` 启动应用并完成一次 Bungie 登录
   （获取与刷新令牌均只在浏览器内进行），从浏览器 localStorage 的
   `d2_armor_bungie_token_v1` 中复制 `refresh_token`。令牌会轮换，抓取后旧
   刷新令牌即失效；如需再次抓取需重新登录复制。
3. **运行抓取脚本**（Windows PowerShell，一次设置全部环境变量）：

   ```powershell
   $env:BUNGIE_API_KEY="<api key>"; $env:BUNGIE_OAUTH_CLIENT_ID="<client id>";
   $env:BUNGIE_OAUTH_CLIENT_SECRET="<client secret>";
   $env:BUNGIE_OAUTH_REFRESH_TOKEN="<refresh token>";
   node scripts/capture-profile-fixture.mjs
   ```

   成功输出：`Fixture written: N items, M instances sanitized`，产物为
   `tests/fixtures/profile-fixture.json`。缺少任一必需环境变量时脚本打印中文
   提示并 exit(1)。

> 注意：Bungie 不提供 client-credentials 授权；访问令牌只能由真实用户登录
> 产生的刷新令牌换取（1 小时有效期）。脚本的 happy path 因此依赖步骤 2。

## 脱敏规则清单（`sanitizeProfileFixture`）

| 数据 | 处理 |
| --- | --- |
| `instanceId`（16-20 位数字字符串） | 替换为递增占位 `"1000000000000000NNN"`，保持字符串类型；同一实例在物品列表与 `itemComponents`（instances / sockets / plugStates 的键）中替换为**同一个**占位 |
| `displayName` / `bungieGlobalDisplayName` / `lastSeenDisplayName` / `uniqueName` / `normalizedName` / `psnDisplayName` / `xboxDisplayName` / `fbDisplayName` / `blizzardDisplayName` | 替换为 `"MockGuardian"` |
| 其它长数字字符串（`membershipId`、`characterId`、BungieNet 账号 id 等，≥15 位纯数字） | 保留长度，打码为 `"9<零填充序号>"`（字符键与对应字段值保持一致） |
| `itemHash`、stats 数值、`bucketHash`、`plugHash`、`statHash`、`energyCapacity` 等**所有数字** | **不做任何修改**（测试断言的数据） |
| 短数字字符串（stat hash 键等 10 位） | 不做任何修改 |

## 断言要求（capture 产物必须满足）

生成后运行 `node --test tests/capture-fixture.test.mjs tests/bungie-inventory.test.mjs`
确认映射与去重逻辑，并核对以下内容（`node -e` 快速检查示例）：

```bash
node -e "const f=require('./tests/fixtures/profile-fixture.json');const d=f.Response.data;const inst=d.itemComponents.instances.data;const plugs=[...Object.values(d.itemComponents.plugStates.data)].flatMap(p=>p.plugs||[]).map(p=>p.plugHash);const sockets=[...Object.values(d.itemComponents.sockets.data)].flatMap(s=>s.sockets||[]).map(s=>s.plugHash);const ids=new Set([...Object.values(d.profileInventory.data.items),...Object.values(d.characterInventories.data).flatMap(c=>c.items),...Object.values(d.characterEquipment.data).flatMap(c=>c.items)].map(i=>i.itemInstanceId));const has=id=>ids.has(String(id));const mw=Object.values(inst).filter(i=>i.energyCapacity&&i.energyCapacity.energyCapacity===10);console.log('exotic class item',Object.values(d.profileInventory.data.items).some(i=>i.bucketHash===1585787867)||Object.values(d.characterEquipment.data).some(c=>c.items.some(i=>i.bucketHash===1585787867)));console.log('masterwork10',mw.length,'mod+10',plugs.concat(sockets).includes(4183296050),'tuning',plugs.concat(sockets).some(h=>h===1735777505||h===2125798995),'weapons',Object.values(d.profileInventory.data.items).some(i=>![3448274439,3551918588,14239492,20886954,1585787867].includes(i.bucketHash)));"
```

（+10 属性模组 / tuning 模组 hash 见 `src/core/armor-mods.data.mjs` 的
`STAT_MOD_HASHES` / `TUNING_MOD_HASH_BY_TUNING` / `BALANCED_TUNING_MOD_HASH`。）

必须包含：

- 至少 1 件**异域职业物品**（`bucketHash` 1585787867，rarity Exotic / tierType 6）；
- 至少 1 件**大师 10 护甲**（`energyCapacity.energyCapacity === 10`）；
- 至少 1 个 **+10 属性模组**（plugHash 命中 `STAT_MOD_HASHES` 的 10 档）；
- 至少 1 个 **tuning 模组**（plugHash 命中 `TUNING_MOD_HASH_BY_TUNING` 或
  `BALANCED_TUNING_MOD_HASH`）；
- **仓库护甲（General 桶）**：仓库里的所有实例物品都以 `bucketHash 138197802`
  （"General" 桶，itemCount 500）返回，而不是各自的护甲桶；目录
  （`armor-items.data.mjs`）中的 `bucketHash` / `classType` 必须能恢复这些
  物品的栏位与职业（回归测试断言 >= 400 件仓库护甲被恢复）；
- 若干**武器**（非五护甲桶，验证 T9 过滤）；
- 尽量覆盖 3 个职业（`characters` 含 titan / hunter / warlock）。

> 去重（同一 instanceId 出现在多个来源）由 synthetic fixture 覆盖：实例物品
> 在真实 API 中只会位于仓库、角色背包或穿戴之一，不会同时出现于多处。

## 测试覆盖

- `tests/capture-fixture.test.mjs`：用合成响应单测 `sanitizeProfileFixture`
  （instanceId / displayName 替换、hash / stats / bucketHash / plugHash 保持、
  membershipId 打码、输入不被修改）。
- `tests/bungie-inventory.test.mjs`：T8/T9 映射与清单拼接测试（依赖本 fixture
  或 synthetic-profile-fixture.json）。
