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
import { ensureBrowser, Browser, sleep } from "./cdp.mjs";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
const D1 = dates[0], D2 = dates[dates.length - 1];
const SUM = ds.summary || {};
const AIR_TOTAL = SUM.air_total, CAR_TOTAL = SUM.car_total;
const PROJECT = cf.project, REASON = cf.reason, TITLE = cf.title;
const CITY_SEQ = [...new Set(trips.map((t) => t.city))].filter(Boolean);
// 出差地点：去掉出发城市（行程首段所在城市），保留目的地
const CITIES = (CITY_SEQ.length > 1 ? CITY_SEQ.slice(1) : CITY_SEQ).join("/");
const PDFS = air.concat(carAttach, hotelAttach).map((i) => i.file).map((f) => join(RAW, f));

console.log(`单据: ${air.length} 机票 ¥${AIR_TOTAL} + 网约车实报 ${carAttach.length}/${car.length} 张 ¥${CAR_TOTAL}`);
console.log(`市内交通: ${TP.ok ? TP.days.map((d) => `${d.date.slice(5)} ¥${d.amount}${d.mode === "subsidy" ? "补助" : "实报"}`).join(" / ") : TP.why}`);
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
await type(/xmjbxx/i, "TB_BXR", user);
await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await sleep(5000);

// 4 项目：点【选择经费】→ 在弹窗里点“编号完全等于项目号”的链接（实测唯一可靠的路径）
const projValue = () => p.eval(inF(/xmjbxx/i, `const e=doc.getElementById("ctl00_ContentPlaceHolder1_TB_XMBH"); return e?e.value:null;`));
await p.eval(inF(/xmjbxx/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_BT_XMXX1"); if(b) b.click(); return !!b;`));
await sleep(6000);
for (let attempt = 0; attempt < 3; attempt++) {
  const clicked = await p.eval(inF(/xmjbxx/i, `const a=[...doc.querySelectorAll("a")].find(x=>(x.innerText||"").trim()===${JSON.stringify(PROJECT)});
    if(a){ a.click(); return true; } return false;`));
  await sleep(5500);
  if (await projValue() === PROJECT) break;
  if (!clicked) { await sleep(3000); }        // 弹窗还没出来，等一会再找
}
const projAfter = await projValue();
say("选项目", projAfter === PROJECT, `${PROJECT}（页面显示 ${projAfter}）`);

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

// 6.5 住宿明细：城市 + 天数 + 金额（确认页里用户填的）；包干与否由系统按这三项判定，脚本不代选
const HD = Number(cf.hotelDays || 0), HA = Number(cf.hotelAmount || 0);
if (HD > 0 || HA > 0) {
  const CITY1 = (CITIES.split("/")[0] || "").trim();
  const opened = await p.eval(inF(/clfbx_simple/i, `
    const b=[...doc.querySelectorAll("input,button,a,span")]
      .find(e=>/^\\s*住宿明细\\s*$/.test((e.value||e.innerText||"").trim()));
    if(!b) return false; b.scrollIntoView({block:"center"}); b.click(); return true;`)).catch(() => false);
  await sleep(4500);
  const dlg = (await p.eval(inF(/clfbx_simple/i, `(() => {
    const vis=e=>!!e.offsetParent;
    const layers=[...doc.querySelectorAll("[class*=layui-layer],[class*=dialog],[class*=modal]")].filter(e=>vis(e)&&e.querySelector("table,select"));
    const L=layers[layers.length-1];
    if(!L) return {ok:false, why:"没有弹出住宿明细"};
    const sels=[...L.querySelectorAll("select")].filter(vis).map(s=>({id:s.id, opts:[...s.options].map(o=>o.text.trim())}));
    const ins=[...L.querySelectorAll("input")].filter(e=>vis(e)&&!/hidden|checkbox|radio|button|submit/.test(e.type))
      .map(i=>({id:i.id, v:i.value}));
    return {ok:true, sels, ins, html:L.outerHTML}; })()`)).catch(() => ({ ok: false, why: "读不到弹层" }))) || { ok: false, why: "弹层无返回" };

  if (!dlg.ok) {
    try {
      const cands = await p.eval(inF(/clfbx_simple/i, `(() => ( [...doc.querySelectorAll("input,button,a,span,td,img")]
        .filter(e=>/住宿/.test((e.value||e.innerText||"")+""))
        .map(e=>{ const r=e.getBoundingClientRect(); const tr=e.closest("tr");
          return { tag:e.tagName, id:e.id||"", txt:(e.value||e.innerText||"").trim().slice(0,20),
                   rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],
                   row: tr? (tr.innerText||"").replace(/\\s+/g," ").slice(0,40): "" }; }) ))()`));
      mkdirSync(D, { recursive: true });
      writeFileSync(join(D, "hotel_candidates.json"), JSON.stringify(cands, null, 1), "utf8");
      console.log("   住宿相关候选元素已存到 finance_recon/hotel_candidates.json（", (cands||[]).length, "个）");
    } catch {}
    say("住宿明细", false, `${dlg.why || "打不开"}（请手动点【住宿明细】填 ${CITY1} / ${HD} 天 / ¥${HA}）`);
  } else {
    try { mkdirSync(D, { recursive: true }); writeFileSync(join(D, "hotel_dialog_dom.html"), dlg.html || "", "utf8"); } catch {}
    console.log(`   住宿明细弹层：select ${dlg.sels.length} 个，输入框 ${dlg.ins.length} 个`);

    let filled = { a: false, b: false };
    if (dlg.sels.length === 1 && dlg.ins.length >= 2) {
      const sel = dlg.sels[0];
      filled = await p.eval(inF(/clfbx_simple/i, `
        const set=(id,v)=>{const e=id&&doc.getElementById(id); if(!e) return false;
          e.value=v; e.dispatchEvent(new Event("change",{bubbles:true})); e.dispatchEvent(new Event("blur",{bubbles:true})); return true;};
        const s=doc.getElementById(${JSON.stringify(sel.id)});
        if(s){ const o=[...s.options].find(x=>x.text.includes(${JSON.stringify(CITY1)})); if(o){ s.value=o.value; s.dispatchEvent(new Event("change",{bubbles:true})); } }
        return { a:set(${JSON.stringify(dlg.ins[0].id)}, ${JSON.stringify(String(HD))}),
                 b:set(${JSON.stringify(dlg.ins[1].id)}, ${JSON.stringify(HA.toFixed(2))}) };`)).catch(() => ({ a: false, b: false }));
    }
    await sleep(1200);
    // 只有确实填进去了才点保存；否则关掉弹层，不要拿空表单给系统保存
    const saved = (filled.a && filled.b) ? await p.eval(inF(/clfbx_simple/i, `(() => {
      const vis=e=>!!e.offsetParent;
      const L=[...doc.querySelectorAll("[class*=layui-layer],[class*=dialog],[class*=modal]")].filter(e=>vis(e)).pop();
      if(!L) return false;
      const btns=[...L.querySelectorAll("input,button,a,span")]
        .filter(e=>vis(e)&&/^\\s*(保存|确定|确认|提交|新增)\\s*$/.test((e.value||e.innerText||"").trim()));
      if(!btns.length) return false; btns[0].click(); return true; })()`)).catch(() => false) : false;
    await sleep(5000);
    // 关掉可能残留的弹层（没填成时也必须关，否则挡住后面的选票/行程单）
    await p.eval(inF(/clfbx_simple/i, `[...doc.querySelectorAll(".layui-layer-close")].forEach(x=>x.click()); return true;`)).catch(() => {});

    // 回读住宿费行的实报金额
    const got = await p.eval(inF(/clfbx_simple/i, `(() => {
      const tr=[...doc.querySelectorAll("tr")].find(t=>/^\\s*住宿费/.test(((t.cells&&t.cells[0]&&t.cells[0].innerText)||"").trim()));
      if(!tr) return null;
      const cells=[...tr.querySelectorAll("td")];
      const inp=cells[cells.length-1].querySelector("input");
      return inp?inp.value:cells[cells.length-1].innerText.trim(); })()`)).catch(() => null);
    say("住宿明细", got != null && Math.abs(Number(got) - HA) < 0.01,
      `填 ${CITY1} / ${HD} 天 / ¥${HA}${saved ? "" : "（未找到保存按钮）"} → 页面实报金额 ${got}`);
    await p.screenshot(join(D, "hotel_detail.png"));
  }
}
// 6.6 住宿明细（真实控件 NHZSBT_*）：淡季天数 / 发票张数 / 住宿金额 + 住宿地点
if (HD > 0 || HA > 0) {
  const HI = Number(cf.hotelInvoices || (cf.hotelMode === "invoice" ? 1 : 0));
  const CITY = String(cf.hotelCity || CITY1 || "").trim();
  const PROV_MAP = { 苏州:"JS", 南京:"JS", 无锡:"JS", 常州:"JS", 镇江:"JS", 徐州:"JS", 扬州:"JS",
    上海:"SH", 北京:"BJ", 天津:"TJ", 重庆:"CQ", 广州:"GD", 深圳:"GD", 珠海:"GD", 东莞:"GD",
    杭州:"ZJ", 宁波:"ZJ", 西安:"SN", 成都:"SC", 武汉:"HB", 长沙:"HN", 合肥:"AH", 济南:"SD",
    青岛:"SD", 郑州:"HA", 福州:"FJ", 厦门:"FJ", 南昌:"JX", 太原:"SX", 石家庄:"HE", 沈阳:"LN" };
  const PROV = String(cf.hotelProvince || PROV_MAP[CITY] || CITY || "").trim();
  await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_BT_ZSFMX"); if(b){b.scrollIntoView({block:"center"}); b.click();} return !!b;`));
  await sleep(6000);

  const res = await p.eval(inF(/clfbx_simple/i, `(() => {
    const pickRow = () => [...doc.querySelectorAll("tr")].find((tr) => {
      const i = tr.querySelector("input[id*=TXT_YGBH]"); return i && (i.value || "").trim() === ${JSON.stringify(user)};
    });
    let row = pickRow();
    if (!row) return { ok: false, why: "没找到本人所在行" };
    const set = (suffix, v) => {
      const e = row.querySelector("input[id*='" + suffix + "']");
      if (!e) return false;
      e.value = v; e.dispatchEvent(new Event("change", { bubbles: true })); return true;
    };
    const a = set("TB_ZSTS_D", ${JSON.stringify(String(HD))});
    const b = set("TB_FPZS", ${JSON.stringify(String(HI))});
    const c = set("TB_ZSJE", ${JSON.stringify(HA.toFixed(2))});
    return { ok: a && b && c, a, b, c };
  })()`)).catch((e) => ({ ok: false, why: e.message }));
  say("住宿明细·填数", res.ok, res.why || `淡季 ${HD} 天 / 发票 ${HI} 张 / 金额 ${HA.toFixed(2)}`);

  // 住宿地点为空时，用【出差地区检索】选城市
  if (res.ok) {
    const need = await p.eval(inF(/clfbx_simple/i, `(() => {
      const row = [...doc.querySelectorAll("tr")].find((tr) => {
        const i = tr.querySelector("input[id*=TXT_YGBH]"); return i && (i.value || "").trim() === ${JSON.stringify(user)};
      });
      if (!row) return "no row";
      const img = row.querySelector("img[id*=Img_ZSDD]");
      if (!img) return "no btn";
      img.click(); return "opened";
    })()`)).catch(() => "err");
    await sleep(4000);
    if (need === "opened") {
      const prov = await p.eval(inF(/clfbx_simple/i, `(() => {
        const e = doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_TB_PRO");
        if (!e) return "no prov input";
        e.value = ${JSON.stringify(PROV)};
        const b = doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_BT_DQJS");
        if (b) b.click();
        return "searched";
      })()`)).catch(() => "err");
      await sleep(5000);
      const picked = await p.eval(inF(/clfbx_simple/i, `(() => {
        const want = ${JSON.stringify(CITY)};
        const rows = [...doc.querySelectorAll("tr")].filter((tr) => /NHZSBT_GV_DQJS_ctl\\d+_Chk_Is/.test(tr.innerHTML || ""));
        const hit = rows.find((tr) => (tr.innerText || "").includes(want));
        if (!hit) return { ok: false, why: "检索结果里没有 " + want, count: rows.length };
        const cb = hit.querySelector("input[type=checkbox]");
        if (cb && !cb.checked) cb.click();
        const place = hit.querySelector("input[type=text]");
        if (place) { place.value = want; place.dispatchEvent(new Event("change", { bubbles: true })); }
        const save = doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_BT_BCDQ2");
        if (save) save.click();
        return { ok: !!(cb), count: rows.length };
      })()`)).catch((e) => ({ ok: false, why: e.message }));
      say("住宿明细·地点", picked.ok, picked.why || `已选 ${CITY}`);
      await sleep(4000);
    }
  }

  // 保存住宿明细
  await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_NHZSBT_BTN_CLOSE"); if(b) b.click(); return !!b;`)).catch(() => false);
  await sleep(5000);
  say("住宿明细·保存", true, "已点【保存并返回上一页】");
}
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

const NEED = air.length + carAttach.length + hotelAttach.length;
if (NEED === 0) {
  say("票夹", true, "没有要挂的发票（全部按补助走），跳过票夹");
} else {
const opened = await openPicker("GV_CLF_ctl02");
say("打开选票面板", opened, opened ? "ok" : "失败");
let wallet = opened ? await walletCount() : -1;
console.log("   票夹现有:", wallet);

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
}

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
             f("TXT_PB",${JSON.stringify(s.pb)}) && f("TXT_DJ",${JSON.stringify(s.dj)}) && f("TXT_ZS","1");`));
    idx++;
  }
  await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_MXCL_BTN_CLOSE"); if(b) b.click();`));
  await sleep(8000);
  say("行程单", true, `${segs.length} 段`);
} else {
  say("行程单", true, "没有机票，跳过");
}

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
if (air.length) await pick("GV_CLF_ctl02", air.map((i) => i.number), "挂机票");
if (carAttach.length) await pick("GV_CLF_ctl04", carAttach.map((i) => i.number), "挂网约车");
else say("挂网约车", true, "每天都不超 80，全部领补助，不交票");

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
  await p.screenshot(join(D, "city_transport.png"));
} else if (TP.ok) {
  say("市内交通补助", true, "每天网约车都超 80，全部交票实报，补助填 0");
}

// 10 保存（只一次）
await p.eval(inF(/clfbx_simple/i, `const b=doc.getElementById("ctl00_ContentPlaceHolder1_BT_SAVE"); if(b) b.click();`));
await sleep(10000);
await p.screenshot(join(D, "fill_saved.png"));
say("保存", true, "见 finance_recon/fill_saved.png");

// 11 下一步（支付方式）
await p.eval(inF(/clfbx_simple/i, `const b=document.getElementById("ctl00_ContentPlaceHolder1_Btn_xmzffs"); if(b) b.click();`));
await sleep(10000);
await p.screenshot(join(D, "fill_payment.png"));
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
  // 支付方式下拉：选“网银对私（校内）”
  const sel = row.querySelector("select");
  if (sel) {
    const o = [...sel.options].find((x) => /网银对私/.test(x.text) && /校内/.test(x.text)) ||
              [...sel.options].find((x) => /网银对私/.test(x.text));
    if (o) { sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
  }
  // 人员：本人
  const radio = [...row.querySelectorAll("input[type=radio]")].find((r) => /rad_wszf/.test(r.id) && /_0$/.test(r.id));
  if (radio && !radio.checked) radio.click();
  // 金额
  const money = [...row.querySelectorAll("input[type=text]")].find((i) => /JE|Money|金额/i.test(i.id || "") || !i.id);
  if (money && diff) { money.value = diff; money.dispatchEvent(new Event("input", { bubbles: true })); money.dispatchEvent(new Event("change", { bubbles: true })); }
  // 新增
  const add = [...row.querySelectorAll("input[type=image],input[type=button],a")].find((e) => /新增|add|Add/.test((e.value || e.title || e.alt || "")));
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

await p.bringToFront();
await p.banner("🏁 已到审批单阶段 — 请在审批单页核对附件与担保人，最后自己点【确认提交审批】", { color: "#059669", pulse: false });
process.stdout.write("\x07");
console.log("\n下一步：审批单页 → 上传附件 → 编辑流程加担保人 → 你自己点【确认提交审批】。");

console.log("\n=== 汇总 ===");
for (const [o, k, m] of log) console.log(`${o ? "✅" : "❌"} ${k}: ${m}`);
console.log("\n下一步：在支付方式页选「对私支付/本人/金额」，最后一步由用户自己点提交。");
process.exit(0);