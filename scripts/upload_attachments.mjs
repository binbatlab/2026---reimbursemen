// 审批单附件上传：只传「非发票」附件，一次一批、传前算差集、传后核对，杜绝多传/少传/误传。
//
// 用法：
//   launch.ps1 -Script scripts\upload_attachments.mjs -ScriptArgs "--dir","<发票所在文件夹>"
//   launch.ps1 -Script scripts\upload_attachments.mjs -ScriptArgs "--files","a.pdf,b.pdf"
//   可选：--dry-run 只算不传；--fix-dupes 尝试删重复（删失败即停）
//
// 防错设计：
//   1) 只读「已提交到单据」的附件表（Gv_File），不把上传队列当成已上传
//   2) 传前先清空 layui 暂存队列，避免历史残留被一起提交（这是重复的根源）
//   3) 按本地文件与现有附件的差集上传，已存在的一律跳过 → 幂等，可反复执行
//   4) 只塞一批文件、只点一次「开始上传」，之后重新读表核对，条数不符即报错退出
//   5) 永不点「确认提交审批」
import { ensureBrowser, Browser, sleep } from "./cdp.mjs";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(`--${k}`);
const DIR = arg("dir");
const FILES = arg("files");
const DRY = has("dry-run");
const FIX_DUPES = has("fix-dupes");

const INVOICE_RE = /发票|机票|火车票|行程单|网约车|滴滴|出租|客运/;
// 名字里带这些词的一律按附件处理，避免"发票查验单/发票通知书"被误判成发票而漏传
const ATTACH_HINT_RE = /通知书|受理|授权|清单|合同|协议|明细|凭证|函/;
const isInvoice = (name) => INVOICE_RE.test(name) && !ATTACH_HINT_RE.test(name);

function collect() {
  if (FILES) return FILES.split(",").map((s) => s.trim()).filter(Boolean);
  if (!DIR) throw new Error("需要 --dir 或 --files");
  return readdirSync(DIR).filter((f) => /\.(pdf|ofd)$/i.test(f)).map((f) => join(DIR, f));
}

function token(name) {
  const s = name.replace(/\.(pdf|ofd)$/i, "").replace(/\d+/g, "").replace(/[\s\-_（）()]/g, "");
  const cn = s.match(/[\u4e00-\u9fa5]+/);
  if (cn && cn[0].length >= 2) return cn[0].slice(0, 4);
  return s.slice(0, 12);
}

const ver = await ensureBrowser({ profileDir: process.env.YWTB_PROFILE });
const browser = await new Browser(ver.webSocketDebuggerUrl).connect();
const page = await browser.attachExisting((t) => /shenpi\/SP_Rcbx_Sp/i.test(t.url || ""));
if (!page) { console.error("没找到审批单页面（SP_Rcbx_Sp.aspx）"); process.exit(2); }
await page.send("Page.enable");
await page.send("DOM.enable");
browser.on((m) => { if (m.method === "Page.javascriptDialogOpening") page.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {}); });

// 已提交到单据的附件（Gv_File 表；没有附件时该表不存在）
const readCommitted = () => page.eval(`(() => {
  const t = document.querySelector("[id*='Gv_File']");
  if (!t) return [];
  return [...t.querySelectorAll("tr")].map((tr) => {
    const s = (tr.innerText || "").replace(/\\s+/g, " ").trim();
    if (!/\\.(pdf|ofd)/i.test(s)) return null;
    const m = s.match(/(.+?\\.(?:pdf|ofd))/i);
    const del = tr.querySelector("a[id*='LINK_DEL']");
    return { raw: s.slice(0, 100), name: m ? m[1] : s.slice(0, 50), del: del ? del.id : "" };
  }).filter(Boolean);
})()`);

// layui 暂存队列：文件名 + 「删除」按钮（不是已提交附件）
const queueCount = () => page.eval(`(() => {
  const q = document.querySelector(".layui-upload-list");
  if (!q) return 0;
  return [...q.querySelectorAll("*")].filter((e) => (e.innerText || "").trim() === "删除" && e.children.length === 0).length;
})()`);

async function clearQueue() {
  for (let i = 0; i < 15; i++) {
    if ((await queueCount()) === 0) break;
    await page.eval(`(() => {
      const q = document.querySelector(".layui-upload-list");
      const b = q && [...q.querySelectorAll("*")].find((e) => (e.innerText || "").trim() === "删除" && e.children.length === 0);
      if (b) b.click();
      return 1;
    })()`);
    await sleep(1000);
  }
}

const all = collect();
const files = all.map((p) => {
  let size = 0;
  try { size = statSync(p).size; } catch { console.error(`文件读不到：${p}`); process.exit(3); }
  return { path: p, name: basename(p), size };
});
const attach = files.filter((f) => !isInvoice(f.name));
const invoices = files.filter((f) => isInvoice(f.name));

// 与解析结果对照：dataset.json 里记的附件清单应当和这次选的完全一致
try {
  const dsPath = join(process.env.YWTB_WORKDIR || process.cwd(), "invoices", "dataset.json");
  const ds = JSON.parse(readFileSync(dsPath, "utf8").replace(/^\uFEFF/, ""));
  const want = (ds.attachments || []).map((n) => basename(n));
  const got = attach.map((a) => a.name);
  const missA = want.filter((w) => !got.some((g) => g.includes(token(w)) || w.includes(basename(g))));
  const extra = got.filter((g) => !want.some((w) => w.includes(token(g)) || g.includes(basename(w))));
  if (missA.length) console.log(`!! 解析结果里有 ${missA.length} 个附件这次没选到：${missA.join(", ")}`);
  if (extra.length) console.log(`!! 这次选的文件里有 ${extra.length} 个不在解析结果中：${extra.join(", ")}`);
  if (!missA.length && !extra.length && want.length) console.log(`附件清单与解析结果一致（${want.length} 个）`);
} catch { /* 没有 dataset.json 就跳过对照 */ }

const committed0 = await readCommitted();
const countOf = (rows) => {
  const map = {};
  for (const r of rows) {
    const k = attach.map((a) => token(a.name)).find((t) => r.name.includes(t));
    if (k) map[k] = (map[k] || 0) + 1;
  }
  return map;
};
const have0 = countOf(committed0);
const plan = attach.filter((a) => !have0[token(a.name)]);
const dupes = Object.entries(have0).filter(([, n]) => n > 1);

console.log(`== 本地 ${files.length} 个文件：发票 ${invoices.length}、附件 ${attach.length} ==`);
for (const a of attach) console.log(`   附件 ${a.name}  (${(a.size / 1024).toFixed(1)} KB)`);
console.log(`\n== 单据现有附件 ${committed0.length} 条 ==` + (committed0.length ? "" : "（空）"));
const q0 = await queueCount();
if (q0) console.log(`!! 上传面板里还有 ${q0} 条历史暂存（未提交），执行上传前会被清掉`);
for (const r of committed0) console.log(`   · ${r.name}`);

if (dupes.length) {
  console.log("\n!! 单据里已有重复：");
  for (const [k, n] of dupes) console.log(`   ${k} × ${n}`);
  if (!FIX_DUPES) console.log("   （未处理；如要尝试清理加 --fix-dupes）");
  else {
    for (let i = 0; i < 10; i++) {
      const rows = await readCommitted();
      const map = {};
      for (const r of rows) {
        const k = attach.map((a) => token(a.name)).find((t) => r.name.includes(t));
        if (k) (map[k] = map[k] || []).push(r);
      }
      const e = Object.entries(map).find(([, arr]) => arr.length > 1);
      if (!e) break;
      const victim = e[1][e[1].length - 1];
      if (!victim.del) { console.log(`   ${e[0]}：行内没有删除控件，无法清理`); break; }
      await page.eval(`(() => { const a=document.getElementById(${JSON.stringify(victim.del)}); if(a) a.click(); return 1; })()`);
      await sleep(6000);
      const after = await readCommitted();
      if (after.length === rows.length) { console.log("   删除没有生效（系统报删除失败），停止清理"); break; }
    }
    console.log(`   清理后附件 ${(await readCommitted()).length} 条`);
  }
}

if (!plan.length) {
  console.log("\n✅ 应传附件都已在单据里，无需上传（幂等，不会重复）");
  process.exit(dupes.length ? 3 : 0);
}

console.log(`\n== 待上传 ${plan.length} 个 ==`);
for (const p of plan) console.log(`   → ${p.name}`);
if (DRY) { console.log("\n(--dry-run 未上传)"); process.exit(0); }

// 打开上传面板
await page.eval(`(() => { if (typeof popBox_PC === "function") popBox_PC(); return 1; })()`);
await sleep(2500);
const stale = await queueCount();
if (stale) { console.log(`清空暂存队列里的 ${stale} 条历史残留…`); await clearQueue(); }

const drag = await page.eval(`(() => {
  const d = document.querySelector(".layui-upload-drag");
  if (!d) return null;
  const b = d.getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
})()`);
if (!drag) { console.error("上传面板没打开"); process.exit(4); }

// 一次性选择全部待传文件
let injected = false;
await page.send("Page.setInterceptFileChooserDialog", { enabled: true });
const chooser = browser.once((m) => m.method === "Page.fileChooserOpened", 12000);
await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: drag.x, y: drag.y, button: "left", clickCount: 1 });
await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: drag.x, y: drag.y, button: "left", clickCount: 1 });
try {
  const ev = await chooser;
  await page.send("DOM.setFileInputFiles", { files: plan.map((p) => p.path), backendNodeId: ev.params.backendNodeId });
  injected = true;
} catch {
  const r = await page.send("Runtime.evaluate", { expression: `document.querySelector("input.layui-upload-file")` });
  if (r.result && r.result.objectId) {
    await page.send("DOM.setFileInputFiles", { files: plan.map((p) => p.path), objectId: r.result.objectId });
    await page.send("Runtime.callFunctionOn", {
      objectId: r.result.objectId,
      functionDeclaration: `function(){ this.dispatchEvent(new Event("change",{bubbles:true})); return this.files.length; }`,
      returnByValue: true,
    });
    injected = true;
  }
}
console.log(injected ? "已选中文件" : "!! 文件选择器无响应");
await sleep(3000);

let queued = await queueCount();
console.log(`队列条数（应为 ${plan.length}）：${queued}`);
// layui 的 change 会触发两次（注入 + 控件自身），导致每个文件进队两份；这里把多余尾部删掉
let guard = 0;
while (queued > plan.length && guard++ < 20) {
  await page.eval(`(() => {
    const q = document.querySelector(".layui-upload-list");
    const bs = q ? [...q.querySelectorAll("*")].filter((e) => (e.innerText || "").trim() === "删除" && e.children.length === 0) : [];
    if (bs.length) bs[bs.length - 1].click();
    return 1;
  })()`);
  await sleep(900);
  queued = await queueCount();
}
console.log(`整理后队列条数：${queued}`);
if (queued !== plan.length) {
  console.log("!! 队列条数仍与待传文件数不一致，停止，避免多传/少传");
  await clearQueue();
  process.exit(6);
}

// 这个页面的「开始上传」实际是空函数（只检查有没有选文件），真正的上传是选完自动触发的。
// 所以这里不点它，只等队列状态变成「上传成功」。
const waitUploaded = async (need, timeoutMs = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await page.eval(`(() => {
      const q = document.querySelector(".layui-upload-list");
      const t = q ? (q.innerText || "") : "";
      return { ok: (t.match(/上传成功/g) || []).length, fail: (t.match(/上传失败|错误/g) || []).length };
    })()`);
    if (s.ok >= need) return s;
    if (s.fail) return { ...s, err: true };
    await sleep(1500);
  }
  return { ok: 0, timeout: true };
};
const upState = await waitUploaded(plan.length);
if (upState.timeout || upState.err) {
  console.log(`!! 没有自动上传成功（成功 ${upState.ok}/${plan.length}）`);
  console.log("   已清空暂存队列，避免残留文件在下次一起被提交。");
  await clearQueue();
  console.log("   请在页面「电脑端附件上传」里手动选一次文件（或点一次「开始上传」），然后重跑本脚本核对。");
  process.exit(8);
}
console.log(`队列已上传成功 ${upState.ok} 条`);

let committed1 = await readCommitted();
if (committed1.length === 0) {
  console.log("附件表暂时读不到，刷新一次再看…");
  await page.send("Page.reload", {});
  await sleep(9000);
  committed1 = await readCommitted();
}
const have1 = countOf(committed1);
const missing = attach.filter((a) => !have1[token(a.name)]);
const extra = Object.entries(have1).filter(([, n]) => n > 1);

console.log(`\n== 上传后单据附件 ${committed1.length} 条 ==`);
for (const r of committed1) console.log(`   · ${r.name}`);
let ok = true;
if (missing.length) { ok = false; console.log("\n❌ 缺少："); missing.forEach((m) => console.log("   - " + m.name)); }
if (extra.length) { ok = false; console.log("\n❌ 重复："); extra.forEach(([k, n]) => console.log(`   - ${k} × ${n}`)); }
if (committed1.length !== attach.length) { ok = false; console.log(`\n条数不符：预期 ${attach.length}，实际 ${committed1.length}`); }
console.log(ok ? "\n✅ 核对通过：附件数量正确、无重复、无多余" : "\n❌ 核对未通过，请人工处理（脚本不会提交）");
process.exit(ok ? 0 : 5);
