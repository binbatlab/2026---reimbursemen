// 只做「进门」：一网通办 → 财务 → 登录 → 网上报账，停在报账平台。
// 由 run.mjs 在打开确认窗口之前调用，保证顺序是：先进系统 → 再让用户填
import { ensureBrowser, Browser } from "./cdp.mjs";
import { ensurePortal } from "./portal.mjs";

const ver = await ensureBrowser({ profileDir: process.env.YWTB_PROFILE });
const browser = await new Browser(ver.webSocketDebuggerUrl).connect();
let page = (await browser.attachExisting((t) => /frame_container/i.test(t.url || "")))
  || (await browser.attachExisting(() => true))
  || (await browser.newPage("about:blank"));
await page.send("Page.enable").catch(() => {});
const pg = await ensurePortal(page, {
  waitMinutes: Number(process.env.YWTB_LOGIN_WAIT_MINUTES || 8),
  log: (m) => console.log(m),
});
if (pg && pg.eval) page = pg;
const st = await page.eval(`(() => ({ url: location.href.slice(0, 70) }))()`).catch(() => ({ url: "" }));
console.log("已进入报账平台:", st.url);
process.exit(/frame_container/i.test(st.url) ? 0 : 3);