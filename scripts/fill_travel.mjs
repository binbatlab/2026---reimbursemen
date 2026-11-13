// —— 浏览器守卫：连接断了给出明确提示，而不是半路 mysteriously 停住 ——
process.on("unhandledRejection", (e) => {
  const msg = String((e && e.message) || e);
  if (/Target closed|Session closed|websocket|ECONNREFUSED|WebSocket/i.test(msg)) {
    console.error("\n❌ 浏览器连接中断（skill 用的 Chrome 被关掉了或崩溃）。");
    console.error("   单据没有丢：重跑一次会从「未提交单据」继续，或手动在该单据上点【修改】。");
    process.exit(9);
  }
  console.error("未处理的错误:", msg);
  process.exit(1);
});
// 按 dataset.json + confirm.json 自动填「国内差旅报销」单据，停在上报支付方式页之前
// 依赖：cdp.mjs、invoices/dataset.json、invoices/confirm.json、发票 PDF 目录
import { ensureBrowser, Browser, sleep, reviver } from "./cdp.mjs";
import { ensurePortal } from "./portal.mjs";
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { readConfig } from "./config.mjs";
import { cityTransportPlan } from "./rules.mjs";

const WORK = process.env.YWTB_WORKDIR || process.cwd();
const D = join(WORK, "finance_recon");
const RAW = join(WORK, "invoices", "raw");
const PROFILE = process.env.YWTB_PROFILE || join(WORK, ".browser-profile");

function mustRead(p, what) {
  if (!existsSync(p)) { console.error(`缺少 ${what}: ${p}`); process.exit(2); }
  return JSON.parse(readFileSync(p, "utf8"));
}
const ds = mustRead(join(WORK, "invoices", "dataset.json"), "解析结果 dataset.json");
// 确认门禁：必须先经过「确认页」，不能拿上一次的旧值直接填报
{
  const dsP = join(WORK, "invoices", "dataset.json");
  const cfP = join(WORK, "invoices", "confirm.json");
  const dsT = existsSync(dsP) ? statSync(dsP).mtimeMs : 0;
  const cfT = existsSync(cfP) ? statSync(cfP).mtimeMs : 0;
  if (process.env.YWTB_SKIP_CONFIRM_GATE !== "1" && cfT < dsT) {
    console.error("\n❌ 这次还没有在确认页确认过（confirm.json 比发票解析结果旧）。");
    console.error("   请先运行 run.mjs，或用确认页填好项目/住宿/支付方式后再填报。");
    process.exit(6);
  }
}
const cf = mustRead(join(WORK, "invoices", "confirm.json"), "确认结果 confirm.json");

const air = ds.invoices.filter((i) => i.kind === "机票");
const car = ds.invoices.filter((i) => i.kind === "网约车");
const hotelInv = ds.invoices.filter((i) => i.kind === "住宿");
// 市内交通：每天 ≤80 领 80 元/天补助（不交票）；>80 那天交票实报。注意：包干只用于住宿
const TP = cityTransportPlan(ds, cf.people || 1);
const carAttach = TP.ok ? car.filter((i) => TP.attach.includes(i.number)) : car;
// 住宿：确认页填了金额才算实报，这时才把住宿票挂到住宿行
const hotelClaim = Number(cf.hotelAmount || 0) > 0;
const hotelAttach = hotelClaim ? hotelInv : [];
const trips = (ds.itineraries || []).flatMap((it) => it.trips || []).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
const dates = trips.map((t) => t.date).sort();
const D1 = String(cf.dateFrom || dates[0] || "").trim(), D2 = String(cf.dateTo || dates[dates.length - 1] || "").trim();
const SUM = ds.summary || {};
const AIR_TOTAL = SUM.air_total, CAR_TOTAL = SUM.car_total;
const PROJECT = cf.project, REASON = cf.reason, TITLE = cf.title;
const CITY_SEQ = [...new Set(trips.map((t) => t.city))].filter(Boolean);
// 出差地点：去掉出发城市（行程首段所在城市），保留目的地
const CITIES = String(cf.cities || (CITY_SEQ.length > 1 ? CITY_SEQ.slice(1) : CITY_SEQ).join("/")).trim();
const PDFS = air.concat(carAttach, hotelAttach).map((i) => i.file).map((f) => join(RAW, f));

console.log(`单据: ${air.length} 机票 ¥${AIR_TOTAL} + 网约车实报 ${carAttach.length}/${car.length} 张 ¥${CAR_TOTAL}`);
console.log(`市内交通: ${TP.ok ? TP.days.map((d) => `${d.date.slice(5)} ¥${d.amount}${d.mode === "subsidy" ? "补助" : "实报"}`).join(" / ") : TP.why}`);
console.log(`日期: ${D1} ~ ${D2}  城市: ${CITIES}  项目: ${PROJECT}`);

// 等某个 frame 真正就绪（导航/回发期间 location 会抛错，必须重试而不是硬等）
async function waitFrame(re, probeExpr = "true", timeoutMs = 45000) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    const r = await p.eval(inF(re, `try { return { ok: !!(${probeExpr}) }; } catch (e) { return { ok: false, why: e.message }; }`)).catch(() => null);
    if (r && r.ok === true) return true;
    if (r && r.why) last = r.why;
    await sleep(800);
  }
  if (last) console.log(`   ! 等 frame 超时（${last}）`);
  return false;
}

// 卡死自愈：页面 3 秒不应答就重启浏览器并重新进入系统
async function guard(tag) {
  if (await p.ping()) { pAlive = true; return true; }
  console.log(`   ↻ [${tag}] 页面无响应，开始自愈…`);
  pAlive = false;
  try {
    const r = await reviver({ profileDir: PROFILE, pageHint: (t) => /cwcwssfv|xidian/.test(t.url || "") });
    p = r.page;
    await p.send("Page.enable").catch(() => {});
    await ensurePortal(p, { waitMinutes: 2, log: (m) => console.log("   " + m) });
    pAlive = true;
    console.log(`   ✓ [${tag}] 浏览器已恢复`);
    // 浏览器崩溃后页面已丢失，继续做只会乱点：明确停下，让用户重跑（会续填同一张单据）
    console.log("\n❌ 浏览器中途崩溃，流程已中止（没有乱改单据）。");
    console.log("   已重启浏览器；重跑一次会从「未提交单据」续填这张。");
    process.exit(9);
    return false;
  } catch (e) {
    console.log(`   ✗ [${tag}] 自愈失败: ${e.message}`);
    return false;
  }
}

const log = [];
const say = (k, ok, m) => { log.push([ok, k, m]); console.log(`  ${ok ? "✅" : "❌"} ${k}: ${m}`); };

const ver = await ensureBrowser({ profileDir: PROFILE });
const b = await new Browser(ver.webSocketDebuggerUrl).connect();
let p = (await b.attachExisting((t) => /cwcwssfv/.test(t.url))) || (await b.newPage("about:blank"));
let pAlive = true;
b.on((m) => { if (m.method === "Page.javascriptDialogOpening") { console.log("  🔔 " + m.params.message.slice(0, 50)); p.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {}); } });
await p.send("Page.enable").catch(() => {});

const F = (re) => `(() => { const walk=(w,d)=>{ if(!w||d>3)return null; try{ if(${re}.test(w.location.href)) return w; }catch{}
  for(let i=0;i<w.frames.length;i++){const r=walk(w.frames[i],d+1); if(r)return r;} return null; }; return walk(window,0); })()`;
const inF = (re, body) => `(() => { const w=${F(re)}; if(!w) return {__err:"frame"}; const doc=w.document; ${String(body).trim().startsWith("(") ? "return " + body : body} })()`;

// 主框架在顶层页面里的偏移（顶部菜单 60px）。鼠标事件必须加这个偏移，否则会点到别的控件
let OFF = { dx: 0, dy: 60 };
async function refreshOffset() {
  const o = await p.eval(`(() => {
    const fr = [...document.querySelectorAll("iframe,frame")].find((f) => (f.name || f.id) === "mainframe");
    if (!fr) return null;
    const r = fr.getBoundingClientRect();
    return { dx: Math.round(r.left), dy: Math.round(r.top) };
  })()`).catch(() => null);
  if (o && Number.isFinite(o.dy)) OFF = o;
  return OFF;
}

// 真鼠标点击 + 键入：实测唯一能稳定写入的方式（JS focus 会被吞）
async function type(re, id, text) {
  const box = await p.eval(inF(re, `const el=doc.getElementById("ctl00_ContentPlaceHolder1_${id}");
    if(!el) return null; el.scrollIntoView({block:"center"});
    const r=el.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};`)).catch(() => null);
  if (!box) return { ok: false, v: "(无控件)" };
  const X = Math.round((Number(OFF.dx) || 0) + Number(box.x));
  const Y = Math.round((Number(OFF.dy) || 0) + Number(box.y));
  if (!Number.isFinite(X) || !Number.isFinite(Y)) return { ok: false, v: "(坐标无效)" };
  const click = async (type) => {
    await p.send("Input.dispatchMouseEvent", { type, x: X, y: Y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 }).catch(() => {});
  };
  await click("mousePressed");
  await click("mouseReleased");
  await sleep(200);
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }).catch(() => {});
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }).catch(() => {});
  await p.send("Input.insertText", { text: String(text) }).catch(() => {});
  await sleep(200);
  // 日期控件会弹日历，Esc 收掉（不要点页面元素）
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }).catch(() => {});
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }).catch(() => {});
  await sleep(250);
  return p.eval(inF(re, `const el=doc.getElementById("ctl00_ContentPlaceHolder1_${id}"); return el ? {ok: el.value===${JSON.stringify(String(text))}, v: el.value} : {ok:false,v:"(无控件)"};`));
}

// 1 登录/进系统：统一走 portal.mjs（先 CAS，再进报账；没会话就自动填/等人登录）
try {
  await ensurePortal(p, { waitMinutes: Number(process.env.YWTB_LOGIN_WAIT_MINUTES || 5), log: (m) => console.log(m) });
  say("进系统", true, "会话就绪");
} catch (e) {
  say("进系统", false, e.message);
  await p.bringToFront().catch(() => {});
  await p.banner(`需要登录：${e.message}`, { color: "#dc2626", pulse: false }).catch(() => {});
  console.log("\n=== 汇总 ===");
  for (const [o, k, m] of log) console.log(`${o ? "✅" : "❌"} ${k}: ${m}`);
  process.exit(3);
}
await refreshOffset();
await p.banner("🤖 正在自动填报，请勿操作这个窗口（约 3-5 分钟）", { color: "#2563eb" });

await guard("进单据前");

// 2 建单 / 续填：已有未提交单据就续上一张，避免每次都新建、每次都从列表重来
await p.eval(`(() => { const w=${F("/frame_main/")}; if(w) w.optimizeJump("Modules/YZSBX/clfbx_simple.aspx"); return true; })()`);
await sleep(7000);
let draftInfo = { has: false };
for (let i = 0; i < 5; i++) {
  const r = await p.eval(inF(/clfbx_simple/i, `(() => {
    const a = [...doc.querySelectorAll("a")].find((x) => (x.innerText || "").trim() === "修改");
    if (!a) return { has: false, ready: true };
    const tr = a.closest("tr");
    return { has: true, ready: true, row: tr ? (tr.innerText || "").replace(/\\s+/g, " ").slice(0, 70) : "" };
  })()`)).catch(() => null);
  if (r && r.ready) { draftInfo = r; break; }
  await sleep(3000);
}
if (!draftInfo.ready) console.log("   ! 列表页没加载出来，按新建处理");
const wantResume = process.env.YWTB_RESUME === "1";
if (draftInfo.has && wantResume) {
  say("建单", true, `续填已有单据（YWTB_RESUME=1）：${draftInfo.row}`);
  // 多张草稿时，优先续填本项目那一张
  await p.eval(inF(/clfbx_simple/i, `(() => {
    const rows = [...doc.querySelectorAll("tr")].filter((tr) => (tr.innerText || "").includes("修改"));
    const hit = rows.find((tr) => (tr.innerText || "").includes(${JSON.stringify(PROJECT)})) || rows[0];
    const a = hit && [...hit.querySelectorAll("a")].find((x) => (x.innerText || "").trim() === "修改");
    if (a) { a.click(); return true; }
    return false;
  })()`)).catch(() => false);
} else {
  say("建单", true, "新建单据");
  await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_But_XZ_top"); if(b) b.click(); return !!b;`));
}
await sleep(9000);

// 3 报销人：工号优先环境变量，否则从登录后的页面自动读取（页面顶部显示"欢迎您：姓名 工号"）
const CFG = readConfig();
async function detectStaff(page) {
  if (process.env.YWTB_STAFF_NO) return { no: process.env.YWTB_STAFF_NO.trim(), name: null };
  if (CFG.staffNo) {
    // 工号来自配置，姓名仍然从页面顶部读
    const r0 = (await page.eval(`(() => {
      const scan=(w)=>{ try { const t=(w.document.body.innerText||""); const m=t.match(/欢迎您[：:]\\s*([^\\s0-9]{2,6})/); if(m) return m[1]; } catch(e){} return null; };
      return scan(window) || scan(window.frames["topFrame"] || {});
    })()`).catch(() => null));
    return { no: String(CFG.staffNo).trim(), name: r0 };
  }
  const r = await page.eval(`(() => {
    const scan = (w) => {
      try {
        const t = (w.document.body.innerText || "");
        const m = t.match(/欢迎您[：:]\\s*([^\\s0-9]{2,6})/);
        if (m) return { name: m[1], no: null };
        const m2 = t.match(/欢迎您[：:]\\s*(\\S+)\\s+(\\d{4,8})/);
        if (m2) return { name: m2[1], no: m2[2] };
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

// 3.4 续填：从「未提交单据」点【修改】进来时，明细页已经打开，
//     根本没有「新建/选项目」页可填报销人 —— 硬去填会等 45 秒超时，直接跳过。
const alreadyOnDetail = (await p.eval(inF(/clfbx_simple/i, `return !!doc.getElementById("ctl00_ContentPlaceHolder1_BT_ZSFMX");`)).catch(() => false)) === true;
if (alreadyOnDetail) {
  console.log("   （续填：明细页已打开，报销人沿用单据上的）");
} else {
  await type(/xmjbxx/i, "TB_BXR", user);
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(1500);
  await waitFrame(/xmjbxx/i, 'doc.readyState === "complete" && !!doc.getElementById("ctl00_ContentPlaceHolder1_TB_BXR")');
  await sleep(1500);
}

// 3.5 续填时，报销人一回车系统可能直接跳到明细页；那就别再做「选项目/下一步」
// 关键：eval 失败会返回对象 {__err:"frame"}，那是 truthy，会错误跳过「选项目+下一步」
const onDetail = alreadyOnDetail || (await p.eval(inF(/clfbx_simple/i, `return !!doc.getElementById("ctl00_ContentPlaceHolder1_BT_ZSFMX");`)).catch(() => false)) === true;
if (onDetail === true) {
  say("跳过选项目", true, "已直接进入明细页（续填）");
}

// 赋值与回发分开：直接 dispatch change 会触发 __doPostBack，导致当前 eval 拿不到返回值
async function setThenPostback(id, value) {
  const setR = await p.eval(inF(/clfbx_simple/i, `(() => {
    const e = doc.getElementById("ctl00_ContentPlaceHolder1_" + ${JSON.stringify(id)});
    if (!e) return { ok: false, why: "没有控件" };
    e.value = ${JSON.stringify(value)};
    return { ok: true, v: e.value };
  })()`)).catch((e) => ({ ok: false, why: e.message }));
  await sleep(300);
  await p.eval(inF(/clfbx_simple/i, `(() => {
    const e = doc.getElementById("ctl00_ContentPlaceHolder1_" + ${JSON.stringify(id)});
    if (!e) return false;
    e.dispatchEvent(new Event("change", { bubbles: true }));
    if (typeof e.onchange === "function") { try { e.onchange(); } catch (err) {} }
    return true;
  })()`)).catch(() => false);
  await sleep(2500);
  return setR;
}
// 真鼠标点击：合成 click() 有时会被页面脚本吃掉，用 CDP 发真实鼠标事件最接近用户操作
async function realClickId(id, frameRe = /clfbx_simple/i) {
  const box = await p.eval(inF(frameRe, `(() => {
    const e = doc.getElementById("ctl00_ContentPlaceHolder1_" + ${JSON.stringify(id)});
    if (!e) return null;
    e.scrollIntoView({ block: "center" });
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`)).catch(() => null);
  if (!box) return false;
  // 主框架在顶层页面里有偏移（顶栏 60px），不加偏移会点到别的控件上
  const X = Math.round((Number(OFF.dx) || 0) + box.x);
  const Y = Math.round((Number(OFF.dy) || 0) + box.y);
  await p.send("Input.dispatchMouseEvent", { type: "mousePressed", x: X, y: Y, button: "left", clickCount: 1, buttons: 1 });
  await sleep(120);
  await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: X, y: Y, button: "left", clickCount: 1, buttons: 0 });
  await sleep(1200);
  return true;
}

// 回发后核对核心字段：系统的 PostBack 会按数据库里的值重绘，我们写的值可能被清掉
async function verifyCore(tag) {
  const v = await p.eval(inF(/clfbx_simple/i, `(() => {
    const g = (id) => { const e = doc.getElementById("ctl00_ContentPlaceHolder1_" + id); return e ? e.value : null; };
    return { qsrq: g("TXT_QSRQ"), zzrq: g("TXT_ZZRQ"), sy: g("TXT_ccddjrw"),
             xm: g("TXT_XM"), jf: g("TXT_JFLY"), rs: g("TXT_RS"), dd: g("Txt_DDd") };
  })()`)).catch(() => null);
  if (!v) { console.log(`   ! [${tag}] 读不到页面字段`); return false; }
  const miss = [];
  if (!v.qsrq) miss.push("日期起");
  if (!v.zzrq) miss.push("日期止");
  if (!v.sy) miss.push("事由");
  if (!v.xm) miss.push("姓名");
  if (!v.jf) miss.push("职称");
  if (!v.rs) miss.push("人数");
  if (!v.dd) miss.push("出差地点");
  if (!miss.length) return true;
  console.log(`   ⚠ [${tag}] 回发后这些字段空了：${miss.join("、")} → 自动重填`);
  const refill = [
    ["TXT_QSRQ", D1], ["TXT_ZZRQ", D2], ["TXT_ccddjrw", REASON],
    ["TXT_XM", String(cf.name || who.name || "").trim()],
    ["TXT_JFLY", TITLE], ["TXT_RS", String(cf.people || 1)],
  ];
  for (const [id, val] of refill) {
    if (!val) continue;
    const cur = await p.eval(inF(/clfbx_simple/i, `const e=doc.getElementById("ctl00_ContentPlaceHolder1_${id}"); return e?e.value:null;`)).catch(() => null);
    if (cur) continue;
    await type(/clfbx_simple/i, id, val);
  }
  await p.eval(inF(/clfbx_simple/i, `const el=doc.getElementById("ctl00_ContentPlaceHolder1_Txt_DDd");
    if(el){ el.disabled=false; el.value=${JSON.stringify(CITIES)}; el.dispatchEvent(new Event("change",{bubbles:true})); }
    return true;`)).catch(() => false);
  await sleep(1500);
  return true;
}

// 数据契约核对：确认页填的每一项，都要在页面上对得上（不漏填、不误填）
async function verifyAll(tag) {
  const expect = {
    "出差日期起": D1,
    "出差日期止": D2,
    "出差事由": REASON,
    "出差人姓名": String(cf.name || who.name || "").trim(),
    "职称职别": TITLE,
    "人数": String(cf.people || 1),
    "出差地点": "",   // 由住宿明细按住宿城市自动带出，只校验非空，不比对具体值
    "住宿费包干": cf.hotelMode === "invoice" ? "不包干" : "包干",
  };
  const actual = await p.eval(inF(/clfbx_simple/i, `(() => {
    const g = (id) => { const e = doc.getElementById("ctl00_ContentPlaceHolder1_" + id); return e ? (e.value || "") : ""; };
    const s = doc.getElementById("ctl00_ContentPlaceHolder1_DDL_SFBG");
    const rowZ = (label) => {
      const rows = [...doc.querySelectorAll("tr")];
      for (const tr of rows) {
        const c1 = tr.cells && tr.cells[1] ? (tr.cells[1].innerText || "").trim() : "";
        if (c1 !== label) continue;
        const zs = tr.querySelector("input[id*=TXT_DZFPZS]");
        const je = tr.querySelector("input[id*=TXT_DZFPJE]");
        return { zs: zs ? zs.value : "", je: je ? je.value : "" };
      }
      return { zs: "", je: "" };
    };
    return {
      "出差日期起": g("TXT_QSRQ"), "出差日期止": g("TXT_ZZRQ"),
      "出差事由": g("TXT_ccddjrw"), "出差人姓名": g("TXT_XM"),
      "职称职别": g("TXT_JFLY"), "人数": g("TXT_RS"), "出差地点": g("Txt_DDd"),
      "住宿费包干": s && s.options[s.selectedIndex] ? s.options[s.selectedIndex].text.trim() : "",
      _air: rowZ("飞机"), _car: rowZ("汽车"),
    };
  })()`)).catch(() => null);

  if (!actual) { console.log(`   ⚠ [${tag}] 读不到页面，无法核对`); return false; }

  const bad = [];
  for (const [k, v] of Object.entries(expect)) {
    if (!v) continue;
    const got = String(actual[k] || "").trim();
    const ok = String(v).trim() === got || (k === "出差事由" && got.includes(String(v).slice(0, 6)));
    console.log(`   ${ok ? "✅" : "❌"} ${k}: 期望「${v}」/ 页面「${got}」`);
    if (!ok) bad.push(k);
  }
  // 出差地点：系统按住宿明细自动带出，只要求非空（为空才兜底写城市）
  const ddGot = String(actual["出差地点"] || "").trim();
  console.log(`   ${ddGot ? "✅" : "❌"} 出差地点（系统自动）: 「${ddGot}」`);
  if (!ddGot) bad.push("出差地点");
  // 票据张数
  const airWant = air.length, carWant = carAttach.length;
  const airCtl = (await rowCtlByLabel("飞机")) || "GV_CLF_ctl02";
  const carCtl = (await rowCtlByLabel("汽车")) || "GV_CLF_ctl03";
  const cnt = await p.eval(inF(/clfbx_simple/i, `(() => {
    const g = (id) => { const e = doc.getElementById("ctl00_ContentPlaceHolder1_" + id); return e ? e.value : ""; };
    return { air: g("${airCtl}_TXT_DZFPZS"), car: g("${carCtl}_TXT_DZFPZS") };
  })()`)).catch(() => null);
  const airGot = Number(actual._air && actual._air.zs || 0) || Number((cnt && cnt.air) || 0);
  const carGot = Number((cnt && cnt.car) || 0) || Number(actual._car && actual._car.zs || 0);
  console.log(`   ${airGot === airWant ? "✅" : "❌"} 机票张数: 期望 ${airWant} / 页面 ${airGot}`);
  console.log(`   ${carGot === carWant ? "✅" : "❌"} 汽车张数: 期望 ${carWant} / 页面 ${carGot}`);
  if (airGot !== airWant) bad.push("机票张数");
  if (carGot !== carWant) bad.push("汽车张数");

  if (bad.length) {
    console.log(`   ⚠ [${tag}] 有 ${bad.length} 项不一致：${bad.join("、")} → 按确认页的值覆盖`);
    // 明确改写成用户确认的值（例如职别被住宿明细改成了“08其余人员”，要改回“副教授”）
    const ID_OF = { "出差日期起": "TXT_QSRQ", "出差日期止": "TXT_ZZRQ", "出差事由": "TXT_ccddjrw",
                    "出差人姓名": "TXT_XM", "职称职别": "TXT_JFLY", "人数": "TXT_RS" };
    for (const k of bad) {
      if (k === "住宿费包干") { await setSfbg(); continue; }
      if (k === "出差地点") {
        await p.eval(inF(/clfbx_simple/i, `const el=doc.getElementById("ctl00_ContentPlaceHolder1_Txt_DDd");
          if(el){ el.disabled=false; el.value=${JSON.stringify(CITIES)}; el.dispatchEvent(new Event("change",{bubbles:true})); }
          return true;`)).catch(() => false);
        await sleep(1500);
        continue;
      }
      const id = ID_OF[k];
      if (!id) continue;
      await type(/clfbx_simple/i, id, expect[k]);
      console.log(`     ↳ 已改写 ${k} = ${expect[k]}`);
      await closePickers();
    }
    const again = await p.eval(inF(/clfbx_simple/i, `(() => {
      const g = (id) => { const e = doc.getElementById("ctl00_ContentPlaceHolder1_" + id); return e ? (e.value || "") : ""; };
      return { "出差事由": g("TXT_ccddjrw"), "出差人姓名": g("TXT_XM"), "职称职别": g("TXT_JFLY"), "人数": g("TXT_RS"), "出差地点": g("Txt_DDd") };
    })()`)).catch(() => null);
    const still = bad.filter((k) => again && expect[k] && String(again[k] || "").trim() !== String(expect[k]).trim() && !(k === "出差事由" && String(again[k] || "").includes(String(expect[k]).slice(0, 6))));
    if (still.length) {
      console.log(`\n❌ [${tag}] 这些还是对不上：${still.join("、")}`);
      console.log("   已停止，不会带着错误数据继续。请回浏览器核对后重跑。");
      await p.bringToFront().catch(() => {});
      await p.banner(`⚠️ 数据对不上：${still.join("、")}`, { color: "#dc2626", pulse: false }).catch(() => {});
      process.exit(8);
    }
  }
  console.log(`   ✓ [${tag}] 数据核对全部通过`);
  return true;
}


if (!onDetail) {
  // 4 项目：点【选择经费】→ 在弹窗里点“编号完全等于项目号”的链接（实测唯一可靠的路径）
  const projValue = () => p.eval(inF(/xmjbxx/i, `const e=doc.getElementById("ctl00_ContentPlaceHolder1_TB_XMBH"); return e?e.value:null;`));
  await p.eval(inF(/xmjbxx/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_BT_XMXX1"); if(b) b.click(); return !!b;`));
  await sleep(6000);
  for (let attempt = 0; attempt < 4; attempt++) {
    let clicked = false;
    try {
      clicked = await p.eval(inF(/xmjbxx/i, `const a=[...doc.querySelectorAll("a")].find(x=>/LB_XMBH/.test(x.id||"") && (x.innerText||"").trim()===${JSON.stringify(PROJECT)})
        || [...doc.querySelectorAll("a")].find(x=>(x.innerText||"").trim()===${JSON.stringify(PROJECT)});
        if(a){ a.click(); return true; } return false;`));
    } catch (e) {
      console.log(`   ! 选项目第 ${attempt + 1} 次点击异常：${String(e.message).slice(0, 60)}`);
    }
    await sleep(5500);
    const gotRaw = await projValue().catch(() => null);
    const got = typeof gotRaw === "string" ? gotRaw : "";
    if (got === PROJECT) break;
    if (!clicked) await sleep(3000);           // 弹窗还没出来，等一会再找
  }
  const projAfter = await projValue();
  say("选项目", projAfter === PROJECT, `${PROJECT}（页面显示 ${projAfter}）`);
  if (projAfter !== PROJECT) {
    console.log("\n❌ 项目没选上（页面项目号是「" + (projAfter === null ? "空" : projAfter) + "」），不再往下填，避免产生脏数据。");
    console.log("   请回浏览器点【选择经费】选一次项目，再重跑。");
    process.exit(5);
  }

  // 5 明细页
  await p.eval(inF(/xmjbxx/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_BT_NEW_NR1"); if(b) b.click();`));
  await waitFrame(/clfbx_simple/i, '!!doc.getElementById("ctl00_ContentPlaceHolder1_TXT_QSRQ")', 60000);
  await sleep(1500);

}

// 6 主信息（正确顺序：日期 → 事由 → 姓名/职称/人数/地点 → 包干选项 → 住宿明细）
const closePickers = async () => {
  // ⚠ 只能用 Esc / blur 收起日历，千万不能点页面元素（点到标题/链接会整页跳走）
  for (let i = 0; i < 2; i++) {
    await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(250);
  }
  await p.eval(inF(/clfbx_simple/i, `try { doc.activeElement && doc.activeElement.blur(); } catch(e) {} return true;`)).catch(() => false);
  await sleep(300);
};

// 等明细页稳定
for (let i = 0; i < 10; i++) {
  const ok = await p.eval(inF(/clfbx_simple/i, `return doc.readyState === "complete" && !!doc.getElementById("ctl00_ContentPlaceHolder1_TXT_QSRQ");`)).catch(() => false);
  if (ok === true) break;
  await sleep(2000);
}

for (const [k, id, v] of [["日期起", "TXT_QSRQ", D1], ["日期止", "TXT_ZZRQ", D2]]) {
  const r = await type(/clfbx_simple/i, id, v); say(k, r.ok, r.v);
  await closePickers();
}
await closePickers();

const TRAVELER = String(cf.name || who.name || "").trim();
for (const [k, id, v] of [
  ["事由", "TXT_ccddjrw", REASON],
  ["姓名", "TXT_XM", TRAVELER],
  ["职称", "TXT_JFLY", TITLE],
  ["人数", "TXT_RS", String(cf.people || 1)],
]) {
  if (!v) { say(k, true, "（空，跳过）"); continue; }
  let r = await type(/clfbx_simple/i, id, v);
  if (!r.ok) {                    // 系统偶发清空，重试一次
    await sleep(1500);
    r = await type(/clfbx_simple/i, id, v);
  }
  say(k, r.ok, r.ok ? r.v : `没写进去（当前值 ${r.v === undefined ? "无法读取" : r.v}）`);
  await closePickers();
}

// 出差地点：**不填**。住宿明细保存后，系统会按住宿城市自动带出（脚本写反而会被回发清掉/覆盖）
const dd = await p.eval(inF(/clfbx_simple/i, `const el=doc.getElementById("ctl00_ContentPlaceHolder1_Txt_DDd"); return el?el.value:null;`)).catch(() => null);
console.log(`   出差地点：${dd || "（等住宿明细保存后由系统自动带出）"}`);

const HD = Number(cf.hotelDays || 0), HA = Number(cf.hotelAmount || 0);

// 6.5 住宿费是否包干：先设一次（系统必填，默认是“不包干”）
const setSfbg = async () => {
  const want = cf.hotelMode === "invoice" ? "0" : "1";
  const wantText = cf.hotelMode === "invoice" ? "不包干" : "包干";
  let txt = "";
  for (let i = 0; i < 6; i++) {
    await setThenPostback("DDL_SFBG", want);
    txt = await p.eval(inF(/clfbx_simple/i, `(() => {
      const s = doc.getElementById("ctl00_ContentPlaceHolder1_DDL_SFBG");
      if (!s) return "";
      return (s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : s.value) || "";
    })()`)).catch(() => "");
    if (String(txt).includes(wantText)) break;
    await sleep(2500);
  }
  say("住宿费包干选项", String(txt).includes(wantText), String(txt || "读不到"));
  return String(txt).includes(wantText);
};
await setSfbg();

// 6.6 住宿明细：全自动（inF 已修复，IIFE 现在会正确返回）
if (HD > 0 || HA > 0) {
  const HI = Number(cf.hotelInvoices || (cf.hotelMode === "invoice" ? 1 : 0));
  const CITY = String(cf.hotelCity || (CITIES || "").split("/")[0] || "").trim();
  const PROV_MAP = { 苏州:"JS", 南京:"JS", 无锡:"JS", 常州:"JS", 镇江:"JS", 徐州:"JS", 扬州:"JS",
    上海:"SH", 北京:"BJ", 天津:"TJ", 重庆:"CQ", 广州:"GD", 深圳:"GD", 珠海:"GD", 东莞:"GD",
    杭州:"ZJ", 宁波:"ZJ", 西安:"SN", 成都:"SC", 武汉:"HB", 长沙:"HN", 合肥:"AH", 济南:"SD",
    青岛:"SD", 郑州:"HA", 福州:"FJ", 厦门:"FJ", 南昌:"JX", 太原:"SX", 石家庄:"HE", 沈阳:"LN" };
  const PROV = String(cf.hotelProvince || PROV_MAP[CITY] || CITY || "").trim();

  // 判据（用户确认）：住宿明细填对后，「住宿费是否包干」下拉会被系统锁定（disabled=true）。
  // 只认「住宿费行有没有金额」会误判 —— 行里一直留着「请点击…填写」的提示文字。
  const hotelFilled = () => p.eval(inF(/clfbx_simple/i, `(() => {
    const s = doc.getElementById("ctl00_ContentPlaceHolder1_DDL_SFBG");
    const locked = !!(s && s.disabled);
    const tr = [...doc.querySelectorAll("tr")].find((t) => {
    const x = (t.innerText || "").replace(/\\s+/g, "");
    return x.startsWith("住宿费") || (x.includes("住宿费") && x.includes("选择票据") && !x.includes("是否包干"));
  });
    const t = tr ? (tr.innerText || "").replace(/\\s+/g, " ") : "";
    const hasAmt = /合计[:：]?\\s*\\d/.test(t) || /\\d+(\\.\\d+)?\\s*$/.test(t);
    return { ok: locked || hasAmt, locked, text: t.slice(0, 70) };
  })()`)).catch(() => null);

  let filledNow = await hotelFilled();
  if (filledNow && filledNow.ok) {
    say("住宿明细", true, "系统已带出，无需重复填");
  } else {
    // 打开面板
    let opened = false;
    for (let a = 0; a < 3 && !opened; a++) {
      await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_BT_ZSFMX"); if(b){b.scrollIntoView({block:"center"}); b.click(); return true;} return false;`)).catch(() => false);
      for (let i = 0; i < 6; i++) {
        await sleep(2500);
        const probe = await p.eval(inF(/clfbx_simple/i, `(() => ({ rows: [...doc.querySelectorAll("tr")].filter((tr) => /NHZSBT_GV_ZSBT_ctl\\d+_TXT_YGBH/.test(tr.innerHTML || "")).length }))()`)).catch(() => null);
        if (probe && probe.rows > 0) { opened = true; break; }
      }
    }
    say("住宿明细·打开", opened, opened ? "面板已出现" : "打不开");

    if (opened) {
      // 填本人那一行
      const r1 = await p.eval(inF(/clfbx_simple/i, `(() => {
        const rows = [...doc.querySelectorAll("tr")].filter((tr) => /NHZSBT_GV_ZSBT_ctl\\d+_TXT_YGBH/.test(tr.innerHTML || ""));
        let row = rows.find((tr) => ((tr.querySelector("input[id*=TXT_YGBH]") || {}).value || "").trim() === ${JSON.stringify(String(user))});
        if (!row) {
          row = rows[0];
          if (!row) return { ok: false, why: "一行都没有" };
          const put0 = (sfx, v) => { const e = row.querySelector("input[id*='" + sfx + "']"); if (!e) return false; e.value = v; return true; };
          put0("TXT_YGBH", ${JSON.stringify(String(user))});
          put0("TB_XM", ${JSON.stringify(String(TRAVELER))});
          put0("TB_RS", "1");
        }
        // 只填出差人（工号一填，职别/姓名由系统带出）。
        // 淡季天数/发票张数要等「出差地区」保存之后再填，住宿金额则完全由系统算 —— 这里都不碰。
        const put = (sfx, v) => { const e = row.querySelector("input[id*='" + sfx + "']"); if (!e) return false; e.value = v; return true; };
        const a = put("TXT_YGBH", ${JSON.stringify(String(user))});
        return { ok: a, a };
      })()`)).catch((e) => ({ ok: false, why: e.message }));
      say("住宿明细·填出差人", !!(r1 && r1.ok), (r1 && r1.why) || `工号 ${user}（职别由系统带出）`);

      // 逐字段回读，确认填写完整（天数/张数/金额/城市）
      const openedDlg = await p.eval(inF(/clfbx_simple/i, `(() => {
        // 优先按 id 找绿色 +；找不到就按「住宿地点」那一列里的图片找
        let img = doc.querySelector("img[id*=Img_ZSDD],input[id*=Img_ZSDD]");
        if (!img) {
          const rows = [...doc.querySelectorAll("tr")].filter((tr) => /NHZSBT_GV_ZSBT_ctl\d+_TXT_YGBH/.test(tr.innerHTML || ""));
          const row = rows.find((tr) => ((tr.querySelector("input[id*=TXT_YGBH]") || {}).value || "").trim() === ${JSON.stringify(String(user))}) || rows[0];
          if (row && row.cells) {
            for (let i = 5; i < Math.min(row.cells.length, 9); i++) {
              const im = row.cells[i] && row.cells[i].querySelector("img");
              if (im) { img = im; break; }
            }
          }
        }
        if (!img) return { ok: false, why: "找不到绿色 + 按钮" };
        img.scrollIntoView({ block: "center" });
        img.click();
        return { ok: true };
      })()`)).catch(() => ({ ok: false, why: "执行失败" }));
      await sleep(4000);
      // 合成点击有时不生效：用真鼠标在 + 的坐标再点一次
      const hasSearch = await p.eval(inF(/clfbx_simple/i, `return !!doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_TB_PRO");`)).catch(() => false);
      if (hasSearch !== true) {
        const box = await p.eval(inF(/clfbx_simple/i, `(() => {
          const img = [...doc.querySelectorAll("img[id*=Img_ZSDD],input[id*=Img_ZSDD]")][0];
          if (!img) return null;
          img.scrollIntoView({ block: "center" });
          const r = img.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`)).catch(() => null);
        if (box) {
          await p.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }).catch(() => {});
          await sleep(120);
          await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }).catch(() => {});
          await sleep(4000);
        }
      }
      if (openedDlg && openedDlg.ok) {
        await p.eval(inF(/clfbx_simple/i, `(() => {
          const e = doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_TB_PRO"); if (e) e.value = ${JSON.stringify(PROV)};
          const b = doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_BT_DQJS"); if (b) b.click();
          return true;
        })()`)).catch(() => false);
        await sleep(5000);
        // 1) 定位命中行（含目的地城市，退到「其他地区」），取复选框的 ctl 序号与坐标
        const hitRow = await p.eval(inF(/clfbx_simple/i, `(() => {
          const want = ${JSON.stringify(CITY)};
          const rows = [...doc.querySelectorAll("tr")].filter((tr) => /NHZSBT_GV_DQJS_ctl\\d+_Chk_Is/.test(tr.innerHTML || ""));
          const hit = rows.find((tr) => (tr.innerText || "").includes(want)) || rows.find((tr) => (tr.innerText || "").includes("其他地区"));
          if (!hit) return { ok: false, why: "检索结果没有 " + want, rows: rows.length };
          const cb = hit.querySelector("input[type=checkbox]");
          if (!cb) return { ok: false, why: "没有复选框" };
          const m = (cb.id || "").match(/_ctl(\\d+)_/);
          cb.scrollIntoView({ block: "center" });
          const r = cb.getBoundingClientRect();
          return { ok: true, ctl: m ? m[1] : null, checked: cb.checked,
                   x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`)).catch((e) => ({ ok: false, why: e.message }));

        if (!hitRow.ok) {
          say("住宿明细·地点", false, hitRow.why);
        } else {
          // 2) 勾选会触发 __doPostBack：必须真鼠标点（合成 click 不触发回发），
          //    而且「住宿地点（城市名）」输入框是回发之后才由服务端渲染出来的 —— 必须分两步
          const CX = Math.round((Number(OFF.dx) || 0) + hitRow.x);
          const CY = Math.round((Number(OFF.dy) || 0) + hitRow.y);
          await p.send("Input.dispatchMouseEvent", { type: "mousePressed", x: CX, y: CY, button: "left", clickCount: 1, buttons: 1 }).catch(() => {});
          await sleep(120);
          await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: CX, y: CY, button: "left", clickCount: 1, buttons: 0 }).catch(() => {});
          await sleep(6000);

          // 3) 回发后填写「住宿地点（城市名）」
          const placeBox = await p.eval(inF(/clfbx_simple/i, `(() => {
            const ctl = ${JSON.stringify(hitRow.ctl)};
            const cb = ctl ? doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_GV_DQJS_ctl" + ctl + "_Chk_Is") : null;
            const inp = ctl ? doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_GV_DQJS_ctl" + ctl + "_TB_ZSDDQR") : null;
            if (!inp) return { ok: false, checked: cb ? cb.checked : null, why: "回发后没出现住宿地点输入框" };
            inp.scrollIntoView({ block: "center" });
            const r = inp.getBoundingClientRect();
            return { ok: true, checked: cb ? cb.checked : true,
                     x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })()`)).catch((e) => ({ ok: false, why: e.message }));

          if (!placeBox.ok) {
            say("住宿明细·地点", false, placeBox.why);
          } else {
            const IX = Math.round((Number(OFF.dx) || 0) + placeBox.x);
            const IY = Math.round((Number(OFF.dy) || 0) + placeBox.y);
            await p.send("Input.dispatchMouseEvent", { type: "mousePressed", x: IX, y: IY, button: "left", clickCount: 1, buttons: 1 }).catch(() => {});
            await sleep(120);
            await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: IX, y: IY, button: "left", clickCount: 1, buttons: 0 }).catch(() => {});
            await sleep(200);
            await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }).catch(() => {});
            await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }).catch(() => {});
            await p.send("Input.insertText", { text: CITY }).catch(() => {});
            await sleep(300);
            const typed = await p.eval(inF(/clfbx_simple/i, `const el=doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_GV_DQJS_ctl" + ${JSON.stringify(hitRow.ctl)} + "_TB_ZSDDQR"); return el?el.value:null;`)).catch(() => null);
            const placeOk = String(typed || "").trim() === CITY;
            say("住宿明细·地点", placeOk && placeBox.checked !== false,
              placeOk ? `已勾选 ${CITY} 并填入住宿地点` : `住宿地点没写进去（当前「${typed}」）`);
            // 4) 填写成功才点「保存并返回上一页」
            if (placeOk) {
              await p.eval(inF(/clfbx_simple/i, `const s=doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_BT_BCDQ2"); if(s) s.click(); return !!s;`)).catch(() => false);
              await sleep(6000);
            }
          }
        }
      } else {
        say("住宿明细·地点", false, (openedDlg && openedDlg.why) || "没找到绿色 + 按钮");
        await sleep(4000);
      }
      // 6.6.8 保存地区后系统会把工号清掉 → 补工号（真键入 + Tab 触发校验，让它带出姓名），否则报“员工编号不存在”
      {
        let who = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          const ygBox = await p.eval(inF(/clfbx_simple/i, `const el=doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_GV_ZSBT_ctl02_TXT_YGBH");
            if(!el) return null; el.scrollIntoView({block:"center"});
            const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};`)).catch(() => null);
          if (!ygBox) break;
          const X = Math.round((Number(OFF.dx) || 0) + ygBox.x), Y = Math.round((Number(OFF.dy) || 0) + ygBox.y);
          await p.send("Input.dispatchMouseEvent", { type: "mousePressed", x: X, y: Y, button: "left", clickCount: 1, buttons: 1 }).catch(() => {});
          await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: X, y: Y, button: "left", clickCount: 1, buttons: 0 }).catch(() => {});
          await sleep(200);
          await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }).catch(() => {});
          await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }).catch(() => {});
          await p.send("Input.insertText", { text: String(user) }).catch(() => {});
          // Tab 失焦 → 系统按工号查人、带出姓名/职别（不 Tab 就一直空着）
          await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }).catch(() => {});
          await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }).catch(() => {});
          await sleep(3000);
          who = await p.eval(inF(/clfbx_simple/i, `const a=doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_GV_ZSBT_ctl02_TXT_YGBH");
            const b=doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_GV_ZSBT_ctl02_TB_XM");
            return {yg:a?a.value:null, xm:b?b.value:null};`)).catch(() => null);
          if (who && String(who.yg).trim() === String(user) && String(who.xm || "").trim()) break;
          await sleep(1000);
        }
        say("住宿明细·补工号", !!(who && String(who.yg).trim() === String(user) && String(who.xm || "").trim()), JSON.stringify(who || {}));
      }

      // 6.6.9 城市已保存 → 先填「淡季天数 / 发票张数」，住宿金额由系统按标准自动算出
      //   金额绝不手填：手填会把系统算出的 500 覆盖成确认页里的值（曾写成 499.99）
      const typeInto = async (suffix, val, label) => {
        let ok = false, cur = null;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          const box = await p.eval(inF(/clfbx_simple/i, `const el=doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_GV_ZSBT_ctl02_${suffix}");
            if(!el) return null; el.scrollIntoView({block:"center"});
            const r=el.getBoundingClientRect();
            return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};`)).catch(() => null);
          if (!box) { console.log(`   ! ${label} 找不到控件`); break; }
          const X = OFF.dx + box.x, Y = OFF.dy + box.y;
          await p.send("Input.dispatchMouseEvent", { type: "mousePressed", x: X, y: Y, button: "left", clickCount: 1, buttons: 1 }).catch(() => {});
          await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: X, y: Y, button: "left", clickCount: 1, buttons: 0 }).catch(() => {});
          await sleep(200);
          await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }).catch(() => {});
          await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }).catch(() => {});
          await p.send("Input.insertText", { text: String(val) }).catch(() => {});
          // Tab 让输入框失焦，触发系统 onchange 里的「住宿金额 = 标准 × 天数」重算
          await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }).catch(() => {});
          await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }).catch(() => {});
          await sleep(1800);
          cur = await p.eval(inF(/clfbx_simple/i, `const el=doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_GV_ZSBT_ctl02_${suffix}"); return el?el.value:null;`)).catch(() => null);
          ok = String(cur || "").trim() === String(val);
        }
        return { ok, cur };
      };

      const daysSet = await typeInto("TB_ZSTS_D", String(HD), "淡季天数");
      say("住宿明细·淡季天数", daysSet.ok, daysSet.ok ? `${HD} 天` : `写入失败（当前「${daysSet.cur}」）`);
      const invSet = await typeInto("TB_FPZS", String(HI), "发票张数");
      say("住宿明细·发票张数", invSet.ok, invSet.ok ? `${HI} 张` : `写入失败（当前「${invSet.cur}」）`);

      // 只读系统算出来的住宿金额，等它自己出现
      const readAmt = () => p.eval(inF(/clfbx_simple/i, `const el=doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_GV_ZSBT_ctl02_TB_ZSJE"); return el?String(el.value):null;`)).catch(() => null);
      let autoAmt = await readAmt();
      for (let i = 0; i < 10 && !(autoAmt && Number(autoAmt) > 0); i++) { await sleep(1000); autoAmt = await readAmt(); }

      if (cf.hotelMode === "invoice") {
        // 不包干：金额 = 票面合计，系统不替我们算，仍需手填
        if (HA > 0) {
          const amtSet = await typeInto("TB_ZSJE", HA.toFixed(2), "住宿金额");
          say("住宿明细·住宿金额", amtSet.ok, amtSet.ok ? `¥${HA.toFixed(2)}（不包干，按票面手填）` : `写入失败（当前「${amtSet.cur}」）`);
        } else {
          say("住宿明细·住宿金额", false, "不包干但确认页没给票面金额，先补上再跑");
        }
      } else {
        const got = autoAmt && Number(autoAmt) > 0 ? Number(autoAmt) : null;
        const want = Number(HA) > 0 ? Number(HA) : null;
        say("住宿明细·住宿金额", !!got,
          got
            ? `系统自动算出 ¥${got}（未手填${want && Math.abs(got - want) > 0.005 ? `；确认页填 ¥${want}，以系统标准为准` : ""}）`
            : "系统没算出金额（检查淡季天数 / 住宿城市 / 包干是否已生效）");
      }


      // 保存住宿明细
      const chk = await p.eval(inF(/clfbx_simple/i, `(() => {
        const rows = [...doc.querySelectorAll("tr")].filter((tr) => /NHZSBT_GV_ZSBT_ctl\\d+_TXT_YGBH/.test(tr.innerHTML || ""));
        const row = rows.find((tr) => ((tr.querySelector("input[id*=TXT_YGBH]") || {}).value || "").trim() === ${JSON.stringify(String(user))}) || rows[0];
        if (!row) return { ok: false, why: "找不到行" };
        const g = (sfx) => { const e = row.querySelector("input[id*='" + sfx + "']"); return e ? e.value : ""; };
        const place = (row.innerText || "").replace(/\\s+/g, " ").trim();
        return { ok: true, d: g("TB_ZSTS_D"), f: g("TB_FPZS"), j: g("TB_ZSJE"),
                 zg: g("TXT_YGBH"), xm: g("TB_XM"), place };
      })()`)).catch(() => null);
      if (chk && chk.ok) {
        const miss = [];
        if (!chk.zg) miss.push("工号");
        if (!chk.xm) miss.push("姓名");
        if (String(chk.d) === "") miss.push("淡季天数");
        if (String(chk.f) === "") miss.push("发票张数");
        if (String(chk.j) === "" || Number(chk.j) === 0) miss.push("住宿金额（系统未自动算出）");
        say("住宿明细·完整性", miss.length === 0,
            miss.length ? `缺：${miss.join("、")}（行内容：${chk.place.slice(0, 40)}）` : `工号 ${chk.zg} / ${chk.d} 天 / ${chk.f} 张 / ¥${chk.j}`);
      }

      // 住宿地点
      await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_BTN_CLOSE"); if(b){b.click(); return true;} return false;`)).catch(() => false);
      await sleep(6000);
      filledNow = await hotelFilled();
      if (!filledNow || !filledNow.ok) {
        // 自动保存没生效 → 让用户点一下，脚本继续等
        console.log("\n⏸  住宿明细已填好，但系统没接受自动保存。");
        console.log("   请在页面上点一次【保存并返回上一页】，我会自动继续（最多等 5 分钟）。");
        try { await p.bringToFront(); } catch {}
        try { await p.banner("⏸ 请点一次【保存并返回上一页】，我自动继续", { color: "#f59e0b", pulse: true }); } catch {}
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline) {
          await sleep(3000);
          const h = await hotelFilled();
          if (h && h.ok) { filledNow = h; break; }
        }
      }
      say("住宿明细·保存", !!(filledNow && filledNow.ok), (filledNow && filledNow.text) || "仍未保存");

      // 判据（用户确认）：住宿明细填对后，「住宿费是否包干」下拉会被系统锁定（disabled=true）
      const bgLocked = await p.eval(inF(/clfbx_simple/i, `const s=doc.getElementById("ctl00_ContentPlaceHolder1_DDL_SFBG");
        return s ? { ok:true, disabled:!!s.disabled, text: s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : "" } : { ok:false };`)).catch(() => ({ ok: false }));
      say("住宿明细·包干锁定", !!(bgLocked && bgLocked.ok && bgLocked.disabled),
        bgLocked && bgLocked.ok
          ? (bgLocked.disabled ? `已锁定（${bgLocked.text}）= 住宿明细已生效` : `仍可选（${bgLocked.text}）→ 住宿明细没填对`)
          : "读不到包干下拉");
    }
    await setSfbg();   // 回发后包干选项再设一次
    await verifyCore("住宿明细后");
  }
}


// 7 票夹：先打开选票面板，"可用发票合计"才会出现；文件框不是常驻的，要确认存在
const pickerOpen = () => p.eval(inF(/clfbx_simple/i, `
  return !!(doc.getElementById("ctl00_ContentPlaceHolder1_BT_QR0") &&
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

const NEED = air.length + carAttach.length + hotelAttach.length;
if (NEED === 0) {
  say("票夹", true, "没有要挂的发票（全部按补助走），跳过票夹");
} else {
const walletRow = (await rowCtlByLabel("飞机")) || "GV_CLF_ctl02";
  const opened = await openPicker(walletRow);
say("打开选票面板", opened, opened ? "ok" : "失败");
let wallet = opened ? await walletCount() : -1;
console.log("   票夹现有:", wallet);

// 票夹里可能已有旧草稿释放出来的票 —— 只补传「还没有的那几张」，
// 否则会把已有的票再传一遍（实测出现过 6 张变 8 张）
const haveNow = new Set(await p.eval(inF(/clfbx_simple/i, `(() => [...doc.querySelectorAll("tr")]
  .filter((tr) => tr.querySelectorAll("td").length >= 5 && /\\d{20}/.test(tr.innerHTML || ""))
  .map((tr) => (tr.innerHTML.match(/\\b\\d{20}\\b/) || [])[0]).filter(Boolean))()`)).catch(() => []) || []);
const needFiles = [...air, ...carAttach, ...hotelAttach]
  .filter((i) => i.number && !haveNow.has(String(i.number)))
  .map((i) => i.file);
const UPLOAD = needFiles.map((f) => join(RAW, f));
console.log(`   票夹里读到 ${haveNow.size} 张，需要补传 ${UPLOAD.length} 张`);

if (UPLOAD.length > 0) {
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
        await p.send("DOM.setFileInputFiles", { files: UPLOAD, backendNodeId: chooser.params.backendNodeId });
        console.log("   已通过文件选择器塞入", UPLOAD.length, "个文件");
      } else {
        const { result } = await p.send("Runtime.evaluate", { expression: `(() => { const w=${F(/clfbx_simple/i)}; return w.document.querySelector(".layui-upload-drag input[type=file]") || w.document.querySelector("input[type=file]"); })()` });
        if (result.objectId) {
          await p.send("DOM.setFileInputFiles", { files: UPLOAD, objectId: result.objectId });
          await p.eval(inF(/clfbx_simple/i, `const i=doc.querySelector("input[type=file]"); i.dispatchEvent(new Event("change",{bubbles:true})); return true;`));
        }
      }
      await sleep(2000);
      for (let i = 0; i < 40; i++) {
        await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("testListAction"); if(b) b.click();`)).catch(() => {});
        await sleep(4000);
        const st = await p.eval(inF(/clfbx_simple/i, `const it=[...doc.querySelectorAll("[id^=upload-]")];
          return {done: it.filter(e=>/成功/.test(e.innerText||"")).length, all: it.length};`));
        if (st.done >= UPLOAD.length) break;
      }
      await p.eval(inF(/clfbx_simple/i, `[...doc.querySelectorAll(".layui-layer-close")].forEach(x=>x.click()); return true;`));
      await sleep(1500);
    } catch (e) {
      say("上传", false, String(e).slice(0, 60));
    }
  }
  await closePicker();
  const upRow = (await rowCtlByLabel("飞机")) || "GV_CLF_ctl02";
  await openPicker(upRow);
  wallet = await walletCount();
  console.log("   上传后票夹:", wallet);
  say("上传", wallet >= NEED, `票夹可用 ${wallet} 张`);
}
if (wallet < NEED) {
  // 等用户点一次【开始上传】（系统只认真人点击）；最多等 8 分钟
  console.log(`\n⏸  票夹可用 ${wallet} 张，需要 ${NEED} 张。`);
  console.log("   6 个发票文件已放入上传队列 → 请在浏览器里点一次【开始上传】，我自动继续。");
  try { await p.bringToFront(); } catch {}
  try { await p.banner("⏸ 请点一次【开始上传】，我自动继续", { color: "#f59e0b", pulse: true }); } catch {}
  const deadline = Date.now() + 8 * 60_000;
  let filledOk = false;
  while (Date.now() < deadline) {
    await sleep(4000);
    const w2 = await p.eval(inF(/clfbx_simple/i, `(() => { const t=(doc.body.innerText||"").replace(/\\s+/g," "); const m=t.match(/可用发票合计[：:]\\s*(\\d+)/); return m?Number(m[1]):-1; })()`)).catch(() => -1);
    if (Number(w2) >= NEED) { wallet = Number(w2); filledOk = true; break; }
  }
  if (!filledOk) {
    say("票夹可用不足", false, `等了 8 分钟仍不足（当前 ${wallet} 张）`);
    await p.bringToFront().catch(() => {});
    process.exit(3);
  }
  say("上传", true, `票夹可用 ${wallet} 张`);
}
if (false) {
  say("票夹可用不足", false, `可用 ${wallet} 张，需要 ${NEED} 张。`);
  await p.bringToFront();
  await p.banner(`⚠️ 需要你处理：票夹可用 ${wallet} 张，不足 ${NEED} 张。请先删除占用发票的草稿单据，或手动拖入发票。`, { color: "#dc2626", pulse: false });
  await closePicker();
  process.exit(3);
}
await closePicker();
}

// 7.9 先保存一次（实测：不保存，机票行的【行程单】按钮点了没反应）
await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_BT_SAVE"); if(b){b.click(); return true;} return false;`)).catch(() => false);
await sleep(10000);
say("保存(挂票后)", true, "已保存，准备挂行程单");

// 8 行程单（每段一行）
if (air.length) {
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
             (()=>{ const pb=doc.getElementById(id("DDL_PB")); if(pb){ const o=[...pb.options].find(x=>x.text.trim()===${JSON.stringify(s.pb)}); if(o){ pb.value=o.value; pb.dispatchEvent(new Event("change",{bubbles:true})); } } else { f("TXT_PB",${JSON.stringify(s.pb)}); } return true; })() &&
f("TXT_DJ",${JSON.stringify(s.dj)}) && f("TXT_ZS","1");`));
    idx++;
  }
  await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_MXCL_BTN_CLOSE"); if(b) b.click();`));
  await sleep(8000);
  say("行程单", true, `${segs.length} 段`);
} else {
  say("行程单", true, "没有机票，跳过");
}

// 9 挂票
// 按行名找行控件（机票/汽车/住宿费的行号会变，不能写死 ctl04）
async function rowCtlByLabel(label) {
  // 以「选择票据」按钮所在行为准，读该行文字里有没有这个类别名（交通费是 rowspan，cells 不可靠）
  const r = await p.eval(inF(/clfbx_simple/i, `(() => {
    const want = ${JSON.stringify(label)};
    const btns = [...doc.querySelectorAll("input[id*=BTN_XZFP]")];
    const found = [];
    for (const b of btns) {
      const tr = b.closest("tr");
      if (!tr) continue;
      const t = (tr.innerText || "").replace(/\\s+/g, " ").trim();
      const m = (b.id || "").match(/(GV_CLF_ctl\\d+)/);
      found.push({ ctl: m ? m[1] : "", text: t.slice(0, 20) });
    }
    const hit = found.find((x) => x.ctl && x.text.startsWith(want)) ||
                found.find((x) => x.ctl && x.text.includes(want) && !x.text.includes("火车") && !x.text.includes("飞机"));
    return hit ? hit.ctl : { list: found.map((x) => x.ctl + ":" + x.text) };
  })()`)).catch(() => null);
  if (typeof r === "string") return r;
  if (r && r.list) console.log("   行控件清单:", JSON.stringify(r.list));
  return null;
}

async function pick(rowCtl, keep, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_${rowCtl}_BTN_XZFP"); if(b) b.click(); return !!b;`)).catch(() => false);
    await sleep(6000);

    const info = await p.eval(inF(/clfbx_simple/i, `(() => {
      const keep = ${JSON.stringify(keep)};
      const rows = [...doc.querySelectorAll("tr")].filter((tr) => tr.querySelectorAll("td").length >= 5 && /\\d{20}/.test(tr.innerHTML || ""));
      let clicked = 0; const seen = new Set();
      for (const tr of rows) {
        const cb = tr.querySelector("input[type=checkbox]");
        if (!cb) continue;
        const num = (tr.innerHTML.match(/\\b\\d{20}\\b/) || [])[0];
        if (!num) continue;
        const want = keep.includes(num) && !seen.has(num);
        if (want) { seen.add(num); if (!cb.checked) { cb.click(); clicked++; } }
      }
      return { rows: rows.length, matched: seen.size, clicked };
    })()`)).catch(() => null);

    await sleep(1200);
    await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_BT_QR0"); if(b) b.click(); return !!b;`)).catch(() => false);
    await sleep(7000);
    const v = await p.eval(inF(/clfbx_simple/i, `const g=id=>{const e=doc.getElementById("ctl00_ContentPlaceHolder1_"+id); return e?e.value:null};
      return {zs:g("${rowCtl}_TXT_DZFPZS"), je:g("${rowCtl}_TXT_DZFPJE")};`)).catch(() => null);
    const ok = v && String(v.zs) === String(keep.length);
    if (ok) { say(label, true, JSON.stringify(v)); return true; }
    console.log(`   ! ${label} 第 ${attempt} 次没挂上（票夹行 ${info ? info.rows : "?"}，匹配 ${info ? info.matched : "?"}，页面 ${JSON.stringify(v)}）`);
    await sleep(3000);
  }
  say(label, false, "3 次都没挂上");
  return false;
}
// 行号优先按行名找（不同用户/不同模块行数可能不同），找不到再退回实测号
const airRow = (await rowCtlByLabel("飞机")) || "GV_CLF_ctl02";
if (air.length) await pick(airRow, air.map((i) => i.number), "挂机票");
// 汽车类（网约车/出租车/大巴…一律按「汽车」）：>80/天 的那几天把票挂到「汽车」行；
// ≤80/天 的那几天不交票，改为在「市内交通补助」里填天数领 80 元/天
const carRow = (await rowCtlByLabel("汽车")) || "GV_CLF_ctl04";
console.log(`   汽车票挂到「汽车」行：${carRow}`);
if (carAttach.length) await pick(carRow, carAttach.map((i) => i.number), "挂汽车票");
else say("挂汽车票", true, "每天都不超 80，全部领补助，不交票");

// 9.5 住宿：把住宿票挂到住宿行（天数/金额已在「住宿明细」里按确认页填过）
if (hotelAttach.length) {
  const rowCtl = await p.eval(inF(/clfbx_simple/i, `
    const btn = [...doc.querySelectorAll("input[id*='BTN_XZFP']")].find((b) => {
      const tr = b.closest("tr"); return tr && /住宿/.test(tr.innerText || "");
    });
    if (!btn) return null;
    const m = (btn.id || "").match(/(GV_CLF_ctl\\d+)/);
    return m ? m[1] : null;`));
  const nights = hotelInv.reduce((s, i) => s + (i.nights || i.qty || 0), 0);
  if (rowCtl) {
    await pick(rowCtl, hotelInv.map((i) => i.number), "挂住宿票");
    say("住宿", true, `${hotelInv.length} 张票 / 票面 ${nights} 晚（天数金额以住宿明细为准）`);
  } else {
    say("住宿", false, "有住宿发票但没找到「住宿」行，需人工确认");
  }
} else if (hotelInv.length) {
  say("住宿", true, "确认页住宿金额为 0，住宿票不挂");
} else {
  say("住宿", true, "无住宿发票");
}

// 9.7 市内交通补助：领补助的天数 × 80 × 人数（实报的天已交票，不再领当天补助）
if (TP.ok && TP.subsidyDays > 0) {
  const fill = await p.eval(inF(/clfbx_simple/i, `(() => {
    const tr=[...doc.querySelectorAll("tr")].find(t=>((t.cells&&t.cells[1]&&t.cells[1].innerText)||"").trim().includes("市内交通补助"));
    if(!tr) return {ok:false, why:"找不到市内交通补助行"};
    const ins=[...tr.querySelectorAll("input")].filter(e=>!/hidden|checkbox|radio|button|submit/.test(e.type));
    if(ins.length<2) return {ok:false, why:"行内输入框不足"};
    const set=(e,v)=>{e.value=v; e.dispatchEvent(new Event("change",{bubbles:true})); e.dispatchEvent(new Event("blur",{bubbles:true}));};
    set(ins[0], ${JSON.stringify(String(TP.persons))});
    set(ins[1], ${JSON.stringify(String(TP.subsidyDays))});
    return {ok:true, ids:ins.map(e=>e.id)}; })()`)).catch(() => ({ ok: false, why: "脚本异常" }));
  await sleep(3000);
  const got = await p.eval(inF(/clfbx_simple/i, `(() => {
    const tr=[...doc.querySelectorAll("tr")].find(t=>((t.cells&&t.cells[1]&&t.cells[1].innerText)||"").trim().includes("市内交通补助"));
    if(!tr) return null;
    const ins=[...tr.querySelectorAll("input")].filter(e=>!/hidden|checkbox|radio|button|submit/.test(e.type));
    const cells=[...tr.querySelectorAll("td")];
    const inp=cells[cells.length-1].querySelector("input");
    return { rs: ins[0] ? ins[0].value : null, ts: ins[1] ? ins[1].value : null,
             amt: inp ? inp.value : cells[cells.length-1].innerText.trim() }; })()`)).catch(() => null);
  const ok = !!fill.ok && got != null
    && Math.abs(Number(got.amt) - TP.subsidyAmount) < 0.01
    && String(got.rs) === String(TP.persons)
    && String(got.ts) === String(TP.subsidyDays);
  say("市内交通补助", ok,
    `${TP.subsidyDays} 天 × ¥80 × ${TP.persons} 人 = ¥${TP.subsidyAmount}；页面 人数=${got && got.rs} 天数=${got && got.ts} 实报=${got && got.amt}${fill.ok ? "" : "（" + fill.why + "）"}`);
  await p.screenshot(join(D, "city_transport.png")).catch(() => {});
} else if (TP.ok) {
  say("市内交通补助", true, "每天网约车都超 80，全部交票实报，补助填 0");
}

// 9.9 保存前核对：机票 / 汽车 / 住宿费 三行的张数和金额
const rowsSnapshot = () => p.eval(inF(/clfbx_simple/i, `(() => {
  const out = {};
  const g = (id) => { const e = doc.getElementById("ctl00_ContentPlaceHolder1_" + id); return e ? e.value : null; };
  out.air = { zs: g("GV_CLF_ctl02_TXT_DZFPZS"), je: g("GV_CLF_ctl02_TXT_DZFPJE") };
  out.car = { zs: g("GV_CLF_ctl03_TXT_DZFPZS"), je: g("GV_CLF_ctl03_TXT_DZFPJE") };
  out.car4 = { zs: g("GV_CLF_ctl04_TXT_DZFPZS"), je: g("GV_CLF_ctl04_TXT_DZFPJE") };
  const tr = [...doc.querySelectorAll("tr")].find((t) => {
    const x = (t.innerText || "").replace(/\s+/g, "");
    return x.startsWith("住宿费") || (x.includes("住宿费") && x.includes("选择票据") && !x.includes("是否包干"));
  });
  out.hotel = tr ? (tr.innerText || "").replace(/\s+/g, " ").slice(0, 50) : null;
  return out;
})()`)).catch(() => null);

let snap = await rowsSnapshot();
console.log("   保存前明细:", JSON.stringify(snap));

// 汽车票如果没挂上，再挂一次
const carOk = snap && ((snap.car4 && Number(snap.car4.zs) === carAttach.length) || (snap.car && Number(snap.car.zs) === carAttach.length));
if (carAttach.length && !carOk) {
  console.log("   ! 汽车票数量不对，重挂一次");
  await pick("GV_CLF_ctl04", carAttach.map((i) => i.number), "挂网约车");
  snap = await rowsSnapshot();
  console.log("   重挂后:", JSON.stringify(snap));
}

// 9.95 出差地点由住宿明细自动带出。只有被清空时才兜底写一次，否则保持系统值
const ddCur = await p.eval(inF(/clfbx_simple/i, `const el=doc.getElementById("ctl00_ContentPlaceHolder1_Txt_DDd"); return el?String(el.value||"").trim():null;`)).catch(() => null);
if (!ddCur) {
  const dd2 = await p.eval(inF(/clfbx_simple/i, `const el=doc.getElementById("ctl00_ContentPlaceHolder1_Txt_DDd");
    if(!el) return {ok:false}; el.disabled=false; el.value=${JSON.stringify(CITIES)};
    el.dispatchEvent(new Event("change",{bubbles:true})); return {ok:true, v:el.value};`)).catch(() => ({ ok: false }));
  say("出差地点(补)", !!(dd2 && dd2.ok), (dd2 && dd2.v) || "没写进去");
} else {
  console.log(`   出差地点（系统带出）：${ddCur}`);
}

await verifyAll("保存前");
  await guard("保存前");

// 10 保存（只一次）
await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_BT_SAVE"); if(b) b.click();`));
await sleep(10000);
await p.screenshot(join(D, "fill_saved.png")).catch(() => {});
say("保存", true, "见 finance_recon/fill_saved.png");

// 保存后系统可能把页面退回列表：自动重新打开这张单据，保证「一站到底」不中断
const backToList = await p.eval(`(() => {
  const w = window.frames["mainframe"];
  const u = w ? w.location.href : location.href;
  return /clfbx_simple\.aspx/i.test(u) && /page=CL/i.test(u);
})()`).catch(() => false);
if (backToList) {
  // 先看列表里这张单的实际金额；对不上说明保存被系统拒了，不要再往下走
  const listed = await p.eval(inF(/clfbx_simple/i, `(() => {
    const rows = [...doc.querySelectorAll("tr")].map((tr) => (tr.innerText || "").replace(/\\s+/g, " ").trim()).filter((t) => /CL\\d{10,}/.test(t));
    return rows.slice(0, 3);
  })()`)).catch(() => null);
  console.log("   列表里的草稿:", JSON.stringify(listed));
  const expectTotal = Number(AIR_TOTAL || 0) + Number(CAR_TOTAL || 0) + Number(HA || 0);
  const matched = (listed || []).find((t) => t.includes(PROJECT));
  const shown = matched ? Number(String((matched.match(/¥([\\d,\\.]+)/) || [0, "0"])[1]).replace(/,/g, "")) : 0;
  if (matched && shown > 0 && Math.abs(shown - expectTotal) > 0.5) {
    say("保存结果", false, `系统保存的金额是 ¥${shown}，应为 ¥${expectTotal.toFixed(2)}（说明有的票没挂上）`);
    console.log("\n❌ 保存的数据不完整，已停在这里，不再往下点。请回浏览器核对后再继续。");
    await p.bringToFront().catch(() => {});
    await p.banner(`⚠️ 保存金额 ¥${shown}，应为 ¥${expectTotal.toFixed(2)}`, { color: "#dc2626", pulse: false }).catch(() => {});
    process.exit(8);
  }
  say("继续", true, "系统把页面退回列表 → 自动打开刚保存的单据接着走");
  await p.eval(inF(/clfbx_simple/i, `const a=[...doc.querySelectorAll("a")].find(x=>(x.innerText||"").trim()==="修改"); if(a) a.click(); return !!a;`)).catch(() => false);
  await sleep(9000);
  await type(/xmjbxx/i, "TB_BXR", user);
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" }).catch(() => {});
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }).catch(() => {});
  await sleep(4000);
  await p.eval(inF(/xmjbxx/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_BT_NEW_NR1"); if(b) b.click(); return !!b;`)).catch(() => false);
  await sleep(12000);
}

await guard("进支付方式前");

// 11 下一步（支付方式）—— 必须真鼠标点：合成 click 不触发回发（实测，会一直停在明细页）
if (!(await realClickId("Btn_xmzffs"))) {
  console.log("   ! 没找到「下一步（支付方式）」按钮");
}
await sleep(10000);
await p.screenshot(join(D, "fill_payment.png")).catch(() => {});
// 必须回读确认真的到了支付方式页，不能盲报成功
const after = await p.eval(`(() => {
  const w = window.frames["mainframe"];
  return { url: w ? w.location.href : location.href,
           text: (w ? w.document.body.innerText : (document.body.innerText || "")).replace(/\\s+/g, " ").slice(0, 200) };
})()`).catch(() => ({ url: "", text: "" }));
if (!/ZFFS/i.test(after.url)) {
  const hint = await p.eval(`(() => {
    const w = window.frames["mainframe"];
    const t = w ? (w.document.body.innerText || "") : (document.body.innerText || "");
    const m = t.match(/(请填写[^。！\\n]{2,20}|请您[^。！\\n]{2,30}|[^。！\\n]{0,8}不能为空)/);
    return m ? m[1] : "";
  })()`).catch(() => "");
  say("进支付方式", false, `停在 ${after.url.slice(0, 55)}${hint ? "；系统提示：" + hint : ""}`);
  console.log("\n=== 汇总 ===");
  for (const [o, k, m] of log) console.log(`${o ? "✅" : "❌"} ${k}: ${m}`);
  console.log("\n⚠️ 没到支付方式页 = 系统校验没通过（常见：住宿明细未填、姓名空、票未挂）。");
  await p.bringToFront();
  await p.banner(`⚠️ 没进支付方式：${hint || "系统校验未通过"}`, { color: "#dc2626", pulse: false });
  process.exit(4);
}
say("进支付方式", true, after.url.slice(0, 70));

// 12 支付方式：对私支付 → 本人 → 金额=差额 → 新增（差额归零）
const payStep = await p.eval(inF(/ZFFS/i, `(() => {
  const d = doc;
  const txt = (d.body.innerText || "").replace(/\\s+/g, " ");
  const m = txt.match(/差额[：:]\\s*¥?\\s*([\\d.]+)/);
  const diff = m ? m[1] : "";
  // 对私支付那一行
  const rows = [...d.querySelectorAll("tr")];
  const row = rows.find((tr) => /网银对私|对私支付/.test(tr.innerText || ""));
  if (!row) return { ok: false, why: "没找到对私支付行", diff };
  // 支付方式下拉：选“网银对私（校内）”（实测 id: GV_WYDSXN_ctl02_drop_zffsds）
  const sel = d.getElementById("ctl00_ContentPlaceHolder1_GV_WYDSXN_ctl02_drop_zffsds") || row.querySelector("select");
  if (sel) {
    const o = [...sel.options].find((x) => /网银对私/.test(x.text) && /校内/.test(x.text)) ||
              [...sel.options].find((x) => /网银对私/.test(x.text));
    if (o) { sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
  }
  // 人员：本人
  const radio = d.getElementById("ctl00_ContentPlaceHolder1_GV_WYDSXN_ctl02_rad_wszf_0") || [...row.querySelectorAll("input[type=radio]")].find((r) => /rad_wszf/.test(r.id) && /_0$/.test(r.id));
  if (radio && !radio.checked) radio.click();
  // 金额
  const money = d.getElementById("ctl00_ContentPlaceHolder1_GV_WYDSXN_ctl02_Txt_WYDSXNDJE") || [...row.querySelectorAll("input[type=text]")].find((i) => /JE|Money|金额/i.test(i.id || ""));
  if (money && diff) { money.value = diff; money.dispatchEvent(new Event("input", { bubbles: true })); money.dispatchEvent(new Event("change", { bubbles: true })); }
  // 新增
  const add = d.getElementById("ctl00_ContentPlaceHolder1_GV_WYDSXN_ctl02_Btn_XZWYDSXN") || [...row.querySelectorAll("input[type=image],input[type=button],a")].find((e) => /新增|add|Add/.test((e.value || e.title || e.alt || "")));
  if (add) add.click();
  return { ok: !!(sel && radio), diff, moneyId: money ? money.id : "", add: !!add };
})()`)).catch((e) => ({ ok: false, why: e.message }));

await sleep(6000);
const diffAfter = await p.eval(inF(/ZFFS/i, `(() => {
  const t = (doc.body.innerText || "").replace(/\\s+/g, " ");
  const m = t.match(/差额[：:]\\s*¥?\\s*([\\d.]+)/);
  return m ? m[1] : "";
})()`)).catch(() => "");
const payOk = payStep.ok && Number(diffAfter || 1) === 0;
say("支付方式", payOk, `差额 ${payStep.diff || "?"} → ${diffAfter || "?"}${payStep.why ? "（" + payStep.why + "）" : ""}`);

if (!payOk) {
  console.log("\n=== 汇总 ===");
  for (const [o, k, m] of log) console.log(`${o ? "✅" : "❌"} ${k}: ${m}`);
  console.log("\n⚠️ 支付方式没自动填成（差额未归零），请在页面上手动：对私支付 → 本人 → 金额 → 新增。");
  await p.bringToFront();
  await p.banner(`⚠️ 支付方式需人工：差额 ${payStep.diff} → ${diffAfter}`, { color: "#dc2626", pulse: false });
  process.exit(5);
}

// 13 提交线上审批 → 审批单（最后一击由用户点）
const submitted = await p.eval(inF(/ZFFS/i, `(() => {
  const b = doc.getElementById("ctl00_ContentPlaceHolder1_Btn_Save3") ||
            [...doc.querySelectorAll("input[type=submit],input[type=button]")].find((e) => /提交线上审批/.test(e.value || ""));
  if (!b) return false;
  b.click(); return true;
})()`)).catch(() => false);
await sleep(12000);

const approval = await p.eval(`(() => {
  const pages = [];
  try { pages.push(location.href); } catch (e) {}
  return pages.join(" ");
})()`).catch(() => "");
say("提交线上审批", !!submitted, submitted ? "已点（弹窗后需在审批单页操作）" : "没找到按钮");

// 12.5 审批单：审批流程加「审核人（= 确认页里的担保人/审核人工号）」
const apNo = String((cf.approvers && cf.approvers[0] && cf.approvers[0].no) || "").trim();
// 审批单可能开在新标签页；下面会自动切到审批单标签
try {
  if (apNo) {
    await sleep(4000);
    // 切到审批单标签
    const pages = await p.browser.listPages().catch(() => []);
    const sp = pages.find((x) => /SP_Rcbx_Sp/i.test(x.url || ""));
    let target = p;
    if (sp && !/SP_Rcbx_Sp/i.test(await p.eval(`location.href`).catch(() => ""))) {
      target = await p.browser.attachExisting((t) => /SP_Rcbx_Sp/i.test(t.url || ""));
    }
    if (target) {
      await target.eval(`(() => { const b=document.getElementById("ctl00_ContentPlaceHolder1_Btn_EdktLc"); if(b) b.click(); return !!b; })()`).catch(() => false);
      await sleep(8000);
      const filled = await target.eval(`(() => {
        const e=document.getElementById("ctl00_ContentPlaceHolder1_Gv_EditLc_ctl02_Txt_ygbh");
        if(!e) return null;
        e.focus(); e.value=${JSON.stringify(apNo)};
        e.dispatchEvent(new Event("change",{bubbles:true}));
        return e.value;
      })()`).catch(() => null);
      await sleep(3000);
      const saved = await target.eval(`(() => { const b=document.getElementById("ctl00_ContentPlaceHolder1_Btn_SaveLc"); if(b){b.click(); return true;} return false; })()`).catch(() => false);
      await sleep(8000);
      const rows = await target.eval(`(() => [...document.querySelectorAll("tr")].map((tr)=>(tr.innerText||"").replace(/\\s+/g," ").trim()).filter((x)=>/审核人|项目负责人|担保人/.test(x) && x.length<60).slice(0,4))()`).catch(() => null);
      say("审批流程", Array.isArray(rows) && rows.some((r) => /审核人/.test(r) && r.includes(apNo)), `审核人 ${apNo}${filled ? "" : "（工号框没找到）"} ${JSON.stringify(rows || [])}`);
    } else {
      say("审批流程", false, "没找到审批单标签页（可能被浏览器拦截）");
    }
  } else {
    say("审批流程", false, "确认页没填审核人工号，跳过");
  }
} catch (e) {
  say("审批流程", false, String(e.message).slice(0, 60));
}

// 审批单备注：确认页填了就写进去（限 50 字）
if (cf.spbz) {
  await sleep(6000);
  try {
    const wrote = await p.eval(`(() => {
      const pages = [...document.querySelectorAll("textarea[id*=spbz]")];
      const el = document.getElementById("ctl00_ContentPlaceHolder1_txt_spbz") || pages[0];
      if (!el) return false;
      el.value = ${JSON.stringify(String(cf.spbz).slice(0, 50))};
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value;
    })()`).catch(() => null);
    if (wrote) say("审批单备注", true, String(wrote));
    else console.log("   ! 审批单备注没写进去（可能审批单在另一个标签页）");
  } catch {}
}

// 14 附件：发票以外的文件（行程单/通知书等）→ 交给 upload_attachments.mjs 上传并核对
//   幂等：已在单据里的跳过；只塞一批、只核对条数，多传/漏传都会报错退出；永不点确认提交
if (process.env.YWTB_SKIP_ATTACH !== "1") {
  console.log("\n▶ 上传附件（发票以外的文件）…");
  try {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "upload_attachments.mjs"), "--dir", RAW], {
      cwd: WORK,
      stdio: "inherit",
      env: { ...process.env, YWTB_WORKDIR: WORK, YWTB_PROFILE: PROFILE },
    });
    say("附件上传", r.status === 0, r.status === 0 ? "核对通过：无缺、无重复" : `返回 ${r.status}（看上面输出，脚本不会提交）`);
  } catch (e) {
    say("附件上传", false, String(e.message).slice(0, 60));
  }
}

await p.bringToFront();
await p.banner("🏁 已到审批单阶段 — 请核对金额/附件/担保人，最后自己点【确认提交审批】", { color: "#059669", pulse: false });
process.stdout.write("\x07");
console.log("\n下一步：审批单页核对金额、附件、担保人 → 你自己点【确认提交审批】。");

console.log("\n=== 汇总 ===");
for (const [o, k, m] of log) console.log(`${o ? "✅" : "❌"} ${k}: ${m}`);
console.log("\n下一步：在支付方式页选「对私支付/本人/金额」，最后一步由用户自己点提交。");
process.exit(0);
