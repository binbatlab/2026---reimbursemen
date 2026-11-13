import { ensureBrowser, Browser, sleep } from "./cdp.mjs";
import { ensurePortal } from "./portal.mjs";
const ver = await ensureBrowser({ profileDir: process.env.YWTB_PROFILE });
const browser = await new Browser(ver.webSocketDebuggerUrl).connect();
let page = (await browser.attachExisting(() => true)) || (await browser.newPage("about:blank"));
await page.send("Page.enable").catch(()=>{});
page.browser.on((m) => { if (m.method === "Page.javascriptDialogOpening") console.log("  【弹窗】", m.params.message.slice(0,30)); });
const pg = await ensurePortal(page, { waitMinutes: 2, log: () => {} });
if (pg && pg.eval) page = pg;
const inF = (b) => `(() => { const w=window.frames["mainframe"]; if(!w||!w.document) return {__err:"frame"}; const doc=w.document; ${b.trim().startsWith("(") ? "return " + b : b} })()`;
const ev = (b) => page.eval(inF(b));
await ev(`w.location.href="Modules/YZSBX/clfbx_simple.aspx?page=CL"; return 1;`).catch(()=>{});
await sleep(9000);
for (let i=0;i<5;i++){
  const del = await ev(`(() => {
    const tr=[...doc.querySelectorAll("tr")].find(x=>/CL\\d{10,}/.test(x.innerText||"") && /删除/.test(x.innerText||""));
    if(!tr) return "none";
    const a=[...tr.querySelectorAll("a")].find(x=>(x.innerText||"").trim()==="删除");
    if(!a) return "no link";
    a.click(); return "deleted";
  })()`);
  console.log("删草稿:", del);
  if(del!=="deleted") break;
  await sleep(6000);
}
const w = await ev(`(() => { const m=(doc.body.innerText||"").match(/总共\\s*(\\d+)\\s*条记录/); return m?m[1]:"?"; })()`);
console.log("剩余草稿:", w);
process.exit(0);
