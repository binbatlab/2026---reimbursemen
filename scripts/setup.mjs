// 首次设置页：让用户在一个本地网页里填「工号 + 密码」，不碰命令行。
//   launch.ps1 -Script scripts\setup.mjs
// 打开 http://127.0.0.1:8799/ ，填完点保存 → 写 .ywtb.config.json，密码用 DPAPI 加密存 .ywtb.cred
import { createServer } from "node:http";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { readConfig, saveConfig, configPath } from "./config.mjs";

const PORT = Number(process.env.YWTB_SETUP_PORT || 8799);
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const CRED = join(ROOT, "scripts", "cred.ps1");

const page = (msg = "", ok = false) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>西电报销助手 · 首次设置</title>
<style>
 body{font-family:"Microsoft YaHei",system-ui,sans-serif;background:#f5f7fa;margin:0;padding:40px}
 .card{max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px 32px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
 h1{font-size:20px;margin:0 0 6px} .sub{color:#666;font-size:13px;margin-bottom:22px}
 label{display:block;font-size:14px;margin:16px 0 6px;color:#333}
 input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:10px 12px;font-size:15px;border:1px solid #d0d5dd;border-radius:8px}
 input:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}
 .row{display:flex;align-items:center;gap:8px;margin-top:18px;font-size:14px;color:#333}
 button{margin-top:24px;width:100%;padding:12px;font-size:16px;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer}
 button:hover{background:#1d4ed8}
 .msg{margin-top:16px;padding:10px 12px;border-radius:8px;font-size:14px}
 .ok{background:#ecfdf5;color:#065f46}.err{background:#fef2f2;color:#991b1b}
 .hint{margin-top:18px;font-size:12px;color:#888;line-height:1.7}
</style></head><body><div class="card">
<h1>报销助手 · 首次设置</h1>
<div class="sub">只需要填这一次。工号用于填报销单「报销人」，密码只存在这台电脑上（Windows 加密）。</div>
<form method="post" action="/save">
  <label>工号</label>
  <input type="text" name="staffNo" placeholder="例如 123456" maxlength="12" required>
  <label>统一身份认证密码</label>
  <input type="password" name="password" placeholder="留空则每次在浏览器里自己输" autocomplete="off">
  <div class="row"><input type="checkbox" name="remember" checked><span>记住密码（本机加密保存，只有你的 Windows 账号能解开）</span></div>
  <button type="submit">保存并开始</button>
</form>
${msg ? `<div class="msg ${ok ? "ok" : "err"}">${msg}</div>` : ""}
<div class="hint">保存后回到对话窗口，说一句「帮我报销」即可。<br>不想记密码也没关系：下次会弹浏览器让你登录一次，勾「7天免登录」。</div>
</div></body></html>`;

function saveCreds(user, pass) {
  return new Promise((res) => {
    const f = join(tmpdir(), `ywtb-cred-${Date.now()}.json`);
    writeFileSync(f, JSON.stringify({ user, pass }), "utf8");
    execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", CRED, "-Action", "import", "-File", f],
      { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
        try { unlinkSync(f); } catch {}
        res({ ok: !err && /SAVED/.test(stdout || ""), out: (stdout || "") + (stderr || "") });
      });
  });
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page());
    return;
  }
  if (req.method === "POST" && req.url === "/save") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on("end", async () => {
      const p = new URLSearchParams(body);
      const staffNo = (p.get("staffNo") || "").trim();
      const password = p.get("password") || "";
      const remember = p.get("remember") === "on";
      if (!/^\d{3,10}$/.test(staffNo)) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(page("工号只能填数字（3-10 位），例如 123456", false));
        return;
      }
      saveConfig({ staffNo, remember: !!(remember && password) });
      let out = "";
      if (remember && password) {
        const r = await saveCreds(staffNo, password);
        out = r.ok ? "已保存工号，密码已用 Windows 加密存在本机。" : "工号已保存，但密码保存失败（下次在浏览器里输一次即可）。";
      } else {
        out = "已保存工号。密码没保存，下次会弹浏览器让你登录一次（记得勾「7天免登录」）。";
      }
      console.log(`设置已保存：工号 ${staffNo}，记住密码=${remember && !!password}`);
      console.log("配置文件:", configPath());
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page(out + "<br>可以关掉这个页面，回到对话窗口说「帮我报销」。", true));
      setTimeout(() => process.exit(0), 1500);
    });
    return;
  }
  res.writeHead(404); res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  const cfg = readConfig();
  console.log(`设置页已启动：http://127.0.0.1:${PORT}/`);
  if (cfg.staffNo) console.log(`（当前已保存的工号：${cfg.staffNo}）`);
  console.log("请在浏览器里打开上面的地址完成设置，保存后本窗口会自动结束。");
});
