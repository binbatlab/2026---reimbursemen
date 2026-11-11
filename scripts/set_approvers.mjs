// 把确认页填的「审批人 / 担保人」写进审批单的审批流程，全程不用再问用户。
//   launch.ps1 -Script scripts\set_approvers.mjs             # 写入
//   launch.ps1 -Script scripts\set_approvers.mjs -ScriptArgs "--dry-run"
//   launch.ps1 -Script scripts\set_approvers.mjs -ScriptArgs "--learn-role"   # 学习担保人角色编号
//
// 原理：审批流程是 Gv_EditLc 可编辑表格，每行 角色名/角色编号/工号/姓名。
//   - 已有「担保人」行 → 直接填工号、姓名
//   - 只有空白行，且知道担保人的角色编号（首次 --learn-role 学到）→ 填角色+工号
//   - 两者都没有 → 提示人工加一次（系统不允许凭空造角色），不写入、不保存
// 永远不点「确认提交审批」。
import { ensureBrowser, Browser, sleep } from "./cdp.mjs";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, saveConfig } from "./config.mjs";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const LEARN = argv.includes("--learn-role");
const ROOT = process.env.YWTB_WORKDIR || resolve(import.meta.dirname, "..");
const CONFIRM = resolve(ROOT, "invoices", "confirm.json");

const ver = await ensureBrowser({ profileDir: process.env.YWTB_PROFILE });
const browser = await new Browser(ver.webSocketDebuggerUrl).connect();
const page = await browser.attachExisting((t) => /shenpi\/SP_Rcbx_Sp/i.test(t.url || ""));
if (!page) { console.error("没找到审批单页面（SP_Rcbx_Sp.aspx）"); process.exit(2); }
await page.send("Page.enable");
browser.on((m) => { if (m.method === "Page.javascriptDialogOpening") page.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {}); });

const openEdit = async () => {
  await page.eval(`(() => { const b=document.getElementById("ctl00_ContentPlaceHolder1_Btn_EdktLc"); if(b) b.click(); return 1; })()`);
  await sleep(3500);
};
const readGrid = () => page.eval(`(() => {
  const g = document.querySelector("[id*=Gv_EditLc]");
  if (!g) return [];
  return [...g.querySelectorAll("tr.row")].map((tr, i) => ({
    i,
    role: (tr.querySelector("input[id*=Txt_roleNM]") || {}).value || "",
    roleid: (tr.querySelector("input[id*=Txt_roleid]") || {}).value || "",
    ygbh: (tr.querySelector("input[id*=Txt_ygbh]") || {}).value || "",
    ygmc: (tr.querySelector("input[id*=Txt_ygmc]") || {}).value || "",
  }));
})()`);

// --learn-role：从已有的「担保人」行里学角色编号，存进配置
if (LEARN) {
  await openEdit();
  const rows = await readGrid();
  const g = rows.find((r) => r.role.includes("担保人") && r.roleid);
  if (!g) {
    console.log("没找到已存在的「担保人」行。请先在页面上点「编辑流程 → 该行角色选担保人」保存一次。");
    process.exit(3);
  }
  saveConfig({ guarantorRoleId: g.roleid, guarantorRoleNM: g.role });
  console.log(`已记住担保人角色：${g.role} (编号 ${g.roleid})，以后可全自动写入。`);
  process.exit(0);
}

// 确认页里填的审批人
if (!existsSync(CONFIRM)) { console.error("缺少 invoices/confirm.json：请先跑确认页"); process.exit(2); }
const cf = JSON.parse(readFileSync(CONFIRM, "utf8").replace(/^\uFEFF/, ""));
const approvers = (cf.approvers || []).filter((a) => a && a.no);
if (!approvers.length) { console.log("确认页里没有填审批人，跳过"); process.exit(0); }

const cfg = readConfig();
await openEdit();
let rows = await readGrid();
const guarantorRow = rows.find((r) => r.role.includes("担保人"));
const blankRow = rows.find((r) => !r.role && !r.ygbh);
const roleId = cfg.guarantorRoleId || "";

console.log("== 当前流程行 ==");
for (const r of rows) console.log(`  ${r.role || "(空白)"}  ${r.ygbh} ${r.ygmc}`);
console.log(`\n待写审批人: ${approvers.map((a) => a.no).join(", ")}`);
console.log(`担保人角色编号: ${roleId || "（未知）"}`);

if (!guarantorRow && !(blankRow && roleId)) {
  console.log("\n⚠️ 系统里还没有「担保人」这一行，也没有可用的角色编号。");
  console.log("   请人工点一次「编辑流程」，把某行的角色选成「担保人」并保存；");
  console.log("   然后运行：set_approvers.mjs --learn-role   读完编号，之后全自动。");
  process.exit(3);
}
if (DRY) { console.log("\n(--dry-run 未写入)"); process.exit(0); }

let filled = 0;
for (const a of approvers) {
  const r = await page.eval(`(() => {
    const no = ${JSON.stringify(a.no)}, nm = ${JSON.stringify(a.name || "")}, rid = ${JSON.stringify(roleId)};
    const g = document.querySelector("[id*=Gv_EditLc]");
    if (!g) return { ok: false, why: "no grid" };
    const rows = [...g.querySelectorAll("tr.row")];
    // 1) 已有担保人行且工号为空 → 填它
    let target = rows.find((tr) => {
      const role = (tr.querySelector("input[id*=Txt_roleNM]") || {}).value || "";
      const bh = (tr.querySelector("input[id*=Txt_ygbh]") || {}).value || "";
      return role.includes("担保人") && !bh;
    });
    // 2) 否则用空白行 + 已知角色编号
    if (!target && rid) {
      target = rows.find((tr) => {
        const role = (tr.querySelector("input[id*=Txt_roleNM]") || {}).value || "";
        const bh = (tr.querySelector("input[id*=Txt_ygbh]") || {}).value || "";
        return !role && !bh;
      });
      if (target) {
        const rn = target.querySelector("input[id*=Txt_roleNM]");
        const ri = target.querySelector("input[id*=Txt_roleid]");
        if (rn) { rn.value = "担保人"; rn.dispatchEvent(new Event("change", { bubbles: true })); }
        if (ri) { ri.value = rid; ri.dispatchEvent(new Event("change", { bubbles: true })); }
      }
    }
    if (!target) return { ok: false, why: "no target row" };
    const bh = target.querySelector("input[id*=Txt_ygbh]");
    const mc = target.querySelector("input[id*=Txt_ygmc]");
    bh.value = no; bh.dispatchEvent(new Event("input", { bubbles: true })); bh.dispatchEvent(new Event("change", { bubbles: true }));
    if (mc && !(mc.value || "").trim() && nm) { mc.value = nm; mc.dispatchEvent(new Event("change", { bubbles: true })); }
    return { ok: true, role: (target.querySelector("input[id*=Txt_roleNM]") || {}).value || "" };
  })()`);
  if (r && r.ok) { filled++; console.log(`  已填 ${a.no} → ${r.role}`); }
  else console.log(`  × 写入失败：${a.no}（${r && r.why}）`);
  await sleep(600);
}

if (filled) {
  await page.eval(`(() => { const b=document.getElementById("ctl00_ContentPlaceHolder1_Btn_SaveLc"); if(b) b.click(); return 1; })()`);
  console.log("已点「保存流程」");
  await sleep(6000);
}

rows = await readGrid();
console.log("\n== 保存后流程行 ==");
for (const r of rows) console.log(`  ${r.role || "(空白)"}  ${r.ygbh} ${r.ygmc}`);
const miss = approvers.filter((a) => !rows.some((r) => r.ygbh === a.no));
console.log(miss.length ? `\n❌ ${miss.length} 个审批人没写进去，请人工检查` : "\n✅ 审批人已写入流程（提交前仍由本人核对）");
process.exit(miss.length ? 4 : 0);
