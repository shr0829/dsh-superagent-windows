# dsh-superagent on Windows

把 [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype)（DeepSeek Harness 上的 super-agent 研究原型）装到 Windows 上，并且能像服务一样管起来：
PowerShell 控制脚本、计划任务保活、bundle 挂载、机器配置、体检与排障。

上游只发布了 POSIX 路径：`tmux` 保活、`fcntl.flock` 互斥、`ps` 找进程、`os.kill(pid, SIGINT)` 停机，
`docs/006-deployment.md` 全文没有出现过 Windows、win32、pwsh 中的任何一个词。本仓库补的就是这一段，
不改上游一行代码——上游按 commit 锁定后原样构建，Windows 的差异全部落在本仓库的脚本与配置里。

## 这个仓库解决什么

| 上游的做法 | 本仓库在 Windows 上的做法 |
| --- | --- |
| `tmux new-session … dsh --profile superagent` 常驻 | `cmd.exe /d /c "node <bin.js> --profile superagent --no-open"` 隐藏窗口 + 日志重定向 |
| `fcntl.flock(operation.lock)` 单操作互斥 | 命名 Mutex `Local\dsh-superagent-<profile>` |
| `ps -ax` 扫 `--profile` 找进程 | `Get-CimInstance Win32_Process` + 命令行分词（同样排除 `plugin` 子命令） |
| `os.kill(pid, SIGINT)` 优雅停机 | `FreeConsole` → `AttachConsole(pid)` → `GenerateConsoleCtrlEvent(CTRL_C_EVENT)` |
| 崩溃/重启靠人 | 计划任务：登录时 `start -RespectStop`，每小时 `watchdog.ps1` 巡检 |
| Shell 工具是 bash | 上游 bundle 已按 `process.platform` 切成 `pwsh-sandbox` / `tool-pwsh`，无需改动 |

退出码沿用上游的语义（0 正常 / 1 未运行或 runtime 报错 / 2 非 runtime 组件报错 / 3 等待 setup），
因为巡检逻辑靠它做判断——把它改成"0 成功 1 失败"会让 watchdog 失去分辨能力。

## 快速开始

前提：Windows 10/11、Node 22.19+ 或 24+、git 2.32+、`dsh` 在 PATH 里（`npm install -g @deepseek-ai/dsh@0.2.1-rc.3`）、已配好模型 provider。

```powershell
git clone https://github.com/shr0829/dsh-superagent-windows.git
cd dsh-superagent-windows
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\doctor.ps1      # 先体检，看哪些项 FAIL
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1     # 构建上游 + 建 profile + 挂 bundle + 写配置
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-superagent.ps1 start
start http://127.0.0.1:3082/orchestrator
```

`install.ps1` 做的六件事，与上游 `docs/006-deployment.md` 的 Install 段一一对应：

1. preflight：Node、git、`dsh`，`stateDir` 必须是绝对路径且不含空格（`worker-bin` 要拼进 PATH）；
2. `scripts\build.ps1`：按 `vendor\upstream.lock.json` 拉取上游 commit，`pnpm install` + `pnpm build`，产物落在 `upstream\`；
3. `dsh <profile> --from-default-profile web --dump-config`：建独立 profile（默认名 `superagent`），操作者自己的 Session 不受影响；
4. `dsh plugin --profile <profile> add link:<checkout>`：把构建产物作为 bundle 挂进 profile；
5. 往 `cordis.patch.yml` 追加机器配置：`webserver` 绑 `127.0.0.1:3082`，`dsh-superagent.stateDir`；
6. `scripts\new-agent-cli.ps1`：生成 `gh-agent.cmd`（agent 自己的 GitHub 账号）与 `lark-bot.cmd`（可选）。

## 仓库结构

```
scripts\
  dsh-superagent.ps1    服务控制：status / start / stop / restart / logs / open / doctor
  install.ps1           一键安装（等价上游 Install 段）
  build.ps1             按 lock 文件拉取并构建上游，产出 upstream\lib
  doctor.ps1            只读体检，14 项 PASS/WARN/FAIL
  watchdog.ps1          每小时巡检判断（无 agent 也能跑）
  register-task.ps1     注册"登录启动 + 每小时巡检"两个计划任务
  unregister-task.ps1   删除计划任务
  new-agent-cli.ps1     生成 gh-agent.cmd / lark-bot.cmd 凭据包装器
  test-scripts.ps1      自检：BOM、语法、语法树引用的文件是否存在
  lib\common.ps1        共用：UTF-8 无 BOM 读写、免代理 HTTP GET、版本号解析
config\
  profile.cordis.patch.yml   机器配置样板（带注释）
  prepare-worktree.ps1       Execution 的 prepare 命令（git worktree，PowerShell 版）
vendor\
  upstream.lock.json    上游 commit 与版本约束，构建的唯一来源
docs\
  00-overview.md        这个系统在解决什么问题：五个模块、两级过滤、订阅直通、上下文档位
  01-windows-deltas.md  Windows 与原型的 12 处差异，以及为什么必须这样改
  02-install.md         安装：前置、分步、验证、升级与回滚
  03-operate.md         运维：日常命令、计划任务、退出码、排障对照表
  04-settings-api.md    Management API 与四块 Settings 的 Windows 取值
```

## 三条必须知道的约束

**1. `.ps1` 文件必须带 UTF-8 BOM。** Windows PowerShell 5.1 读无 BOM 的文件时按系统 ANSI 代码页解码，
脚本里的中文注释会被拆成半个字符，把后面的引号和换行吃掉，报出一堆莫名其妙的语法错误。
本机 `pwsh` 工具实际就是 5.1，所以这不是理论问题。仓库里所有 `.ps1` 都带 BOM，`scripts\test-scripts.ps1` 会检查；
编辑器保存时不要勾掉 BOM。

**2. 脚本要能在 Windows PowerShell 5.1 上跑。** 目标机器是 stock Windows，不该为了跑一个控制脚本先装 PowerShell 7。
所以：不用 `??`、`-AsHashtable`、三元运算符，不用 `-Encoding utf8NoBOM`，
HTTP 用 `HttpWebRequest` 而不是 `Invoke-RestMethod -NoProxy`（5.1 没有这个参数，而系统代理会吞掉 `127.0.0.1` 的请求）。
`common.ps1` 里把这几个坑都封好了。

**3. `stateDir` 不能含空格、必须是绝对路径。** 上游把 `<stateDir>\worker-bin` 插到 PATH 最前，
路径里有空格时 shim 解析会把参数切断，表现是 `gh`/`lark-cli` 找不到或参数错位。
默认 `%USERPROFILE%\.dsh\state\superagent`。

## 现在能跑到哪一步

已在本机验证：
- `doctor.ps1` 14 项检查全部按预期给出 PASS/WARN（`dsh 0.2.2-rc.1`、Node 24.18、git 2.56）；
- `dsh-superagent.ps1 status` 在没有服务时输出完整 JSON 并以 1 退出，`logs` 以 0 退出；
- 所有脚本通过 5.1 语法树解析（`scripts\test-scripts.ps1`）；
- `build.ps1` 能从锁定 commit 构建出 `upstream\lib\index.js`。

尚未在本机跑通的（`docs\01-windows-deltas.md` 末尾有完整清单）：真实 GitHub Issue → Ticket 的端到端链路、
计划任务在锁屏/睡眠跨过触发点后的补跑行为、飞书 Source（未装 `lark-cli`）。

## 与上游的关系

上游是研究原型，不是产品：`private: true`，没有 npm 包，`package.json` 里的 `engines.dsh` 钉在 `^0.2.1-alpha.2`。
本仓库不复制上游源码，只锁定 commit（`vendor\upstream.lock.json`，当前 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`），
构建时拉取。上游更新后：改 `vendor\upstream.lock.json` 的 commit → `scripts\build.ps1` → 重启 profile。

## 许可

本仓库脚本与文档：MIT。上游代码遵循其自身许可（MIT），由构建流程按 commit 拉取，不进入本仓库。
