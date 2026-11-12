// 唯一入口：一站到底，但**一定先让用户在窗口里填**。
//   1) 没有配置 → 打开设置页（工号+密码，记住 7 天）
//   2) 解析发票 → 生成草稿 → 打开确认页（项目/住宿/支付/审批人）
//   3) 等用户在页面上点「确认」→ 自动接着填报到审批单 → 停下等用户提交
//
//   node run.mjs            # 正常流程
//   node run.mjs --skip-confirm   # 仅供调试：跳过确认页（生产不要用）
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig } from "./config.mjs";

const ROOT = process.env.YWTB_WORKDIR || resolve(import.meta.dirname, "..");
const NODE = process.execPath;
const S = (n) => resolve(import.meta.dirname, n);
const SKIP = process.argv.includes("--skip-confirm");

const log = (m) => console.log(m);
const die = (m) => { console.error("\n❌ " + m); process.exit(2); };

const PY = resolve(import.meta.dirname, "..", "runtime", "python", "python.exe");

function runNode(script, args = [], { env = {} } = {}) {
  log(`\n▶ ${script} ${args.join(" ")}`);
  const isPy = script.endsWith(".py");
  const bin = isPy ? PY : NODE;
  const r = spawnSync(bin, [S(script), ...args], {
    cwd: ROOT, stdio: "inherit", env: { ...process.env, YWTB_WORKDIR: ROOT, ...env },
  });
  if (r.error) console.error("   启动失败:", r.error.message);
  return r.status ?? 1;
}

// 0 配置门禁：没有工号就先让用户填（设置页）
const cfg = readConfig();
if (!cfg.staffNo) {
  log("\n首次使用：打开设置页（工号 + 密码，只需一次）");
  const r = spawnSync(NODE, [S("setup.mjs")], { cwd: ROOT, stdio: "inherit", env: { ...process.env, YWTB_WORKDIR: ROOT } });
  if ((r.status ?? 1) !== 0) die("设置页没有完成，先设置工号密码再跑。");
}

// 1 解析发票（若已有 dataset.json 且比 PDF 新，就复用）
const invDir = resolve(ROOT, "invoices");
const dsPath = resolve(invDir, "dataset.json");
if (!existsSync(dsPath)) {
  log("\n没有解析结果，先解析发票（把 PDF 放在当前目录）");
  if (runNode("extract_invoices.py", [".", "invoices/raw/texts.json"]) !== 0) die("发票提取失败");
  if (runNode("invoice_parse.py") !== 0) die("发票解析失败（看上面输出）");
} else {
  log(`\n复用已有解析结果：${dsPath}`);
}

// 2 起草事由/备注 + 项目清单
runNode("draft_confirm.mjs");
if (!existsSync(resolve(invDir, "projects.json"))) {
  log("\n没有项目清单，尝试从系统抓取（需要已登录）");
  runNode("list_projects.mjs");
}

// 3 确认页：等用户填完并点确认
const confirmPath = resolve(invDir, "confirm.json");
const before = existsSync(confirmPath) ? statSync(confirmPath).mtimeMs : 0;

if (SKIP) {
  log("\n⚠️ --skip-confirm：跳过确认页（调试用）");
} else {
  log("\n▶ 打开确认页，等你在页面上点「确认，继续填单」…");
  const child = spawn(NODE, [S("confirm_server.mjs")], {
    cwd: ROOT, stdio: "inherit", env: { ...process.env, YWTB_WORKDIR: ROOT },
  });
  const t0 = Date.now();
  const timeoutMs = 30 * 60_000;
  let confirmed = false;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1500));
    if (existsSync(confirmPath) && statSync(confirmPath).mtimeMs > before) { confirmed = true; break; }
  }
  // confirm 服务自己会拉起 fill_travel（点确认时），这里只负责等它结束
  if (!confirmed) {
    try { child.kill(); } catch {}
    die("确认页等了 30 分钟仍然没有收到确认，先停在这里。");
  }
  log("\n✅ 收到确认，等待自动填报结束…");
  await new Promise((r) => {
    child.on("exit", r);
    setTimeout(() => { try { child.kill(); } catch {} r(); }, 15 * 60_000);
  });
  process.exit(0);
}

// 4（仅 --skip-confirm）直接填报
if (!existsSync(confirmPath)) die("没有 confirm.json，无法填报");
process.exit(runNode("fill_travel.mjs"));
