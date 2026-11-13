// 会话就绪检查：CAS 登录 → 一网通办 → 财务 → 报账平台
import { ensureBrowser, Browser } from "./cdp.mjs";
import { ensurePortal } from "./portal.mjs";

const PROFILE = process.env.YWTB_PROFILE || `${process.env.LOCALAPPDATA}\\ywtb-skill\\profile`;
const ver = await ensureBrowser({ profileDir: PROFILE });
const browser = await new Browser(ver.webSocketDebuggerUrl).connect();

let page = await browser.attachExisting((t) => /cwcwssfv\.xidian\.edu\.cn|xidian\.edu\.cn/i.test(t.url || ""));
if (!page) page = await browser.attachExisting(() => true);
if (!page) page = await browser.newPage("about:blank");

try {
  page = await ensurePortal(page, { waitMinutes: Number(process.env.YWTB_LOGIN_WAIT_MINUTES || 4), log: (m) => console.log(m) });
  const info = await page.eval(`({ url: location.href, title: document.title })`);
  console.log("FINAL_URL:", info.url);
  console.log("LOGIN_OK");
  process.exit(0);
} catch (e) {
  console.log("LOGIN_FAIL:", e.message);
  process.exit(1);
}
