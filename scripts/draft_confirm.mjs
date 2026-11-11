// 从解析结果自动起草「报销事由」和「备注」，写到 invoices/draft.json。
// 确认页会把这些草稿带进输入框，用户看一眼、改一下、点确认即可。
//
// 用法：launch.ps1 -Script scripts\draft_confirm.mjs
// 依赖：invoices/dataset.json（invoice_parse.py 产出）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.env.YWTB_WORKDIR || resolve(import.meta.dirname, "..");
const DS = resolve(ROOT, "invoices", "dataset.json");
const OUT = resolve(ROOT, "invoices", "draft.json");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));

if (!existsSync(DS)) { console.error("缺少 invoices/dataset.json：请先跑解析（extract_invoices.py + invoice_parse.py）"); process.exit(2); }
const ds = readJson(DS);
const invs = ds.invoices || [];

// 销售方简称：去掉括号里的"特殊普通合伙"这类后缀
const shortSeller = (s) => (s || "").replace(/（[^）]*）|\([^)]*\)/g, "").trim();

// 品目：优先 items 字段，退到 kind
const itemsOf = (i) => (i.items && i.items.length ? i.items : [i.kind]).filter(Boolean);
const cleanItem = (s) => {
  let t = (s || "").replace(/\*[^*]*\*/g, "").replace(/\s+/g, "").trim();
  if (!t) return "";
  if (!/[费款项金]$/.test(t)) t += "费";     // "专利申请" → "专利申请费"
  return t;
};

const groups = new Map();
for (const inv of invs) {
  const key = shortSeller(inv.seller) || "未知销售方";
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(inv);
}

const fmt = (n) => (n == null ? "?" : String(n));
const money = (list) => list.reduce((s, i) => s + Number(i.total || 0), 0).toFixed(2);

let reason, remark;
if (groups.size === 1) {
  const [seller, list] = [...groups.entries()][0];
  const its = [...new Set(list.flatMap(itemsOf).map(cleanItem))].filter(Boolean);
  reason = `${its.slice(0, 2).join("、") || "业务费用"}（${seller}）`;
  const nos = list.map((i) => i.number).filter(Boolean);
  remark = `${seller}${its.join("、")}，发票${nos.length}张（${nos[0]}${nos.length > 1 ? " 等" : ""}），价税合计 ${money(list)} 元`;
} else {
  // 多销售方：汇总成"多笔业务费用"
  const total = money(invs);
  reason = `业务费用报销（${groups.size}家单位）`;
  remark = `${[...groups.keys()].join("、")}，共 ${invs.length} 张发票，价税合计 ${total} 元`;
}
// 备注控制在 50 字内（系统限制）
if (remark.length > 50) remark = remark.slice(0, 49) + "…";

writeFileSync(OUT, JSON.stringify({ reason, remark, _generatedAt: new Date().toISOString() }, null, 1), "utf8");
console.log("已生成草稿 invoices/draft.json：");
console.log("  事由:", reason);
console.log("  备注:", remark);
