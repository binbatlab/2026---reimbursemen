import { ensureBrowser, Browser, sleep } from "./cdp.mjs";
const ver = await ensureBrowser({ profileDir: process.env.YWTB_PROFILE });
const browser = await new Browser(ver.webSocketDebuggerUrl).connect();
const page = await browser.attachExisting((t) => /frame_container/.test(t.url || ""));
const inF = (b) => `(() => { const w=window.frames["mainframe"]; if(!w||!w.document) return {__err:"frame"}; const doc=w.document; ${b.trim().startsWith("(") ? "return " + b : b} })()`;
const ev = (b) => page.eval(inF(b));
for (let i = 0; i < 24; i++) {
  await sleep(5000);
  const st = await ev(`(() => {
    const t=(doc.body.innerText||"").replace(/\\s+/g," ");
    const w=t.match(/可用发票合计：(\\d+)/);
    const ok=(t.match(/上传成功/g)||[]).length;
    const wait=(t.match(/等待上传/g)||[]).length;
    const busy=/正在上传处理中/.test(t);
    return { wallet: w?w[1]:"?", ok, wait, busy };
  })()`).catch(() => null);
  if (st) console.log(`${(i+1)*5}s  可用=${st.wallet}  成功=${st.ok}  等待=${st.wait}  ${st.busy?"上传中":"空闲"}`);
  if (st && st.wallet !== "0" && st.wallet !== "?" && st.ok >= 6 && !st.busy) { console.log("✅ 全部上传完成"); break; }
}
process.exit(0);
