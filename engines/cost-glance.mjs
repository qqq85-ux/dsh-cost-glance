// dsh-cost-glance —— 会话费用速览引擎（零第三方依赖）
//
// 产品定位：根据 DeepSeek 官方定价、模型、缓存命中情况和 API 请求发生时段，
// 实时计算并展示当前 DSH 会话的【预估费用】。它不是账户余额工具、不是正式
// 账单系统、也不是跨会话财务仪表盘；以 DeepSeek 官方账单为准。
//
// 计费口径（只能使用模型调用返回的原始 usage，禁止估算/反推）：
//   适配器（dsh-llm-deepseek）映射：DeepSeek 的 prompt_tokens 含缓存命中，
//   适配器已做互斥拆分 ——
//     usage.inputTokens      = prompt_cache_miss_tokens（缓存未命中输入）
//     usage.cacheReadTokens  = prompt_cache_hit_tokens（缓存命中输入）
//     usage.outputTokens     = completion_tokens（输出，含 reasoning）
//   三个字段缺一即视为"无法精确计价"，不编造金额。
//
// 计价：
//   - 只用 DeepSeek 官方 API（provider === "deepseek-official"）且模型在官方
//     价格表中的调用，自动按人民币计价；其余一律显示"费用 —"。
//   - 价格规则版本化（pricing/deepseek-official.json），按调用发生时刻
//     （事件时间）选择当时生效的规则，禁止用今天的价格重算历史调用。
//   - 峰谷时段按北京时间（Asia/Shanghai）判断，左闭右开：
//     高峰 = [09:00,12:00) ∪ [14:00,18:00)，其余为闲时。
//   - 内部全程用整数最小计价单位 nanoYuan（1e-9 元）累加，禁止浮点累计；
//     只在 UI 展示时转两位小数。

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// ── 价格规则加载 ──────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
/** 加载并校验内置官方价格规则。 */
export function loadPricingRules(path = "../pricing/deepseek-official.json") {
  const raw = JSON.parse(readFileSync(require.resolve(path), "utf8"));
  validatePricingSchema(raw);
  return raw;
}
/** 把规则里的 +08:00 时间戳解析成 epoch 毫秒（解析失败抛错）。 */
function toEpochMs(text) {
  if (text === null || text === void 0) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error(`dsh-cost-glance: 价格规则时间不可解析: ${JSON.stringify(text)}`);
  return ms;
}
function validatePricingSchema(rules) {
  if (typeof rules !== "object" || rules === null) throw new Error("dsh-cost-glance: 价格规则必须是 JSON 对象");
  for (const key of ["schemaVersion", "rulesVersion", "sourceUrl", "sourceCheckedAt", "currency", "unit", "timezone", "models", "rules"]) {
    if (rules[key] === void 0) throw new Error(`dsh-cost-glance: 价格规则缺少字段 ${key}`);
  }
  if (rules.currency !== "CNY") throw new Error("dsh-cost-glance: 仅支持 CNY 官方规则");
  if (rules.unit !== "per_1M_tokens") throw new Error(`dsh-cost-glance: 未知计价单位 ${rules.unit}`);
  if (rules.timezone !== "Asia/Shanghai") throw new Error(`dsh-cost-glance: 未知时区 ${rules.timezone}`);
  const seenModels = new Set();
  for (const rule of rules.rules) {
    if (typeof rule.model !== "string" || rule.model.length === 0) throw new Error("dsh-cost-glance: 规则缺少 model");
    toEpochMs(rule.effectiveFrom);
    toEpochMs(rule.effectiveTo);
    const priceKeys = Object.keys(rule.prices ?? {});
    const validShape = priceKeys.length === 1 && priceKeys[0] === "flat" ||
      priceKeys.length === 2 && priceKeys.includes("peak") && priceKeys.includes("offPeak");
    if (!validShape) throw new Error(`dsh-cost-glance: ${rule.model} 价格形态需为 flat 或 peak+offPeak`);
    for (const key of priceKeys) {
      for (const field of ["cacheHitInput", "cacheMissInput", "output"]) {
        const v = rule.prices[key][field];
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
          throw new Error(`dsh-cost-glance: ${rule.model}.${key}.${field} 非法`);
        }
      }
    }
  }
  // 模型唯一性：同一模型同一生效区间不得重复
  const keys = rules.rules.map((r) => `${r.model}|${r.effectiveFrom}|${r.effectiveTo}`);
  if (new Set(keys).size !== keys.length) throw new Error("dsh-cost-glance: 存在重复的模型+生效区间规则");
  return true;
}

// ── 北京时间工具 ──────────────────────────────────────────────────────────
/** 事件时间（epoch ms）→ 北京时间小时 0-23。 */
export function beijingHour(epochMs) {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23"
  }).format(new Date(epochMs)));
}
/** 事件时间（epoch ms）→ 北京时间日期 YYYY-MM-DD（字符串可比较）。 */
export function beijingDate(epochMs) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(epochMs));
}
/**
 * 时段判断（左闭右开）：高峰 = [09,12) ∪ [14,18)，其余闲时。
 * @param epochMs - 事件时间。
 * @param periods - 价格规则的 periods（默认官方）。
 * @returns "peak" | "offPeak"。
 */
export function periodOf(epochMs, periods = { peak: [[9, 12], [14, 18]] }) {
  const hour = beijingHour(epochMs);
  for (const [start, end] of periods.peak ?? []) {
    if (hour >= start && hour < end) return "peak";
  }
  return "offPeak";
}

// ── 整数计价（nanoYuan）───────────────────────────────────────────────────
/** 每百万 tokens 单价（元）→ 每 token 单价（nanoYuan 整数）。1 元/M = 1000 nano/token。 */
export function nanoPerToken(yuanPerMillion) {
  if (typeof yuanPerMillion !== "number" || !Number.isFinite(yuanPerMillion) || yuanPerMillion < 0) {
    throw new Error(`dsh-cost-glance: 非法单价 ${yuanPerMillion}`);
  }
  return Math.round(yuanPerMillion * 1000);
}
/**
 * 按价格与时段计算一次调用的费用（全部为整数 nanoYuan）。
 * @param tokens - { hit, miss, out } 原始 token 数。
 * @param prices - 规则的价格对象（flat 或 peak/offPeak）。
 * @param period - "flat" | "peak" | "offPeak"。
 * @returns 各桶与合计（整数 nanoYuan）。
 */
export function costNano(tokens, prices, period) {
  const rate = prices[period];
  if (rate === void 0) throw new Error(`dsh-cost-glance: 价格对象缺少时段 ${period}`);
  const hit = Math.round(tokens.hit) * nanoPerToken(rate.cacheHitInput);
  const miss = Math.round(tokens.miss) * nanoPerToken(rate.cacheMissInput);
  const out = Math.round(tokens.out) * nanoPerToken(rate.output);
  return { hit, miss, out, total: hit + miss + out };
}

// ── 规则选择 ──────────────────────────────────────────────────────────────
/**
 * 选择某模型在事件时刻生效的价格规则。
 * @param rules - 价格规则数组。
 * @param model - 模型 id。
 * @param epochMs - 事件时间。
 * @returns 规则对象，或 undefined（无适用规则）。
 */
export function selectRule(rules, model, epochMs) {
  for (const rule of rules) {
    if (rule.model !== model) continue;
    const from = toEpochMs(rule.effectiveFrom);
    const to = toEpochMs(rule.effectiveTo);
    if ((from === null || epochMs >= from) && (to === null || epochMs <= to)) return rule;
  }
  return void 0;
}

// ── 原始 usage 提取（严格）────────────────────────────────────────────────
/**
 * 从 assistant/message 事件提取原始 usage。三字段缺一即失败，禁止假设。
 * @param event - 会话事件。
 * @returns { ok, tokens?, reason? }
 */
export function usageFromEvent(event) {
  const usage = event?.data?.usage;
  if (typeof usage !== "object" || usage === null) return { ok: false, reason: "usage-missing" };
  const miss = usage.inputTokens;
  const hit = usage.cacheReadTokens;
  const out = usage.outputTokens;
  for (const [name, value] of [["cache-miss", miss], ["cache-hit", hit], ["output", out]]) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return { ok: false, reason: `${name}-missing` };
    }
  }
  return { ok: true, tokens: { hit: Math.round(hit), miss: Math.round(miss), out: Math.round(out) } };
}

// ── 投影 ──────────────────────────────────────────────────────────────────
const nanoToYuanText = (nano, digits) => (nano / 1e9).toFixed(digits);
const yuanSymbol = () => "¥";

/** 视图校验（手写 schema，零依赖）。 */
const costGlanceViewSchema = {
  parse(value) {
    if (typeof value !== "object" || value === null) throw new Error("dsh-cost-glance: 视图必须是对象");
    for (const key of ["status", "calls", "estimated", "pricingRuleVersion"]) {
      if (value[key] === void 0) throw new Error(`dsh-cost-glance: 视图缺少 ${key}`);
    }
    return value;
  }
};

/**
 * 构造 costGlance 投影。
 * @param pricing - 已校验的价格规则。
 * @param maxAgeDays - 规则过期提示阈值（天）。
 * @returns 投影定义。
 */
export function makeCostProjection(pricing, maxAgeDays = 45) {
  const ruleIndex = new Map(); // model -> rules[]
  for (const rule of pricing.rules) {
    const list = ruleIndex.get(rule.model) ?? [];
    list.push(rule);
    ruleIndex.set(rule.model, list);
  }
  const modelDisplay = (model) => pricing.models[model]?.displayName ?? model;
  return {
    key: "costGlance",
    schema: costGlanceViewSchema,
    init: () => ({
      totalNano: 0,
      hitNano: 0,
      missNano: 0,
      outNano: 0,
      calls: 0,
      lastByTurnStep: new Map(), // "turn:step" -> 该次调用明细（用于去重替换）
      perModel: new Map(),       // model -> { totalNano, hitNano, missNano, outNano, calls }
      lastCall: null,            // 最近一次成功计费调用
      unpriced: new Map()        // model -> reason
    }),
    apply(state, event) {
      if (event?.type !== "assistant/message") return state;
      const data = event.data ?? {};
      const source = data.message?.source ?? {};
      const model = source.model;
      const provider = source.provider;
      const turnStep = `${String(data.turn)}:${String(data.step)}`;
      const epoch = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : null;

      // 门控：Provider / 事件时间
      let reason = null;
      if (provider !== "deepseek-official") reason = "non-deepseek-provider";
      else if (epoch === null) reason = "no-event-time";
      // 门控：usage 完整性
      const usage = usageFromEvent(event);
      if (reason === null && !usage.ok) reason = usage.reason;
      // 门控：模型在官方价格表 + 有适用规则
      let rule = null;
      if (reason === null) {
        if (model === void 0 || typeof model !== "string" || !pricing.models[model]) reason = "model-not-in-official-table";
        else {
          rule = selectRule(ruleIndex.get(model) ?? [], model, epoch);
          if (rule === void 0) reason = "no-applicable-rule";
        }
      }

      if (reason !== null) {
        if (model !== void 0 && typeof model === "string" && !state.unpriced.has(model)) {
          const next = new Map(state.unpriced);
          next.set(model, reason);
          return { ...state, unpriced: next };
        }
        return state;
      }

      const period = rule.prices.flat !== void 0 ? "flat" : periodOf(epoch, pricing.periods);
      const cost = costNano(usage.tokens, rule.prices, period);
      const callInfo = {
        hitNano: cost.hit, missNano: cost.miss, outNano: cost.out, totalNano: cost.total,
        model, period, ruleVersion: pricing.rulesVersion, time: epoch
      };
      const prev = state.lastByTurnStep.get(turnStep);

      // 同 (turn,step) 重复/重写：先扣旧值再记新值，绝不重复累计
      const perModel = new Map(state.perModel);
      let { totalNano, hitNano, missNano, outNano, calls } = state;
      if (prev !== void 0) {
        totalNano -= prev.totalNano;
        hitNano -= prev.hitNano;
        missNano -= prev.missNano;
        outNano -= prev.outNano;
        calls -= 1;
        const old = perModel.get(prev.model) ?? { totalNano: 0, hitNano: 0, missNano: 0, outNano: 0, calls: 0 };
        perModel.set(prev.model, {
          totalNano: old.totalNano - prev.totalNano,
          hitNano: old.hitNano - prev.hitNano,
          missNano: old.missNano - prev.missNano,
          outNano: old.outNano - prev.outNano,
          calls: old.calls - 1
        });
      }
      totalNano += cost.total;
      hitNano += cost.hit;
      missNano += cost.miss;
      outNano += cost.out;
      calls += 1;
      const cur = perModel.get(model) ?? { totalNano: 0, hitNano: 0, missNano: 0, outNano: 0, calls: 0 };
      perModel.set(model, {
        totalNano: cur.totalNano + cost.total,
        hitNano: cur.hitNano + cost.hit,
        missNano: cur.missNano + cost.miss,
        outNano: cur.outNano + cost.out,
        calls: cur.calls + 1
      });

      const lastByTurnStep = new Map(state.lastByTurnStep);
      lastByTurnStep.set(turnStep, callInfo);
      return {
        totalNano, hitNano, missNano, outNano, calls,
        lastByTurnStep, perModel,
        lastCall: callInfo,
        unpriced: state.unpriced
      };
    },
    view(state) {
      const display = (nano) => `${yuanSymbol()}${nanoToYuanText(nano, 2)}`;
      const stale = Date.now() - Date.parse(pricing.sourceCheckedAt) > maxAgeDays * 86400000;
      const unpricedReasons = [...state.unpriced.entries()].map(([model, reason]) => ({ model, reason }));
      const base = {
        calls: state.calls,
        estimated: display(state.totalNano),
        estimatedNano: state.totalNano,
        hit: display(state.hitNano),
        miss: display(state.missNano),
        output: display(state.outNano),
        hitNano: state.hitNano,
        missNano: state.missNano,
        outputNano: state.outNano,
        model: state.lastCall === null ? null : modelDisplay(state.lastCall.model),
        pricingPeriod: state.lastCall === null ? null :
          state.lastCall.period === "peak" ? "高峰" :
          state.lastCall.period === "offPeak" ? "闲时" : "非峰谷价",
        pricingRuleVersion: pricing.rulesVersion,
        lastUpdatedAt: state.lastCall?.time ?? null,
        unpricedReasons,
        ruleStale: stale,
        perModel: [...state.perModel.entries()].map(([model, entry]) => ({
          model,
          displayName: modelDisplay(model),
          estimated: display(entry.totalNano),
          calls: entry.calls
        }))
      };
      if (state.calls === 0 && unpricedReasons.length === 0) return { ...base, status: "empty", estimated: `${yuanSymbol()}0.00`, estimatedNano: 0 };
      if (state.calls === 0) return { ...base, status: "unpriced", estimated: "费用 —", estimatedNano: 0 };
      return { ...base, status: "priced" };
    },
    stateVersion: 1
  };
}

// ── 插件入口 ──────────────────────────────────────────────────────────────
export const name = "dsh-cost-glance";

/**
 * 插件主体：注册 costGlance 投影 + 每步费用日志。
 * @param ctx - cordis 插件上下文。
 * @param config - 可选配置 { maxAgeDays? }。
 */
export function apply(ctx, config = {}) {
  const pricing = loadPricingRules();
  const maxAgeDays = config?.maxAgeDays ?? 45;
  ctx.inject(["sessionProjections"], (projectionCtx) => {
    projectionCtx.sessionProjections.register(makeCostProjection(pricing, maxAgeDays));
  });
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "assistant/message") return;
    const usage = usageFromEvent(event);
    if (!usage.ok) return;
    const source = event.data?.message?.source ?? {};
    const model = source.model;
    if (source.provider !== "deepseek-official" || model === void 0 || !pricing.models[model]) return;
    const epoch = typeof event.time === "number" ? event.time : Date.now();
    const rule = selectRule(pricing.rules, model, epoch);
    if (rule === void 0) return;
    const period = rule.prices.flat !== void 0 ? "flat" : periodOf(epoch, pricing.periods);
    const cost = costNano(usage.tokens, rule.prices, period);
    const periodLabel = period === "peak" ? "高峰" : period === "offPeak" ? "闲时" : "非峰谷价";
    ctx.logger.info(`dsh-cost-glance: step ${event.data.step} 约 ${(cost.total / 1e9).toFixed(4)} 元（${model} · ${periodLabel} · 规则 ${pricing.rulesVersion}）`);
  });
}
