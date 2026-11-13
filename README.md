# 西电报销助手（ywtb-reimburse）

把「一堆发票」变成「一张填好的报销单」，最后一步永远留给人点。

> 版本：2026.11.13 · 适用：西安电子科技大学 一网通办 / 网上自助报账平台
> 覆盖：**国内差旅报销**（`clfbx_simple.aspx`）与**电子发票无纸化报销**（`TSingFPKSBX.aspx`）

---

## 它替你做什么

```
发票文件夹/压缩包
   ↓  extract_invoices.py    提取 PDF 文本
   ↓  invoice_parse.py       识别 + 自检（票号、金额闭合、购买方税号、行程配对）
   ↓  confirm_server.mjs     本地确认页（8787）：项目/事由/职称/住宿/审核人由你定
   ↓  fill_travel.mjs        建单 → 主信息 → 住宿明细 → 挂票 → 行程单 → 支付方式
   ↓                         → 提交线上审批 → 审批单加担保人 → 上传「发票以外」的附件
   ↓
停在审批单，等你自己点【确认提交审批】
```

**红线**：不代点提交、不伪造票号金额、解析不出来就报错不猜。

---

## 装什么

| 需要 | 说明 |
|---|---|
| Windows 10/11 | 依赖 PowerShell |
| DeepSeek Harness 桌面版 | skill 宿主 |
| Chrome | 没有会退回 Edge |
| Node.js | **不用装**，DSH 自带 |
| Python + pypdf | **不用装**，`runtime/` 已内置（约 24 MB） |

## 安装

1. 解压到 DSH 的工作区 skills 目录（或 `~\.dsh\skills\`）：

   ```
   ...\deepseek-harness\default-workspace\skills\ywtb-reimburse
   ```

2. 重启 DeepSeek Harness（或新开会话），输入 `/` 能看到 `ywtb-reimburse`。

3. 自检：

   ```powershell
   powershell -File scripts\launch.ps1 -CheckOnly
   ```

   `RESULT: OK` 即可（会检查 Node / 内置 Python / Chrome / 调试端口 9222）。

## 第一次用

- 没有 `.ywtb.config.json` 时会自动弹**设置页**（`127.0.0.1:8799`），填 **工号 + 密码**。
- 密码用 Windows DPAPI 加密存 `.ywtb.cred`，绑定当前 Windows 账户；不勾「记住密码」就每次在浏览器里登一次（勾「7 天免登录」）。
- 登录态存在专用 Chrome 配置 `%LOCALAPPDATA%\ywtb-skill\profile`，不影响日常浏览器。

## 日常使用

把发票压缩包（或文件夹）丢给 AI，说一句「**帮我报销**」，然后：

1. AI 解析发票，0 错误才继续；
2. 弹出**确认页** `http://127.0.0.1:8787/`：核对经费项目、出差事由、职称、住宿、审核人 → 点【确认，继续填单】；
3. 自动跑到审批单（约 6–8 分钟），过程中不用管；
4. 在审批单核对金额、附件、担保人 → **你自己点【确认提交审批】**。

命令行也能跑：

```powershell
$env:YWTB_WORKDIR = "D:\报销\2026-11"      # 放发票和产物的目录
powershell -File scripts\launch.ps1 -Script scripts\run.mjs
```

单步执行：

```powershell
powershell -File scripts\launch.ps1 -Script extract_invoices.py -ScriptArgs "invoices\raw","invoices\raw\texts.json"
powershell -File scripts\launch.ps1 -Script invoice_parse.py
powershell -File scripts\launch.ps1 -Script confirm_server.mjs
powershell -File scripts\launch.ps1 -Script fill_travel.mjs
```

## 填报规则（跟系统对齐，别想当然）

| 项 | 规则 |
|---|---|
| 飞机行 | 只挂机票 |
| 汽车行 | 只挂汽车票（网约车/出租车/大巴都算「汽车」，**不看票种**） |
| 汽车费按天 | ≤ 80 元/天 → 不交票，在「市内交通补助」填**天数**；> 80 元/天 → 交票挂**汽车行**，当天不再领补助 |
| 住宿 | 包干时**金额不用填**，系统按「城市 × 淡季天数」自动算；「包干/不包干」变灰不可选 = 住宿明细生效 |
| 出差地点 | **不用填**，住宿明细保存后系统自动带出 |
| 职称职别 | 住宿明细会把它改写成「08其余人员」，脚本回读后会自动改回并按确认页核对 |
| 住宿明细顺序 | 工号 → 绿色+ → 检索（省简称如 JS）→ 勾城市 → 填住宿地点 → 保存 → 淡季天数 |

## 目录

```
scripts/
  run.mjs                 唯一入口（配置→解析→草稿→项目→确认页→填单）
  setup.mjs / cred.ps1    首次设置页（工号+DPAPI 密码）
  extract_invoices.py     PDF → 文本
  invoice_parse.py        文本 → dataset.json（含一致性校验）
  confirm_server.mjs      本地确认页（8787）
  fill_travel.mjs         差旅单自动填报（主流程）
  upload_attachments.mjs  审批单「发票以外」附件上传（幂等、去重、传后核对）
  list_projects.mjs       抓可用经费项目
  portal.mjs              CAS 登录 + 进报账系统
  cdp.mjs                 零依赖 CDP 驱动
  rules.mjs               市内交通补助规则
runtime/                  内置 Python + pypdf
SKILL.md                  给 AI 看的操作手册（含踩坑表）
```

## 已知坑（都已在代码里处理）

1. **合成 click 不触发回发**：`下一步（支付方式）`、`编辑流程`、`开始上传` 必须用真鼠标事件；否则会卡在明细页 / 面板打不开 / 队列被清空。
2. **勾选「出差地区」会 `__doPostBack`**：住宿地点输入框是回发之后才渲染的，必须分两步写。
3. **保存后可能退回列表**：要回读列表金额，对不上就别继续。
4. **票夹会捡到旧票**：删掉的草稿会把发票释放回票夹，上传前要先读已有票号、只补传缺的那几张，否则「该 6 张、显示 8 张」。
5. **明细页底部「合计」是前端汇总**，挂完汽车票常常不重算（显示 1730 而实际 2403）——以列表金额 / 支付页 / 审批单为准。
6. **附件表里含发票**：只有带删除链接（`LINK_DEL`）的行才是真附件；上传后要刷新页面再核对。
7. 一张发票只能绑一张单；票夹可用为 0 时先查是不是被别的草稿占用。

## 分发给其他老师

把 `ywtb-reimburse.zip` 发给对方，解压到 `~\.dsh\skills\` 即可。

**包里不要带**：`.ywtb.config.json`（工号）、`.ywtb.cred`（加密密码）、`.browser-profile*/`（Cookie）、`invoices/`、`finance_recon/`。

凭据各人录一次——DPAPI 绑定 Windows 账户，别人的加密文件解不开，这是设计如此。

## 安全

- 本地服务只监听 `127.0.0.1`。
- 发票内容会进 AI 上下文，**涉密材料不要用**（学校明令「涉密不上网」）。
- 不把身份证、银行卡、手机号写进任何输出文件。
- 最终提交永远由本人完成。

## 更新记录

- **2026-11-13**：住宿明细按真实顺序（真点勾选→回发→填地点）、金额交系统算；汽车票统一挂汽车行并按 80 元/天分补助与实报；支付方式/审批流程/附件上传全自动化；票夹只补传缺的票；附件识别以 `dataset.json` 为准。
- **2026-11-12**：首版（解析、确认页、差旅填报、行程单、挂票）。
