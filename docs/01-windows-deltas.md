# 01 · Windows 与上游的差异清单

上游只发布了 POSIX 部署路径：控制脚本假设 `fcntl`、`tmux`、`ps`、`SIGINT`，执行环境假设 `sh`，账号包装器是 `#!/bin/sh`，`docs/006-deployment.md` 全文没有出现 Windows / win32 / pwsh 中的任何一个词。本仓库把上游源码收入仓库（基线记在 `vendor/upstream.lock.json`），差异分两类：部署侧的 Windows 等价物落在 `scripts/` 与 `config/`，逻辑侧的改造留在源码里并按 `[fork]` 标注。下面每条都按同一结构写——上游怎么做（文件:行）→ Windows 上为什么不行 → 本仓库怎么替代（脚本:行）。

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

`blockedCommands` 受影响更直接：拦截的实现是把 `worker-bin` 前置到 PATH（`src/infra/environment.ts:120`），而 shim 的内容是 `#!/bin/sh` 脚本（:89），gh / lark-cli / 被拦命令三者的 shim 都这么写（:100-104）。

**这条已经不是"推断"，是确认失效。** 两个独立原因，任何一个都足以让它不生效：

1. `environment.ts:89` 写的是 `#!/bin/sh` + `mode: 0o755`，Windows 的 CreateProcess 不看 shebang 也不看 POSIX 权限位；`worker-bin` 里没有 `gh.exe` / `gh.cmd`，所以 PATH 上的 `gh` 命中的是系统里那个真的 `gh`。
2. `environment.ts:93-98` 剥 PATH 用 `IFS=:` 的 sh 循环，`:120` 拼 PATH 用的是 node 的 `delimiter`（Windows 上 `;`）。同一个仓库里两种分隔符口径，Windows 上永远剥不干净，即使 shim 能执行也会漏。

`src/deployment.ts:73-76` 的 `workerProbe` 与 `:120` 的飞书探测同样把 `env` 当 argv[0]（`['env','PATH=…', …]`），Windows 没有 `env` 这个程序——这两条探测在真实启动时会失败，在测试里靠注入的 `probe` 掩盖了。

要让隔离在 Windows 上真的成立，需要：把 shim 改成 `.cmd`（同 §5 的 `new-agent-cli.ps1` 思路）、剥 PATH 走 `delimiter`、探测不用 `env` 前缀。这是运行时行为改动，还没做。

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

### 6.1 绝对路径校验（`[fork]` 已改）

上游 `src/deployment.ts:16` 的 `absolute()` 只认 `/^\//`。本仓库发布用的样板 `config/profile.cordis.patch.yml:24` 写的是
`stateDir: 'C:/Users/CHANGE_ME/.dsh/state/superagent'`——按上游正则这是"相对路径"，配置直接拒绝加载，Windows 部署走不通第一步。
现在改成 `[fork]` 版：

```ts
const absolute = (value: string) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value)
```

覆盖 POSIX 绝对路径、盘符路径与 UNC 路径。行上方有 `[fork]` 注释写原因。

**同类还有一处没改**：`src/policy.ts:94` 的 `directory` 字段
（`path === '' || path.startsWith('/')`）只接受 `/` 开头的值，Windows 下 `<stateDir>/work` 是 `C:/…`，会被拒。
默认值是 `''`（= `<stateDir>/work`），所以只在显式配置目录时才踩到。等执行侧的工作目录约定定下来一起动，避免改两次。

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
3. 改 `vendor/upstream.lock.json` 的 commit → `scripts\sync-upstream.ps1`（拉对照克隆、列出差异）→ 手动合并 → `pnpm test`
4. `scripts\dsh-superagent.ps1 restart`，退出码 0 才算完成；不健康就看 `status` 的 `errors` 与 `logs`

回滚的关键约束：数据库被新版本迁移后旧版本打不开（`docs/006-deployment.md:242`）。所以回滚必须先停服务、再用备份覆盖数据库，光把 lock 文件改回旧 commit 不够——代码回去了，schema 没回去。

## 13 状态目录与数据库的权限

上游用 POSIX 权限位保护状态：`src/app/store.ts:59` 建目录带 `mode: 0o700`，`:63` 对 sqlite 文件 `chmodSync(path, 0o600)`，
`src/app/runtime.ts:91` 同样建目录 0o700。库里放的是会话、凭据引用与执行记录，所以"仅属主可读写"是安全边界的一部分，不是卫生习惯。

Windows 上这两句都是空操作。实测 `statSync(...).mode & 0o777` 目录与文件都是 `0o666`——NTFS 的权限由安全描述符决定，
node 的 `mode` 只影响只读位。实际权限来自父目录 ACL 继承，也就是说 `<stateDir>` 落在谁的目录下，就继承谁的权限。

这意味着 **Windows 部署上"库文件仅属主可读"这条意图没有生效**。要补就得显式设置 ACL（`icacls <path> /inheritance:r /grant:r "<user>:(F)"`），
加在哪一层（`install.ps1` 建目录时、还是每次 `Store` 打开时）取决于是否允许用户自定义 `stateDir` 的权限模型。
本轮只记录，未改代码：`store.spec.ts` 现在只在非 win32 断权限位，Windows 侧断"目录与文件都存在"。

## 未验证项

以下没有在本机跑过，不要当成已验证：

- `GenerateConsoleCtrlEvent(CTRL_C_EVENT)` 的实际传播：信号送达 attach 的控制台后，是主进程收尾退出还是另有子进程存活，取决于 dsh 对 `SIGINT` 的处理与它自己的子进程组；本机只验证了"没有服务时 status 返回 1"。
- `Stop-Process -Force` 之外的兜底：进程不响应 Ctrl+C 时的真实占比（当前策略是等满 `-StopTimeout` 返回 1，不做别的）。
- 计划任务在锁屏、睡眠跨过触发点后的补跑：`-StartWhenAvailable` 对"每 60 分钟重复"触发的行为、错过的多次触发是否合并成一次。
- `AtLogOn` 在无交互登录（仅 RDP 断开、锁屏）状态下是否执行。
- prepare 经 `sh` 调 `powershell.exe` 的实际行为：单行引号、路径含空格、`$LASTEXITCODE` 能否透传给上游的执行器。
- `blockedCommands` 的 `#!/bin/sh` shim 在 Windows 上失效后的具体后果（是否真的静默跳过、有没有可观察的报错）。已确认失效（§4），但"用户会不会察觉"没验证过：拦截一个命令后，`gh` 仍能照常访问，且没有任何日志。
- `gh` 2.48+ 通过 `.cmd` 包装器读 `GH_CONFIG_DIR` 的行为：`doctor.ps1` 只验证 `api user` 能返回 agent 账号，未验证 push、PR 凭据在 `worker-gitconfig` 下的组合。
- 真实 GitHub Issue → Ticket → 执行 → 回写的端到端链路；飞书 Source（本机未装 `lark-cli`）。
- `stateDir` 含空格时的运行时行为：`install.ps1` 直接拒绝，因此这条路径没有被测过。
- `core.longpaths` 在 `git worktree` 与 node `fs` 混合场景下的实际边界。
- 真实 `start` 时的 setup 探测：`workerProbe` 与飞书探测都以 `env` 为 argv[0]（§4），按代码必然在 Windows 上失败，但本机没装 profile，没跑过一次真实启动去确认失败长什么样。
- 飞书实时事件消费在 Windows 上未跑过（本机没有 `lark-cli`）；按 `feishu-loops.ts:71` 的 `spawn` 形式预计 ENOENT，轮询补拉那条不 spawn CLI，预计正常。
- `scripts/dsh-superagent.ps1` 的行为契约：profile 锁、Ctrl+C 优雅停止、日志保留 20 份、退出码 0/1/2/3 只在 `doctor.ps1` 与人工操作里验证过，没有自动化断言（对应的 POSIX spec 已整组跳过，见 `docs/06-test-baseline.md`）。


## 14 插件在 Windows 上启动期的四个缺口

这一节记的是"上游代码在 Windows 上装起来之后才暴露"的问题，不是平台偏好。前两个已按 `[fork]` 修掉，后两个是剩余项。

### 14.1 主 Session 的工具白名单写死 `bash`

`src/app/sessions.ts` 恢复 Orchestrator 主会话时调用 `tools.restrict()`，名单写死
`['skill','bash','read','read_image','job_output','job_list','job_kill']`。Windows profile 里没有 `bash` 这个全局工具，
restrict 直接抛 `RemoteError: resume failed for session "orchestrator-…": tools.restrict() names unknown global tool "bash"`，
插件因此不激活，`/orchestrator/api/*` 全部 404——面板能打开，但每个请求都失败。

`[fork]` 改成 `MAIN_TOOLS = ['skill','bash','pwsh','read','read_image','job_output','job_list','job_kill']`，
再用 `agent.ctx.tools.get(name, scopeParentOf(agent))` 过滤掉本 profile 不存在的工具；`noWait` 的 shell 分支同时认 `bash` 与 `pwsh`。

### 14.2 探测 worker 环境时以 `env` 为 argv[0]

`src/deployment.ts` 的 `workerProbe` 原来拼 `runAsWorker(subprocess, ['env', 'PATH=…', ...argv])`。Windows 没有 `env`，
保存 Source 时报 `spawn env ENOENT`，界面上表现为 `agentCliSignedOut`——错误码指向账号，实际是缺一个可执行文件。

`[fork]` 改成把 PATH 放进 `runAsWorker` 的 env 参数（`{ ...process.env, PATH: path }`），argv 原样传。
`tests/runtime.spec.ts:852-856` 相应改成断言 `argv[0]` 是 CLI 本身、PATH 里没有 worker-bin。

### 14.3 `proper-lockfile` 的残留锁

硬杀进程（任务管理器、`Stop-Process`）后 `%USERPROFILE%\.dsh\state\<profile>.lock` 会留下，
下次启动 `dsh-superagent` 抛出 `Lock file is already being held` 并拒绝启动（`proper-lockfile@4.1.2`，重试次数耗完即抛）。
`scripts\watchdog.ps1` 与计划任务看不到这一类失败——进程起来了、日志为空、健康检查超时。

绕法：删掉锁目录再启动。要不要在 `dsh-superagent.ps1 start` 里加"锁存在但没人持有就清掉"的判断，待定：
判断错会制造双实例，比启动失败更糟。

### 14.4 进程识别与 `.cmd` / 无扩展名的 spawn

两个独立问题：

- `Get-ServiceProcesses` 靠命令行匹配找服务进程，而 3082 上的真实进程是 `DeepSeek Harness.exe --profile … --no-open`，
  经 `cmd /d /c` 包一层之后匹配不到。结果是 `start` 认不出已在跑的实例，`stop` 杀不干净，
  下一次启动撞上 `listen EADDRINUSE: address already in use 127.0.0.1:3082`，并在启动日志里表现为
  `2 required plugins did not activate`（`webserver` 与挂在它后面的 `dsh-superagent`、`dsh-superagent-github`）。
- Node 的 `spawn` 不解析 `.cmd`，也不执行只有 shebang 的无扩展名脚本。因此把 Source 的 `cli` 设成 `gh-agent.cmd` 会 ENOENT；
  `src/sources/feishu-loops.ts:71` 直接 spawn `lark-cli` 在 Windows 上同样起不来。GitHub Source 填 `.exe` 的绝对路径可用。

### 14.5 单账号机器上收不到自己产生的事件

`src/sources/github.ts:227` 的 `if (sameName(item.user.login, login)) continue` 会跳过智能体账号自己产生的
Issue、PR 与评论。这是设计（智能体不该把自己的动作当成新工作），但它意味着：本机只登录了一个 GitHub 账号时，
用这个账号造 Issue/评论不会产生 trigger。演示与自测要么用第二个账号留言，要么走"人直接跟 Router 对话"这条路。
用 GitHub Actions 以 `github-actions[bot]` 身份评论可以产生 trigger，但 bot 的 trigger 会在决策阶段被判
`not_human`（`strength: inferred`），不会开单——这正好是 `src/sources/kind.ts:57` 那条规则在运行时的样子。

## 15 Desktop profile 只能由 Electron 应用启动

`dsh --profile desktop --dump-config` 会报 `profile "desktop" is managed exclusively by the Electron application`；
`dsh plugin --profile desktop add|install` 仍然可用（它只动 `package.json` 与 `node_modules` 链接）。所以验证桌面端是否
加载了插件，不能靠 `--dump-config`，只能看三处：`%USERPROFILE%\.dsh\profiles\desktop\package.json` 里的
`link:E:\project\08-SuperAgent-Windows`、`node_modules\dsh-superagent` junction 是否有效（`valid=True`）、
`cordis.patch.yml` 里是否有 `- id: dsh-superagent` 与它的 `stateDir`。改完插件源码后必须重启桌面应用——热重载不会重读
profile 与插件的 `cordis.patch.yml`。

另一个本机坑：`dsh plugin add` 会先解析该 profile 已声明的所有 bundle。本机 desktop profile 的 `dsh-llm-wiki` 曾是指向
已删除目录的失效 junction，导致报 `cannot resolve profile bundle "dsh-llm-wiki"`；`dsh plugin --profile desktop install`
按 `package.json` 的 `link:E:/project/07-个人知识库/dsh-plugin` 重新链接后恢复。

## 16 插件改写的是 DSH 自己的进程环境

`applyEnvironment`（`src/infra/environment.ts`）不是给子进程传一份 env，而是直接改 `process.env`：把
`<stateDir>/worker-bin` 插到 PATH 最前，并写 `GIT_CONFIG_GLOBAL=<stateDir>/worker-gitconfig`、`GIT_CONFIG_NOSYSTEM=1`、
`GIT_ASKPASS=''`、`GIT_TERMINAL_PROMPT=0`、作者身份等。这在 Linux 的独立跑法里没问题，在 Windows 桌面端上有一个副作用：

- 插件是装在 `desktop` profile 里的，所以**整个 Electron 应用进程**都被改了；此后它 spawn 的任何东西——
  agent 的 `pwsh` 工具、`job_*` 后台任务、面板里的终端——都继承这份环境。
- 实测：本机桌面端加载插件后，agent 自己的 pwsh 会话里 `GIT_CONFIG_GLOBAL` 指向
  `C:\Users\s1215\.dsh\state\superagent-desktop\worker-gitconfig`，PATH 首位是同一个 stateDir 下的 `worker-bin`。
  于是 `git commit` 会读到 worker 的 `useConfigOnly = true`（人自己提交时报 `no email was given`），
  PATH 上还挂着一个 Windows 执行不了的 `gh` shebang shim（按 PATHEXT 解析，实际仍落到后面的 `gh.exe`，不会跑错，但很容易误判）。
- 只要插件在跑，这份改写就一直在；`stop()` 才还原（`applyEnvironment` 返回的还原函数）。

影响与处理：

1. **测试**：`tests/runtime.spec.ts` 里"环境被还原"的断言在这样一台机器上必挂。spec 现在在 `beforeEach` 清掉
   `GIT_CONFIG_GLOBAL/GIT_CONFIG_NOSYSTEM/GIT_ASKPASS/GIT_TERMINAL_PROMPT/GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL/GIT_COMMITTER_NAME/GIT_COMMITTER_EMAIL`，
   `afterAll` 还回去，断言对齐"从没跑过插件的机器"。CI 上本来就没有这些变量，行为不变。
2. **人的终端**：在桌面端里开 shell 干活时，先 `Remove-Item Env:GIT_CONFIG_GLOBAL, Env:GIT_CONFIG_NOSYSTEM`，
   或者用 `git -c user.name=... -c user.email=...` 显式给身份。
3. **要彻底解决**，得让 DSH 的 shell 工具支持 per-call env，插件不再改 `process.env`；那是宿主侧的改动，不在本仓库范围。

`[fork]` 同轮还做了 GitHub 可选：没填仓库时不再卡在 `setupPending`（细节见 `docs/06-test-baseline.md` 的
"本轮：GitHub 变成可选"）。