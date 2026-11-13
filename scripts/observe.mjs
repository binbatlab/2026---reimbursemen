import { ensureBrowser, Browser, sleep } from "./cdp.mjs";
const ver = await ensureBrowser({ profileDir: process.env.YWTB_PROFILE });
const browser = await new Browser(ver.webSocketDebuggerUrl).connect();
// 优先观察财务标签（frame_container），没有才退回任意标签
const page = await browser.attachExisting((t) => /cwcwssfv\.xidian\.edu\.cn\/wsyy/i.test(t.url || ""))
  || await browser.attachExisting((t) => /cwcwssfv/i.test(t.url || ""))
  || await browser.attachExisting(() => true);
await page.send("Page.enable").catch(()=>{});
const snap = () => page.eval(`(() => {
  const out = { tab: location.href.slice(0,70) };
  const w = window.frames["mainframe"];
  out.main = w && w.document ? w.location.href.slice(0,80) : "none";
  try {
    const d = w.document;
    const g=(id)=>{const e=d.getElementById("ctl00_ContentPlaceHolder1_"+id); return e?String(e.value).slice(0,18):null;};
    out.f = { qs:g("TXT_QSRQ"), zz:g("TXT_ZZRQ"), sy:g("TXT_ccddjrw"), xm:g("TXT_XM"), jf:g("TXT_JFLY"), rs:g("TXT_RS"), dd:g("Txt_DDd"),
              bg:g("DDL_SFBG"), air:g("GV_CLF_ctl02_TXT_DZFPZS"), car:g("GV_CLF_ctl04_TXT_DZFPZS"), itin:g("GV_CLF_ctl02_BTN_XCD_Cl"),
              hotel:g("BT_ZSFMX") };
    out.hotel = { yg:g("NHZSBT_GV_ZSBT_ctl02_TXT_YGBH"), d:g("NHZSBT_GV_ZSBT_ctl02_TB_ZSTS_D"), j:g("NHZSBT_GV_ZSBT_ctl02_TB_ZSJE"),
                  city:g("NHZSBT_GV_DQJS_ctl02_TB_ZSDDQR") };
    out.wallet = (() => { const t=(d.body.innerText||"").replace(/\\s+/g," "); const m=t.match(/可用发票合计[：:]\\s*(\\d+)/); return m?m[1]:null; })();
    out.layers = [...d.querySelectorAll(".layui-layer-title")].map(e=>(e.innerText||"").trim().slice(0,14)).slice(0,2);
  } catch(e) { out.err = String(e).slice(0,40); }
  return out;
})()`).catch(e => ({ err: String(e).slice(0,40) }));
let prev = "";
const t0 = Date.now();
console.log("👀 观察开始（只读，不会操作页面）—— 你操作吧");
for (let i = 0; i < 300; i++) {
  const s = await snap();
  const line = JSON.stringify(s);
  if (line !== prev) {
    const sec = Math.round((Date.now()-t0)/1000);
    console.log(`[${sec}s] ${line}`);
    prev = line;
  }
  await sleep(1500);
}
console.log("👀 观察结束");
process.exit(0);
