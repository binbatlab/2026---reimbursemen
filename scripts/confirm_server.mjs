import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, saveConfig } from "./config.mjs";

const ROOT = process.env.YWTB_WORKDIR || resolve(import.meta.dirname, "..");
const PORT = Number(process.env.CONFIRM_PORT || 8787);
const html = readFileSync(resolve(import.meta.dirname, "review.html"), "utf8");
const CONFIRM = resolve(ROOT, "invoices", "confirm.json");
const DRAFT = resolve(ROOT, "invoices", "draft.json");

function lastValues() {
  let last = null;
  try {
    if (existsSync(CONFIRM)) last = JSON.parse(readFileSync(CONFIRM, "utf8").replace(/^\uFEFF/, ""));
  } catch { /* 忽略 */ }
  const cfg = readConfig();
  const d = cfg.defaults || {};
  let draft = {};
  try { if (existsSync(DRAFT)) draft = JSON.parse(readFileSync(DRAFT, "utf8").replace(/^\uFEFF/, "")); } catch { /* 忽略 */ }
  // 审批人：上次确认页填的优先，其次用记住的默认值
  const aps = (last && Array.isArray(last.approvers) && last.approvers.length)
    ? last.approvers
    : (cfg.defaultApprovers || []);
  return {
    project: (last && last.project) || d.project || "",
    reason: draft.reason || (last && last.reason) || "",
    title: (last && last.title) || d.title || "",
    hotel: (last && last.hotel) || d.hotel || "none",
    car: (last && last.car) || d.car || "qiche",
    remark: draft.remark || (last && last.remark) || "",
    payMethod: (last && last.payMethod) || d.payMethod || "private_self",
    approvers: aps,
    hadLast: !!last,
  };
}

const FILL_JS = `
(function () {
  var d = {};
  try { d = JSON.parse(document.getElementById('prefill-data').textContent || '{}'); } catch (e) {}
  function setVal(id, v) { var el = document.getElementById(id); if (el && v != null && v !== '') el.value = v; }
  function pick(name, v) { if (!v) return; var el = document.querySelector('input[name="' + name + '"][value="' + v + '"]'); if (el) el.checked = true; }
  setVal('reason', d.reason); setVal('title', d.title); setVal('remark', d.remark);
  pick('hotel', d.hotel); pick('car', d.car); pick('pay', d.payMethod); setVal('project', d.project);
  var aps = d.approvers || [];
  aps.slice(0, 2).forEach(function (a, i) {
    setVal('ap_no' + (i + 1), a.no);
    setVal('ap_name' + (i + 1), a.name);
  });
  if (aps.length || d.hadLast) {
    var box = document.createElement('div');
    box.style.cssText = 'background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:18px';
    box.innerHTML = '已带出<b>上次填的内容</b>（含审批人），核对无误直接点「确认，继续填单」；要改就改，改完再确认。';
    document.querySelector('.card').parentNode.insertBefore(box, document.querySelector('.card'));
  }
})();
`;

const render = () => {
  const data = JSON.stringify(lastValues()).replace(/</g, "\\u003c");
  return html.replace("</body>",
    `<script id="prefill-data" type="application/json">${data}</script><script>${FILL_JS}</script></body>`);
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/review")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(render());
    return;
  }

  if (req.method === "POST" && url.pathname === "/submit") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        data._submittedAt = new Date().toISOString();
        mkdirSync(resolve(ROOT, "invoices"), { recursive: true });
        writeFileSync(CONFIRM, JSON.stringify(data, null, 1), "utf8");
        // 记住「下次可以直接带出」的字段（项目/事由这类每张单都变的不记全文，只记偏好）
        saveConfig({
          defaultApprovers: (data.approvers || []).filter((a) => a && a.no),
          defaults: {
            title: data.title || "",
            hotel: data.hotel || "",
            car: data.car || "",
            payMethod: data.payMethod || "",
          },
        });
        console.log("收到确认:", JSON.stringify(data));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  const v = lastValues();
  console.log(`确认页已启动: http://127.0.0.1:${PORT}/`);
  if (v.hadLast) console.log("（已带出上次填写的内容，可直接确认或修改）");
  if (v.approvers.length) console.log(`（记住的审批人：${v.approvers.map((a) => a.no).join(", ")}）`);
});
