# 01 · Windows 与上游的差异清单

上游只发布了 POSIX 部署路径：控制脚本假设 `fcntl`、`tmux`、`ps`、`SIGINT`，执行环境假设 `sh`，账号包装器是 `#!/bin/sh`，`docs/006-deployment.md` 全文没有出现 Windows / win32 / pwsh 中的任何一个词。本仓库不改上游一行代码：上游按 commit 锁死后原样构建（`vendor/upstream.lock.json`），差异全部落在 `scripts/` 与 `config/`。下面每条都按同一结构写——上游怎么做（文件:行）→ Windows 上为什么不行 → 本仓库怎么替代（脚本:行）。

| # | 上游依赖 | Windows 上的问题 | 本仓库替代 |
| --- | --- | --- | --- |
| 1 | `fcntl.flock`、`ps`、`tmux`、`SIGINT` | 四样都没有 | `scripts/dsh-superagent.ps1` |
| 2 | 退出码 0/1/2/3 与 status JSON | 无（语义必须照搬） | 同一脚本，`Get-Outcome` / `New-StatusJson` |
| 3 | tmux 会话 + 每小时巡检 | 无 tmux、注销即停 | `scripts/register-task.ps1` + `scripts/watchdog.ps1` |
| 4 | `bash-sandbox` / `tool-bash` | bundle 已按平台切，无需改 | 不启用 bash 工具；prepare 仍需 `sh` |
| 5 | `#!/bin/sh` 的 `gh-agent` / `lark-bot` | shebang 与权限位不生效 | `scripts/new-agent-cli.ps1` 生成 `.cmd` |
| 6 | 绝对 `stateDir` | 空格/中文/长路径 | `scripts/install.ps1` 校验 + `core.longpaths` |
| 7 | 输出与文件的 UTF-8 | 5.1 默认 ANSI 读文件、UTF-16 写管道 | 脚本带 BOM + 全链路显式 UTF-8（`scripts/lib/common.ps1`） |
| 8 | LF 的 `cordis.patch.yml` | autocrlf 改写行尾 | 仓库内 `.gitattributes` |
| 9 | 只监听 `127.0.0.1` | 防火墙弹窗诱导放通 | `install.ps1` 写死回环 + 提示里选取消 |
| 10 | node 22.19+、pnpm 11.7、dsh 0.2.1 | 桌面版 CLI 路径不同 | `scripts/build.ps1` + npm 全局 dsh |
| 11 | `~/.dsh` 与 `DSH_HOME` | `%USERPROFILE%\.dsh` | 一律读环境变量 |
| 12 | 停 → 备份库 → 升级 → 起 | 迁移后不可降级 | 同一顺序，命令换成脚本 |

**为什么不在 Windows 上装一层 POSIX 兼容层。** Git Bash 有 `sh` 与 `bash`，但没有 `tmux`、没有 Python 的 `fcntl`，也不改变服务随注销停止的事实；MSYS2 能补 `tmux`，代价是引入第二套路径空间（`/c/...` 与 `C:\...`），`stateDir` 与 PATH 都要翻译；WSL 能完整复刻上游，代价是把 agent 的工作树放进另一个文件系统，`gh`、仓库凭据、编辑器集成全部要重新对齐。三条路都是在 Windows 上再建一个 Linux，而本仓库要的是让上游代码在原生 Windows 上跑、失败点少而明确。

## 1 进程管理与信号

上游 `scripts/dsh-superagent`：单操作互斥用 `fcntl.flock(lock, LOCK_EX | LOCK_NB)`（:227-231）；进程发现靠 `ps`（`ps()` :53、`running()` :63、`processes()` :66）；托管靠 tmux，`start()` 里 `tmux new-session -s dsh-<profile>` 再 `new-window`（:168-182），从 `#{pane_pid}` 取服务进程号写进 `service.pid`（:181-184）；优雅停止用 `os.kill(pid, signal.SIGINT)`（:141），超时只 raise、不强杀（:145）；日志保留 20 个（:151-156）。

Windows 上不行：没有 `fcntl`（无 `flock` 语义）、没有 tmux、没有 `ps`（`Get-Process` 拿不到完整命令行，只有 `Win32_Process.CommandLine` 有）、没有 POSIX 信号（`Stop-Process` 是强杀，node 收不到"该收尾了"）。

`scripts/dsh-superagent.ps1` 逐项替代：

- 互斥：`Enter-ControlLock`（:75-90）用命名 Mutex `Local\dsh-superagent-<profile>`，`WaitOne(0)` 非阻塞，抢占失败抛错并以 1 退出；`AbandonedMutexException` 视为已获得，对应上游 :231 的加锁失败语义。
- 进程发现：`Get-ServiceProcesses`（:128-152）用 `Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'dsh.exe'"`，`Test-Serves`（:111-126）把命令行按引号分词后逐词找 `--profile <p>` 或 `--profile=<p>`，并排除带 `plugin` 子命令的调用——与上游 `serves()` 同构；`service.pid` 里的号若进程还在、又没被 CIM 扫到，也计为在跑（:141-150），防止 `dsh.exe` 之外的启动方式漏判。
- 启动：`Resolve-DshInvocation`（:259-296）先读出 npm/pnpm 的 `.cmd` shim 里写的 `node.exe` 与 `bin.js` 路径，再 `Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/c','"node" "bin.js" --profile <p> --no-open >> "<log>" 2>&1') -WindowStyle Hidden -PassThru`（:339-346）。直接起 node 而不是 `dsh.cmd`，进程树里就没有多余的 cmd 常驻，信号也落得准。
- 停止：`Send-ConsoleCtrl`（:235-255）走 `FreeConsole` → `AttachConsole(pid)` → 屏蔽本进程 Ctrl+C 处理 → `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)` → 挂回父控制台。这里用的是 **CTRL_C_EVENT 而不是 CTRL_BREAK_EVENT**：上游发的是 `SIGINT`，node 在 Windows 上把 Ctrl+C 映射成 `SIGINT`、把 Ctrl+Break 映射成 `SIGBREAK`，只有前者与上游语义对齐；也因此不需要把服务放进独立进程组，代价是目标进程必须有自己的控制台（隐藏窗口的 `cmd.exe` 有）。
- 超时：等 `--stop-timeout`（默认 300 s，对应上游 :217-218），仍未退出则返回 1、保留进程、不 `Stop-Process -Force`；只有显式 `-Force` 才强杀（:408-417），与上游 :145 一致。
- 日志：`.artifacts\dsh-superagent-<profile>-<yyyyMMdd-HHmmss>-<pid>.log`，`Remove-OldLogs`（:298-304）保留 20 个。

## 2 退出码与 status JSON

上游：`outcome()`（:112-119）把状态折成退出码，语义表在 `docs/006-deployment.md:113-124`——0 正常；1 未运行、重复启动、无应答或 runtime 报错（restart 可能修）；2 运行中但非 runtime 组件报错（restart 修不好）；3 运行中等待 setup（restart 修不好）。`status()`（:122-129）输出 JSON，字段 `pids` / `cwd` / `url` / `manually_stopped` / `health` / `errors` / `setup` / `feishu`。

`Get-Outcome`（:191-201）照搬同一判断顺序，顺序本身是有意的：进程数不等于 1 → 1；`/orchestrator/api/state` 无应答 → 1；`runtime` 不是 `ready` / `paused` → 1；有 `setup` 问题 → 3；有组件 `error` → 2；否则 0。runtime 报错在 2 之前被拦下，所以"面板打不开"永远不会被报成"某个 Source 挂了"。

`New-StatusJson`（:203-216）用 `ConvertTo-Json -Depth 6` 输出同名字段；`cwd` 填仓库根（进程的工作目录），`health` / `errors` 来自 `Get-OrchestratorState`（:154-189），后者 `Invoke-JsonGet` 带 `x-orchestrator-request: 1`，与上游 `state()`（:81-95）一致。

为什么必须逐字一致：`scripts/watchdog.ps1` 与计划任务按这四个码分流（:30-53）。如果把退出码改成"0 成功 / 1 失败"，巡检就无法区分"restart 能修"和"restart 白费"，只能一直重启。另一个坑：PowerShell 把原生命令的非零退出码放进 `$LASTEXITCODE` 而不抛异常，`Invoke-Stop`/`Invoke-Start` 因此显式构造 `@{ Code; Output }` 再 `exit $result.Code`（:459-496）。

## 3 持久化：tmux + 巡检 → 两个计划任务

上游：服务跑在 tmux 会话里，SSH 断线不影响；持久性由"另一个 profile 里的每小时 DSH 定时任务"兜底（`docs/006-deployment.md:133-141`），`--respect-stop` 让有意停机之后不被自动拉起（:141，脚本 :219-220 与 :232-234）。

Windows：没有 tmux；`Start-Process` 起的进程不受 RDP/SSH 断线影响，但注销与重启会带走它；DSH 自己是 Web 服务，没有守护能力。`scripts/register-task.ps1` 注册两个任务：

- `<prefix>-<profile>-logon`（:69-73）：`AtLogOn` 当前用户，动作 `powershell -File scripts\dsh-superagent.ps1 start -RespectStop`。
- `<prefix>-<profile>-hourly`（:61-67）：`-Once` 在 5 分钟后首次触发、`-RepetitionInterval 60 分钟`、重复 3650 天，动作跑 `scripts\watchdog.ps1`。

注册细节：principal 是 `InteractiveToken` + `RunLevel Limited`（:43，不需要管理员），settings 含 `-StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit 2h`（:45-47）。`-StartWhenAvailable` 让错过的触发在唤醒后补跑，`-MultipleInstances IgnoreNew` 防止上一次还在跑时叠一个。

`watchdog.ps1` 是上游那段巡检 prompt 的"无 agent 版"（:30-53），判断顺序：status 退出码 0 → 静默；2 或 3 → 只打印状态不重启；输出里 `"manually_stopped": true` → 跳过拉起；其余（1）→ `restart -RespectStop`，失败则附上最近日志尾部 40 行。它自己恒以 0 退出：巡检任务失败不该在计划任务里堆积错误状态。

`--respect-stop` 的载体是文件：`stop` 写 `.artifacts\control\profiles\<profile>\manually-stopped`（:392-394），`start` 清掉（:347），巡检看 marker 决定是否拉起。这与上游"marker 文件 + 判断位置"同构，只是路径从 `$HOME` 挪到了仓库下的 `.artifacts`。

## 4 shell 工具与 prepare

上游 bundle 已经按平台切好，不需要打补丁：worker preset 的 shell 组在 `cordis.patch.yml:44-62`（`bash-sandbox` 带 `disabled: !!js process.platform === 'win32'`，`pwsh-sandbox` 反之，`tool-bash` / `tool-pwsh` 成对），router preset 在 :139-162 重复同一套。

要守住两件事：

**其一，同一 profile 里不要同时启用 bash 与 pwsh 两套 shell 工具。** 模型看到两个 shell 会按措辞挑，而两者语义不同：pwsh 工具单引号不插值、反引号才是转义、管道传对象；bash 用 `$'...'`、`&&` 短路、`\` 是转义符。同一段 Ticket 指令在两种 shell 下结果不同，出问题时无法归因。注意本机 `pwsh` 这个名字解析到 PowerShell 5.1，插件名照旧叫 `pwsh-sandbox` / `tool-pwsh`，实际跑的是 5.1 语法。

**其二，prepare 命令仍按 POSIX 语义执行。** `src/executor/dsh.ts:254` 固定拼 `['sh','-c',command]`，面板文案写"用 sh 运行一次"（`src/client/locales.ts:376`），`docs/003-execution.md:51` 写明 "runs once with `sh`"。所以 `config/prepare-worktree.ps1` 是 PowerShell 写的，实际调用方式是让 `sh` 去起它：`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\...\config\prepare-worktree.ps1"`，前提是 Git for Windows 的 `sh.exe` 在 PATH 上。由此得到两条约束：prepare 命令行本身必须是 sh 能解析的单行（路径全加引号），脚本内部才用 PowerShell 语法。

`blockedCommands` 受影响更直接：拦截的实现是把 `worker-bin` 前置到 PATH（`src/infra/environment.ts:120`），而 shim 的内容是 `#!/bin/sh` 脚本（:89），gh / lark-cli / 被拦命令三者的 shim 都这么写（:100-104）。Windows 上 `#!/bin/sh` 不可执行，拦截会静默失效——不报错，只是不生效（据上游实现推断：`environment.ts:89` 写死 shebang 与 `mode: 0o755`，Windows 的 CreateProcess 不看这两样）。

## 5 账户包装器与凭据隔离

上游：`gh-agent` 与 `lark-bot` 是 `#!/bin/sh` 脚本，设置 `GH_CONFIG_DIR` / `LARKSUITE_CLI_CONFIG_DIR` 之后 exec 真正的 CLI（`docs/006-deployment.md:224`）；`worker-bin` 里的 shim 同样是 sh 脚本（`src/infra/environment.ts:87-104`），`WORKER_COMMANDS` 是 `['gh','git','lark-cli']`（:18）。

Windows 上不行：非 `.cmd` 的包装依赖 shebang 与 POSIX 权限位（`mode: 0o755`，:89），NTFS 与 cmd 都不看这两样；也没有 `exec`，父进程没法被替换掉。

`scripts/new-agent-cli.ps1` 生成 `.cmd`，默认落在 `%USERPROFILE%\.local\bin`（:20），内容（:59-67）：

```bat
@echo off
setlocal
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-agent"
"C:\Program Files\GitHub CLI\gh.exe" %*
```

- `gh` 必须 2.48+：上游文档只要求 git 2.32+（`docs/006-deployment.md:23`），没写 gh 的下限，而 `GH_CONFIG_DIR` 的隔离行为在更早版本上不一致；`doctor.ps1` 用 `gh-agent api user` 验证命中的是 agent 账号（:213-215）。
- 路径含空格必须加引号：生成时写入的是 `Resolve-Tool` 解析出的绝对路径，外面套了引号；`set "VAR=value"` 的引号位置不能挪，挪了会把引号写进变量值。
- `%*` 原样转发全部参数，但 cmd 会先解释 `& | ^ < >`，参数里含这些字符时由调用方转义。
- 文件用 `-Encoding ascii` 写（:67）：`.cmd` 带 BOM 会让 cmd 把 BOM 当成命令的一部分；内容全 ASCII，中文注释只在生成器的注释里。
- 不写 `exit /b`：`.cmd` 的退出码取最后一条命令的，`gh.exe` 的码因此直接透传。

## 6 stateDir

上游：`stateDir` 必填绝对路径（`src/deployment.ts:16`），承载数据库、锁、`worker-bin` shim、`worker-gitconfig` 与默认 Ticket 目录（`docs/006-deployment.md:95`）；`worker-bin` 会被拼进 PATH（`src/infra/environment.ts:19`、:120），`worker-gitconfig` 里有 `[user] useConfigOnly`（:106-110）。

Windows 上的两个坑：

- 空格。PATH 项里有空格，`[workerBin, path].join(delimiter)` 拼出来的串在 cmd 与部分 CLI 的 argv 处理下会断，表现是 `gh` / `lark-cli` 找不到或参数错位。`install.ps1` 因此直接拒绝：非绝对路径 throw（:75），含空白 throw（:76）；`doctor.ps1` 对同样的条件给 WARN（:145-149）。默认值是 `%USERPROFILE%\.dsh\state\<profile>`（`install.ps1:47`），用户名含空格时这个默认值会被拒绝，必须显式传 `-StateDir`。
- 长路径。Ticket 目录下会生成 `work/<ticket>/...` 与 `git worktree` 的路径，超过 260 字符时 git 与 node 的行为不一致。要求 `git config --global core.longpaths true`，`doctor.ps1` 检查并给 WARN（:79-83）。

## 7 编码与 PowerShell 版本

目标环境是 stock Windows，解释器就是系统自带的 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`（5.1；本机没有 `C:\Program Files\PowerShell`，`pwsh` 这个名字也解析到 5.1）。脚本第一行一律 `#Requires -Version 5.1`，且刻意只用 5.1 有的语法：不用 `??`、`?:`、`-AsHashtable`、`-Encoding utf8NoBOM`、`Invoke-RestMethod -NoProxy`，HTTP 走 `HttpWebRequest`，文件读写走显式编码的包装函数。

- `.ps1` 必须带 UTF-8 BOM。这是保命项，不是风格问题：5.1 读无 BOM 文件时按系统 ANSI 代码页（本机 GBK）解码，中文注释会吃掉后面的引号与换行，报出一串与真实原因无关的语法错误——错误行号、错误类型全都指向不存在的问题。`scripts/test-scripts.ps1:33-35` 逐文件检查 BOM 位，缺了直接失败，CI 也跑它。
- 运行时输出：`Set-ConsoleUtf8`（`scripts/lib/common.ps1:18-23`）把 `[Console]::OutputEncoding` 与 `$OutputEncoding` 设成 `UTF8Encoding($false)`，日志与 JSON 因此是无 BOM 的 UTF-8，`ConvertFrom-Json`、巡检与上游的 `json.load` 读得动。
- 文件读写：一律 `Read-Utf8Text` / `Write-Utf8Text`（:26-43），内部用 `[System.IO.File]` 显式指定编码，不依赖 `Get-Content` / `Set-Content` 的默认值——5.1 的默认是 ANSI，读 UTF-8 的 YAML 会乱码，写回去就毁文件。
- HTTP：`Invoke-JsonGet`（:46-79）用 `HttpWebRequest` 且 `Proxy = $null`。5.1 没有 `Invoke-RestMethod -NoProxy`，而本机配了系统代理时，`127.0.0.1` 的请求可能被代理吞掉，表现为"服务明明起着却查不到状态"。
- 不要写 `-Encoding utf8NoBOM`：那是 6.0+ 的参数。编码靠 BOM（对 `.ps1`）与 `[System.IO.File]`（对数据文件），不靠 cmdlet 参数。

## 8 CRLF 与 autocrlf

仓库内 `.gitattributes`（:4-14）固定：`*.ps1` / `*.psm1` / `*.cmd` / `*.bat` 为 `eol=crlf`，`*.yml` / `*.yaml` / `*.md` / `*.json` 为 `eol=lf`；`doctor.ps1:86` 读 `core.autocrlf` 只是提示，真正的保证在 `.gitattributes`。

理由各有出处：`.cmd` 与 `.ps1` 必须是 CRLF（cmd 对 LF-only 批处理的标签与 `goto` 处理不可靠）；`cordis.patch.yml` 必须保持 LF——它既是 bundle 的 patch 入口（`package.json:31-33`），又含 `!!js` 行内表达式（`cordis.patch.yml:47` 等），autocrlf 在 checkout 时改写行尾会让工作区与发布包里的文件不一致，与上游的 diff 也对不齐。排查这类问题先看行尾，再看内容。

## 9 端口与防火墙

上游：面板只监听 `127.0.0.1:<port>`，默认 3082（`scripts/dsh-superagent:214`）；管理 API 要求 Host 头是 `127.0.0.1:<port>` 或 `localhost:<port>`，否则 403（`docs/006-deployment.md:163`）。

`install.ps1` 把这段写进 profile 的 `cordis.patch.yml`（:129-137）：`- id: webserver` + `host: 127.0.0.1` + `port: <Port>`；样板在 `config/profile.cordis.patch.yml:15-18`。不要为了"方便访问"改成 `0.0.0.0`——上游的 Host 校验是唯一防线。

首次监听时 Defender 防火墙会弹窗，选取消，不要放通，也不要 `New-NetFirewallRule`。核对用 `Get-NetTCPConnection -LocalPort 3082 -State Listen | Select-Object LocalAddress, OwningProcess`：`LocalAddress` 必须是 `127.0.0.1`，出现 `0.0.0.0` 或 `::` 说明配置被改到了公网接口。

## 10 依赖与 CLI 来源

上游（`package.json:53-57`）：`engines.node` 为 `^22.19.0 || >=24.0.0`，`packageManager` 为 `pnpm@11.7.0`，`engines.dsh` 为 `^0.2.1-alpha.2`；部署文档另要求 git 2.32+、python 与 tmux（`docs/006-deployment.md:23`）。

Windows 上：python 与 tmux 不再是硬依赖（`dsh-superagent.ps1` 取代了 Python 脚本）；node 用 22.19+ 或 24+；pnpm 版本从上游 `packageManager` 字段读，没装 pnpm 时 `build.ps1` 退回 `npx pnpm@11.7.0`（:74-85）。

dsh 必须用 npm 全局安装的那一份（`docs/006-deployment.md:76`，本仓库用 `0.2.1-rc.3`）：`install.ps1` 在 PATH 上找不到 `dsh` 时执行 `npm install -g @deepseek-ai/dsh@0.2.1-rc.3`（:62-68），发现 `dsh.Source` 含 `app.asar` 时警告（:71-73）。桌面版自带的 CLI 版本是 `0.2.2-rc.1`，profile 与插件解析路径与独立安装不同，混用会表现为"profile 找不到插件"或版本越界；`doctor.ps1` 把这一项单列为 `dsh 独立安装`（:105-107）。插件安装仍是 `dsh plugin --profile <name> add "link:<checkout>"`（`install.ps1:119`）。

## 11 $DSH_HOME 与 profile 位置

上游默认 `~/.dsh`，可用 `DSH_HOME` 重定位（`docs/006-deployment.md:85`）。Windows 上默认是 `%USERPROFILE%\.dsh`，`install.ps1:44` 用同款回退：`if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }`。

脚本一律读环境变量，不硬编码用户名路径。理由不只是习惯：计划任务以交互式令牌运行、人工排障可能换一个账户，硬编码 `C:\Users\<name>\.dsh` 会让两边读到不同的 profile。profile 目录是 `<DSH_HOME>\profiles\<profile>`，bundle 用 `link:` 指向上游 checkout，源码不进本仓库。

## 12 升级与回滚

上游顺序（`docs/006-deployment.md:233-242`）：等 Executor 空闲 → 备份 `<stateDir>/orchestrator.sqlite` → `git pull` + `pnpm install` + `pnpm build` → `restart`。

Windows 上按同一顺序，命令换成脚本：

1. `scripts\dsh-superagent.ps1 stop`，确认退出码 0、`status` 的 `pids` 为空
2. `Copy-Item <stateDir>\orchestrator.sqlite <stateDir>\backup\orchestrator-<yyyyMMdd-HHmmss>.sqlite`
3. 改 `vendor/upstream.lock.json` 的 commit → `scripts\build.ps1`（重新 checkout、`pnpm install --frozen-lockfile`、`pnpm build`）
4. `scripts\dsh-superagent.ps1 restart`，退出码 0 才算完成；不健康就看 `status` 的 `errors` 与 `logs`

回滚的关键约束：数据库被新版本迁移后旧版本打不开（`docs/006-deployment.md:242`）。所以回滚必须先停服务、再用备份覆盖数据库，光把 lock 文件改回旧 commit 不够——代码回去了，schema 没回去。

## 未验证项

以下没有在本机跑过，不要当成已验证：

- `GenerateConsoleCtrlEvent(CTRL_C_EVENT)` 的实际传播：信号送达 attach 的控制台后，是主进程收尾退出还是另有子进程存活，取决于 dsh 对 `SIGINT` 的处理与它自己的子进程组；本机只验证了"没有服务时 status 返回 1"。
- `Stop-Process -Force` 之外的兜底：进程不响应 Ctrl+C 时的真实占比（当前策略是等满 `-StopTimeout` 返回 1，不做别的）。
- 计划任务在锁屏、睡眠跨过触发点后的补跑：`-StartWhenAvailable` 对"每 60 分钟重复"触发的行为、错过的多次触发是否合并成一次。
- `AtLogOn` 在无交互登录（仅 RDP 断开、锁屏）状态下是否执行。
- prepare 经 `sh` 调 `powershell.exe` 的实际行为：单行引号、路径含空格、`$LASTEXITCODE` 能否透传给上游的执行器。
- `blockedCommands` 的 `#!/bin/sh` shim 在 Windows 上失效后的具体后果（是否真的静默跳过、有没有可观察的报错）。
- `gh` 2.48+ 通过 `.cmd` 包装器读 `GH_CONFIG_DIR` 的行为：`doctor.ps1` 只验证 `api user` 能返回 agent 账号，未验证 push、PR 凭据在 `worker-gitconfig` 下的组合。
- 真实 GitHub Issue → Ticket → 执行 → 回写的端到端链路；飞书 Source（本机未装 `lark-cli`）。
- `stateDir` 含空格时的运行时行为：`install.ps1` 直接拒绝，因此这条路径没有被测过。
- `core.longpaths` 在 `git worktree` 与 node `fs` 混合场景下的实际边界。
