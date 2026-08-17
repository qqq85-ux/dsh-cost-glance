#!/usr/bin/env node
// dsh-cost-glance 真实对账脚本：与 DeepSeek 官方余额对比，验证本地计费。
//
// 用法：
//   DEEPSEEK_API_KEY=sk-xxx node scripts/reconcile-official-balance.mjs
//   DSH_COST_GLANCE_DRY_RUN=1 node scripts/reconcile-official-balance.mjs   # 无 key 的流程自检
//
// 安全：密钥只从环境变量读取，绝不打印/保存；报告不含请求内容与密钥。
// 建议在专用 API Key / 测试账户上运行（要求无其他并发调用）。
import { loadPricingRules, costNano, periodOf, selectRule, beijingDate } from "../engines/cost-glance.mjs";

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.DSH_COST_GLANCE_RECONCILE_MODEL ?? "deepseek-v4-flash";
const REQUEST_COUNT = Number(process.env.DSH_COST_GLANCE_REQUEST_COUNT ?? 3);
const POLL_TIMEOUT_MS = Number(process.env.DSH_COST_GLANCE_POLL_TIMEOUT_MS ?? 120000);
const DRY = process.env.DSH_COST_GLANCE_DRY_RUN === "1";
const pricing = loadPricingRules();

// ── 传输（dry-run 用脚本化 mock，真实模式用 fetch）──────────────────────
let _dryBalanceNano = 100e9; // 100 元（整数 nano，避免 mock 引入浮点误差）
let _drySequence = 0;
async function httpJson(url, options) {
  if (DRY) {
    if (url.endsWith("/user/balance")) {
      const b = _dryBalanceNano / 1e9;
      return {
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: b.toFixed(6), granted_balance: "0.00", topped_up_balance: b.toFixed(6) }]
      };
    }
    if (url.endsWith("/chat/completions")) {
      _drySequence++;
      const usage = {
        prompt_tokens: 1000 + _drySequence * 500,
        prompt_tokens_details: { cached_tokens: 300 + _drySequence * 100 },
        completion_tokens: 50 + _drySequence * 10
      };
      // 模拟官方扣费：按本地引擎同样的价格计算
      const t = Date.now();
      const rule = selectRule(pricing.rules, MODEL, t);
      const period = rule.prices.flat !== void 0 ? "flat" : periodOf(t, pricing.periods);
      const c = costNano(
        { hit: usage.prompt_tokens_details.cached_tokens, miss: usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens, out: usage.completion_tokens },
        rule.prices, period
      );
      _dryBalanceNano -= c.total; // 官方侧也按整数 nano 扣减
      return { id: `dry-${_drySequence}`, model: MODEL, usage };
    }
    throw new Error(`dry-run: 未预期的请求 ${url}`);
  }
  const res = await fetch(url, options);
  const body = await res.json();
  if (!res.ok) throw new Error(`DeepSeek API ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

function balanceOf(body) {
  const infos = body?.balance_infos ?? [];
  const cny = infos.find((b) => b.currency === "CNY");
  return {
    isAvailable: body?.is_available === true,
    total: cny ? Number(cny.total_balance) : NaN,
    granted: cny ? Number(cny.granted_balance ?? 0) : NaN,
    toppedUp: cny ? Number(cny.topped_up_balance ?? 0) : NaN
  };
}
function authHeaders() {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key && !DRY) throw new Error("缺少 DEEPSEEK_API_KEY（仅从环境变量读取，不会打印）");
  return { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

async function runChat() {
  const t0 = Date.now();
  const body = await httpJson(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "计费对账：请用一句话回答 1+1。" }],
      max_tokens: 32,
      stream: false
    })
  });
  const usage = body.usage;
  const hit = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const miss = (usage?.prompt_tokens ?? 0) - hit;
  const out = usage?.completion_tokens ?? 0;
  if (!(hit >= 0 && miss >= 0 && out >= 0 && usage?.prompt_tokens !== void 0)) {
    throw new Error("响应缺少完整 usage，无法对账");
  }
  const rule = selectRule(pricing.rules, MODEL, t0);
  if (rule === void 0) throw new Error(`模型 ${MODEL} 无适用价格规则`);
  const period = rule.prices.flat !== void 0 ? "flat" : periodOf(t0, pricing.periods);
  const c = costNano({ hit, miss, out }, rule.prices, period);
  return { hit, miss, out, costNano: c.total, period, ruleVersion: pricing.rulesVersion, occurredAt: t0 };
}

async function pollBalance(expectedAfter) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = balanceOf(await httpJson(`${BASE_URL}/user/balance`, { headers: authHeaders() }));
    if (Number.isFinite(last.total) && last.total <= expectedAfter - 1e-9) return last;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return last;
}

async function main() {
  console.log(`== dsh-cost-glance 官方余额对账${DRY ? "（DRY-RUN，脚本化 mock）" : ""} ==`);
  console.log(`模型: ${MODEL} · 请求数: ${REQUEST_COUNT} · 规则版本: ${pricing.rulesVersion} · 时区基准: ${pricing.timezone}`);
  const before = balanceOf(await httpJson(`${BASE_URL}/user/balance`, { headers: authHeaders() }));
  console.log(`对账前余额: 总 ${before.total.toFixed(6)} 元（充值 ${before.toppedUp.toFixed(6)} / 赠送 ${before.granted.toFixed(6)}）`);

  const rows = [];
  let localTotalNano = 0;
  for (let i = 0; i < REQUEST_COUNT; i++) {
    const r = await runChat();
    rows.push(r);
    localTotalNano += r.costNano;
    console.log(`  请求 ${i + 1}: hit=${r.hit} miss=${r.miss} out=${r.out} · ${r.period} · 本地费用 ${(r.costNano / 1e9).toFixed(9)} 元`);
  }
  const localTotalYuan = localTotalNano / 1e9;

  console.log("等待官方余额更新（轮询，超时 " + Math.round(POLL_TIMEOUT_MS / 1000) + "s）…");
  const after = await pollBalance(before.total);
  const officialDelta = before.total - after.total;
  const absError = Math.abs(officialDelta - localTotalYuan);
  const relError = localTotalYuan > 0 ? absError / localTotalYuan : 0;

  console.log(`\n对账后余额: 总 ${after.total.toFixed(6)} 元（充值 ${after.toppedUp.toFixed(6)} / 赠送 ${after.granted.toFixed(6)}）`);
  console.log(`官方余额变化: ${officialDelta.toFixed(9)} 元`);
  console.log(`本地预估合计: ${localTotalYuan.toFixed(9)} 元（${localTotalNano} nano）`);
  console.log(`绝对误差: ${absError.toFixed(9)} 元 | 相对误差: ${(relError * 100).toFixed(4)}%`);
  console.log(`验收: 内部算术误差 ${localTotalNano === rows.reduce((a, r) => a + r.costNano, 0) ? "0（整数累计）" : "异常"}；最终差异原则上应 ≤ ¥0.01`);
  if (absError > 0.01 && !DRY) {
    console.log(`⚠ 差异超过 ¥0.01，可能原因：余额更新延迟/其他并发调用/赠送余额扣减顺序。请勿修改测试容差掩盖。`);
  }
  console.log(`注：若赠送与充值余额并存，比较的是总可用余额变化；官方优先扣赠送余额。`);
  if (DRY) console.log(`DRY-RUN 通过（流程与算术自检）；真实运行请设置 DEEPSEEK_API_KEY 后重跑。`);
}

main().catch((e) => {
  console.error("对账失败:", e.message);
  process.exit(1);
});
