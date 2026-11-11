# AGENTS.md

面向在本仓库里改代码的 agent（也包括人）。这里只写"改东西时必须遵守的东西"，不复述 README。

## 目标环境

- Windows 10/11。运行脚本的是 **Windows PowerShell 5.1**（`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`）。
  本机没有 PowerShell 7，`pwsh` 这个名字解析到的就是 5.1。不要假设 `pwsh` 是 7。
- Node 22.19+ 或 24+；包管理器 pnpm 11.7.0（`vendor/upstream.lock.json` 里钉着）。
- `dsh` 在 PATH 里，版本落在上游 `engines.dsh`（`^0.2.1-alpha.2`）范围内。

## 硬约束

1. **`.ps1` 必须带 UTF-8 BOM。** 5.1 读无 BOM 文件按 ANSI 解码，中文注释会吃掉后面的引号与换行，
   报出一串与真实原因无关的语法错误。改动任何 `.ps1` 后跑 `scripts/test-scripts.ps1` 复核；
   编辑器保存时丢了 BOM 就跑 `scripts/fix-encoding.ps1` 补回来，不要手工加。
   `Encoding.GetBytes` **不产生** BOM，写 BOM 必须把 `GetPreamble()` 的字节拼到内容前面——
   只 `WriteAllBytes(GetBytes($text))` 得到的文件仍然没有 BOM。
2. **只用 5.1 有的语法与参数。** 禁止 `??`、`?:`、`-AsHashtable`、`-Encoding utf8NoBOM`、`Invoke-RestMethod -NoProxy`。
   文件读写走 `common.ps1` 的 `Read-Utf8Text` / `Write-Utf8Text`；HTTP 走 `Invoke-JsonGet`。
3. **不复制上游源码。** `upstream/` 是构建产物，被 `.gitignore` 忽略；上游版本只由 `vendor/upstream.lock.json` 决定。
   要升级上游就改那个 commit，别改 `upstream/` 里的文件。
4. **退出码不许改语义。** 0 正常、1 未运行/双实例/runtime 报错、2 非 runtime 组件报错、3 等待 setup。
   `watchdog.ps1` 与计划任务按这四个码分流，改成二值退出码等于让巡检失效。
5. **不打印凭据。** 不要 `echo` `gh` token、`.credentials.yaml` 内容、`lark` app secret。`gh-agent` / `lark-bot`
   包装器存在的意义就是让凭据留在自己的配置目录里。
6. **只监听 `127.0.0.1`。** 面板与 Management API 都绑定回环；不要为了"方便访问"改成 `0.0.0.0`——
   上游的 Host 校验和 `x-orchestrator-request` 头是唯一的防线。

## 改完必须做的验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-encoding.ps1 -Check   # BOM + CRLF，只查不写
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-scripts.ps1   # BOM + 语法 + 点源引用
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\doctor.ps1          # 14 项环境体检
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-superagent.ps1 status
```

`build.ps1` 只在改了 `vendor/upstream.lock.json` 或构建流程时才需要重跑（要联网、要几分钟）。

## 目录约定

- `scripts/` 放可执行脚本，一个动作一个文件；共用函数只进 `scripts/lib/common.ps1`，别再开新的 lib 文件。
- `config/` 放"要给用户抄进自己环境"的东西：样板 YAML、prepare 命令。这里的文件要能被直接改路径后使用。
- `docs/` 按主题分文件，`00-*` 到 `04-*` 的编号是阅读顺序；新增文档给下一个编号，不要插号。
- `vendor/upstream.lock.json` 是构建的唯一事实来源，改它等于换上游版本，commit message 要写清换了什么。

## 提交

- 一个 commit 一件可描述的事。commit message 用祈使句，中文或英文都行，但要在同一仓库里保持一致。
- 不提交 `upstream/`、`.artifacts/`、`state/`、`local/`、`*.local.yml`、`node_modules/`。
- 改动脚本行为时，在同一个 commit 里同步 `docs/`（尤其 `docs/01-windows-deltas.md` 的差异表）。
