// 把「我的项目」抓下来，写成 invoices/projects.json，供确认页做下拉选择。
//   launch.ps1 -Script scripts\list_projects.mjs
import { ensureBrowser, Browser, sleep } from "./cdp.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.env.YWTB_WORKDIR || resolve(import.meta.dirname, "..");
const ver = await ensureBrowser({ profileDir: process.env.YWTB_PROFILE });
const browser = await new Browser(ver.webSocketDebuggerUrl).connect();
const page = (await browser.attachExisting((t) => /frame_container/i.test(t.url || ""))) ||
             (await browser.attachExisting((t) => /xidian/.test(t.url || ""))) ||
             (await browser.newPage("about:blank"));
await page.send("Page.enable");

if (!/frame_container/i.test(await page.eval(`location.href`))) {
  await page.goto("https://cwcwssfv.xidian.edu.cn/tysfrz/jump.aspx?sysid=wsyy", { settleMs: 7000 });
}
await page.eval(`(() => {
  const w = window.frames["mainframe"];
  if (!w) return "no mainframe";
  if (typeof w.optimizeJump === "function") { w.optimizeJump("Modules/Wdxm/Wdxm.aspx"); return "optimizeJump"; }
  w.location.href = "Modules/Wdxm/Wdxm.aspx";
  return "direct";
})()`);
await sleep(8000);

const rows = await page.eval(`(() => {
  const f = window.frames["mainframe"];
  const d = f ? f.document : document;
  const out = [];
  d.querySelectorAll("table tr").forEach((tr) => {
    const tds = [...tr.querySelectorAll("td")].map((td) => (td.innerText || "").replace(/\\s+/g, " ").trim());
    if (tds.length < 4) return;
    const codeIdx = tds.findIndex((x) => /^\\d{8,12}$/.test(x));
    if (codeIdx < 0) return;
    const code = tds[codeIdx];
    const dept = tds[codeIdx - 1] || "";
    const name = (tds[codeIdx + 1] || "").split("<==>")[0].trim();
    const money = (tds.slice(codeIdx).find((x) => /¥|\\d,\\d{3}/.test(x)) || "").replace(/[^\\d.]/g, "");
    out.push({ dept, code, name, balance: money });
  });
  // 去重
  const seen = new Set();
  return out.filter((r) => (seen.has(r.code) ? false : (seen.add(r.code), true)));
})()`);

// 只保留「现在能选」的：有余额 + 没过授权截止日期
const today = new Date();
const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
const usable = rows.filter((r) => Number(r.balance || 0) > 0 && (!r.expiry || r.expiry >= ymd));
const dropped = rows.filter((r) => !usable.includes(r));

mkdirSync(resolve(ROOT, "invoices"), { recursive: true });
writeFileSync(resolve(ROOT, "invoices", "projects_all.json"), JSON.stringify(rows, null, 1), "utf8");
writeFileSync(resolve(ROOT, "invoices", "projects.json"), JSON.stringify(usable, null, 1), "utf8");
console.log(`共 ${rows.length} 个项目：可用 ${usable.length} 个，过滤掉 ${dropped.length} 个（余额为 0 或已过授权截止日期）`);
for (const r of usable) console.log(`  ✅ ${r.code}  ${r.name.slice(0, 26)}  ¥${r.balance}${r.expiry ? "  截止 " + r.expiry : ""}`);
for (const r of dropped) console.log(`  ✗ ${r.code}  ${r.name.slice(0, 26)}  ¥${r.balance}${r.expiry ? "  截止 " + r.expiry : ""}`);
process.exit(0);
