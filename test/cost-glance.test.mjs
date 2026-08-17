// dsh-cost-glance 引擎测试（node --test）
// 每个 Case 输出：输入 / 期望 / 实际 / 误差。期望值由测试根据已审核价格 Fixture
// 手工写出，不与生产代码互证。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadPricingRules, beijingHour, beijingDate, periodOf, nanoPerToken,
  costNano, selectRule, usageFromEvent, makeCostProjection
} from "../engines/cost-glance.mjs";

const pricing = loadPricingRules();
const FLASH = "deepseek-v4-flash";
const PRO = "deepseek-v4-pro";

// ── 测试报告收集 ──────────────────────────────────────────────────────────
const report = [];
function record(name, input, expected, actual, error) {
  report.push({ name, input, expected, actual, error });
  return actual;
}

// ── 工具 ──────────────────────────────────────────────────────────────────
/** 构造北京时间某时刻的 epoch ms（用 UTC 反推，与测试机时区无关）。 */
function bj(y, mo, d, hour, minute = 0, second = 0, ms = 0) {
  return Date.UTC(y, mo - 1, d, hour - 8, minute, second, ms);
}
const yuan = (nano) => nano / 1e9;
const fmt = (nano) => nano.toFixed(0) + " nano(" + yuan(nano).toFixed(9) + " 元)";
const msg = (event) => ({
  type: "assistant/message",
  time: event.time,
  data: {
    turn: event.turn ?? 0,
    step: event.step ?? 0,
    usage: event.usage,
    message: { source: { provider: event.provider ?? "deepseek-official", model: event.model } }
  }
});
function foldEvents(events) {
  const proj = makeCostProjection(pricing);
  let s = proj.init();
  for (const e of events) s = proj.apply(s, e);
  return { state: s, view: proj.view(s) };
}
const flashRules = pricing.rules.filter((r) => r.model === FLASH);
const proRules = pricing.rules.filter((r) => r.model === PRO);
const PEAK = bj(2026, 8, 17, 10);   // 北京 10:00 高峰
const OFF = bj(2026, 8, 17, 20);    // 北京 20:00 闲时
const HIST = bj(2026, 8, 16, 15);   // 8/17 生效前（历史价）

// ── 4.2 固定算例（期望值手工写出）──────────────────────────────────────
test("固定算例：V4 Flash 高峰 2026-08-17T02:00:00Z", () => {
  const ev = msg({
    model: FLASH, time: Date.UTC(2026, 7, 17, 2, 0, 0),
    usage: { inputTokens: 200000, cacheReadTokens: 100000, outputTokens: 300000 },
    turn: 0, step: 0
  });
  // 手工期望：命中 100000×0.1/M=0.01；未命中 200000×3/M=0.60；输出 300000×9/M=2.70；合计 3.31
  const hitNano = 100000 * nanoPerToken(0.1);   // 10,000,000 nano = 0.01
  const missNano = 200000 * nanoPerToken(3);    // 600,000,000 nano = 0.60
  const outNano = 300000 * nanoPerToken(9);     // 2,700,000,000 nano = 2.70
  assert.equal(hitNano, 10000000);
  assert.equal(missNano, 600000000);
  assert.equal(outNano, 2700000000);
  assert.equal(hitNano + missNano + outNano, 3310000000); // 3.31 元
  const { view } = foldEvents([ev]);
  assert.equal(view.status, "priced");
  assert.equal(view.estimatedNano, 3310000000);
  assert.equal(view.estimated, "¥3.31");
  assert.equal(view.hit, "¥0.01");
  assert.equal(view.miss, "¥0.60");
  assert.equal(view.output, "¥2.70");
  assert.equal(view.model, "DeepSeek V4 Flash");
  assert.equal(view.pricingPeriod, "高峰");
  assert.equal(view.pricingRuleVersion, pricing.rulesVersion);
  record("固定算例", "flash 高峰 hit100k/miss200k/out300k", "3.31 元", yuan(view.estimatedNano), 0);
});

// ── 4.1 纯计价单元测试 ───────────────────────────────────────────────────
function pricesAt(time, model) { return selectRule(model === FLASH ? flashRules : proRules, model, time).prices; }
function periodAt(time, prices) { return prices.flat !== void 0 ? "flat" : periodOf(time, pricing.periods); }
const mk = (tokens, time, model = FLASH) => {
  const prices = pricesAt(time, model);
  return costNano(tokens, prices, periodAt(time, prices));
};

test("1. V4 Flash 高峰", () => {
  const c = mk({ hit: 1e6, miss: 1e6, out: 1e6 }, PEAK);
  const expectedNano = 12100000000; // 手写：1e6×(100+3000+9000) nano = 12.10 元
  assert.equal(c.total, expectedNano);
  const actual = yuan(c.total);
  record("V4 Flash 高峰", "各 1M tokens", "12.10 元", actual, actual - 12.1);
});
test("2. V4 Flash 闲时", () => {
  const c = mk({ hit: 1e6, miss: 1e6, out: 1e6 }, OFF);
  const expectedNano = 6050000000; // 手写：1e6×(50+1500+4500) nano = 6.05 元
  assert.equal(c.total, expectedNano);
  const actual = yuan(c.total);
  record("V4 Flash 闲时", "各 1M tokens", "6.05 元", actual, actual - 6.05);
});
test("3. V4 Pro 高峰", () => {
  const c = mk({ hit: 1e6, miss: 1e6, out: 1e6 }, PEAK, PRO);
  const expectedNano = 36300000000; // 手写：1e6×(300+9000+27000) nano = 36.30 元
  assert.equal(c.total, expectedNano);
  const actual = yuan(c.total);
  record("V4 Pro 高峰", "各 1M tokens", "36.30 元", actual, actual - 36.3);
});
test("4. V4 Pro 闲时", () => {
  const c = mk({ hit: 1e6, miss: 1e6, out: 1e6 }, OFF, PRO);
  const expectedNano = 18150000000; // 手写：1e6×(150+4500+13500) nano = 18.15 元
  assert.equal(c.total, expectedNano);
  const actual = yuan(c.total);
  record("V4 Pro 闲时", "各 1M tokens", "18.15 元", actual, actual - 18.15);
});
test("5. 全部缓存命中", () => {
  const c = mk({ hit: 1e6, miss: 0, out: 0 }, OFF);
  assert.equal(c.total, 50000000); // 1e6×50 nano = 0.05 元
  assert.equal(c.miss, 0);
  record("全部命中", "hit1M miss0 out0 闲时", "0.05 元", yuan(c.total), 0);
});
test("6. 全部缓存未命中", () => {
  const c = mk({ hit: 0, miss: 1e6, out: 0 }, OFF);
  assert.equal(c.total, 1500000000); // 1e6×1500 nano = 1.50 元
  record("全部未命中", "hit0 miss1M out0 闲时", "1.50 元", yuan(c.total), 0);
});
test("7. 命中+未命中+输出混合", () => {
  const c = mk({ hit: 100000, miss: 200000, out: 300000 }, PEAK);
  const expectedNano = 3310000000; // 手写：1e5×100 + 2e5×3000 + 3e5×9000 nano = 3.31 元
  assert.equal(c.total, expectedNano);
  record("混合", "hit100k miss200k out300k 高峰", "3.31 元", yuan(c.total), 0);
});
test("8. 输出为 0", () => {
  const c = mk({ hit: 100000, miss: 100000, out: 0 }, OFF);
  const expectedNano = 155000000; // 手写：1e5×50 + 1e5×1500 nano = 0.155 元
  assert.equal(c.total, expectedNano);
  assert.equal(c.out, 0);
  record("输出为 0", "hit100k miss100k out0 闲时", "0.155 元", yuan(c.total), 0);
});
test("9. 未知模型 → 不计价", () => {
  const { view } = foldEvents([msg({ model: "deepseek-v4-unknown", time: PEAK, usage: { inputTokens: 1, cacheReadTokens: 1, outputTokens: 1 } })]);
  assert.equal(view.status, "unpriced");
  assert.equal(view.estimated, "费用 —");
  assert.equal(view.unpricedReasons[0].reason, "model-not-in-official-table");
  record("未知模型", "deepseek-v4-unknown", "费用 —", view.estimated, 0);
});
test("10. 非 DeepSeek 官方 Provider → 不套官方价", () => {
  const { view } = foldEvents([msg({ model: FLASH, provider: "openrouter", time: PEAK, usage: { inputTokens: 1, cacheReadTokens: 1, outputTokens: 1 } })]);
  assert.equal(view.status, "unpriced");
  assert.equal(view.unpricedReasons[0].reason, "non-deepseek-provider");
  record("非官方 Provider", "openrouter/deepseek-v4-flash", "费用 —", view.estimated, 0);
});
test("11. usage 字段缺失 → 不编造金额", () => {
  const miss = foldEvents([msg({ model: FLASH, time: PEAK, usage: { inputTokens: 1, outputTokens: 1 } })]).view; // 缺 cacheRead
  assert.equal(miss.unpricedReasons[0].reason, "cache-hit-missing");
  const none = foldEvents([msg({ model: FLASH, time: PEAK })]).view; // 全缺
  assert.equal(none.unpricedReasons[0].reason, "usage-missing");
  record("usage 缺失", "缺 cacheReadTokens", "费用 —", miss.estimated, 0);
});
test("12. 历史价格规则（8/17 生效前）", () => {
  const c = mk({ hit: 1e6, miss: 1e6, out: 1e6 }, HIST);
  const expectedNano = 3020000000; // 手写：1e6×(20+1000+2000) nano = 3.02 元（历史 flat 价）
  assert.equal(c.total, expectedNano);
  const { view } = foldEvents([msg({ model: FLASH, time: HIST, usage: { inputTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 1e6 } })]);
  assert.equal(view.estimatedNano, c.total);
  record("历史规则", "8/16 各 1M tokens", "3.02 元", yuan(view.estimatedNano), 0);
});
test("13. 多次小额调用累计：整数精确 vs 每笔四舍五入", () => {
  // 3000 笔，每笔 1 hit + 1 miss + 1 out token，闲时 flash → 每笔 50+1500+4500=6050 nano
  const perCall = costNano({ hit: 1, miss: 1, out: 1 }, pricesAt(OFF, FLASH), "offPeak");
  assert.equal(perCall.total, 6050);
  const events = [];
  for (let i = 0; i < 3000; i++) {
    events.push(msg({ model: FLASH, time: OFF + i, usage: { inputTokens: 1, cacheReadTokens: 1, outputTokens: 1 }, turn: 0, step: i }));
  }
  const { view } = foldEvents(events);
  const exactNano = 6050 * 3000; // 18,150,000 nano = 0.01815 元（精确整数）
  assert.equal(view.estimatedNano, exactNano);
  // 对照：每笔先四舍五入到 2 位小数再累加 → 每笔 0.00 或 0.01 元 → 误差巨大
  const roundedPerCall = Math.round(6050 / 1e7) / 100; // 每笔四舍五入到分
  const roundedTotal = roundedPerCall * 3000;
  const errorVsRounding = Math.abs(yuan(exactNano) - roundedTotal);
  assert.ok(errorVsRounding > 0.01, "每笔四舍五入会产生明显误差");
  record("3000 笔小额累计", "每笔 6050 nano", `${yuan(exactNano).toFixed(9)} 元`, `${yuan(view.estimatedNano).toFixed(9)} 元`, `0（整数累计）；每笔取整误差 ${errorVsRounding.toFixed(4)} 元`);
});
test("14. 重复事件去重（同 turn:step 只计一次）", () => {
  const e = msg({ model: FLASH, time: PEAK, usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 1000 }, turn: 3, step: 7 });
  const proj = makeCostProjection(pricing);
  let s = proj.init();
  s = proj.apply(s, e); // 第 1 次
  s = proj.apply(s, e); // 重复
  const view = proj.view(s);
  assert.equal(view.calls, 1);
  const once = foldEvents([e]).view;
  assert.equal(view.estimatedNano, once.estimatedNano);
  record("重复事件去重", "同 turn3:step7 两次", "只计 1 次", `${view.calls} 次`, 0);
});
test("15. Fork / 双会话不重复累计", () => {
  const parentEvents = [
    msg({ model: FLASH, time: OFF, usage: { inputTokens: 100000, cacheReadTokens: 0, outputTokens: 100000 }, turn: 0, step: 0 }),
    msg({ model: FLASH, time: OFF + 1, usage: { inputTokens: 100000, cacheReadTokens: 0, outputTokens: 100000 }, turn: 0, step: 1 })
  ];
  const parent = foldEvents(parentEvents).view;
  // fork = 继承父事件的新会话：同样事件折叠一次，不得因"继承"翻倍
  const fork = foldEvents(parentEvents).view;
  assert.equal(fork.estimatedNano, parent.estimatedNano);
  // fork 新增调用只计新增
  const forkNext = foldEvents([...parentEvents, msg({ model: FLASH, time: OFF + 2, usage: { inputTokens: 100000, cacheReadTokens: 0, outputTokens: 100000 }, turn: 0, step: 2 })]).view;
  const perCall = costNano({ hit: 0, miss: 100000, out: 100000 }, pricesAt(OFF, FLASH), "offPeak");
  assert.equal(forkNext.estimatedNano, parent.estimatedNano + perCall.total);
  record("Fork 不重复累计", "父 2 笔 / fork 继承 2 笔 + 新增 1 笔", "fork=父，新增只加新增", `${forkNext.calls} 笔`, 0);
});

// ── 时间边界（北京时间，左闭右开）──────────────────────────────────────
test("峰谷时间边界（8 个）", () => {
  const cases = [
    ["08:59:59", 8, 59, 59, "offPeak"],
    ["09:00:00", 9, 0, 0, "peak"],
    ["11:59:59", 11, 59, 59, "peak"],
    ["12:00:00", 12, 0, 0, "offPeak"],
    ["13:59:59", 13, 59, 59, "offPeak"],
    ["14:00:00", 14, 0, 0, "peak"],
    ["17:59:59", 17, 59, 59, "peak"],
    ["18:00:00", 18, 0, 0, "offPeak"]
  ];
  for (const [label, h, m, s, expected] of cases) {
    const t = bj(2026, 8, 17, h, m, s);
    const actual = periodOf(t, pricing.periods);
    assert.equal(actual, expected, `${label} 应为 ${expected}`);
    record(`边界 ${label}`, `${label} 北京`, expected, actual, 0);
  }
  // 规则选择与时段联动：边界前后价格不同
  const before = bj(2026, 8, 17, 8, 59, 59);
  const at = bj(2026, 8, 17, 9, 0, 0);
  const c1 = costNano({ hit: 1e6, miss: 0, out: 0 }, pricesAt(before, FLASH), "offPeak");
  const c2 = costNano({ hit: 1e6, miss: 0, out: 0 }, pricesAt(at, FLASH), "peak");
  assert.equal(yuan(c1.total), 0.05);
  assert.equal(yuan(c2.total), 0.1);
});

// ── 规则选择：历史/现行/未来─────────────────────────────────────────────
test("规则版本选择（按事件时间）", () => {
  const t1 = bj(2026, 8, 16, 23, 59, 59); // 历史价
  const t2 = bj(2026, 8, 17, 0, 0, 0);    // 新价生效瞬间
  assert.equal(selectRule(flashRules, FLASH, t1).status, "historical");
  assert.equal(selectRule(flashRules, FLASH, t2).status, "active");
  assert.equal(selectRule(flashRules, FLASH, t2).prices.peak.cacheMissInput, 3);
  record("规则版本选择", "8/16 23:59:59 → historical；8/17 00:00:00 → active", "2 套规则各选其时刻", `${selectRule(flashRules, FLASH, t2).rulesVersion ?? pricing.rulesVersion}`, 0);
});

// ── 北京时间工具（含时区无关性：本函数显式指定 Asia/Shanghai）──────────
test("北京时间工具", () => {
  assert.equal(beijingHour(bj(2026, 8, 17, 10, 30)), 10);
  assert.equal(beijingDate(bj(2026, 8, 17, 0, 30)), "2026-08-17");
  assert.equal(beijingDate(Date.UTC(2026, 7, 16, 16, 30)), "2026-08-17"); // UTC 16:30 = 北京次日 00:30
  record("北京时间工具", "UTC16:30→北京次日00:30", "2026-08-17", beijingDate(Date.UTC(2026, 7, 16, 16, 30)), 0);
});

// ── 价格规则 schema 校验 ─────────────────────────────────────────────────
test("价格规则 schema 自检", () => {
  assert.equal(pricing.currency, "CNY");
  assert.equal(pricing.unit, "per_1M_tokens");
  assert.equal(pricing.timezone, "Asia/Shanghai");
  assert.ok(pricing.sourceUrl.startsWith("https://api-docs.deepseek.com"));
  assert.equal(typeof pricing.rulesVersion, "string");
  assert.ok(pricing.rules.length >= 4);
  record("规则自检", "schemaVersion/rulesVersion/models/rules", ">=4 条规则", `${pricing.rules.length} 条`, 0);
});

// ── 输出测试报告 ─────────────────────────────────────────────────────────
test("输出测试报告", () => {
  console.log("\n=== dsh-cost-glance 计价测试报告（输入 / 期望 / 实际 / 误差）===");
  console.log(`价格规则版本: ${pricing.rulesVersion} · 核验时间: ${pricing.sourceCheckedAt} · 来源: ${pricing.sourceUrl}`);
  for (const r of report) {
    console.log(`- ${r.name.padEnd(22)} | 输入: ${String(r.input).padEnd(44)} | 期望: ${String(r.expected).padEnd(16)} | 实际: ${String(r.actual).padEnd(22)} | 误差: ${r.error}`);
  }
  console.log(`合计 ${report.length} 个断言点\n`);
});
