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
  // 0) 幂等检查：只要已经有一个标签在报账平台，就直接复用，绝不再绕门户
  const maybe = await page.browser.attachExisting((t) => /wsyy\/(frame_container|frame_main)/i.test(t.url || ""));
  if (maybe) {
    const realUrl = String(await maybe.eval(`location.href`).catch(() => "") || "");
    if (/wsyy\/(frame_container|frame_main)/i.test(realUrl)) {
      await maybe.send("Page.enable").catch(() => {});
      await maybe.bringToFront().catch(() => {});
      // 顺手清掉重复的 frame_container 标签 / 多余的财务平台页（保留当前这个和审批单）
      try {
        const keep = maybe.targetId || "";
        const all = await page.browser.listPages();
        let closed = 0;
        for (const t of all) {
          const u = t.url || "";
          if (t.id === keep) continue;
          const dupWsyy = /wsyy\/(frame_container|frame_main)/i.test(u);
          const fin = /tysfrz\/(Newindex|caslogin)/i.test(u);
          if (dupWsyy || fin) { try { await page.browser.closeTarget(t.id); closed++; } catch {} }
        }
        if (closed) log(`· 清理重复标签 ${closed} 个`);
      } catch {}
      log("· 已在报账平台，跳过门户（不重新走一网通办）");
      return maybe;
    }
    log("· 有个标签看着像报账平台，但实际是 " + realUrl.slice(0, 50) + "，继续走门户");
  }

  log("· 1) 打开一网通办…");
  await page.goto("https://ywtb.xidian.edu.cn/yk/index.html#/", { settleMs: 7000, timeoutMs: 40000 }).catch(() => {});
  await page.bringToFront().catch(() => {});


  log("· 2) 点【财务】…");
  const clickFin = () => page.eval(`(() => {
    const walk=(w)=>{ try{ for (const a of w.document.querySelectorAll("a,div")) {
        if ((a.innerText||"").trim()==="财务" && a.getBoundingClientRect().width>40) { a.click(); return true; } } }catch(e){}
      for(let i=0;i<w.frames.length;i++){ if(walk(w.frames[i])) return true; } return false; };
    return walk(window);
  })()`).catch(() => false);

  // 财务卡片点一次就会开一个新标签；所以「点一次 → 等新标签出现」，
  // 只有确实没开出来时才再点，避免连点造成多个重复页面
  const financeOpened = () => page.browser.attachExisting((t) => /ids\.xidian|tysfrz\//i.test(t.url || ""));
  let finClicked = false;
  for (let i = 0; i < 4 && !finClicked; i++) {
    const before = (await page.browser.listPages()).length;
    finClicked = await clickFin();
    if (!finClicked) { await sleep(2500); continue; }
    // 等新标签（最多 9 秒）
    for (let k = 0; k < 6; k++) {
      await sleep(1500);
      if (await financeOpened()) break;
    }
    const after = (await page.browser.listPages()).length;
    if (after > before || await financeOpened()) break;   // 已经开出来了，不再点
    finClicked = false;                                    // 没开出来，允许再试
  }
  // 换门户路由再试：门户有 /yk/ 和 /default/ 两套页面，卡片不一定在同一个
  for (const route of ["https://ywtb.xidian.edu.cn/default/index.html#/", "https://ywtb.xidian.edu.cn/yk/index.html#/hall", "https://ywtb.xidian.edu.cn/yk/index.html#/"]) {
    if (finClicked) break;
    log("· 换门户页面再找【财务】：" + route.replace("https://ywtb.xidian.edu.cn",""));
    await page.goto(route, { settleMs: 6000, timeoutMs: 30000 }).catch(() => {});
    for (let i = 0; i < 2 && !finClicked; i++) {
      finClicked = await clickFin();
      if (finClicked) { await sleep(4000); if (await financeOpened()) break; }
      else await sleep(2500);
    }
  }
  if (!finClicked) throw new Error("一网通办里没找到【财务】卡片");
  await sleep(8000);

  // 3) 新标签 = 统一身份认证；若已登录会直接跳到 Newindex
  let finPage = await page.browser.attachExisting((t) => /ids\.xidian|tysfrz\//i.test(t.url || ""));
  if (!finPage) finPage = page;
  await finPage.send("Page.enable").catch(() => {});

  const casState = () => finPage.eval(`(() => {
    const href = location.href;
    const onCas = /ids\.xidian\.edu\.cn\/authserver/.test(href);
    const onFinLogin = /tysfrz\/login\.aspx/i.test(href);
    return {
      url: href,
      onCas: onCas || onFinLogin,          // 两种登录页都要等
      onFinLogin,
      hasUser: !!document.querySelector("#username") || !!document.querySelector("#txtUserName, #txtYhm, input[name*=user i]"),
      hasCaptcha: !!document.querySelector("#captcha") || !!document.querySelector("input[name*=yzm i], #txtYzm"),
    };
  })()`).catch(() => ({ url: "", onCas: false }));

  let cs = await casState();
  if (cs && cs.onFinLogin) {
    const cred = revealCred();
    if (cred) {
      log("· 3) 财务登录页：自动填工号密码（验证码请你输入）");
      const setv = (sel, v) => finPage.eval(`(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.focus(); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true})); return true; })()`).catch(() => false);
      await setv("#txtUserName, #txtYhm, input[name*=user i]", cred.user);
      await setv("#txtPassword, #txtPwd, input[type=password]", cred.pass);
      await finPage.bringToFront().catch(() => {});
      await finPage.banner("请补验证码并点【登录】，我在这里等", { color: "#f59e0b", pulse: true }).catch(() => {});
    } else {
      log("· 3) 财务登录页：请在浏览器里填工号+密码+验证码");
      await finPage.bringToFront().catch(() => {});
    }
    const dlf = Date.now() + Math.max(waitMinutes, 8) * 60_000;
    while (Date.now() < dlf) {
      await sleep(2500);
      const u = await finPage.eval(`location.href`).catch(() => "");
      if (!/tysfrz\/login\.aspx/i.test(String(u))) break;
    }
    cs = await casState();
  }

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
      log("· 3) 需要你在浏览器里登录财务平台（工号+密码+验证码）…");
      await finPage.bringToFront().catch(() => {});
      await finPage.banner("请在这里登录：工号 + 密码 + 验证码", { color: "#f59e0b", pulse: true }).catch(() => {});
    }
    const dl = Date.now() + Math.max(waitMinutes, 8) * 60_000;   // 登录（含验证码）最多等 8 分钟
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
    const norm = (x) => ((x.innerText||"") + " " + (x.value||"") + " " + (x.title||"") + " " + (x.alt||"")).replace(/\\s+/g,"");
    let a = cands.find((x)=>norm(x)==="网上报账")
      || cands.find((x)=>norm(x).includes("网上报账"))
      || cands.find((x)=>(x.getAttribute && /jump\\.aspx\\?sysid=wsyy/i.test(x.getAttribute("href")||"")));
    // 兜底：图片按钮 / 带 onclick 跳转的元素
    if (!a) a = cands.find((x)=>(x.getAttribute && /wsyy/i.test(x.getAttribute("onclick")||"")));
    if (!a) {
      const img=[...document.querySelectorAll("img")].find((i)=>/报账/.test((i.alt||"")+(i.title||"")+(i.src||"")));
      if (img) { img.click(); return true; }
      return false;
    }
    a.click();   // 只点一次：link 自带 target 会自己开新标签，绝不再 window.open 兜底（会开出两个）
    return true;
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

  // 清理重复标签：多个 frame_container / 多个财务平台页 —— 只留当前使用的这个
  try {
    const all = await page.browser.listPages();
    const keepId = page.targetId || "";   // Page 对象的真实属性是 targetId
    let closed = 0;
    for (const t of all) {
      const u = t.url || "";
      const dupWsyy = /wsyy\/(frame_container|frame_main)/i.test(u) && t.id !== keepId;
      const dupFin = /tysfrz\/(Newindex|caslogin)/i.test(u);
      if (dupWsyy || dupFin) {
        try { await page.browser.closeTarget(t.id); closed++; } catch {}
      }
    }
    if (closed) log(`· 清理重复标签 ${closed} 个`);
  } catch {}

  log("✅ 会话就绪（frame_container）");
  return page;   // 返回实际使用的标签页（门户里点【财务】可能换了标签）
}
