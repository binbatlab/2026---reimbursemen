import { ensureBrowser, Browser, sleep } from "./cdp.mjs";
import { readFileSync } from "node:fs";
const ds = JSON.parse(readFileSync(process.env.YWTB_WORKDIR + "\\invoices\\dataset.json", "utf8").replace(/^\uFEFF/, ""));
const air = ds.invoices.filter(i => i.kind === "机票");
const car = ds.invoices.filter(i => i.kind === "网约车");
const rows = (list, label) => list.map(i => `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${i.number}</td>
  <td style="padding:4px 8px;border-bottom:1px solid #eee">${i.from ? `${i.from} → ${i.to}` : (i.seller || "")}</td>
  <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">¥${i.total}</td></tr>`).join("");
const html = `
<div id="ywtb-invoice-list" style="position:fixed;right:18px;top:90px;width:560px;max-height:70vh;overflow:auto;background:#fff;border:2px solid #2563eb;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.18);z-index:99999;font:13px/1.6 system-ui,'Microsoft YaHei'">
  <div style="background:#2563eb;color:#fff;padding:10px 14px;border-radius:8px 8px 0 0;font-size:14px">
    本次要挂的发票（请核对后点确认）
  </div>
  <div style="padding:12px 14px">
    <div style="font-weight:600;color:#111;margin:6px 0 4px">机票行（发票行）· ${air.length} 张 · ¥${air.reduce((s,i)=>s+Number(i.total),0)}</div>
    <table style="width:100%;border-collapse:collapse">${rows(air)}</table>
    <div style="font-weight:600;color:#111;margin:12px 0 4px">汽车行（网约车）· ${car.length} 张 · ¥${car.reduce((s,i)=>s+Number(i.total),0)}</div>
    <table style="width:100%;border-collapse:collapse">${rows(car)}</table>
    <div style="margin-top:12px;padding-top:10px;border-top:1px dashed #ddd;font-weight:600">合计 ¥${ds.summary.grand_total}</div>
    <div id="ywtb-inv-msg" style="margin-top:8px;color:#888">核对无误后点下面的按钮</div>
    <button id="ywtb-inv-ok" style="margin-top:10px;width:100%;padding:10px;background:#059669;color:#fff;border:0;border-radius:8px;font-size:15px;cursor:pointer">发票清单没有问题，确认</button>
  </div>
</div>`;
const ver = await ensureBrowser({ profileDir: process.env.YWTB_PROFILE });
const browser = await new Browser(ver.webSocketDebuggerUrl).connect();
const page = await browser.attachExisting((t) => /frame_container/.test(t.url || ""));
const inF = (b) => `(() => { const w=window.frames["mainframe"]; if(!w||!w.document) return {__err:"frame"}; const doc=w.document; ${b.trim().startsWith("(") ? "return " + b : b} })()`;
await page.eval(inF(`(() => {
  const old = doc.getElementById("ywtb-invoice-list"); if (old) old.remove();
  const d = doc.createElement("div"); d.innerHTML = ${JSON.stringify(html)}; doc.body.appendChild(d.firstElementChild);
  window.__ywtb_confirm = false;
  doc.getElementById("ywtb-inv-ok").onclick = () => {
    window.__ywtb_confirm = true;
    const m = doc.getElementById("ywtb-inv-msg"); if (m) { m.textContent = "已确认 ✅ 正在继续…"; m.style.color = "#059669"; }
    const b = doc.getElementById("ywtb-inv-ok"); if (b) b.disabled = true;
  };
  return true;
})()`));
console.log("已在页面上显示发票清单浮层，等待你点确认…");
for (let i = 0; i < 100; i++) {
  await sleep(3000);
  const ok = await page.eval(inF(`return !!(window.__ywtb_confirm === true);`)).catch(() => null);
  if (ok === true) { console.log(`第 ${(i+1)*3} 秒：已确认 ✅`); break; }
  if (i % 10 === 9) console.log(`   还在等你确认…（${(i+1)*3} 秒）`);
}
process.exit(0);
