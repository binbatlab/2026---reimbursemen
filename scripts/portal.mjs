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

  log("· 打开统一身份认证…");
  await page.goto(ENTRY, { settleMs: 4000, timeoutMs: 30000 });

  let st = await state();
  if (st.onCas && st.hasUser) {
    const cred = revealCred();
    if (cred) {
      log("· 用已保存的账号自动登录…");
      const fill = async (sel, text) => {
        const ok = await page.eval(`(() => { const e=document.querySelector(${JSON.stringify(sel)});
          if(!e) return false; e.focus(); e.value=${JSON.stringify("")}; return true; })()`);
        if (!ok) return false;
        await page.send("Input.insertText", { text });
        return true;
      };
      await fill("#username", cred.user);
      await fill("#password", cred.pass);
      const hasCap = (await state()).hasCaptcha;
      if (hasCap) {
        log("!! 出现了验证码：请在弹出的窗口里手动输入验证码并登录");
      } else {
        await page.eval(`(() => { const b=document.querySelector("#login_submit"); if(b) b.click(); return !!b; })()`);
      }
    } else {
      log("!! 需要登录：请在弹出的 Chrome 窗口里输入工号+密码（勾 7 天免登录）");
    }

    // 等登录完成（自动或人工）
    const deadline = Date.now() + waitMinutes * 60_000;
    while (Date.now() < deadline) {
      await sleep(2000);
      st = await state();
      if (!st.onCas) break;
      if (st.msg) log("   系统提示:", st.msg);
    }
    if (st.onCas) throw new Error("登录未完成（超时）。请先在浏览器里登录一次再重跑。");
  }

  // 进报账系统
  log("· 进入网上报账系统…");
  await page.goto("https://cwcwssfv.xidian.edu.cn/tysfrz/jump.aspx?sysid=wsyy", { settleMs: 6000, timeoutMs: 30000 });
  await sleep(1500);
  const ok = await page.eval(`(() => ({
    url: location.href,
    lost: /登录信息丢失/.test(document.body.innerText || ""),
    frames: Object.keys(window.frames).length,
  }))()`).catch(() => ({ lost: false, frames: 0 }));

  if (ok.lost || !/frame_container/i.test(ok.url)) {
    // 兜底：再走一次 CAS 入口（有些情况下 caslogin 才是真正建会话的一步）
    await page.goto(ENTRY, { settleMs: 4000, timeoutMs: 30000 });
    await page.goto("https://cwcwssfv.xidian.edu.cn/tysfrz/jump.aspx?sysid=wsyy", { settleMs: 6000, timeoutMs: 30000 });
    const st2 = await page.eval(`(() => ({ url: location.href }))()`).catch(() => ({ url: "" }));
    if (!/frame_container/i.test(st2.url)) {
      throw new Error("进不了报账系统（jump 仍被拒）。请在浏览器里手动从门户进一次报账系统，再重跑。");
    }
  }
  log("✅ 会话就绪（frame_container）");
  return true;
}
