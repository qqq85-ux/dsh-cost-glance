// dsh-cost-glance DSH 集成测试：在合成会话事件 fixture 上验证。
//
// 隐私说明：fixture 为完全合成的数据（种子化 PRNG 确定性生成）——
//   - 会话 ID / 文件名不含任何真实会话标识；
//   - 时间戳为 2026-08 合成的调用时刻（前 2 条在 8/17 峰谷价生效前 = 历史价，
//     其余 45 条在北京时间高峰时段 = 峰谷价）；
//   - token 数值量级与真实 DSH 会话相近，但不复制任何真实调用序列；
//   - 不含消息正文、路径、余额或任何个人数据。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPricingRules, makeCostProjection, periodOf, selectRule } from "../engines/cost-glance.mjs";

const pricing = loadPricingRules();
const events = JSON.parse(readFileSync(
  fileURLToPath(new URL("../test/fixtures/synthetic-session.assistant-messages.json", import.meta.url)),
  "utf8"
));

test("合成会话：47 条事件全部计费且与冻结期望值一致", () => {
  const proj = makeCostProjection(pricing);
  let s = proj.init();
  for (const e of events) s = proj.apply(s, e);
  const view = proj.view(s);
  // 期望值 = 对合成 fixture 折叠后冻结的字面量（修改 fixture 会使其失效并暴露）
  assert.equal(view.status, "priced");
  assert.equal(view.calls, 47);
  assert.equal(view.estimatedNano, 1839462320); // ¥1.839462
  assert.equal(view.hitNano, 1193335320);       // ¥1.193335（缓存命中）
  assert.equal(view.missNano, 41439000);        // ¥0.041439（缓存未命中）
  assert.equal(view.outputNano, 604688000);     // ¥0.604688（输出）
  assert.equal(view.model, "DeepSeek V4 Flash");
  assert.equal(view.pricingRuleVersion, pricing.rulesVersion);
  assert.deepEqual(view.unpricedReasons, []);
});

test("合成会话：历史调用用历史价、新调用用峰谷价（版本化规则生效）", () => {
  let flat = 0, peak = 0, off = 0;
  for (const e of events) {
    const rule = selectRule(pricing.rules, "deepseek-v4-flash", e.time);
    const period = rule.prices.flat !== void 0 ? "flat" : periodOf(e.time, pricing.periods);
    if (period === "flat") flat++; else if (period === "peak") peak++; else off++;
  }
  assert.equal(flat, 2);
  assert.equal(peak, 45);
  assert.equal(off, 0);
});

test("合成会话：重复折叠同一事件列表不重复累计（刷新/恢复语义）", () => {
  const proj = makeCostProjection(pricing);
  let s = proj.init();
  for (const e of events) s = proj.apply(s, e);
  const once = proj.view(s).estimatedNano;
  const proj2 = makeCostProjection(pricing);
  let s2 = proj2.init();
  for (const e of events) s2 = proj2.apply(s2, e);
  assert.equal(proj2.view(s2).estimatedNano, once);
});

test("合成会话：失败/无 usage 事件不虚构费用", () => {
  const proj = makeCostProjection(pricing);
  let s = proj.init();
  for (const e of events) s = proj.apply(s, e);
  s = proj.apply(s, { type: "assistant/message", time: events[0].time, data: { turn: 99, step: 0, message: { source: { provider: "deepseek-official", model: "deepseek-v4-flash" } } } });
  s = proj.apply(s, { type: "turn/end", time: events[0].time, data: { reason: { kind: "error" } } });
  assert.equal(proj.view(s).estimatedNano, 1839462320);
  assert.equal(proj.view(s).calls, 47);
});
