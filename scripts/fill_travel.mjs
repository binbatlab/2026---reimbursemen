// 按 dataset.json + confirm.json 自动填「国内差旅报销」单据，停在上报支付方式页之前
// 依赖：cdp.mjs、invoices/dataset.json、invoices/confirm.json、发票 PDF 目录
import { ensureBrowser, Browser, sleep } from "./cdp.mjs";
import { readFileSync, existsSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { readConfig } from "./config.mjs";

const WORK = process.env.YWTB_WORKDIR || process.cwd();
const D = join(WORK, "finance_recon");
const RAW = join(WORK, "invoices", "raw");
const PROFILE = process.env.YWTB_PROFILE || join(WORK, ".browser-profile");

function mustRead(p, what) {
  if (!existsSync(p)) { console.error(`缺少 ${what}: ${p}`); process.exit(2); }
  return JSON.parse(readFileSync(p, "utf8"));
}
const ds = mustRead(join(WORK, "invoices", "dataset.json"), "解析结果 dataset.json");
const cf = mustRead(join(WORK, "invoices", "confirm.json"), "确认结果 confirm.json");

const air = ds.invoices.filter((i) => i.kind === "机票");
const car = ds.invoices.filter((i) => i.kind === "网约车");
const trips = ds.itineraries.flatMap((it) => it.trips).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
const dates = trips.map((t) => t.date).sort();
const D1 = dates[0], D2 = dates[dates.length - 1];
const AIR_TOTAL = ds.summary.air_total, CAR_TOTAL = ds.summary.car_total;
const PROJECT = cf.project, REASON = cf.reason, TITLE = cf.title;
const CITY_SEQ = [...new Set(trips.map((t) => t.city))].filter(Boolean);
// 出差地点：去掉出发城市（行程首段所在城市），保留目的地
const CITIES = (CITY_SEQ.length > 1 ? CITY_SEQ.slice(1) : CITY_SEQ).join("/");
const PDFS = air.concat(car).map((i) => i.file).map((f) => join(RAW, f));

console.log(`单据: ${air.length} 机票 ¥${AIR_TOTAL} + ${car.length} 网约车 ¥${CAR_TOTAL}`);
console.log(`日期: ${D1} ~ ${D2}  城市: ${CITIES}  项目: ${PROJECT}`);

const log = [];
const say = (k, ok, m) => { log.push([ok, k, m]); console.log(`  ${ok ? "✅" : "❌"} ${k}: ${m}`); };

const ver = await ensureBrowser({ profileDir: PROFILE });
const b = await new Browser(ver.webSocketDebuggerUrl).connect();
const p = (await b.attachExisting((t) => /cwcwssfv/.test(t.url))) || (await b.newPage("about:blank"));
b.on((m) => { if (m.method === "Page.javascriptDialogOpening") { console.log("  🔔 " + m.params.message.slice(0, 50)); p.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {}); } });
await p.send("Page.enable").catch(() => {});

const F = (re) => `(() => { const walk=(w,d)=>{ if(!w||d>3)return null; try{ if(${re}.test(w.location.href)) return w; }catch{}
  for(let i=0;i<w.frames.length;i++){const r=walk(w.frames[i],d+1); if(r)return r;} return null; }; return walk(window,0); })()`;
const inF = (re, body) => `(() => { const w=${F(re)}; if(!w) return {__err:"frame"}; const doc=w.document; ${body} })()`;

async function type(re, id, text) {
  const r = await p.eval(inF(re, `const el=doc.getElementById("ctl00_ContentPlaceHolder1_${id}"); if(!el) return {ok:false};
    el.value=""; el.scrollIntoView({block:"center"}); el.focus(); el.click(); return {ok:true};`));
  if (!r.ok) return r;
  await p.send("Input.insertText", { text });
  await sleep(120);
  return p.eval(inF(re, `const el=doc.getElementById("ctl00_ContentPlaceHolder1_${id}"); return {ok:el.value===${JSON.stringify(text)}, v:el.value};`));
}

// 1 登录/进系统
await p.goto("https://cwcwssfv.xidian.edu.cn/tysfrz/jump.aspx?sysid=wsyy", { settleMs: 6000 });
if (/login\.aspx/i.test((await p.info()).url)) {
  await p.goto(`https://ids.xidian.edu.cn/authserver/login?service=${encodeURIComponent("https://cwcwssfv.xidian.edu.cn/tysfrz/caslogin.aspx")}`, { settleMs: 8000 });
  await p.goto("https://cwcwssfv.xidian.edu.cn/tysfrz/jump.aspx?sysid=wsyy", { settleMs: 6000 });
}
say("进系统", (await p.info()).url.includes("frame_container"), "");
await p.banner("🤖 正在自动填报，请勿操作这个窗口（约 3-5 分钟）", { color: "#2563eb" });

// 2 建单
await p.eval(`(() => { const w=${F("/frame_main/")}; if(w) w.optimizeJump("Modules/YZSBX/clfbx_simple.aspx"); return true; })()`);
await sleep(6000);
await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_But_XZ_top"); if(b) b.click();`));
await sleep(6000);

// 3 报销人：工号优先环境变量，否则从登录后的页面自动读取（页面顶部显示"欢迎您：姓名 工号"）
const CFG = readConfig();
async function detectStaff(page) {
  if (process.env.YWTB_STAFF_NO) return { no: process.env.YWTB_STAFF_NO.trim(), name: null };
  if (CFG.staffNo) return { no: String(CFG.staffNo).trim(), name: null };
  const r = await page.eval(`(() => {
    const scan = (w) => {
      try {
        const t = (w.document.body.innerText || "");
        const m = t.match(/欢迎您[：:]\\s*(\\S+)\\s+(\\d{4,8})/);
        if (m) return { name: m[1], no: m[2] };
      } catch (e) {}
      return null;
    };
    return scan(window) || scan(window.frames["topFrame"] || {}) || null;
  })()`).catch(() => null);
  return { no: r && r.no ? r.no : "", name: r && r.name ? r.name : null };
}
const who = await detectStaff(p);
const user = who.no;
if (!user) {
  console.error("读不到工号：请先在弹出的浏览器里用「工号+密码」登录财务系统（勾选 7 天免登录），然后再让我继续。");
  process.exit(2);
}
say("报销人", true, `${who.name || ""} ${user}`);
await type(/xmjbxx/i, "TB_BXR", user);
await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await sleep(5000);

// 4 项目
await p.eval(inF(/xmjbxx/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_BT_XMXX1"); if(b) b.click();`));
await sleep(5000);
await p.eval(inF(/xmjbxx/i, `const cell=[...doc.querySelectorAll("td,a,span")].find(e=>{const t=(e.innerText||"").trim(); return t && (t.includes(${JSON.stringify(PROJECT)}) || ${JSON.stringify(PROJECT)}.includes(t) && t.length>6);});
  if(cell){ const tr=cell.closest("tr"); (tr.querySelector("a")||cell).click(); } return true;`));
await sleep(5000);
say("选项目", (await p.eval(inF(/xmjbxx/i, `const e=doc.getElementById("ctl00_ContentPlaceHolder1_TB_XMBH"); return e?e.value:null;`))) === PROJECT, PROJECT);

// 5 明细页
await p.eval(inF(/xmjbxx/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_BT_NEW_NR1"); if(b) b.click();`));
await sleep(9000);

// 6 主信息
for (const [k, id, v] of [["日期起", "TXT_QSRQ", D1], ["日期止", "TXT_ZZRQ", D2],
  ["事由", "TXT_ccddjrw", REASON], ["姓名", "TXT_XM", cf.name || who.name || ""],
  ["职称", "TXT_JFLY", TITLE], ["人数", "TXT_RS", String(cf.people || 1)]]) {
  const r = await type(/clfbx_simple/i, id, v); say(k, r.ok, r.v);
}
// 出差地点：设计上可填但被抓成 disabled
const dd = await p.eval(inF(/clfbx_simple/i, `const el=doc.getElementById("ctl00_ContentPlaceHolder1_Txt_DDd");
  if(!el) return {ok:false}; el.disabled=false; el.value=${JSON.stringify(CITIES)};
  el.dispatchEvent(new Event("change",{bubbles:true})); return {ok:true, v:el.value};`));
say("出差地点", dd.ok, dd.v);
// 7 票夹：先打开选票面板，"可用发票合计"才会出现；文件框不是常驻的，要确认存在
const pickerOpen = () => p.eval(inF(/clfbx_simple/i, `
  return !!(doc.getElementById("ctl00_ContentPlaceHolder1_BT_QR") &&
            (doc.body.innerText||"").includes("我的票夹"));`)).catch(() => false);
const hasFileInput = () => p.eval(inF(/clfbx_simple/i, `return !!(doc.querySelector(".layui-upload-drag input[type=file]") || doc.querySelector("input[type=file]"));`)).catch(() => false);

async function openPicker(rowCtl) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_${rowCtl}_BTN_XZFP"); if(b) b.click();`));
    await sleep(6000);
    if (await pickerOpen()) return true;
    console.log(`   ! 选票面板未打开，重试 ${attempt + 1}/3`);
  }
  return false;
}
async function closePicker() {
  await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_BT_CLOSE"); if(b) b.click();`)).catch(() => {});
  await sleep(2500);
}
async function walletCount() {
  return p.eval(inF(/clfbx_simple/i, `const t=(doc.body.innerText||""); const m=t.match(/可用发票合计：(\\d+)/); return m?Number(m[1]):-1;`));
}
// 打开"点击开始"上传层，让文件框出现
async function openUploadLayer() {
  if (await hasFileInput()) return true;
  await p.eval(inF(/clfbx_simple/i, `
    const cands=[...doc.querySelectorAll("div,span,a,button")].filter(e=>/点击开始/.test((e.innerText||"").trim()));
    if(!cands.length) return false;
    cands.sort((a,b)=>(a.innerText||"").length-(b.innerText||"").length);
    cands[0].click(); return true;`));
  await sleep(3000);
  return await hasFileInput();
}

const opened = await openPicker("GV_CLF_ctl02");
say("打开选票面板", opened, opened ? "ok" : "失败");
let wallet = opened ? await walletCount() : -1;
console.log("   票夹现有:", wallet);
const NEED = air.length + car.length;

if (wallet >= 0 && wallet < NEED) {
  const layer = await openUploadLayer();
  console.log("   上传层:", layer ? "已打开" : "打不开");
  if (layer) {
    // layui 上传组件不认直接赋值，改为拦截文件选择器：点拖拽区 → 捕获 → 塞文件
    let chooser = null;
    const grab = b.once((m) => m.method === "Page.fileChooserOpened", 12000);
    await p.send("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});
    await p.eval(inF(/clfbx_simple/i, `
      const drag = doc.getElementById("testList") || doc.querySelector(".layui-upload-drag");
      if (drag) { drag.click(); return true; }
      const i = doc.querySelector("input[type=file]"); if (i) { i.click(); return true; }
      return false;`));
    try { chooser = await grab; } catch { console.log("   未捕获文件选择器，退回直接赋值"); }

    try {
      if (chooser && chooser.params && chooser.params.backendNodeId) {
        await p.send("DOM.setFileInputFiles", { files: PDFS, backendNodeId: chooser.params.backendNodeId });
        console.log("   已通过文件选择器塞入", PDFS.length, "个文件");
      } else {
        const { result } = await p.send("Runtime.evaluate", { expression: `(() => { const w=${F(/clfbx_simple/i)}; return w.document.querySelector(".layui-upload-drag input[type=file]") || w.document.querySelector("input[type=file]"); })()` });
        if (result.objectId) {
          await p.send("DOM.setFileInputFiles", { files: PDFS, objectId: result.objectId });
          await p.eval(inF(/clfbx_simple/i, `const i=doc.querySelector("input[type=file]"); i.dispatchEvent(new Event("change",{bubbles:true})); return true;`));
        }
      }
      await sleep(2000);
      for (let i = 0; i < 40; i++) {
        await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("testListAction"); if(b) b.click();`)).catch(() => {});
        await sleep(4000);
        const st = await p.eval(inF(/clfbx_simple/i, `const it=[...doc.querySelectorAll("[id^=upload-]")];
          return {done: it.filter(e=>/成功/.test(e.innerText||"")).length, all: it.length};`));
        if (st.done >= PDFS.length) break;
      }
      await p.eval(inF(/clfbx_simple/i, `[...doc.querySelectorAll(".layui-layer-close")].forEach(x=>x.click()); return true;`));
      await sleep(1500);
    } catch (e) {
      say("上传", false, String(e).slice(0, 60));
    }
  }
  await closePicker();
  await openPicker("GV_CLF_ctl02");
  wallet = await walletCount();
  console.log("   上传后票夹:", wallet);
  say("上传", wallet >= NEED, `票夹可用 ${wallet} 张`);
}
if (wallet < NEED) {
  say("票夹可用不足", false, `可用 ${wallet} 张，需要 ${NEED} 张。`);
  await p.bringToFront();
  await p.banner(`⚠️ 需要你处理：票夹可用 ${wallet} 张，不足 ${NEED} 张。请先删除占用发票的草稿单据，或手动拖入发票。`, { color: "#dc2626", pulse: false });
  await closePicker();
  process.exit(3);
}
await closePicker();

// 8 行程单（每段一行）
await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_GV_CLF_ctl02_BTN_XCD_Cl"); if(b) b.click();`));
await sleep(6000);
const segs = air.map((i) => ({
  jt: "飞机", qs: i.travel_date || D1, js: i.travel_date || D1,
  qd: i.from, md: i.to, pb: "经济舱", dj: String(i.total), zs: "1",
}));
let idx = 0;
for (const s of segs) {
  const ctl = "ctl" + String(idx + 2).padStart(2, "0");
  await p.eval(inF(/clfbx_simple/i, `
    const id=x=>"ctl00_ContentPlaceHolder1_MXCL_GV_HAVE_dj_${ctl}_"+x;
    const sel=doc.getElementById(id("DDL_JTGJ"));
    if(sel){ const o=[...sel.options].find(x=>x.text.trim()===${JSON.stringify(s.jt)}); if(o){ sel.value=o.value; sel.dispatchEvent(new Event("change",{bubbles:true})); } }
    const f=(x,v)=>{const e=doc.getElementById(id(x)); if(!e) return false; e.value=v; e.dispatchEvent(new Event("change",{bubbles:true})); return true;};
    return f("TXT_QSSJ",${JSON.stringify(s.qs)}) && f("TXT_JSSJ",${JSON.stringify(s.js)}) &&
           f("TXT_QSDD",${JSON.stringify(s.qd)}) && f("TXT_JSDD",${JSON.stringify(s.md)}) &&
           f("TXT_PB",${JSON.stringify(s.pb)}) && f("TXT_DJ",${JSON.stringify(s.dj)}) && f("TXT_ZS","1");`));
  idx++;
}
await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_MXCL_BTN_CLOSE"); if(b) b.click();`));
await sleep(8000);
say("行程单", true, `${segs.length} 段`);

// 9 挂票
async function pick(rowCtl, keep, label) {
  await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_${rowCtl}_BTN_XZFP"); if(b) b.click();`));
  await sleep(6000);
  await p.eval(inF(/clfbx_simple/i, `
    const keep=${JSON.stringify(keep)};
    const rows=[...doc.querySelectorAll("tr")].filter(tr=>tr.querySelectorAll("td").length>=6 && !/序号/.test(tr.innerText||""));
    const seen=new Set();
    for (const tr of rows) { const cb=tr.querySelector("input[type=checkbox]"); if(!cb) continue;
      const num=(tr.innerText.match(/\\b\\d{20}\\b/)||[])[0]; if(!num) continue;
      const want=keep.includes(num) && !seen.has(num);
      if (want) seen.add(num);
      if (cb.checked!==want) cb.click(); }
    return true;`));
  await sleep(1200);
  await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_BT_QR"); if(b) b.click();`));
  await sleep(7000);
  const v = await p.eval(inF(/clfbx_simple/i, `const g=id=>{const e=doc.getElementById("ctl00_ContentPlaceHolder1_"+id); return e?e.value:null};
    return {zs:g("${rowCtl}_TXT_DZFPZS"), je:g("${rowCtl}_TXT_DZFPJE")};`));
  say(label, String(v.zs) === String(keep.length), JSON.stringify(v));
}
await pick("GV_CLF_ctl02", air.map((i) => i.number), "挂机票");
await pick("GV_CLF_ctl04", car.map((i) => i.number), "挂网约车");

// 10 保存（只一次）
await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_BT_SAVE"); if(b) b.click();`));
await sleep(10000);
await p.screenshot(join(D, "fill_saved.png"));
say("保存", true, "见 finance_recon/fill_saved.png");

// 11 下一步（支付方式）
await p.eval(inF(/clfbx_simple/i, `const b=document.getElementById("ctl00_ContentPlaceHolder1_Btn_xmzffs"); if(b) b.click();`));
await sleep(10000);
await p.screenshot(join(D, "fill_payment.png"));
say("进支付方式", true, "见 finance_recon/fill_payment.png");
await p.bringToFront();
await p.banner("✅ 填报完成 — 请核对金额与发票，然后手动：对私支付 → 本人 → 金额 → 新增 → 确认提交审批", { color: "#059669", pulse: false });
process.stdout.write("\x07");

console.log("\n=== 汇总 ===");
for (const [o, k, m] of log) console.log(`${o ? "✅" : "❌"} ${k}: ${m}`);
console.log("\n下一步：在支付方式页选「对私支付/本人/金额」，最后一步由用户自己点提交。");
process.exit(0);