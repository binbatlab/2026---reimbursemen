// 开跑前先整理浏览器标签：把重复的报账平台 / 财务平台 / 一网通办 页关掉，
// 只保留「一个报账平台 + 一个审批单（如果有）」。幂等，可反复执行。
//
// 用途：run.mjs 第一步调用，避免历史遗留的重复标签让后续操作attach到错的页面。
import { ensureBrowser, Browser } from "./cdp.mjs";

const ver = await ensureBrowser({ profileDir: process.env.YWTB_PROFILE });
const browser = await new Browser(ver.webSocketDebuggerUrl).connect();

const pages = await browser.listPages().catch(() => []);
if (!pages.length) {
  console.log("· 没有打开的标签，跳过整理");
  process.exit(0);
}

const isWsyy = (u) => /wsyy\/(frame_container|frame_main)/i.test(u);
const isApproval = (u) => /shenpi\/SP_/i.test(u);
const isFinance = (u) => /tysfrz\//i.test(u);
const isPortal = (u) => /ywtb\.xidian\.edu\.cn/i.test(u);

let keepWsyy = pages.find((p) => isWsyy(p.url || "")) || null;
let keepApproval = pages.find((p) => isApproval(p.url || "")) || null;
let keepPortal = pages.find((p) => isPortal(p.url || "")) || null;

const keepIds = new Set([keepWsyy, keepApproval, keepPortal].filter(Boolean).map((p) => p.id));
let closed = 0;
const closedList = [];

for (const p of pages) {
  if (keepIds.has(p.id)) continue;
  const u = p.url || "";
  // 关掉：重复报账平台、所有财务平台中间页、重复门户、空白页
  const shouldClose = isWsyy(u) || isFinance(u) || isPortal(u) || u === "about:blank" || u === "";
  if (!shouldClose) continue;
  const ok = await browser.closeTarget(p.id).catch(() => false);
  if (ok) { closed++; closedList.push(u.slice(0, 46)); }
}

console.log(`· 标签整理：原有 ${pages.length} 个，关闭 ${closed} 个，保留 ${pages.length - closed} 个`);
for (const c of closedList) console.log(`   关闭 ${c}`);
if (keepWsyy) console.log(`   保留报账平台 ${(keepWsyy.url || "").slice(-40)}`);
if (keepApproval) console.log(`   保留审批单 ${(keepApproval.url || "").slice(-40)}`);

process.exit(0);
