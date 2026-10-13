# dsh-ofm-compat

**WeChatAgent ↔ [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 兼容包。**

给 WeChatAgent 暴露一条**永不改变的 provider 路由**和一个**固定模型别名**，
由本插件在每次真实调用时自动解析到 our-free-model 当下真正可用的模型。

---

## 它解决什么问题

WeChatAgent 把模型选择写死在配置里：

```jsonc
// %APPDATA%\WeChatAgent\workspace\config\wechatagent.json
"dsh": { "provider": "deepseek-account", "model": "deepseek-flash" }
```

而 `dsh-social-bridge-plugin` 是在**创建 DSH agent 的那一刻**把 provider/model 绑定的
（`packages/dsh-social-bridge-plugin/native-context.mjs:213-215`），之后无法更改 ——
这就是项目里反复强调「改模型后必须完整退出并重开 DSH」的原因。

同时，our-free-model 的可用模型是**会变的**：受地区封锁、上游下线、渠道波动影响。
本机实测的一份 `availability.json` 就是这么惨：

| 状态 | 数量 | 例子 |
| --- | --- | --- |
| 上游拒绝（`OpenCode's free tier can only be used from within OpenCode`） | 8 | `ling-3.1-flash-free`、`cat-jam-free`、`step-5-preview-free`… |
| 地区封锁（`not available in your country`） | 2 | `muse-spark-1.2/1.3-contributor-free` |
| 真正可用 | 1 | `nemotron-3-ultra-free` |

**把这样的模型写死进 WeChatAgent，必然烂掉**，而且每烂一次就要重开一次 DSH。

## 工作原理

本插件向 DSH 注册一条**属于自己**的路由（默认 `wechatagent-free`），只 advertise 一个
固定别名（默认 `auto`），然后**把真实调用代理给真正拥有该路由的适配器**：

```
WeChatAgent ──► dsh-social-bridge-plugin ──► agent(provider=wechatagent-free, model=auto)
                                                     │
                                                     ▼
                                        dsh-ofm-compat（本插件）
                                        ① 读 our-free-model 的 availability.json
                                        ② 按 可用性 / 偏好 / 粘性 / 冷却 选出真实模型
                                        ③ ctx.llm.stream({provider:'our-free-model', model:<真实模型>})
                                                     │
                                                     ▼
                                        dsh-our-free-model（真正的上游适配器）
```

因此 WeChatAgent 侧只需要配置**一次**：

```jsonc
"dsh": { "provider": "wechatagent-free", "model": "auto" }
```

之后模型失效时本插件自动换下一个，**WeChatAgent 无感，不需要再重开 DSH**。

### 选型规则（优先级从高到低）

1. **排除**：命中 `exclude` 的模型永不使用；
2. **冷却**：刚刚被判定不可用的模型在 `cooldownMs` 内不再使用；
3. **可用性**：`state:available` 优先于未知；
4. **偏好**：命中 `prefer` 的模型排前；
5. **粘性**：当前模型仍健康就继续用 —— 避免每轮换模型导致语气/人格漂移；
6. **稳定**：其余按上游 advertise 顺序，保证同样输入下选择确定。

**失败归因**：只有 turn 以 `error` 结束、且错误信息命中「不可用」关键词
（`not available in your country` / `deprecated` / `model is unavailable` /
`only be used from within` …）时，才把责任归到当前模型并触发冷却。
账号类（`ACCOUNT_SIGN_IN_REQUIRED`）、参数类、网络类错误**刻意不归因** ——
误冷却只会让选型乱跳。

## 安装（一键式）

不需要手改 `package.json`。DSH 自带官方的插件安装通道，**包名加进 bundle、失败回滚、
构建脚本审批、并发锁**都由它处理 —— 本包已声明 `dsh.bundle`，可直接被它识别。

### 方式 A：官方命令（推荐，一行）

```powershell
# 从 GitHub 装（把 <你> 换成你的用户名）
dsh plugin --profile desktop add github:<你>/dsh-ofm-compat

# 或从 npm 装（发布之后）
dsh plugin --profile desktop add dsh-ofm-compat
```

`--profile desktop` 是关键：WeChatAgent 驱动的是它自带的 DSH 运行时，只读 `desktop` profile。
把插件装进 `web` profile 对 WeChatAgent **完全无效**。

官方安装路径（`@deepseek-ai/dsh-plugin-manager`）的实际行为：

| 行为 | 说明 |
| --- | --- |
| 自动登记 bundle | 装完自动写入 `dsh.profile.bundles`，无需手工编辑 |
| 要求 `dsh.bundle` | 没有则以 `not-bundle` 拒绝；本包已声明 ✅ |
| **失败即回滚** | 安装失败/取消/无 bundle 时还原 `package.json` 与 `pnpm-lock.yaml` |
| 支持 GitHub | `github:用户/仓库`，安装前做连接检查 |
| 原子写 + 锁 | 用 `@deepseek-ai/dsh-atomic-write`，并与其他 profile 操作互斥 |

### 方式 B：本包自带的一键 CLI

适合没把 `dsh` 加进 PATH 的情况（本 CLI 会自动去找它）：

```powershell
cd D:\idea\WeChat_Fish\dsh-ofm-compat

node scripts/cli.mjs doctor         # 先体检：DSH_HOME / profile / 依赖是否就位
node scripts/cli.mjs install        # 默认 desktop profile
node scripts/cli.mjs status         # 读运行状态
node scripts/cli.mjs uninstall

.\scripts\install.ps1               # Windows 薄包装
./scripts/install.sh                # macOS / Linux / Git Bash
```

发布到 npm 之后还可以：

```powershell
npx dsh-ofm-compat install
npx github:<你>/dsh-ofm-compat install
```

CLI 会**优先调用官方的 `dsh plugin ... add`**，只有找不到 `dsh` 时才退回
「pnpm + 改 JSON」的手工路径（并用不带 BOM 的 UTF-8 写回）。加 `--dry-run` 只打印不落盘。

### 方式 C：DSH 设置里的插件管理器

DSH 的 **设置 → 插件** 就是同一个 plugin manager 的界面（`dsh-client-ui-plugin-manager`），
里面可以粘贴包名或 GitHub 地址安装、启用/停用、卸载 —— 效果与方式 A 完全一致。

### 方式 D：手工（仅在前三者都不可用时）

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
Set-Location $profile
Copy-Item package.json package.json.bak       # 先备份
pnpm add link:D:\idea\WeChat_Fish\dsh-ofm-compat
# 再把 "dsh-ofm-compat" 手工追加进 package.json 的 dsh.profile.bundles
```

⚠️ 用 PowerShell 的 `ConvertTo-Json` 重写该文件时**必须写不带 BOM 的 UTF-8**，
否则 JSON 解析会炸：

```powershell
[System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
```

改完 **从托盘完整退出 DSH 并重新打开**，插件才会加载。

## 配置

全部字段都有安全默认值，`config: {}` 即可运行。完整写在 [`cordis.patch.yml`](./cordis.patch.yml)：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `targetProviders` | `['our-free-model', 'our-free-model-region']` | 从哪些路由取候选，按顺序 |
| `route` | `'wechatagent-free'` | 暴露给 WeChatAgent 的固定路由名 |
| `alias` | `'auto'` | 固定模型别名 |
| `displayName` | `'OFM Auto（WeChatAgent 兼容）'` | 模型选择器里的分组名 |
| `prefer` | `[]` | 优先使用的模型（支持包含匹配，如 `['kimi']`） |
| `exclude` | `[]` | 永不使用的模型 |
| `preferLanes` | `['eac', 'free']` | **白嫖优先**：渠道偏好，顺序即优先级；传 `[]` 关闭 |
| `excludeLanes` | `[]` | 永不使用的渠道 |
| `cooldownMs` | `900000`（15 分钟） | 判定不可用后的冷却时长 |
| `statusPort` | `11231` | 只读状态接口端口，`0` 关闭 |
| `statusFile` | 空（用 `<DSH_HOME>/ofm-compat/status.json`） | 状态文件路径 |

## 兼容性与抗变动（WeChatAgent 改接口会怎样）

**核心结论：本插件不依赖 WeChatAgent 的任何代码，因此 WeChatAgent 改接口不会让它坏掉。**

这不是印象，是可以机械验证的事实 —— [test/surface.test.mjs](./test/surface.test.mjs) 把依赖面钉死了：

| 依赖面 | 实际内容 |
| --- | --- |
| 第三方包 | **零**。只有 `node:fs` / `node:os` / `node:path` / `node:http` 与自身相对模块 |
| DSH 内核服务 | **只有 4 个**：`ctx.llm`、`ctx.effect`、`ctx.on`、`ctx.logger` |
| WeChatAgent 的模块 | **零 import**。代码里出现的只是「文案」与 CLI 里一个带 `existsSync` 保护的路径探测 |
| 文件写入 | **只有 `src/status.js`** 写自己的状态文件，绝不改别人的东西 |

> 守卫测试会在以下情况立刻变红：有人 `import` 了 WeChatAgent 或 `@deepseek-ai/*` 的模块、
> 用了白名单外的 `ctx` 服务、或除 `status.js` 之外的模块开始写文件。

### 各类变动的影响

| 变动 | 影响 | 是否还能用 |
| --- | --- | --- |
| WeChatAgent 改**内部实现**、UI、日志格式 | 无影响 | ✅ 照常 |
| WeChatAgent 改**配置字段名**或不再支持配 provider/model | 它不会再把 `wechatagent-free`/`auto` 传给 DSH | ⚠️ 插件**失效但不报错**（变成没被用），DSH 不会崩 |
| WeChatAgent 换掉 `dsh-social-bridge-plugin` | 同上 —— 路由没人用而已 | ⚠️ 同上 |
| **DSH 内核改 `ctx.llm` 适配器契约** | 这是**唯一真正会坏**的地方 | ❌ 但 `checkLlmContract` 会**明确报出缺哪个方法**并安静跳过注册，不拖垮 DSH |
| our-free-model 改**状态文件格式** | 丢失渠道/可用性情报，`preferLanes` 失效 | ✅ **模型路由照常**（候选来自 `ctx.llm.listModels()`，不读状态文件） |
| our-free-model 被改名/卸载 | 没有候选模型 | ❌ 报 `OFM_COMPAT_NO_MODEL`；改 `targetProviders` 即可重定向 |
| 别的插件占了 `wechatagent-free` 这个路由名 | 注册抛 `DUPLICATE_ADAPTER` | ⚠️ 插件记日志并跳过；改 `route` 即可避让 |

### 两条刻意的设计选择让它在变动中更稳

1. **不声明 `@deepseek-ai/dsh*` 的 peerDependency** —— 不受安装版本闸门限制，
   DSH 小版本升级不会把它拒之门外。代价是需要运行时契约自检来补偿（见上表），
   而不是靠版本号。**版本号本来也证明不了「我用到的那几个签名没变」。**
2. **候选来自 `ctx.llm.listModels()`，而不是解析 our-free-model 的内部文件** ——
   所以上游插件怎么改自己的存储格式，都不影响「能不能调通模型」这件事，
   最坏只是丢掉渠道偏好与诊断信息。

## 渠道（白嫖）适配

our-free-model 把免费额度分成**三条代价与门槛都不同**的渠道。本插件把「某模型属于哪条渠道」
变成可排序、可过滤、可诊断的事实 —— 这是「白嫖模型接入」的适配核心。

| 渠道 | id | 是什么 | 门槛 |
| --- | --- | --- | --- |
| **共付渠道（白嫖）** | `eac` | DeepSeek V4.1 Flash、Kimi k2.6/k3、gpt-oss-20b、GLM-5.3/5.3-flash 等前沿模型 | ①凭据以 **AES-GCM 封印**随包分发，**只有在被认可的 DSH 宿主里才解开**；②**还要 GitHub 授权（登录 + star 仓库）** |
| 匿名免费通道 | `free` | 10 个 `*-free` 条目 | 无门槛，但受地区与上游策略限制 |
| Kilo 渠道 | `kilo` | Kilo 网关模型（`org/model`，常带 `:free`） | 无门槛 |

> ⚠️ **能列出 ≠ 能用。** 实测（CN 出口）时 `eac` 的 6 个模型**全都会被 advertise 出来**，
> 但每次调用都返回：
> ```json
> { "code": "AUTHORIZATION_REQUIRED",
>   "detail": "需要 GitHub 授权：请在插件设置页用 GitHub 登录，并 star 仓库后使用 EAC 模型" }
> ```
> 也就是说封印解开只解决了第一道门，**第二道门要你在 dsh-our-free-model 的设置页用
> GitHub 登录并 star 该仓库**。本插件的渠道诊断只看 advertise，因此**必须配合
> 失败学习**才能得出正确结论 —— 见下节「失败归因的两种粒度」。

**默认 `preferLanes: ['eac', 'free']`** —— 白嫖渠道优先。排序为
「点名偏好 > 渠道偏好 > 可用性 > 上游顺序」，所以你在 `prefer` 里点名的模型依然说了算。

### 失败归因的两种粒度

因为「能列出 ≠ 能用」，光看 catalog 会得出错误结论，所以选型同时依赖**失败学习**，
而且要区分两种粒度：

| 粒度 | 触发信号 | 动作 | 例子 |
| --- | --- | --- | --- |
| **渠道级** | 错误码在 `LANE_FAILURE_CODES` 里（`AUTHORIZATION_REQUIRED`、`UNAUTHORIZED`…），或消息命中授权类关键词 | **整条渠道**冷却 | EAC 需要 GitHub 授权 —— 只冷却单个模型会立刻换上同渠道的下一个，永远在失败模型之间打转 |
| **模型级** | 地区封锁 / 已弃用 / `only be used from within` 等 | 只冷却那**一个**模型 | `muse-spark-1.2-contributor-free` 在 CN 被封锁 |
| **不归因** | 错误码在 `NOT_MODEL_FAILURE_CODES` 里（`ACCOUNT_SIGN_IN_REQUIRED`…），或无法识别 | 什么都不做 | 宿主账号没登录、参数校验失败、网络超时 —— 怪到模型头上只会让选型乱跳 |

> 账号未登录的原文是 "Sign in to DeepSeek…"，里面有 "Sign in"；而渠道授权也常说
> sign in。**光靠关键词分不开**，所以有一张显式的「宿主账号」错误码表优先摘除。
> 这个坑有专门的测试盯着（`test/failure.test.mjs`）。

冷却结果会体现在 `/status` 的 `laneCooldowns` / `lastFailure` / `warnings` 里，
所以「为什么现在用的是这个模型」永远有据可查。

### 时延：重试策略必须继承，不能丢

**这是一个实测抓到并已修掉的回归。** 代理型适配器如果 `providerRetryPolicy()` 返回
`undefined`，DSH 会套用它的默认策略 —— 而默认策略是「重试 **5** 次、且把 `RATE_LIMIT`
当瞬态故障」。会话日志里的证据：

```
policyKey: ["normal", 5, ["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"], 500, 10000, 0.1]
```

而 our-free-model 自己声明的是刻意更保守的一套，并在源码里写明了原因：

> *"this lane's 429 carries a growing retry-after, and the two automatic retries turned
> every quota wall into three walls — the same turn, paid thrice, arriving later (issue #13)."*

实测代价：一次 turn 因默认策略重试 5 次，退避 `0.5+1+2+4+8` ≈ **15.5 秒纯等待**。

**现在的行为**：`providerRetryPolicy()` **绝不返回 `undefined`** ——
先向**确实已注册**的目标 provider 继承真实策略（必须先查 `listProviders()`，
因为 `ctx.llm.providerRetryPolicy()` 对未注册路由会返回「已解析好的默认值」）；
继承到的策略若**长得就像运行时默认值**（重试 ≥5 且含 `RATE_LIMIT`）则拒收；
最终退回保守策略（重试 2 次、**不含 `RATE_LIMIT`**）。

生效的策略会出现在 `/status` 的 `retryPolicy` 字段里 —— **这段必须可见**，
否则「默认策略被静默套用」这种问题根本查不出来。

### 冷却递增：长期不可用的渠道不该被周期性重撞

另一个实测到的循环：`eac` 因需要 GitHub 授权而整条冷却 15 分钟 → **到期后又选中它**
→ 又挂满 120 秒（会话日志里 `chunks=0`）→ 再冷却 15 分钟。固定时长意味着
一个长期不可用的渠道会被反复重试，每次都让用户白等一次超时。

**现在的行为**：同一目标连续失败时冷却**翻倍**（`cooldownMs` → 2× → 4× …
以 `cooldownMaxMs` 封顶，默认 15min → 30min → 1h）；**一旦成功立刻清零**，
避免偶尔抖动的渠道被永久惩罚。当前计数在 `/status` 的 `strikes` 里可见。

### 共付渠道凭什么能解锁

判定逻辑在 our-free-model 的 `src/vault.js` → `detectSealedHost()`：

| 宿主 | 判定信号 |
| --- | --- |
| Tauri（DSHEAC AIO） | `DSH_HOME` 含 `com.deepseek.dsh.desktop.aio` **且** 自带 `resources\node\node.exe` **且** argv 含 `web-desktop`（三者齐备，单独一个可伪造，三个一起不是巧合） |
| Web | 内核声明的 profile 名是 `web` / `web-desktop` |
| **Electron（DeepSeek Harness）** | **内核声明的 profile 名是 `desktop`** ← WeChatAgent 用的就是它 |

所以 WeChatAgent 理论上**满足条件**。但它解锁失败时，our-free-model 只会
`logger.warn` 一句然后把模型**整个摘掉** —— 你在 WeChatAgent 里什么都看不见。

本插件的适配就是把这件事变成一个**确定的事实**：对比「catalog 里本可以有」与
「实际 advertise 出来的」，写进 `/status`：

```jsonc
"lanes": {
  "eac":  { "label": "共付渠道（白嫖）", "catalogCount": 6, "advertisedCount": 0, "state": "hidden",
            "missing": ["deepseek-ai/deepseek-v4.1-flash", "moonshotai/kimi-k3", "…"] },
  "free": { "label": "匿名免费通道", "catalogCount": 10, "advertisedCount": 10, "state": "available" }
},
"warnings": ["共付渠道未解锁：our-free-model 只在被认可的 DSH 宿主里解开封印凭据…"]
```

`state` 三态：`available`（有货）/ `hidden`（catalog 里有但被摘掉，附 `missing` 清单）
/ `absent`（catalog 里本就没有这条渠道）。

> 实测你机器上的真实 catalog：`eac` 6 个、`free` 10 个、`kilo` 16 个、未分类 0 个。
> 共付渠道就是那 6 个前沿模型。

状态文件在**每次决策后即时刷新**（不只是 30 秒定时），所以 `/status` 读到的永远是新鲜的。

## 状态接口

排查「现在到底在用哪个模型」的窗口。**只绑定 127.0.0.1，只读，非回环 host 直接拒绝。**

```powershell
curl http://127.0.0.1:11231/status   # 当前模型、决策原因、候选数、冷却表、出口 IP、最近 20 条决策
curl http://127.0.0.1:11231/health   # {"ok":true}
```

同时每 30 秒（以及启动时）原子写一份状态到 `%USERPROFILE%\.dsh\ofm-compat\status.json`。

这个接口存在的理由很实际：WeChatAgent 的 bridge 会把插件返回的错误详情**过滤掉**
（`components/qq-bridge/src/dsh/plugin-client.js:41` 只接受 `/^[a-zA-Z_]{3,100}$/`），
所以会话日志里只剩一个毫无信息量的 `turn_error`。没有状态面就只能靠猜。

## 测试

```powershell
node test/select.test.mjs     # 选型算法，25 个用例（含本机真实 availability 数据固件）
node test/plugin.test.mjs     # 伪造 ctx 的集成验证，17 个用例
node test/contract.test.mjs   # ctx.llm 契约自检与静默降级，8 个用例
```

> `node --test test/` 在受限沙箱里会因 `spawn EPERM` 失败（子进程管道被禁止），
> 直接以进程内方式跑单文件即可 —— 这也是本仓库把测试写成可直接 `node <file>` 运行的原因。

集成测试用一个按 DSH 公开契约手写的 `ctx.llm` 替身，覆盖：路由注册与释放、路由冲突降级、
别名 advertise、元数据身份改写、**调用转交时改写路由且不自引用递归**、可用性驱动选型、
粘性、冷却、失败归因（含「账号错误不该归因」的反例）、状态文件输出、
以及 **`ctx.llm` 不完整时插件只记一条诊断而不拖垮 DSH**。

## 设计约束

- **不 import 任何 `@deepseek-ai/*` 包**，只用结构化的 `ctx` 契约。这是从
  dsh-our-free-model 的 `adapter/kernel.js` 学来的纪律：插件不锁内核版本，
  DSH 升级时不需要跟着改。
- **不声明 `@deepseek-ai/dsh*` 的 peerDependency。** DSH 的安装闸门
  （`dsh-app-boot` 的 `evaluatePluginCompatibility`）只校验这一类 peer：
  ```js
  if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
  ```
  不声明就永远不会因为运行时版本漂移而被拒装。代价是**必须自己在运行时校验契约**，
  所以 `apply` 会先做一次 `checkLlmContract(ctx.llm)`，缺方法就报出一条指名道姓的日志
  并安静跳过注册（而不是等第一次调用时抛一个看不懂的错）。
  这比语义化版本号更有意义 —— 版本号证明不了「我用到的签名没变」。
- **绝不因为自身故障拖垮 DSH**：配置非法退回默认、路由冲突只记日志、读不到状态文件降级为
  「未知」、状态接口起不来不影响模型路由。
- `resolveModel` 永不抛错（返回兜底元数据）；真正无模型可用时由 `stream` 抛出带
  `OFM_COMPAT_NO_MODEL` 的错误，让失败落在一次 turn 上而不是插件加载期。

## 已知限制（务必先读）

1. **本插件不能凭空造出可用模型。** 它只做「在 our-free-model 已 advertise 的模型里挑一个能用的」。
   如果你的出口 IP 让所有免费通道都不可用（本机实测 CN 出口就是这样），
   它只会诚实地报告 `OFM_COMPAT_NO_MODEL`，而不是变魔术。
   可行方向：在 our-free-model 里启用它的 `egress`（代理），或使用它基于账号的 `eac` 渠道。
2. **未在真实 DSH 中端到端验证。** 开发环境的 Electron 无法启动，所以插件包只经过了
   50 个自动化测试和静态审查，**没有在活的 DSH 里跑过一次 turn**。
   上生产前请按 [`docs/INTEGRATION.md`](./docs/INTEGRATION.md) 的验证清单实测。
3. **归属精度**：拿不到 session id 时，失败归因退化为「最近一次派发的模型」。
   WeChatAgent 逐会话串行调用时这是准确的；并发多会话时可能误冷却。
4. **`listModels` 只暴露别名**，因此无法通过 `wechatagent-free` 路由点名某个具体模型。
   需要点名时直接使用 `our-free-model` 路由，或在本插件里透传真实 id（已支持，
   只是不 advertise）。

## 许可

MIT，见 [LICENSE](./LICENSE)。

本插件与 DeepSeek Harness、WeChatAgent、dsh-our-free-model 均无隶属关系。
