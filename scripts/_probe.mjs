// 试探：用 JS 跳转代替 Page.navigate（避免 Page.navigate 命令 15s 不回包）
import { ensureBrowser, Browser, sleep } from "./cdp.mjs";

const PROFILE = process.env.YWTB_PROFILE || `${process.env.LOCALAPPDATA}\\ywtb-skill\\profile`;
const ver = await ensureBrowser({ profileDir: PROFILE });
const browser = await new Browser(ver.webSocketDebuggerUrl).connect();
const pages = await browser.listPages();
console.log("pages:", pages.map((p) => p.url).join(" | "));
let page = pages.find((p) => /ywtb\.xidian/.test(p.url)) || pages[0];
page = await browser.attachExisting((t) => t.id === page.id);

const TARGET = process.argv[2] || "https://cwcwssfv.xidian.edu.cn/tysfrz/jump.aspx?sysid=wsyy";
console.log("before:", await page.eval("location.href"));
// 用 JS 跳转，不用 Page.navigate
await page.eval(`(() => { location.href = ${JSON.stringify(TARGET)}; return 1; })()`).catch((e) => console.log("eval-jump err:", e.message));
for (let i = 0; i < 10; i++) {
  await sleep(2000);
  const st = await page.eval(`({ url: location.href, title: document.title, frames: window.frames.length, text: (document.body ? document.body.innerText : "").slice(0, 300) })`).catch((e) => ({ err: e.message }));
  console.log(i, JSON.stringify(st).slice(0, 500));
  if (st && /frame_container/i.test(st.url || "")) break;
}
