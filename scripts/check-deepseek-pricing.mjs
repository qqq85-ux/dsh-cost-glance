#!/usr/bin/env node
// dsh-cost-glance 每日官方价格监控（本地可跑；GitHub Actions 定时触发）。
//
// 职责：
//   1. 抓取 DeepSeek 官方价格页与更新日志，记录时间/HTTP 状态/页面摘要/内容哈希；
//   2. 从页面提取结构化价格（模型、单价、峰谷时段、生效说明）—— 只对"提取后的
//      结构化载荷"做比较，页面排版/文案变化不会误判为调价；
//   3. 与仓库最后一份快照（.pricing/latest.json）比较，无变化则正常结束；
//   4. 有变化 → 生成结构化 Diff，写入 .pricing/diffs/，并用 gh 创建/更新 Issue
//      （在 GitHub Actions 中自动；本地有 gh 且登录时也可用）；
//   5. 运行全部计价测试，生成候选规则提示（禁止自动合并/发布/覆盖本地规则）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const PRICING_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
const UPDATES_URL = "https://api-docs.deepseek.com/zh-cn/updates";
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pricingDir = join(repoRoot, ".pricing");
const latestPath = join(pricingDir, "latest.json");
const snapshotsDir = join(pricingDir, "snapshots");
const diffsDir = join(pricingDir, "diffs");

const today = new Date().toISOString().slice(0, 10);

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "dsh-cost-glance-pricing-monitor" } });
  const text = await res.text();
  return { status: res.status, text };
}
function sha1(text) {
  return createHash("sha1").update(text).digest("hex");
}
/** 从价格页文本提取结构化价格载荷（尽力而为；提取失败返回 null）。 */
export function extractPricing(text) {
  const flat = (s) => s.replace(/\s+/g, " ").trim();
  // 去除 script/style 与标签，只留可见文本（页面排版变化不应影响提取）
  const visible = text
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
  const body = flat(visible);
  // 官方价格表两列模型并排：空闲时段 两价 高峰时段 两价（左列=flash，右列=pro）
  const modelOrder = ["deepseek-v4-flash", "deepseek-v4-pro"];
  const row = (label) => {
    const re = new RegExp(`${label}\\s*空闲时段\\s*([0-9.]+)\\s*元\\s*([0-9.]+)\\s*元\\s*高峰时段\\s*([0-9.]+)\\s*元\\s*([0-9.]+)\\s*元`);
    const m = body.match(re);
    if (!m) return null;
    return {
      flash: { offPeak: Number(m[1]), peak: Number(m[3]) },
      pro: { offPeak: Number(m[2]), peak: Number(m[4]) }
    };
  };
  const hit = row("百万tokens输入（缓存命中）");
  const miss = row("百万tokens输入（缓存未命中）");
  const out = row("百万tokens输出");
  if (hit === null || miss === null || out === null) return null;
  const models = [
    { name: modelOrder[0], cacheHit: hit.flash, cacheMiss: miss.flash, output: out.flash },
    { name: modelOrder[1], cacheHit: hit.pro, cacheMiss: miss.pro, output: out.pro }
  ];
  const peakHours = body.match(/高峰时段为北京时间\s*([0-9:]+)\s*-\s*([0-9:]+)、\s*([0-9:]+)\s*-\s*([0-9:]+)/);
  return {
    extractedAt: new Date().toISOString(),
    models,
    peakHours: peakHours ? peakHours.slice(1) : null,
    offPeakIsHalf: body.includes("空闲时段价格为高峰时段价格的一半")
  };
}
function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
/** 结构化载荷的稳定部分（不含每次不同的 extractedAt 时间戳）。 */
function stableOf(extracted) {
  return { models: extracted.models, peakHours: extracted.peakHours, offPeakIsHalf: extracted.offPeakIsHalf };
}
async function runTests() {
  const res = spawnSync("node", ["--test"], { cwd: repoRoot, encoding: "utf8" });
  return { ok: res.status === 0, summary: (res.stdout + res.stderr).match(/ℹ pass \d+[\s\S]{0,60}ℹ fail \d+/)?.[0] ?? "（无法解析测试摘要）" };
}
async function upsertIssue(title, body) {
  const gh = spawnSync("gh", ["issue", "list", "--state", "open", "--search", title, "--json", "number", "--limit", "1"], { encoding: "utf8" });
  if (gh.status !== 0) return { action: "skipped", why: "gh 不可用" };
  let number = null;
  try { number = JSON.parse(gh.stdout)[0]?.number ?? null; } catch {}
  const cmd = number === null
    ? spawnSync("gh", ["issue", "create", "--title", title, "--body", body], { encoding: "utf8" })
    : spawnSync("gh", ["issue", "edit", String(number), "--title", title, "--body", body], { encoding: "utf8" });
  return { action: number === null ? "created" : `updated #${number}`, ok: cmd.status === 0 };
}

async function main() {
  mkdirSync(snapshotsDir, { recursive: true });
  mkdirSync(diffsDir, { recursive: true });
  console.log(`== 检查 DeepSeek 官方价格（${today}）==`);
  const [price, updates] = await Promise.all([fetchText(PRICING_URL), fetchText(UPDATES_URL).catch(() => ({ status: 0, text: "" }))]);
  const extracted = extractPricing(price.text);
  const record = {
    fetchedAt: new Date().toISOString(),
    pricingPage: { status: price.status, sha1: sha1(price.text) },
    updatesPage: { status: updates.status, sha1: sha1(updates.text) },
    extracted
  };
  writeFileSync(join(snapshotsDir, `${today}.json`), JSON.stringify(record, null, 2));
  console.log(`价格页 HTTP ${price.status}（sha1 ${record.pricingPage.sha1.slice(0, 12)}）· 更新页 HTTP ${updates.status}`);
  if (extracted === null || extracted.models.length === 0) {
    console.log("⚠ 未能从页面提取结构化价格（页面可能改版）。不会修改任何规则。");
    writeFileSync(latestPath, JSON.stringify(record, null, 2));
    return;
  }
  console.log(`提取: ${extracted.models.map((m) => `${m.name}(命中${JSON.stringify(m.cacheHit)} 未命中${JSON.stringify(m.cacheMiss)} 输出${JSON.stringify(m.output)})`).join("，")}`);
  const previous = existsSync(latestPath) ? JSON.parse(readFileSync(latestPath, "utf8")) : null;
  if (previous !== null && jsonEqual(stableOf(previous.extracted), stableOf(extracted))) {
    console.log("与上次快照一致：无价格变化（仅存档今日快照）。");
  } else if (previous === null) {
    console.log("首次快照：建立基线（无历史可对比）。");
  } else {
    console.log("⚠ 检测到官方价格变化！");
    const diff = { detectedAt: new Date().toISOString(), previous: previous.extracted, detected: extracted };
    writeFileSync(join(diffsDir, `${today}.json`), JSON.stringify(diff, null, 2));
    const tests = await runTests();
    console.log(`已运行计价测试: ${tests.ok ? "通过" : "失败"} · ${tests.summary}`);
    const title = `DeepSeek 官方价格可能已变化：${today}`;
    const body = [
      "检测到 DeepSeek 官方价格页的结构化载荷与仓库最后快照不一致。",
      "",
      "旧规则:",
      "```json\n" + JSON.stringify(previous.extracted, null, 2) + "\n```",
      "",
      "新检测结果:",
      "```json\n" + JSON.stringify(extracted, null, 2) + "\n```",
      "",
      `官方价格页: ${PRICING_URL}`,
      `更新日志: ${UPDATES_URL}`,
      "",
      "待确认项：",
      "- [ ] 是否为真实调价（区分：排版变化/文案变化/模型新增/单价变化/峰谷时段变化/生效日期变化）",
      "- [ ] 确认新价格与峰谷时段",
      "- [ ] 更新 pricing/deepseek-official.json 并人工审核",
      "- [ ] 运行全部测试并复核",
      "",
      "注意：禁止自动合并、自动发布、未经审核直接让用户端生效。",
      `测试: ${tests.ok ? "通过" : "失败"} · ${tests.summary}`
    ].join("\n");
    const issue = await upsertIssue(title, body);
    console.log(`Issue: ${issue.action}`);
  }
  writeFileSync(latestPath, JSON.stringify(record, null, 2));
  console.log("完成。仓库规则未被修改（需要人工审核后更新 pricing/）。");
}
const isDirectRun = process.argv[1] !== void 0 && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
  main().catch((e) => {
    console.error("监控失败:", e.message);
    process.exit(1);
  });
}
