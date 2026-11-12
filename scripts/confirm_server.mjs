import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { readConfig, saveConfig } from "./config.mjs";
import { cityTransportPlan } from "./rules.mjs";

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

  let projects = [];
  try { projects = JSON.parse(readFileSync(resolve(ROOT, "invoices", "projects.json"), "utf8").replace(/^\uFEFF/, "")); } catch { /* 没有清单就退化成输入框 */ }

  let ds = null;
  try { ds = JSON.parse(readFileSync(resolve(ROOT, "invoices", "dataset.json"), "utf8").replace(/^\uFEFF/, "")); } catch { /* 没有解析结果就跳过 */ }

  // 住宿：优先带出上次填的，其次带出检测到的住宿发票（天数/金额）；都为空就留给用户填
  let hotel = { count: 0, nights: 0, total: "0.00" };
  if (ds) {
    const hs = (ds.invoices || []).filter((i) => i.kind === "住宿");
    hotel = {
      count: hs.length,
      nights: hs.reduce((s, i) => s + (Number(i.nights || i.qty) || 0), 0),
      total: hs.reduce((s, i) => s + Number(i.total || 0), 0).toFixed(2),
    };
  }

  // 住宿天数/金额：由用户按实际填，这里只负责带出（上次的 > 发票检测值 > 空）
  const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? 0 : Number(v));
  const lastDays = last ? num(last.hotelDays) : 0;
  const lastAmount = last ? num(last.hotelAmount) : 0;
  const hotelDays = lastDays > 0 ? String(lastDays) : (hotel.nights > 0 ? String(hotel.nights) : "");
  const hotelAmount = lastAmount > 0 ? lastAmount.toFixed(2) : (Number(hotel.total) > 0 ? hotel.total : "");
  let hotelMode = (last && last.hotelMode) || (num(hotelAmount) > 0 ? "invoice" : (num(hotelDays) > 0 ? "baogan" : "none"));
  const projectForRule = String((last && last.project) || d.project || "").trim();
  if (/^2/.test(projectForRule)) hotelMode = "invoice";   // 2 开头：必须不包干

  // 市内交通补助：每天 ≤80 领包干、不挂票；>80 该天挂票实报
  const people = (last && num(last.people)) || 1;
  const transport = ds ? cityTransportPlan(ds, people) : { ok: false, why: "没有解析结果" };

  // 审批人：上次确认页填的优先，其次用记住的默认值
  const aps = (last && Array.isArray(last.approvers) && last.approvers.length)
    ? last.approvers
    : (cfg.defaultApprovers || []);
  return {
    project: (last && last.project) || d.project || "",
    projects,
    reason: (last && last.reason) || draft.reason || "",
    title: (last && last.title) || d.title || "",
    hotel: hotelMode,
    hotelMode,
    hotelDays,
    hotelAmount,
    hotelInfo: hotel,
    dateFrom: (last && last.dateFrom) || (ds && (ds.itineraries || []).flatMap((it) => (it.trips || []).map((t) => t.date)).filter(Boolean).sort()[0]) || "",
    dateTo: (last && last.dateTo) || (ds && (ds.itineraries || []).flatMap((it) => (it.trips || []).map((t) => t.date)).filter(Boolean).sort().slice(-1)[0]) || "",
    cities: (last && last.cities) || (() => {
      if (!ds) return "";
      const all = (ds.itineraries || []).flatMap((it) => (it.trips || []).map((t) => t.city)).filter(Boolean);
      const uniq = [...new Set(all)];
      const dest = uniq.length > 1 ? uniq.slice(1) : uniq;
      return dest.join("/");
    })(),
    hotelCity: (last && last.hotelCity) || (() => {
      if (!ds) return "";
      const all = (ds.itineraries || []).flatMap((it) => (it.trips || []).map((t) => t.city)).filter(Boolean);
      const uniq = [...new Set(all)];
      return (uniq.length > 1 ? uniq.slice(1) : uniq).slice(-1)[0] || "";
    })(),
    hotelInvoices: (last && Number(last.hotelInvoices)) || (hotel.count > 0 ? 1 : 0),
    name: (last && last.name) || "",
    people,
    transport,
    car: (last && last.car) || d.car || "qiche",
    remark: (last && last.remark) || draft.remark || "",
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
  pick('car', d.car); pick('pay', d.payMethod); setVal('project', d.project);
  // 有项目清单 → 文本框升级成下拉，用户只需选
  var pj = d.projects || [];
  var pin = document.getElementById('project');
  if (pin && pj.length) {
    var sel = document.createElement('select');
    sel.id = 'project';
    sel.style.cssText = 'width:100%;box-sizing:border-box;padding:10px 12px;font-size:15px;border:1px solid #d0d5dd;border-radius:8px';
    var opts = ['<option value="">请选择经费项目…</option>'];
    pj.forEach(function (p) {
      var label = p.code + '  ' + String(p.name || '').slice(0, 26) + (p.balance ? '（余额 ¥' + p.balance + '）' : '');
      opts.push('<option value="' + p.code + '">' + label + '</option>');
    });
    sel.innerHTML = opts.join('');
    if (d.project) sel.value = d.project;
    pin.parentNode.replaceChild(sel, pin);
  }
  setVal('hotelDays', d.hotelDays); setVal('hotelAmount', d.hotelAmount); setVal('people', d.people);
  setVal('hotelCity', d.hotelCity); setVal('hotelInvoices', d.hotelInvoices);
  setVal('dateFrom', d.dateFrom); setVal('dateTo', d.dateTo); setVal('cities', d.cities);
  // 住宿模式：2 开头强制不包干；9 开头用户可选
  function applyHotelRule() {
    var pv = (document.getElementById('project') || {}).value || '';
    var forced = /^2/.test(String(pv).trim());
    var bg = document.querySelector('input[name="hotelMode"][value="baogan"]');
    var iv = document.querySelector('input[name="hotelMode"][value="invoice"]');
    var note = document.getElementById('hotelModeNote');
    if (forced && iv) {
      iv.checked = true;
      if (bg) bg.disabled = true;
      if (note) note.innerHTML = '项目号 <b>' + pv + '</b> 是 2 开头 → <b>必须不包干（按发票实报）</b>，已锁定';
    } else {
      if (bg) bg.disabled = false;
      if (note) note.innerHTML = '项目号 <b>' + (pv || '—') + '</b> 是 9 开头 → <b>包干、不包干都可以</b>，按实际情况选';
    }
  }
  (function () {
    var want = d.hotelMode || 'baogan';
    var el = document.querySelector('input[name="hotelMode"][value="' + want + '"]');
    if (el) el.checked = true;
  })();
  applyHotelRule();
  var psel = document.getElementById('project');
  if (psel) psel.addEventListener('change', applyHotelRule);
  // 住宿提示：天数/金额由用户按实际填，包干与否系统判定
  var hi = document.getElementById('hotelInfo');
  if (hi) {
    var h = d.hotelInfo || {};
    if (h.count > 0) {
      hi.innerHTML = '检测到 <b>' + h.count + '</b> 张住宿发票，共 <b>' + h.nights + '</b> 晚，合计 <b>¥' + h.total +
        '</b> —— 已带出，按实际核对修改';
    } else {
      hi.innerHTML = '未检测到住宿发票 —— 按实际住宿填天数和金额；不住都填 0';
    }
  }
  // 市内交通补助：每天 ≤80 领 80 元/天补助（不交票）；>80 该天交票实报
  var ti = document.getElementById('transportInfo');
  if (ti) {
    var tp = d.transport || {};
    if (!tp.ok) {
      ti.innerHTML = '没有行程/网约车数据（' + (tp.why || '解析结果缺失') + '），市内交通补助请按实际填';
    } else {
      var rows = (tp.days || []).map(function (x) {
        var tag = x.mode === 'actual'
          ? '<span style="color:#b45309">超 80 → 交票实报（不领当天补助）</span>'
          : '<span style="color:#047857">≤ 80 → 领 80 元/天补助（不交票）</span>';
        return '<div>' + x.date + '　网约车 <b>¥' + Number(x.amount).toFixed(2) + '</b>　' + tag + '</div>';
      }).join('');
      var head = '<div>' + tp.dayCount + ' 天 · ' + tp.persons + ' 人 · 补助标准 ¥' + tp.rate + '/人/天　网约车合计 ¥' +
        Number(tp.carTotal).toFixed(2) + '</div>';
      var foot = tp.subsidyDays > 0
        ? '<div style="margin-top:8px"><b>市内交通补助填 ¥' + Number(tp.subsidyAmount).toFixed(2) + '</b>（' +
          tp.subsidyDays + ' 天 × ¥' + tp.rate + ' × ' + tp.persons + ' 人）；汽车行交票 ' + tp.attach.length +
          ' 张 ¥' + Number(tp.actualAmount).toFixed(2) + '</div>'
        : '<div style="margin-top:8px"><b>市内交通补助填 0</b>；汽车行交票 ' + tp.attach.length +
          ' 张 ¥' + Number(tp.actualAmount).toFixed(2) + '</div>';
      if (tp.unassigned && tp.unassigned.length) {
        foot += '<div style="margin-top:6px;color:#b45309">另有 ' + tp.unassigned.length +
          ' 张网约车票没有行程单日期（¥' + Number(tp.unassignedAmount).toFixed(2) + '），按实报处理、一起交票</div>';
      }
      ti.innerHTML = head + '<div style="margin-top:6px">' + rows + '</div>' + foot;
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

// —— 点「确认」后自动接着填报（不用回对话窗口）——
let autofill = { running: false, code: null, lines: [] };

function startAutofill() {
  if (autofill.running) return;
  autofill = { running: true, code: null, lines: ["开始自动填报…"] };
  const push = (s) => {
    autofill.lines.push(...String(s).split(/\r?\n/).filter((x) => x.trim()));
    if (autofill.lines.length > 500) autofill.lines.splice(0, autofill.lines.length - 500);
  };
  const override = process.env.YWTB_AUTOFILL_CMD;
  const child = override
    ? spawn(override, { shell: true, env: process.env, windowsHide: true })
    : spawn(process.env.YWTB_POWERSHELL || "powershell", [
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", resolve(import.meta.dirname, "launch.ps1"),
        "-Script", "scripts\\fill_travel.mjs",
      ], { env: { ...process.env, YWTB_WORKDIR: ROOT }, windowsHide: true });

  child.stdout?.on("data", push);
  child.stderr?.on("data", push);
  child.on("exit", (code) => {
    autofill.running = false;
    autofill.code = code;
    push(code === 0 ? "✅ 填报完成：已停在支付方式页，请核对后自己点提交。" : `⚠️ 填报进程结束，返回码 ${code}`);
  });
  child.on("error", (e) => { autofill.running = false; autofill.code = -1; push("启动失败: " + e.message); });
}

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
        // 住宿天数/金额规范化；hotel 只做兼容标记，包干与否由系统按城市/天数/金额判定
        const hd = Number(data.hotelDays) || 0;
        const ha = Number(data.hotelAmount) || 0;
        data.hotelDays = hd > 0 ? hd : 0;
        data.hotelAmount = ha > 0 ? Number(ha.toFixed(2)) : 0;
        // 尊重前端选的包干/不包干；2 开头项目强制不包干
        const forced = /^2/.test(String(data.project || "").trim());
        data.hotelMode = forced ? "invoice" : (data.hotelMode || (data.hotelAmount > 0 ? "invoice" : "baogan"));
        data.hotel = data.hotelDays > 0 ? data.hotelMode : "none";
        data.hotelInvoices = data.hotelMode === "invoice" && data.hotelDays > 0 ? Number(data.hotelInvoices || 1) : 0;
        data.people = Math.max(1, Math.floor(Number(data.people) || 1));
        data._submittedAt = new Date().toISOString();
        mkdirSync(resolve(ROOT, "invoices"), { recursive: true });
        writeFileSync(CONFIRM, JSON.stringify(data, null, 1), "utf8");
        // 记住「下次可以直接带出」的字段（项目/事由这类每张单都变的不记全文，只记偏好）
        saveConfig({
          defaultApprovers: (data.approvers || []).filter((a) => a && a.no),
          defaults: {
            title: data.title || "",
            car: data.car || "",
            payMethod: data.payMethod || "",
          },
        });
        console.log("收到确认:", JSON.stringify(data));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, autofill: true }));
        // 回应写完再启动，避免阻塞
        setTimeout(() => { try { startAutofill(); } catch (e) { console.error("自动填报启动失败:", e.message); } }, 300);
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/status") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      running: autofill.running,
      code: autofill.code,
      lines: autofill.lines.slice(-120),
    }));
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
