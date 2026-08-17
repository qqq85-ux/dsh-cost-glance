# 会话费用速览（DSH Cost Glance）

> **Early Preview（v0.1.0-beta.1）** —— 功能可用，核心验证已完成：
> DeepSeek 官方余额手工核对、macOS 真实 Web 界面验证（顶栏徽标与 Popover）均已通过。
> 显示的是**当前会话预估费用**，以 DeepSeek 官方账单为准。

本插件显示的是**当前会话的预估费用**：根据 DeepSeek 官方定价、模型、缓存命中情况和
API 请求发生时段，实时计算并展示当前 DSH 会话的预估金额。它**不是**账户余额工具、
**不是**正式账单系统、**不是**跨会话财务仪表盘。**DeepSeek 官方平台负责余额、充值与
最终账单；本插件显示的是本地预估，以 DeepSeek 官方账单为准。**

- 顶栏徽标：`约 ¥1.46`，点击查看费用构成（缓存命中/未命中/输出、模型、时段、规则版本）
- 金额为 0 显示 `约 ¥0.00`；无法计价显示 `费用 —`，点击解释原因
- 切换会话立即切换；刷新/恢复/Fork 不重复累计同一条调用
- 仅支持 DeepSeek 官方 API + 官方价格表内模型，自动按人民币计价；其余一律 `费用 —`
- 价格规则版本化，按**调用发生时刻**选择当时生效的规则（历史调用用历史价）
- 峰谷时段按北京时间自动识别（高峰 09:00-12:00、14:00-18:00，左闭右开）
- 内部用整数 nanoYuan 累计，禁止浮点误差

**已验证环境**：DSH 0.1.0-rc.6 · Node ≥ 18 · macOS Web Profile（`@deepseek-ai/dsh-web-app`）——已在 macOS 真实 Web 界面验证顶栏徽标与 Popover，并完成 DeepSeek 官方余额手工核对。
**已知限制**：见文末「已知边界」；官方账单与插件不一致时，以 DeepSeek 官方为准。

## 数据来源与计费口径

只使用模型调用返回的原始 usage（适配器已做互斥拆分，来源 `dsh-llm-deepseek`）：

| 原始字段（DeepSeek） | 适配器映射 | 计费用途 |
|---|---|---|
| `prompt_cache_hit_tokens` | `usage.cacheReadTokens` | 缓存命中输入（低价） |
| `prompt_cache_miss_tokens`（= `prompt_tokens` − 命中） | `usage.inputTokens` | 缓存未命中输入（全价） |
| `completion_tokens`（含 reasoning） | `usage.outputTokens` | 输出 |

禁止行为：按字符估算 Token、按命中率反推 Token、使用 UI 四舍五入的 Token、
把总输入同时计入命中与未命中、缺字段时假设全命中/全未命中。
三字段缺一即显示 `费用 —`，不编造金额。

## 支持的 Provider / 模型 / 环境

- Provider：仅 `deepseek-official`（DeepSeek 官方 API）。OpenRouter、中转、私有部署等一律不套官方价。
- 模型：`deepseek-v4-flash`、`deepseek-v4-pro`（官方价格表内）。`deepseek-chat`/`deepseek-reasoner` 已不在官方价格表，自动显示 `费用 —`。
- 币种：CNY（人民币），价格单位每 1,000,000 Token。
- 环境：DSH 0.1.0-rc.6 · Node ≥ 18 · Web Profile（`@deepseek-ai/dsh-web-app`）。

## 价格规则

- 规则文件：`pricing/deepseek-official.json`（版本 `2026-08-17.1`，核验时间 `2026-08-17T11:39:00+08:00`，来源 [官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)）。
- 同一模型支持多套历史规则，按 `effectiveFrom`/`effectiveTo` 与调用时刻选择。
- 峰谷：高峰 = 北京时间 `[09:00,12:00) ∪ [14:00,18:00)`（价格翻倍），其余闲时半价。
- 规则可能过期时，UI 显示轻提示 `价格规则待确认`（阈值 `config.maxAgeDays`，默认 45 天）。

## 安装

DSH Profile 插件管理需要 **pnpm**。推荐安装方式（锁定 tag `v0.1.0-beta.1`）：

```bash
npm install -g pnpm
npx -y @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add github:qqq85-ux/dsh-cost-glance#v0.1.0-beta.1
npx -y @deepseek-ai/dsh@0.1.0-rc.6 web
```

或手动：把仓库加入 profile 依赖后重启 DSH：

```jsonc
// ~/.dsh/profiles/<name>/package.json
{
  "dependencies": { "dsh-cost-glance": "github:qqq85-ux/dsh-cost-glance#v0.1.0-beta.1" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-cost-glance"] } }
}
```

> 插件集变更需重启 `dsh web`；仅改前端文件后刷新页面即可。
> 本仓库发布前已通过 25 项自动测试；普通用户安装后无需运行测试，重启 DSH 并完成一次模型调用即可验证。

## 配置

```yaml
# cordis.patch.yml（或 bundles patch）
- insert:
    - id: dsh-cost-glance
      name: dsh-cost-glance
      config:
        maxAgeDays: 45   # 价格规则过期提示阈值（天）
```

V1 不支持自定义价格表（自定义价格是后续版本的设计项，不在本轮范围）。

## 界面

- 顶栏徽标（`conversation.session.header.actions`）：默认 `约 ¥X.XX`；0 金额 `约 ¥0.00`；无法计价 `费用 —`。
- 点击弹出紧凑 Popover：本会话预估 / 缓存命中输入 / 缓存未命中输入 / 输出 / 模型 / 当前计价 / 价格规则版本 / 最后更新，底部固定提示 `本地预估，以 DeepSeek 官方账单为准`。
- 无悬浮球、无状态点、无跨会话总账。

## 每日价格监控

- GitHub Actions（`.github/workflows/check-deepseek-pricing.yml`）每天 UTC 19:17（= 北京时间次日 03:17）运行，支持手动触发。
- 抓取官方价格页与更新日志 → 记录时间/HTTP 状态/页面摘要/内容哈希 → 提取结构化价格（与排版无关）→ 与仓库最后快照比较 → 无变化正常结束；有变化生成结构化 Diff 并创建/更新 Issue `DeepSeek 官方价格可能已变化：YYYY-MM-DD`。
- **禁止自动合并、自动发布、未经审核直接让用户端生效**。新规则经人工审核更新 `pricing/` 后再发布。
- 运行时更新：V1 只使用内置已审核价格表，不直接抓网页覆盖本地规则（远程规则校验更新为可选设计，暂未实现，无占位 URL）。

## 真实余额对账

```bash
DEEPSEEK_API_KEY=sk-xxx npm run reconcile
```

在专用测试账户上运行：读 `/user/balance` 前余额 → 3 次受控请求 → 本地计费 →
轮询官方余额更新 → 比较并输出逐次明细/合计/绝对与相对误差。密钥只从环境变量读取。
详见 `docs/BILLING_VALIDATION.md`。

## 卸载

```bash
dsh plugin --profile web remove dsh-cost-glance   # 需要 pnpm
# 或手动：从 ~/.dsh/profiles/<name>/package.json 的 bundles 移除
#   + 删除 ~/.dsh/profiles/<name>/node_modules/dsh-cost-glance
```

卸载后重启 DSH；插件不写入任何全局状态（无 localStorage、无残留 DOM/事件/样式）。

## 测试

```bash
npm test                       # node --test（21 项计价/边界 + 4 项合成会话集成）
npm run test:tz                # 在 UTC / 东京 / 纽约时区下运行，证明时区无关
npm run check:pricing          # 本地手动触发一次价格监控
```

每个 Case 输出「输入 / 期望 / 实际 / 误差」，期望值由已审核 Fixture 手工写出。

## 排错（Troubleshooting）

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动报 `declares no dsh.bundle` | 包 `package.json` 缺 `dsh.bundle.patch` | 保留 `dsh.bundle` 声明 |
| 启动报 `cannot resolve profile bundle` | `bundles` 列表有包但 node_modules 里没有 | `dsh plugin … add`（需 pnpm）或手动拷贝 |
| 启动报 `Failed to load plugins / client.js failed to load` | **改了插件/包名后未重启服务就刷新**，旧服务还在按旧配置找已删除的 bundle | 重启 `dsh web` 后再刷新页面 |
| 徽标不出现 | 插件集变更未重启；或当前会话无任何调用 | 重启 + 刷新；跑一次任务后再看 |
| 显示 `费用 —` | 非 DeepSeek 官方 API / 模型不在官方价格表 / usage 缺失 / 无事件时间 | 点击徽标查看具体原因 |
| 金额与预期不符 | 高峰期价格翻倍 / 规则版本过期 / 官方调价 | 核对徽标「当前计价」与「价格规则版本」，必要时更新 `pricing/` |
| 改前端后还是旧样 | 浏览器缓存 | 强刷 `Cmd+Shift+R` |
| `npm pack`/`publish` 报 EPERM | `~/.npm` 缓存有历史 root 权限问题 | `sudo chown -R 501:20 ~/.npm`，或加 `--cache <临时目录>` |

## 已知边界（未覆盖）

- Windows / Linux 环境尚未验证（本机仅验证 macOS）。
- 非 DeepSeek 官方 Provider 的自定义计价（V2 设计项）。
- 远程价格规则自动校验更新（保留接口设计，无占位实现）。
- 不同货币的自动换算。

## 免责声明

官方账单与插件不一致时，**以 DeepSeek 官方为准**。本插件不承诺 100% 等同官方账单，
不声称适配所有 Provider 或自动适配所有未来模型。
