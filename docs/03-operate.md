# 运维

## 日常四条命令

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-superagent.ps1 status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-superagent.ps1 start
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-superagent.ps1 stop
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-superagent.ps1 logs
```

全部参数都有默认值：`-Profile superagent`、`-Url http://127.0.0.1:3082`、`-Timeout 60`、`-StopTimeout 300`。
环境变量 `DSH_SUPERAGENT_PROFILE` / `DSH_SUPERAGENT_URL` 可以改默认，多实例时按 profile 分开。

`status` 的 JSON 键与上游一致：

```json
{
  "pids": [12345],
  "cwd": "C:\\path\\to\\dsh-superagent-windows",
  "url": "http://127.0.0.1:3082",
  "manually_stopped": false,
  "health": { "runtime": "ready", "github": "ready" },
  "errors": {},
  "setup": "",
  "feishu": ""
}
```

`errors` 只收 `state == "error"` 的部件，值是 `detail`。`setup` 非空表示还在等配置。

## 退出码

| 码 | 含义 | 该做什么 |
| --- | --- | --- |
| 0 | 正常；或者已停止；或者有意停机被 `-RespectStop` 跳过 | 什么都不用做 |
| 1 | 没在跑 / 双实例 / 端口无应答 / `runtime` 报错 | `restart` 通常能修 |
| 2 | 进程在，但非 runtime 部件报错（Source、`sync:<source id>`、delivery…） | 看 `errors`，`restart` 修不了 |
| 3 | 进程在，等 setup | 去面板把 Sources / Policy / CLI 登录补完，`restart` 修不了 |

这套码不是自创的：上游的巡检 prompt 就是按 `0 静默 / 2 报错不重启 / 3 报 setup 不重启 / 其它 restart` 分流的。
`watchdog.ps1` 与计划任务原样继承了这套判断，所以**不要**把它改成"成功 0 失败 1"。

## 启停语义

**start**

- 命名的 Mutex 先抢操作锁（`Local\dsh-superagent-<profile>`），抢不到直接报
  `Another dsh-superagent control operation is in progress.`——两个终端同时按 start 不会起出两个实例。
- 已经在跑就拒绝；`http://127.0.0.1:3082/orchestrator/api/state` 已经有应答也拒绝（防止"端口被别的 dsh 占着"时又拉一个）。
- 启动方式是 `cmd.exe /d /c "node <bin.js> --profile <p> --no-open"`，窗口隐藏，stdout/stderr 进 `.artifacts\dsh-superagent-<profile>-<yyyyMMdd-HHmmss>-<pid>.log`。
  只为保留最近 20 份，多出来的按时间删。
- `node` 与 `bin.js` 是从 npm/pnpm 的 `dsh.cmd` 里解析出来的，不是硬编码路径；`-DshExe` 可以指向别的可执行文件。

**stop**

- 先在 `control\profiles\<profile>\manually-stopped` 写标记，**再**发 Ctrl+C。先写标记是为了让巡检判定"是人为停的"，不要自动拉起。
- Ctrl+C 的实现：`FreeConsole` 脱离自己的控制台 → `AttachConsole(pid)` 挂到目标进程的控制台 →
  屏蔽本进程的 Ctrl+C 处理 → `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)` 广播 → 挂回父控制台。
  目标进程是 node，收到 CTRL_C_EVENT 等同于 SIGINT，与上游 `os.kill(pid, SIGINT)` 等价。
- 之后最多等 `-StopTimeout`（默认 300 秒，和上游"最多等 5 分钟"一致）。**超时不强杀**，返回 1 并列出还活着的 pid。
  确实要杀：确认 Executor 没在写东西，再 `stop -Force`。
- 只有 `stop` 写停机标记，`restart` 不写——`restart` 是"修一下"，不是"我不想要它了"。

**restart**：`stop` 成功再 `start`，两者输出拼在一起返回。

**open**：直接打开面板 URL。

**doctor**：转调 `scripts\doctor.ps1`。

## 计划任务

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-task.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Force   # 覆盖已存在的
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\unregister-task.ps1 -WhatIf
```

注册两个任务，都在当前用户下、`InteractiveToken` + `Limited`，**不需要管理员**：

| 任务 | 触发 | 动作 |
| --- | --- | --- |
| `DshSuperagent-<profile>-logon` | 该用户登录时 | `dsh-superagent.ps1 start -RespectStop` |
| `DshSuperagent-<profile>-hourly` | 今天 +5 分钟起，每 60 分钟，持续 3650 天 | `watchdog.ps1` |

设置项的含义：

- `MultipleInstances = IgnoreNew`：上一次巡检没跑完时不再叠一个；
- `StartWhenAvailable`：错过触发点（睡眠、关机）后开机补跑一次；
- `ExecutionTimeLimit = 2h`：卡死的巡检会被终止，不会一直挂着；
- `AllowStartIfOnBatteries` + `DontStopIfGoingOnBatteries`：笔记本上别因为拔电就停。

上游用 tmux 会话做"活着"，Windows 没有等价物，所以是"登录时拉起 + 每小时自检"两段拼起来的。
已知差异：**锁屏时 `InteractiveToken` 任务照常运行**（会话还在），但**注销或没登录时不会运行**——
这一点和 tmux 在服务器上常驻不一样。要让服务在无人登录时也活着，得改成 Windows 服务或
`S4U`/`Password` 登录类型的任务，代价是拿不到用户的环境变量与凭据目录，本仓库没有这么做。

## 巡检判断

`watchdog.ps1` 每小时的逻辑（与上游给 agent 的那段 prompt 一一对应）：

1. 跑 `dsh-superagent.ps1 status`，拿 stdout 与退出码；
2. 码 0 → 静默，不输出任何东西；
3. 码 2 / 3 → 只打印状态与错误，**不重启**（restart 修不了，重启只会掩盖）；
4. JSON 里 `"manually_stopped": true` → 保持停机，什么都不做；
5. 其它（1、无输出、脚本自身异常）→ `restart -RespectStop`，打印结果；仍失败则 tail 最新日志 40 行。

它自己的退出码恒为 0：巡检是"报告器"，不是"失败源"，不应该让计划任务显示红色。

## 日志

```
.artifacts\dsh-superagent-<profile>-<yyyyMMdd-HHmmss>-<pid>.log
.artifacts\control\profiles\<profile>\service.pid
.artifacts\control\profiles\<profile>\manually-stopped
```

日志是 dsh 进程的 stdout/stderr 原样重定向，所以上游文档里那些报错串会原样出现在这里。
保留最近 20 份；`logs` 子命令列出全部并 tail 最新一份的 60 行。

`.artifacts\` 不进版本库。

## 排障对照表

上游 `006-deployment.md` 的报错串是英文原样，这里是它们在 Windows 上通常意味着什么。

| 报错 / 现象 | 原因与处理 |
| --- | --- |
| `The agent GitHub CLI is not set.` | Settings → Sources 里 GitHub Source 的 CLI 没填，填 `gh-agent` |
| `The agent GitHub CLI was not found.` | `%USERPROFILE%\.local\bin` 不在 PATH，或没跑 `new-agent-cli.ps1` |
| `The agent GitHub CLI cannot read its account` | `gh-agent auth login` 没做，或 token 过期 |
| `@<login> cannot read <repo>` / `cannot push` | agent 账号没有该仓库权限；或用 `-Repository` 跑 doctor 定位 |
| `The GitHub Source names no repository.` | Source 配置里 `owner/name` 空着 |
| `The prepare command failed: …` | 见下一行；`prepare-worktree.ps1` 每一步都检查 `$LASTEXITCODE` |
| prepare 报 `fatal: invalid reference` | PR head 取不到（fork 的 PR 需要 `DSH_SUPERAGENT_GITHUB_PR_HEAD`） |
| `git does not read the github.com credential configuration dsh-superagent writes` | git < 2.32 |
| `The git configuration of the repository in … sets …` | 你的 clone 的 `.git/config` 里有自己的凭据或 `http.*.extraheader`，删掉 |
| `… was not written by dsh-superagent` | `<stateDir>\worker-bin` / `worker-gitconfig` 里有同名文件；挪走或换 `stateDir` |
| `dsh-superagent configuration has keys it does not use` | patch 里有插件不认识的键（拼写错误或版本不匹配） |
| 日志说插件与运行的 dsh 不兼容 | dsh 版本超出 `engines.dsh`；装回 `^0.2.1-alpha.2` 这一代 |
| 面板 `Failed to load plugins` | 升级后没重启实例：`restart` |
| 提到但没反应 | 作者不在 Policy 允许名单；Source 没开；处理已暂停。**编辑 Issue 正文追加的 mention 收不到**，要新评论 |
| `status` 里 `runtime` 一直 `starting` | 模型 provider 没配好，或 `stateDir` 不可写；看日志第一屏 |
| 端口 3082 被占 | `Get-NetTCPConnection -LocalPort 3082`，改 patch 里的 `port` 与 `-Url` 一起改 |
| 所有中文变乱码、脚本报奇怪语法错 | `.ps1` 丢了 UTF-8 BOM；`scripts\test-scripts.ps1` 指出文件 |

## 健康状态的读法

`health` 是一个部件表，常见条目：`runtime`、`models`、`evals`、`assessment`、`launch`、`delivery`、
`relay`、`notice`、`reply`、`worker`、`github`、`feishu`、`history`，以及每个 Source 的 `sync:<source id>`。

- `runtime` 是唯一的"总闸"：不是 `ready`/`paused`，退出码就是 1。
- `sync:*` 还在 `starting` 是**正常的**，第一次同步要拉一批 Issue，别当故障。
- 飞书没装时 `setup.feishuProblem` 可能有值，但那只是"没能检查"，不影响 GitHub Source。
