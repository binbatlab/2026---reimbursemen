import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, saveConfig } from "./config.mjs";

const ROOT = process.env.YWTB_WORKDIR || resolve(import.meta.dirname, "..");
const BASE_PORT = Number(process.env.CONFIRM_PORT || 8787);
let PORT = BASE_PORT;
const { execFile } = await import("node:child_process");
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

  // 住宿：有发票就走实报（不包干），并带出天数/金额；没有就包干
  let hotel = { count: 0, nights: 0, total: "0.00" };
  try {
    const ds = JSON.parse(readFileSync(resolve(ROOT, "invoices", "dataset.json"), "utf8").replace(/^\uFEFF/, ""));
    const hs = (ds.invoices || []).filter((i) => i.kind === "住宿");
    hotel = {
      count: hs.length,
      nights: hs.reduce((s, i) => s + (Number(i.nights || i.qty) || 0), 0),
      total: hs.reduce((s, i) => s + Number(i.total || 0), 0).toFixed(2),
    };
  } catch { /* 没有解析结果就跳过 */ }

  // 审批人：上次确认页填的优先，其次用记住的默认值
  const aps = (last && Array.isArray(last.approvers) && last.approvers.length)
    ? last.approvers
    : (cfg.defaultApprovers || []);
  return {
    project: (last && last.project) || d.project || "",
    reason: draft.reason || (last && last.reason) || "",
    title: (last && last.title) || d.title || "",
    hotel: hotel.count > 0 ? "invoice" : ((last && last.hotel) || d.hotel || "baogan"),
    hotelInfo: hotel,
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
  // 住宿发票提示：有票 → 实报（不包干），没有 → 包干
  var hi = document.getElementById('hotelInfo');
  if (hi) {
    var h = d.hotelInfo || {};
    if (h.count > 0) {
      hi.innerHTML = '检测到 <b>' + h.count + '</b> 张住宿发票，共 <b>' + h.nights + '</b> 晚，合计 <b>¥' + h.total +
        '</b> → 按<b>实报（不包干）</b>，天数和金额会自动填进单据';
    } else {
      hi.innerHTML = '未检测到住宿发票 → 按<b>包干</b>处理（不填天数和金额）';
    }
  }
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

function tryListen(port, attempt = 0) {
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && attempt < 20) { PORT = port + 1; tryListen(PORT, attempt + 1); }
    else { console.error("确认页启动失败:", e.message); process.exit(1); }
  });
  server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}/`;
  const v = lastValues();
  console.log(`确认页已启动: ${url}`);
  if (v.hadLast) console.log("（已带出上次填写的内容，可直接确认或修改）");
  if (v.approvers.length) console.log(`（记住的审批人：${v.approvers.map((a) => a.no).join(", ")}）`);
  if (!process.argv.includes("--no-open")) {
    try { execFile("rundll32", ["url.dll,FileProtocolHandler", url], { windowsHide: true }); } catch {}
    console.log("已自动打开浏览器；保存后本窗口结束。");
  }
  });
}
tryListen(BASE_PORT);
