// 一网通办统一入口：三种登录模式
//   --mode forever  密码存本机(DPAPI)，脚本自动登录，会话长期保留
//   --mode seven    不存密码，人工登录一次，会话保留约 7 天
//   --mode each     每次清空会话，脚本每次自动填账号密码
//   --mode auto     不加参数时沿用上次保存的模式（默认 seven）
import { ensureBrowser, Browser, sleep } from "./cdp.mjs";
import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ROOT = resolve(import.meta.dirname, "..");
const MODE_FILE = resolve(ROOT, ".ywtb.mode");
const SERVICE = "https://cwcwssfv.xidian.edu.cn/tysfrz/caslogin.aspx";
const ENTRY = `https://ids.xidian.edu.cn/authserver/login?service=${encodeURIComponent(SERVICE)}`;

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

// 账号密码来源优先级：环境变量 → 首次设置页保存的 DPAPI 凭据
import { readConfig } from "./config.mjs";
import { execFileSync } from "node:child_process";

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

const cfg = readConfig();
let USER = process.env.YWTB_USERNAME || "";
let PASS = process.env.YWTB_PASSWORD || "";
const saved = USER && PASS ? null : revealCred();
if (saved) { USER = USER || saved.user; PASS = PASS || saved.pass; }

let mode = arg("mode", existsSync(MODE_FILE) ? readFileSync(MODE_FILE, "utf8").trim()
  : (USER && PASS ? "forever" : "seven"));
if (!["forever", "seven", "each"].includes(mode)) throw new Error(`未知模式: ${mode}`);
if (arg("mode", null)) writeFileSync(MODE_FILE, mode, "utf8");
const WAIT_MIN = Number(arg("wait-minutes", mode === "seven" ? 5 : 1));
const LABEL = { forever: "永久免密", seven: "7 天免密", each: "每次登录" }[mode];

console.log(`== 模式：${LABEL} (${mode}) ==`);
if (cfg.staffNo) console.log(`   工号：${cfg.staffNo}`);
if (mode !== "seven" && !(USER && PASS)) {
  console.log("（本机还没有保存账号密码，这次改为在浏览器里登录一次；勾选「7天免登录」下次就不用了）");
  mode = "seven";
}

const PROFILE = process.env.YWTB_PROFILE || resolve(ROOT, ".browser-profile");
const ver = await ensureBrowser({ profileDir: PROFILE });
const browser = await new Browser(ver.webSocketDebuggerUrl).connect();
const page = (await browser.attachExisting((t) => /ids\.xidian\.edu\.cn|cwcwssfv|ywtb\.xidian\.edu\.cn/.test(t.url))) ||
             (await browser.newPage("about:blank"));
await page.send("Network.enable").catch(() => {});
await page.send("Page.enable").catch(() => {});

const cookies = async () => {
  const r = await page.send("Network.getCookies", { urls: ["https://ids.xidian.edu.cn/", SERVICE] });
  const tgt = r.cookies.find((c) => /^CASTGC/i.test(c.name));
  return { tgt, names: r.cookies.map((c) => c.name) };
};

const state = () => page.eval(`(() => {
  const u = location.href;
  const ue = document.querySelector("#username");
  const cap = document.querySelector("#captcha");
  const err = [...document.querySelectorAll("#msg,.login-error,.error-tip,[class*=error]")]
    .map(e => (e.innerText || "").trim()).filter(Boolean).slice(0, 3);
  return {
    url: u, title: document.title,
    onCas: /ids\\.xidian\\.edu\\.cn\\/authserver/.test(u),
    hasForm: !!ue && ue.getBoundingClientRect().height > 2,
    captcha: !!(cap && cap.getBoundingClientRect().height > 2),
    err,
  };
})()`);

// each 模式：先清空所有 Cookie，保证"从零开始"
if (mode === "each") {
  await page.send("Network.clearBrowserCookies");
  const c0 = await cookies();
  console.log("已清空会话 Cookie，剩余:", c0.names.length ? c0.names.join(",") : "(无)");
}

console.log("进入 CAS 入口…");
await page.goto(ENTRY, { settleMs: 3500 });
let st = await state();
console.log("落地:", st.url.slice(0, 120));

if (!st.onCas || !st.hasForm) {
  console.log("=> 会话有效，已直接进入财务系统（无需密码）");
} else {
  console.log("=> 需要登录");
  const canAuto = (mode === "forever" || mode === "each") && USER && PASS;

  if (canAuto) {
    console.log(`   自动填写（账号 ${USER.slice(0, 2)}***）`);
    const focusType = async (sel, text) => {
      const ok = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
        if (!e) return false; e.scrollIntoView({block:"center"}); e.focus(); e.click(); return true; })()`);
      if (!ok) throw new Error(`找不到字段 ${sel}`);
      await page.send("Input.insertText", { text });
    };
    await focusType("#username", USER);
    await focusType("#password", PASS);

    const filled = await page.eval(`(() => ({
      u: (document.querySelector("#username")||{}).value || "",
      pLen: ((document.querySelector("#password")||{}).value || "").length,
    }))()`);
    console.log(`   回填校验: 账号长度=${filled.u.length} 密码长度=${filled.pLen}`);

    if (mode === "forever" || mode === "seven") {
      await page.eval(`(() => { const b = document.querySelector("#rememberMe"); if (b && !b.checked) b.click(); })()`);
    }
    await page.eval(`document.querySelector("#login_submit").click()`);
    console.log("   已提交，等待跳转…");
  } else {
    console.log(`   等待你在 Chrome 窗口里手动登录（最多 ${WAIT_MIN} 分钟）`);
    console.log(`   提示：勾选「7天免登录」${mode === "seven" ? "（本模式必须勾）" : ""}`);
  }

  const deadline = Date.now() + WAIT_MIN * 60_000;
  let lastUrl = st.url;
  while (Date.now() < deadline) {
    await sleep(1200);
    try { st = await state(); } catch { continue; }
    if (st.url !== lastUrl) { console.log("   →", st.url.slice(0, 110)); lastUrl = st.url; }
    if (st.captcha) { console.log("   ! 出现验证码，请人工输入后继续"); }
    if (!st.onCas) break;
    if (st.err.length) { console.log("   ! 页面提示:", st.err.join(" | ")); break; }
  }

  st = await state();
  if (st.onCas) {
    console.log("\n== 未完成登录 ==");
    console.log("当前:", st.url.slice(0, 120));
    if (st.err.length) console.log("提示:", st.err.join(" | "));
    console.log("登录页仍打开着，可人工完成后重跑本脚本（会话会被识别）。");
    process.exit(2);
  }
}

// 登录成功后：如果停在中间页，再走一次入口落到财务系统
st = await state();
if (!/cwcwssfv/.test(st.url)) {
  await page.goto(ENTRY, { settleMs: 3500 });
  st = await state();
}

const ck = await cookies();
console.log("\n== 结果 ==");
console.log("URL   :", st.url);
console.log("TITLE :", st.title);
console.log("SSO会话:", ck.tgt
  ? `CASTGC 有效至 ${new Date(ck.tgt.expires * 1000).toLocaleString("zh-CN")}`
  : "未发现 CASTGC（本模式不保留会话）");

const shot = resolve(ROOT, "portal_probe", `05_${mode}.png`);
await page.screenshot(shot);
console.log("截图  :", shot);

const brief = await page.eval(`(() => {
  const t = (document.body && document.body.innerText || "").replace(/\\s+/g, " ").trim();
  return t.slice(0, 600);
})()`);
console.log("页面摘要:", brief.slice(0, 300));

if (mode === "each") {
  await page.send("Network.clearBrowserCookies");
  console.log("（已按要求清除本次会话 Cookie）");
}
process.exit(0);
