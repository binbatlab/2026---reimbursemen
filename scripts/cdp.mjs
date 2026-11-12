// 极简 Chrome DevTools Protocol 驱动：零依赖（Node >= 22 自带 WebSocket/fetch）
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Chrome 位置：优先用 CHROME_EXE 环境变量，否则按常见安装路径自动找
const CHROME_CANDIDATES = [
  process.env.CHROME_EXE,
  process.env.LOCALAPPDATA &&
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  process.env.ProgramFiles &&
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  process.env["ProgramFiles(x86)"] &&
    `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p)) || CHROME_CANDIDATES[0] || "chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9222);

async function httpJson(path) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

export async function ensureBrowser({ profileDir, headless = false } = {}) {
  try {
    return await httpJson("/json/version");
  } catch { /* not running yet */ }

  const args = [
    `--remote-debugging-port=${PORT}`,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--no-sandbox",
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new");
  const child = spawn(CHROME, args, { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try { return await httpJson("/json/version"); }
    catch { await sleep(300); }
  }
  throw new Error("Chrome 未能在 25s 内开放调试端口");
}

export class Browser {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener("open", res, { once: true });
      this.ws.addEventListener("error", () => rej(new Error("CDP WebSocket 连接失败")), { once: true });
    });
    this.ws.addEventListener("close", () => {
      for (const [, p] of this.pending) { try { p.rej(new Error("CDP 连接已断开")); } catch {} }
      this.pending.clear();
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.rej(new Error(`${msg.error.message} (${msg.error.code})`)) : p.res(msg.result);
      } else {
        // 任何会话弹出 alert/confirm 都自动确认，避免页面被弹窗卡死
        if (msg.method === "Page.javascriptDialogOpening") {
          this.send("Page.handleJavaScriptDialog", { accept: true }, msg.sessionId).catch(() => {});
        }
        for (const fn of this.listeners) fn(msg);
      }
    });
    return this;
  }

  send(method, params = {}, sessionId, timeoutMs = 15000) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (e) {
      return Promise.reject(new Error(`CDP 发送失败: ${method} (${e.message})`));
    }
    // 关键：CDP 不回包时不能无限挂起（页面回发/上下文销毁很常见）
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`CDP 超时(${Math.round(timeoutMs / 1000)}s): ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        res: (v) => { clearTimeout(timer); res(v); },
        rej: (e) => { clearTimeout(timer); rej(e); },
      });
    });
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  once(predicate, timeoutMs = 20000) {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { off(); rej(new Error("等待 CDP 事件超时")); }, timeoutMs);
      const off = this.on((msg) => {
        if (!predicate(msg)) return;
        clearTimeout(timer); off(); res(msg);
      });
    });
  }

  async listPages() {
    const list = await httpJson("/json/list");
    return list.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  }

  async attachExisting(match = () => true) {
    const pages = await this.listPages();
    const target = pages.find(match) || pages[0];
    if (!target) return null;
    const { sessionId } = await this.send("Target.attachToTarget", { targetId: target.id, flatten: true });
    const page = new Page(this, target.id, sessionId);
    await page.init();
    return page;
  }

  async newPage(url = "about:blank") {
    const { targetId } = await this.send("Target.createTarget", { url });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    await page.init();
    return page;
  }
}


// 浏览器/页面卡死时的自愈：探测 → 重启 Chrome → 重新附着页面
export async function reviver({ profileDir, pageHint } = {}) {
  let ver = null;
  try { ver = await httpJson("/json/version"); } catch { ver = null; }
  if (!ver) {
    console.log("   ↻ 浏览器没响应，正在重启…");
    try { spawn("taskkill", ["/F", "/IM", "chrome.exe"], { stdio: "ignore" }); } catch {}
    await new Promise((r) => setTimeout(r, 2500));
    ver = await ensureBrowser({ profileDir });
  }
  const browser = await new Browser(ver.webSocketDebuggerUrl).connect();
  let page = null;
  try {
    page = pageHint ? await browser.attachExisting(pageHint) : null;
    if (!page) page = await browser.attachExisting(() => true);
    if (!page) page = await browser.newPage("about:blank");
    await page.init().catch(() => {});
  } catch (e) {
    console.log("   ! 重新附着页面失败:", e.message);
  }
  console.log("   ✓ 已恢复连接");
  return { ver, browser, page };
}

export class Page {
  constructor(browser, targetId, sessionId) {
    this.browser = browser; this.targetId = targetId; this.sessionId = sessionId;
  }
  send(method, params) { return this.browser.send(method, params, this.sessionId); }

  // 轻量探活：3 秒没回应就认为页面/浏览器挂了
  async ping() {
    try {
      const r = await this.browser.send("Runtime.evaluate", { expression: "1+1", returnByValue: true }, this.sessionId, 3000);
      return !!r && r.result && r.result.value === 2;
    } catch { return false; }
  }

  async init() {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("DOM.enable");
  }

  async goto(url, { settleMs = 3000, timeoutMs = 45000 } = {}) {
    const loaded = this.browser.once(
      (m) => m.method === "Page.loadEventFired" && m.sessionId === this.sessionId, timeoutMs,
    );
    await this.send("Page.navigate", { url });
    await loaded.catch(() => {});
    await sleep(settleMs);
  }

  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression, awaitPromise, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    if (!r.result || r.result.value === undefined) return null;   // 统一成 null，避免 undefined 到处炸
    return r.result.value;
  }

  async waitFor(expression, { timeoutMs = 30000, intervalMs = 400 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (await this.eval(expression)) return true; } catch { /* ignore */ }
      await sleep(intervalMs);
    }
    throw new Error(`等待条件超时: ${expression}`);
  }

  async screenshot(file) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  }

  info() { return this.eval(`({ url: location.href, title: document.title })`); }

  // 把标签页切到前台，让用户看到
  async bringToFront() { await this.send("Page.bringToFront").catch(() => {}); }

  // 在页面顶部盖一条醒目横幅，提示用户「现在轮到你」
  // 注意：财务系统是 frameset，frame 文档可能没有 body，要逐帧注入
  async banner(text, { color = "#059669", pulse = true } = {}) {
    return this.eval(`(() => {
      const paint = (doc) => {
        if (!doc) return false;
        const host = doc.body || doc.documentElement;
        if (!host) return false;
        let el = doc.getElementById("__ywtb_banner");
        if (!el) {
          el = doc.createElement("div");
          el.id = "__ywtb_banner";
          el.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:16px 24px;" +
            "font:600 17px/1.6 system-ui,-apple-system,'Microsoft YaHei',sans-serif;color:#fff;" +
            "text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.35);letter-spacing:.3px";
          host.appendChild(el);
        }
        el.style.background = ${JSON.stringify(color)};
        el.textContent = ${JSON.stringify(text)};
        ${pulse ? 'try{el.animate([{opacity:.65},{opacity:1},{opacity:.65}],{duration:1600,iterations:3});}catch(e){}' : ""}
        return true;
      };
      // frameset 文档没有 body，贴上去不渲染；只选面积最大的"有 body"的帧贴一次
      const cands = [];
      const scan = (w, d) => {
        if (!w || d > 3) return;
        try {
          const doc = w.document;
          // frameset 文档不参与布局，贴上去尺寸为 0，必须跳过
          if (doc && doc.body && !doc.querySelector("frameset")) {
            const br = doc.body.getBoundingClientRect();
            if (br.width > 200 && br.height > 100) {
              cands.push({ w, area: br.width * br.height, doc });
            }
          }
        } catch (e) {}
        for (let i = 0; i < w.frames.length; i++) { try { scan(w.frames[i], d + 1); } catch (e) {} }
      };
      scan(window, 0);
      if (!cands.length) return 0;
      cands.sort((a, b) => b.area - a.area);
      return paint(cands[0].doc) ? 1 : 0;
    })()`);
  }

  async clearBanner() {
    return this.eval(`(() => { const el=document.getElementById("__ywtb_banner"); if(el) el.remove(); return true; })()`).catch(() => {});
  }

  // 直接对页面里某个元素点一下（比坐标点击稳）
  async clickText(text, { selector = "a,button,div,span,li,td", exact = false } = {}) {
    const res = await this.eval(`(() => {
      const want = ${JSON.stringify(text)};
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const hit = nodes.find(n => {
        const t = (n.innerText || "").trim();
        return ${exact ? "t === want" : "t === want || t.includes(want)"};
      });
      if (!hit) return { ok: false, count: nodes.length };
      hit.scrollIntoView({ block: "center" });
      hit.click();
      return { ok: true, tag: hit.tagName, text: (hit.innerText || "").trim().slice(0, 80) };
    })()`);
    await sleep(800);
    return res;
  }
}

export { sleep, httpJson, CHROME, PORT };
