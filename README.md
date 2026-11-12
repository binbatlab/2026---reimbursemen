# 西电报销助手 · 安装与使用

给老师的说明：装一次，以后把发票丢给 AI，它负责填到"就差你点提交"。

## 第一次用（30 秒，只填一次工号密码）

1. 把发票压缩包丢给 AI，说一句「**帮我报销**」
2. AI 会**自动弹出本地设置页**（地址形如 `http://127.0.0.1:8799/`，端口被占用会自动换一个，以弹出的页面为准）
3. 在网页里填 **工号 + 密码**，勾「记住密码」，点「保存并开始」
   - 密码用 Windows 加密后只存在这台电脑，别人的账号解不开
4. 之后每次：AI 自动登录 → 读票 → 校验 → 填单 → **停在提交前**，由你自己点提交

不想记密码也行：不勾「记住密码」，每次会弹浏览器让你登录一次（记得勾「7天免登录」）。
**全程不需要在 PowerShell 里配任何环境变量。**

## 它能做什么

- 读发票（PDF / OFD / 照片转的 PDF 需注意），抽出票号、金额、税额、日期、行程
- 先自检一遍：票号重复、金额不闭合、购买方税号不对、行程对不上发票 —— 有问题先拦住
- 自动登录财务系统，打开对应的报销模块
- 把"经费项目、出差事由、职称职别"这类必须你定的字段，做成一个本地网页让你填
- 按你的选择填单、挂发票、填行程单，填完回读核对
- **停住**，把核对清单给你，你自己点提交

## 装什么

| 需要 | 说明 |
|---|---|
| Windows 10/11 | 依赖 PowerShell |
| **DeepSeek Harness 桌面版** | skill 的宿主，必须装 |
| **Chrome** | 没有 Chrome 会自动退回 Edge（Windows 自带） |
| Node.js | **不用装**，DSH 自带 |
| Python + pypdf | **不用装**，包里已内置（`runtime/`，约 24 MB） |

## 安装

1. 解压这个文件夹到：

   ```
   C:\Users\<你的用户名>\.dsh\skills\ywtb-reimburse
   ```

2. 重启 DeepSeek Harness（或新开会话），输入框敲 `/` 应该能看到 `ywtb-reimburse`。

3. 自检一下（可选）：

   ```powershell
   powershell -File scripts\launch.ps1 -CheckOnly
   ```

   看到 `RESULT: OK` 就说明环境齐了。

## 第一次使用

1. **登录财务系统一次**：让 AI 执行登录，在弹出的 Chrome 窗口里输账号密码，勾「7天免登录」。
   会话存在专用 Chrome 配置里（`%LOCALAPPDATA%\ywtb-skill\profile`），不影响你日常浏览器。
2. **（可选）保存密码**：想以后完全不输，选「永久免密」模式，密码用 Windows DPAPI 加密存本机，绑定你的账户。

## 日常使用

把发票压缩包或文件夹丢给 AI，说一句"帮我报销"。流程是：

```
1. 解压 + 提取文本   extract_invoices.py
2. 解析 + 校验       invoice_parse.py      → 0 错误才继续
3. 弹出确认页        confirm_server.mjs    → http://127.0.0.1:8787/
4. 自动填单          fill_travel.mjs
5. 你核对 → 你自己点提交
```

命令行也可以单独跑：

```powershell
powershell -File scripts\launch.ps1 -Script extract_invoices.py -ScriptArgs "invoices\raw","invoices\raw\texts.json"
powershell -File scripts\launch.ps1 -Script invoice_parse.py
powershell -File scripts\launch.ps1 -Script confirm_server.mjs
powershell -File scripts\launch.ps1 -Script fill_travel.mjs
```

## 分发给其他老师

把 `ywtb-reimburse.zip` 直接发给对方，解压到 `~\.dsh\skills\` 即可。

**分发前确认包里没有这些**：

| 不要打包 | 原因 |
|---|---|
| `.browser-profile/` | 你的登录 Cookie |
| `.ywtb.cred` | 你的加密密码 |
| `invoices/`、`finance_recon/` | 你的发票和截图 |

同一个包里所有老师共用代码，但**凭据必须各人自己录一次**——DPAPI 绑定用户账户，别人的加密文件你解不开，这是设计如此。

## 常见问题

**Q: 提示要重新登录？**
A: 会话过期（7–14 天）。让 AI 重新登录，或自己登一次。

**Q: 浏览器起不来 / 调试端口占不上？**
A: 先关掉所有 Chrome；脚本用的是独立配置。若系统有限制，可能需要一次管理员授权。

**Q: 提示"职工号错误"？**
A: 报销人框里残留了内容。清空后重输工号再回车。

**Q: 保存报错说"请填写出差地点"，但框是灰的？**
A: 那是系统模板的缺陷——字段被写成 `disabled`，但本意是可填。`fill_travel.mjs` 会自动解除禁用再赋值。

**Q: 填到一半想退出？**
A: 直接关掉那个 Chrome 标签，单据不会保存。已保存的草稿在【未提交单据】里可删除。

## 安全说明

- 本地确认页只监听 `127.0.0.1`，外部访问不到。
- 发票会进入 AI 上下文用于识别——**涉密材料不要用**，学校也明令"涉密不上网"。
- 最终提交永远由你本人完成，脚本不会代点。
