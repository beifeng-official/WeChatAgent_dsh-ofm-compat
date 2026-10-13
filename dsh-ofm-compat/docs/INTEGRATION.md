# 中文接入文档：把 dsh-ofm-compat 接进 WeChatAgent

本文是在**你这台机器上**从零到可用、以及出问题怎么查的完整步骤。
理论背景看 [README](../README.md)，这里只讲怎么落地。

---

## 0. 前置条件

先确认三件事，缺一件后面都会失败：

| 检查 | 命令 / 位置 | 期望 |
| --- | --- | --- |
| DSH 的 profile 目录 | `%USERPROFILE%\.dsh\profiles\desktop` | 存在，含 `package.json` |
| our-free-model 已装进同一 profile | 见下 | `dsh-our-free-model` 在依赖与 bundle 列表里 |
| WeChatAgent 用的是这个 profile | WeChatAgent 控制台 → 连接设置 → DSH 程序位置 | 指向 `...\runtimes\<版本>\dsh\DeepSeek Harness.exe` |

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
Get-Content "$profile\package.json"
```

里面应该能看到 `dsh-social-bridge-plugin`、`dsh-our-free-model`、`dsh-ofm-compat` 三项。

> **为什么必须同一个 profile**：WeChatAgent 驱动的是它自己那套 DSH 运行时
> （`%APPDATA%\WeChatAgent\runtimes\<版本>\dsh\`），它读的就是 `desktop` profile。
> 你在 `web` profile 里装的插件对 WeChatAgent **完全无效** —— 这是最容易踩的坑。

---

## 1. 把兼容包装进 desktop profile（一键）

**不要手改 `package.json`。** DSH 官方就有插件安装通道，它会自动登记 bundle，
并在失败时回滚清单 —— 本包已声明 `dsh.bundle`，可直接被识别。

### 首选：官方命令

```powershell
# 本机已确认存在可用的 dsh CLI（见下方 doctor 输出）
dsh plugin --profile desktop add github:<你的用户名>/dsh-ofm-compat

# 本地开发时直接指向源码目录
dsh plugin --profile desktop add D:\idea\WeChat_Fish\dsh-ofm-compat
```

### 备用：本包自带的一键 CLI（自动去找 dsh）

```powershell
cd D:\idea\WeChat_Fish\dsh-ofm-compat

node scripts/cli.mjs doctor      # 先体检
node scripts/cli.mjs install     # 默认就是 desktop profile
```

`doctor` 在本机的真实输出（可作为「一键是否可用」的判断依据）：

```
==> 环境体检
  DSH_HOME      C:\Users\l666\.dsh
  profile       desktop
  profile 目录  C:\Users\l666\.dsh\profiles\desktop  存在
  dsh CLI       C:\Users\l666\dsh-0.2.0-rc.2\node_modules\@deepseek-ai\dsh\lib\bin.js
  已装 bundles  4 个
    ✓ dsh-our-free-model (bundle 已选)
    ✓ dsh-social-bridge-plugin (bundle 已选)
```

CLI 会优先调用官方的 `dsh plugin ... add`；只有找不到 `dsh` 时才退回
「pnpm + 改 JSON」的手工路径（用不带 BOM 的 UTF-8 写回，并自动备份）。

> 加 `--dry-run` 可先看要执行什么，不落盘。

### 也可以走 DSH 界面

**设置 → 插件** 就是同一个 plugin manager（`dsh-client-ui-plugin-manager`），
粘贴包名或 GitHub 地址即可安装/启用/卸载，效果完全一致。

### 手工兜底（仅在前三者都不可用时）

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
Set-Location $profile
Copy-Item package.json package.json.bak       # 先备份
pnpm add link:D:\idea\WeChat_Fish\dsh-ofm-compat
# 再手工把 "dsh-ofm-compat" 追加进 package.json 的 dsh.profile.bundles
```

⚠️ 用 `ConvertTo-Json` 重写该文件时务必**写不带 BOM 的 UTF-8**，否则 JSON 解析会炸：

```powershell
[System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
```

装完 **必须从托盘完整退出 DSH 并重新打开**。

> ⚠️ **插件代码更新一律需要重启 DSH。** 实测结论：`dsh` 的 HMR 只在**首次**加载一个
> 新 bundle 时生效；之后即使重算组合（改 `package.json` 的 bundles、摘掉再装回、
> 改 profile 补丁文件），模块也**不会重新求值** —— Node 的 ESM 模块缓存按 URL 命中，
> `apply()` 会重跑，但跑的还是旧代码。判断依据：`/status` 的 `registeredAt` 变了，
> 但行为没变。
>
> 想要免重启迭代，可以借用 WeChatAgent 自己的做法（`scripts/project-config.mjs:113`）：
> 把入口写成带版本查询串的 `file://` URL（`…/index.js?rev=<hash>`），URL 一变缓存就不命中。
> 本项目没有内置这个技巧，因为它需要写死绝对路径，不适合分发的包。

---

## 2. 改 WeChatAgent 的模型配置

**推荐走界面**（不用手改 JSON）：

1. 打开 WeChatAgent 控制台 → **连接设置** → 找到「**模型连接**」卡片
2. 填：
   - **模型提供方标识**：`wechatagent-free`
   - **模型标识**：`auto`
3. 保存 → **工具页** → 点「**准备项目配置**」
4. **从 DSH 托盘完全退出并重新打开** → 回控制台点「**已重开 DSH**」
5. **重启助手服务**

**等价的文件改法**（界面不好使时）：

```jsonc
// %APPDATA%\WeChatAgent\workspace\config\wechatagent.json
"dsh": {
  "provider": "wechatagent-free",   // 原 deepseek-account
  "model": "auto"                   // 原 deepseek-flash
}
```

然后必须让配置生效：

```powershell
# 重新生成 bridge-config.json 与插件补丁（provider/model 会被写进 cordis.patch.yml）
node "$env:APPDATA\WeChatAgent\workspace\scripts\project-config.mjs"
```

> **为什么一定要「准备项目配置 + 重开 DSH」**：provider/model 是在
> `native-context.mjs:213-215` 创建 agent 时绑定的，改文件不会影响已经活着的 agent。
> 这也是**唯一一次**需要重开 —— 之后模型换代由兼容包接管。

---

## 3. 测试：分层做，从零风险到端到端

**不要一上来就发微信消息**。这套东西有四个独立的失败点（插件没加载 / 渠道没解锁 / 适配器
不通 / 微信侧没配对），一次只验一层，失败时才能立刻定位。

### 第 0 层：离线自检（零风险，不用装任何东西）

```powershell
cd D:\idea\WeChat_Fish\dsh-ofm-compat
node scripts/selftest.mjs
```

它把不需要动 DSH 的部分全自动化，分四段：

| 段 | 查什么 |
| --- | --- |
| A 静态 | 模块能否 import、零 `@deepseek-ai` 依赖、`dsh.bundle`/`bin`/补丁文件是否完整 |
| B 测试 | 跑四套测试（75 个用例，含真实 catalog 固件） |
| C 环境 | DSH_HOME、目标 profile、依赖是否就位、**真实 catalog 的渠道分布** |
| D 现场 | 插件已在运行时读它的 `/status`（渠道/当前模型/警示） |

**A/B 段必须全绿。** C 段里「本插件已装」「our-free-model 已装」在安装前为红属正常；
D 段在重开 DSH 前为红属正常。脚本会把未通过项逐条列出来。

### 第 1 层：插件是否被 DSH 加载

装完并**从托盘完整退出并重开 DSH**之后：

```powershell
node scripts/cli.mjs status      # 或 curl http://127.0.0.1:11231/status
```

- 有 `"registered": true` → 插件挂上了
- 连不上 → 插件没加载（回去查 bundle 列表）、或 `statusPort` 被改成了 0
- `"registered": false` + 有日志 → 路由名冲突或契约自检失败，看 `contract.missing`

### 第 2 层：白嫖渠道到底解没解锁（关键未知）

```powershell
curl http://127.0.0.1:11231/status | Select-String 'eac' -Context 0,6
```

| `lanes.eac.state` | 含义 |
| --- | --- |
| `available` | ✅ 6 个前沿模型在候选里，白嫖可用 |
| `hidden` | ❌ catalog 里有但被整个摘掉 —— 看 `warnings` 那条说明 |
| `absent` | catalog 里本就没有这条渠道 |

### 第 3 层：隔离测试模型链路（不碰微信）

在 **DSH 自己的聊天窗口**里新建一个会话，模型选择器选 **「OFM Auto（WeChatAgent 兼容）」**，
发一句 `你好`。这一层完全绕开微信，只验证 `prepareCall` + `stream` + 路由改写是否成立。

- 有正常回复 → 适配器通了，问题只可能在微信侧
- 报 `OFM_COMPAT_NO_MODEL` → 回到第 2 层，是渠道/可用性问题，不是代码问题
- 选不到「OFM Auto」→ 回到第 1 层

### 第 4 层：端到端（微信）

按下一节的清单做，重点是这三处证据：

```powershell
# ① 微信侧是否收到并受理
Get-Content "$env:APPDATA\WeChatAgent\workspace\state\logs\bridge.stdout.log" -Tail 20
#    ✅ 出现 [WeChat] accepted ... 且没有 error=
#    ❌ error=DSH plugin: turn_error → 看 ②

# ② 兼容包当时选了什么
curl http://127.0.0.1:11231/status | Select-String 'current' -Context 0,5
#    看 current.model / current.lane / lastDecision.reason

# ③ 白嫖渠道有没有真的被用上
#    current.lane == "eac" 且 lastDecision.byLane.eac > 0 → 白嫖生效
```

### 第 5 层：失败时交什么给我

最有用的是这三样，我可以在几分钟内定位：

1. `curl http://127.0.0.1:11231/status` 的完整输出
2. `bridge.stdout.log` 的尾部
3. DSH 会话日志（我可以解 zstd 读出 `turn/end` 里的**真实错误** ——
   bridge 会把插件返回的 detail 过滤掉，所以只靠 bridge 日志永远看不到原因）

---

## 3.1 验证清单

按顺序做，任何一步不过就先别往下走。

### ① 插件是否注册成功

```powershell
curl http://127.0.0.1:11231/status
```

期望看到 `"route": "wechatagent-free"`、`"registered": true`。

失败 → 端口没起来或插件没加载，看下一步。

### ② 状态文件

```powershell
Get-Content "$env:USERPROFILE\.dsh\ofm-compat\status.json" -Raw
```

文件不存在 = `apply()` 根本没跑 = 插件没被加载（回到第 1 步检查 bundle 列表与是否重开过 DSH）。

### ③ 候选与选型是否合理

同一个 `/status` 里看：

```jsonc
"lanePreference": ["eac", "free"],
"lanes": {
  "eac":  { "label": "共付渠道（白嫖）", "catalogCount": 6, "advertisedCount": 0, "state": "hidden" },
  "free": { "label": "匿名免费通道", "catalogCount": 10, "advertisedCount": 3, "state": "available" }
},
"current":   { "model": "ling-3.1-flash-free", "lane": "free", "reason": "lane:free" },
"lastDecision": { "usableCount": 3, "candidates": 3, "byLane": { "free": 3 }, "egress": { "country": "CN" } }
```

- `usableCount: 0` → 当前**一个可用模型都没有**（见下面排错表）
- `reason: "sticky"` → 沿用上一轮模型（正常）
- `reason: "lane:eac"` → 这次选中的是白嫖渠道，符合预期
- `candidates` 明显偏小 → our-free-model 还没成功刷过 catalog

### ④ 白嫖渠道（共付渠道）到底解开了没有

**这是最值得单独确认的一项**，因为它决定了你能不能白嫖到前沿模型，
而 OFM 在失败时只会静默把模型摘掉。

```powershell
curl http://127.0.0.1:11231/status | Select-String 'eac' -Context 0,6
```

| `lanes.eac.state` | 含义 | 处理 |
| --- | --- | --- |
| `available` | ✅ 已解锁，6 个前沿模型在候选里 | 无需操作；`preferLanes` 会自动优先它们 |
| `hidden` | ❌ catalog 里有、但一个都没 advertise | 看 `warnings` 里那条说明；确认 DSH 是 WeChatAgent 自带的运行时（profile 必须叫 `desktop`），且内核提供了 profile 上下文服务 |
| `absent` | catalog 里本就没有这条渠道 | 检查 our-free-model 是否在运行、是否同步过 catalog |

`missing` 数组会**列出被摘掉的具体模型 id**（如 `deepseek-ai/deepseek-v4.1-flash`、
`moonshotai/kimi-k3`），便于对照 OFM 自己日志里的那条
`the sealed lane is not available in this composition (no recognized host profile)`。

### ⑤ 真实收发一次

用白名单里的好友发一条消息，然后看：

```powershell
Get-Content "$env:APPDATA\WeChatAgent\workspace\state\logs\bridge.stdout.log" -Tail 20
```

- ✅ 正常：出现 `[WeChat] accepted ...` 且**没有** `error=`
- ❌ `error=DSH plugin: turn_error` → 日志里看不到原因（bridge 会过滤详情），
  去 `/status` 看 `current` 和 `lastDecision`，再对照下面排错表

---

## 4. 排错表

| 症状 | 真实原因 | 处理 |
| --- | --- | --- |
| `/status` 连不上 | 插件没加载，或 `statusPort` 被改成 0，或端口被占 | 检查 `package.json` 的 bundles 是否含 `dsh-ofm-compat`；确认重开过 DSH；换一个 `statusPort` |
| `registered: false` | 路由名与其他适配器冲突（`DUPLICATE_ADAPTER`） | 在 `cordis.patch.yml` 里改 `route`（如 `wechatagent-free-2`），重开 DSH |
| `OFM_COMPAT_NO_MODEL` | our-free-model 当前没有任何可用模型 | 见下一行 |
| `usableCount: 0`，`egress.country: "CN"` | 出口 IP 被地区封锁 / 上游拒绝 | ①在 our-free-model 里启用 `egress`（代理）；②改用它的账号渠道；③换网络 |
| `lanes.eac.state: "hidden"` | **白嫖渠道（共付渠道）未解锁** —— OFM 只在被认可的 DSH 宿主里解开封印，失败时静默摘掉这 6 个模型 | 看 `warnings` 那条说明；确认 DSH 是 WeChatAgent 自带运行时且 profile 名为 `desktop`；对照 OFM 日志里的 `no recognized host profile` |
| 明明有白嫖渠道，`reason` 却总是 `lane:free` | `eac` 被摘掉了（不在候选里），或你在 `excludeLanes` 里排除了它 | 先看 ④ 的 `lanes.eac.state`；确认 `preferLanes` 含 `eac` |
| 只想白嫖，完全不想碰账号渠道 | 默认没排除任何渠道 | 设 `excludeLanes` 把不要的渠道排掉；或在 `preferLanes` 里只留 `['eac','free']` |
| 想钉死某个白嫖模型 | 候选会按可用性浮动 | 用 `prefer`，如 `prefer: ['kimi-k3']`（点名偏好压过渠道偏好） |
| 模型选择器里看不到「OFM Auto」 | 插件没注册，或 `displayName` 被改空 | 看 DSH 日志里有没有 `ofm-compat: 注册路由 ... 失败` |
| 仍然报 `ACCOUNT_SIGN_IN_REQUIRED` | WeChatAgent 还在用旧的 `deepseek-account` | 回到第 2 步，确认 `provider` 真的是 `wechatagent-free` 并跑过 `project-config.mjs` |
| 每轮都在换模型 | 冷却触发太频繁（候选都不稳） | 调大 `cooldownMs`；用 `prefer` 钉住一个稳定渠道 |
| 免费通道全部被拒（`only be used from within OpenCode`） | 这不是配置问题，是上游对非 OpenCode 客户端的限制 | 只能用账号渠道或代理；本插件无法绕过 |

---

## 5. 回滚

兼容包是**纯增量**的，回滚只需两步：

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
Set-Location $profile

# 1) 从 bundle 列表里删掉 "dsh-ofm-compat"，然后：
pnpm remove dsh-ofm-compat

# 2) 把 WeChatAgent 的 provider/model 改回原来的值
#    连接设置 → 模型连接 → 恢复原 provider/model → 准备配置 → 重开 DSH → 重启服务
```

有备份时也可以直接还原：

```powershell
Copy-Item "$profile\package.json.bak" "$profile\package.json" -Force
pnpm install
```

插件本身**不改动 WeChatAgent 的任何文件**，也不改系统设置、不装服务、不开监听端口
（状态接口只绑 127.0.0.1，可用 `statusPort: 0` 完全关闭）。

---

## 6. 已知风险

1. **本插件只做选型，不创造可用性。** 如果所有渠道都不可用，它会诚实报错，
   不会伪造一个能用的模型。
2. **未在真实 DSH 里端到端验证过。** 开发环境无法启动 Electron，兼容包只经过了
   42 个自动化测试（含一个按 DSH 公开契约手写的 `ctx.llm` 替身）。
   **首次接入请严格按第 3 节的验证清单逐项确认。**
3. **our-free-model 的 sealed/EAC 渠道可能需要「被认可的宿主 profile」**
   （其 `index.js:422` 明说 `no recognized host profile` 时最强模型会隐藏）。
   WeChatAgent 自带的官方 DSH 是否被认可，需要在实测中观察
   `/status` 的 `candidates` 数量来判断。
