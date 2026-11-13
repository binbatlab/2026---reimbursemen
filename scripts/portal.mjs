// 统一入口守卫：保证「门户 + 报账系统」两个会话都在，避免 jump.aspx 弹「登录信息丢失」。
//   1) 先走 CAS（ids.xidian.edu.cn/authserver/login?service=caslogin.aspx）
//        - 会话有效 → 自动跳到财务系统
//        - 需要登录 → 有保存的凭据就自动填；没有就等用户在弹出的窗口里登录
//   2) 再进 jump.aspx?sysid=wsyy，确认到 frame_container
import { sleep } from "./cdp.mjs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { readConfig } from "./config.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SERVICE = "https://cwcwssfv.xidian.edu.cn/tysfrz/caslogin.aspx";
const ENTRY = `https://ids.xidian.edu.cn/authserver/login?service=${encodeURIComponent(SERVICE)}`;

function revealCred() {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", resolve(ROOT, "scripts", "cred.ps1"), "-Action", "reveal"],
      { encoding: "utf8", timeout: 15000, windowsHide: true });
    if (!out || out.includes("NO_CRED")) return null;
    const o = JSON.parse(out);
    return o && o.user && o.pass ? o : null;
  } catch { return null; }
}

export async function ensurePortal(page, { waitMinutes = 5, log = console.log } = {}) {
  // 自动关掉系统的 alert/confirm
  page.browser.on((m) => {
    if (m.method === "Page.javascriptDialogOpening" && m.sessionId === page.sessionId) {
      page.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    }
  });
  await page.send("Page.enable").catch(() => {});

  const state = async () => page.eval(`(() => ({
    url: location.href,
    onCas: /ids\\.xidian\\.edu\\.cn\\/authserver/.test(location.href),
    hasUser: !!document.querySelector("#username"),
    hasCaptcha: !!document.querySelector("#captcha"),
    msg: ([...document.querySelectorAll("#msg,.login-error,[class*=error]")].map((e) => (e.innerText || "").trim()).filter(Boolean)[0]) || "",
  }))()`).catch(() => ({ url: "", onCas: false, hasUser: false }));

  // ===== 用户指定的正确顺序 =====
  // 1) Chrome 打开一网通办
  // 2) 点页面下方的【财务】→ 会开新标签到「统一身份认证」登录页
  // 3) 填工号+密码登录 → 进入财务办公平台 Newindex.aspx
  // 4) 在财务平台点【网上报账】→ 进报账系统
  log("· 1) 打开一网通办…");
  await page.goto("https://ywtb.xidian.edu.cn/yk/index.html#/", { settleMs: 7000, timeoutMs: 40000 }).catch(() => {});
  await page.bringToFront().catch(() => {});

  // 关掉无关的多余标签（保留当前这个）
  const selfId = page.targetId;
  for (const t of (await page.browser.listPages().catch(() => []))) {
    if (!t.id || t.id === selfId) continue;
    if (/ywtb\.xidian|ids\.xidian|tysfrz\/|wsyy\/(frame_container|frame_main)/.test(t.url || "")) {
      await page.browser.closeTarget(t.id).catch(() => {});
    }
  }

  log("· 2) 点【财务】…");
  const clickFin = () => page.eval(`(() => {
    const walk=(w)=>{ try{ for (const a of w.document.querySelectorAll("a,div")) {
        if ((a.innerText||"").trim()==="财务" && a.getBoundingClientRect().width>40) { a.click(); return true; } } }catch(e){}
      for(let i=0;i<w.frames.length;i++){ if(walk(w.frames[i])) return true; } return false; };
    return walk(window);
  })()`).catch(() => false);

  let finClicked = false;
  for (let i = 0; i < 8 && !finClicked; i++) {
    finClicked = await clickFin();
    if (!finClicked) await sleep(2500);
  }
  if (!finClicked) throw new Error("一网通办里没找到【财务】卡片");
  await sleep(8000);

  // 3) 新标签 = 统一身份认证；若已登录会直接跳到 Newindex
  let finPage = await page.browser.attachExisting((t) => /ids\.xidian|tysfrz\//i.test(t.url || ""));
  if (!finPage) finPage = page;
  await finPage.send("Page.enable").catch(() => {});

  const casState = () => finPage.eval(`(() => ({
    url: location.href,
    onCas: /ids\.xidian\.edu\.cn\/authserver/.test(location.href),
    hasUser: !!document.querySelector("#username"),
    hasCaptcha: !!document.querySelector("#captcha"),
  }))()`).catch(() => ({ url: "", onCas: false }));

  let cs = await casState();
  if (cs.onCas && cs.hasUser) {
    const cred = revealCred();
    if (cred && !cs.hasCaptcha) {
      log("· 3) 用已保存账号自动登录…");
      const fill = async (sel, text) => {
        const ok = await finPage.eval(`(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.focus(); e.value=""; return true; })()`);
        if (!ok) return false;
        await finPage.send("Input.insertText", { text });
        return true;
      };
      await fill("#username", cred.user);
      await fill("#password", cred.pass);
      await finPage.eval(`(() => { const b=document.querySelector("#login_submit"); if(b) b.click(); return !!b; })()`).catch(() => false);
    } else {
      log("· 3) 请在浏览器里输入工号+密码登录（勾「7天免登录」最好）…");
      await finPage.bringToFront().catch(() => {});
    }
    const dl = Date.now() + waitMinutes * 60_000;
    while (Date.now() < dl) {
      await sleep(2500);
      cs = await casState();
      if (!cs.onCas) break;
    }
    if (cs.onCas) throw new Error("登录未完成（超时）。请先在浏览器里登录一次再重跑。");
  }
  log("· 3) 已登录财务平台");

  // 4) 财务平台点【网上报账】
  await sleep(2000);
  log("· 4) 点【网上报账】…");
  const clickWsyy = () => finPage.eval(`(() => {
    const cands=[...document.querySelectorAll("a,div,span,button,input")];
    const a = cands.find((x)=>(x.innerText||"").replace(/\\s+/g,"")==="网上报账")
      || cands.find((x)=>(x.innerText||"").includes("网上报账"))
      || cands.find((x)=>(x.getAttribute && (x.getAttribute("href")||"")==="jump.aspx?sysid=wsyy"));
    if (!a) return false;
    a.click(); return true;
  })()`).catch(() => false);

  let wsClicked = false;
  for (let i = 0; i < 10 && !wsClicked; i++) {
    wsClicked = await clickWsyy();
    if (!wsClicked) await sleep(2500);
  }
  if (!wsClicked) throw new Error("财务平台里没找到【网上报账】按钮");
  await sleep(9000);

  const wsPage = await page.browser.attachExisting((t) => /wsyy\/(frame_container|frame_main)/i.test(t.url || ""));
  if (wsPage) {
    page = wsPage;
    await page.send("Page.enable").catch(() => {});
    await page.bringToFront().catch(() => {});
  }
  // 关掉中间的登录页/财务平台页，只留报账平台
  for (const t of (await page.browser.listPages().catch(() => []))) {
    if (/ids\.xidian|tysfrz\/|ywtb\.xidian/.test(t.url || "")) await page.browser.closeTarget(t.id).catch(() => {});
  }

  log("✅ 会话就绪（frame_container）");
  return page;   // 返回实际使用的标签页（门户里点【财务】可能换了标签）
}
