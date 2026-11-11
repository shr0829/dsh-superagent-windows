# Management API 与 Settings

面板上的每个开关背后都是这个 HTTP 接口。它在 `<url>/orchestrator/api/` 下，**只监听回环**，并且有两个门：

1. 必须带请求头 `x-orchestrator-request: 1`——挡掉浏览器里跨站发起的简单请求；
2. `Host` 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，否则 403——挡掉 DNS rebinding。

两条都不满足时返回 403，且响应体不解释原因。用 PowerShell 调的时候别用 `Invoke-RestMethod -NoProxy`
（5.1 没有这个参数，系统代理还可能把 127.0.0.1 的请求吞掉），用 `scripts\lib\common.ps1` 里的 `Invoke-JsonGet`：

```powershell
. .\scripts\lib\common.ps1
$api = 'http://127.0.0.1:3082/orchestrator/api'
$state = Invoke-JsonGet -Uri "$api/state" -Headers @{ 'x-orchestrator-request' = '1' }
$state.health.runtime
```

## 路由

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `state` | 健康表、`setup.problem`、`setup.feishuProblem`、`load`、`paused` |
| GET | `settings` | 四块配置的当前值 + revision；`sources[]`；`policyVersion`；`environment` |
| GET | `sources` | 只取 Source 列表（含 `form` / `problem`，面板据此渲染表单） |
| PUT | `settings/<block>` | 写一块配置，body `{ "value": …, "revision": … }` |
| POST | `executor/pause` | body `{ "paused": true }`，暂停取活 |
| POST | `setup/check` | 重跑 setup 检查（等价面板上的"再检查一次"） |
| POST | `policy-sync/<source id>` | 从该 Source 重新同步允许名单 |
| GET / PUT | `prompts` | 提示词覆盖（披露行、review bots、commit 作者、auto-merge 条件） |
| POST | `tickets/<id>/retry` | 重试一个 Ticket |
| POST | `tickets/<id>/stop` | 停一个 Ticket |

`state` 里值得盯的字段：

```json
{
  "setup":  { "problem": "", "feishuProblem": "" },
  "health": { "runtime": { "state": "ready", "detail": "", "at": "2026-11-11T09:40:00+08:00" } },
  "load":   { "running": 0, "queued": 1, "maxWorkers": 4 },
  "paused": false,
  "masterId": "…"
}
```

`PUT settings/<block>` 的响应：`{ "saved": true, "revision": 12, "policy_changed": false, "restarting": false }`。
`revision` 是乐观锁：拿旧 revision 写会得到 409，重新 GET 再写。错误码：400 参数不合法、404 没有这个块或 Ticket、
409 revision 冲突、500 内部错误。

## 四块 Settings 在 Windows 上填什么

字段名以面板渲染的表单为准（`GET settings` 的 `sources[].form` 会告诉你哪些必填）；下面是对应的**值**。

### Sources — GitHub

| 字段 | Windows 取值 |
| --- | --- |
| repository | `owner/name`，生产仓库，不是这个 build 仓库 |
| cli | `gh-agent`（不要填 `gh`：那会用你自己的账号） |
| observeIssues / observePulls / observeComments / observeCi | 默认全关。先只开 Issues，跑顺了再开 |

Source 装好后 `health` 里会出现 `sync:github`，第一次同步显示 `starting` 是正常的。

### Sources — 飞书（可选）

| 字段 | 取值 |
| --- | --- |
| cli | `lark-bot` |
| chats[] | `chatId` + `listen: mentions`（或 `all`） |
| directMessages | 是否接私聊 |
| otherChats | `listen: all` 的其他群 |

飞书检查失败只会禁用飞书 Source，不影响 GitHub。`setup.feishuProblem` 有值但你没打算接飞书时，忽略它。

### Policy

两条规则：**谁能派活**、**派给谁**。每个 Source 一份允许名单，**名单为空 = 任何请求都成不了 Ticket**
（不是"谁都行"）。飞书可以从群成员同步名单；GitHub 侧填 login。

改完会立刻影响 intake，`policy_changed: true` 就是提醒你这个改动不需要重启但会马上生效。

### Execution

这是 Windows 上和上游差别最大的一块，因为 `prepare` 在上游是一条 POSIX 的 `git … && git …` 单行命令。

| 字段 | 取值 |
| --- | --- |
| directory root | 你 clone 生产仓库的父目录，例如 `C:\Users\<you>\src` |
| prepare | `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\dsh-superagent-windows\config\prepare-worktree.ps1"` |
| blockedCommands | 你自己的个人 CLI（`gh`、`az`、`aws`、`kubectl` …），防止 agent 用到你的身份 |

`prepare-worktree.ps1` 从环境变量拿参数，由插件在每个 Ticket 开始时注入：

| 变量 | 内容 |
| --- | --- |
| `DSH_SUPERAGENT_GITHUB_REPOSITORY` | `owner/name` |
| `DSH_SUPERAGENT_TICKET` | Ticket id，用作 fetch 的 ref 后缀 |
| `DSH_SUPERAGENT_GITHUB_PR_HEAD` | PR 的 head ref；Issue 触发的 Ticket 为空，脚本退回 `HEAD` |
| `DSH_SUPERAGENT_DIR` | 要给这个 Ticket 用的 worktree 绝对路径 |
| `DSH_SUPERAGENT_NAME` | 分支名后缀，最终分支 `agent/<name>` |

脚本做的是：`git -C <root clone> fetch --no-tags <https url> <head>:refs/dsh-superagent/<ticket>`
→ `git -C <clone> worktree add -b "agent/<name>" <dir> refs/dsh-superagent/<ticket>`。
每一步检查 `$LASTEXITCODE`，失败就以非 0 退出，插件会把整段 stderr 变成 `The prepare command failed: …`。

**为什么不用一条命令写完**：PowerShell 的 `&&` 只有 7 才有，5.1 上写 `a && b` 会把 `&&` 当参数传下去，
结果是一个"成功"的假象。脚本里显式判断退出码，比追求一行命令可靠。

### Prompts

| 字段 | 含义 |
| --- | --- |
| 披露行 | agent 在 Issue/PR 里发言时带的那句"我是自动处理的" |
| review bots | 允许自动响应哪些 bot 的评论（默认不响应，防互相唤醒） |
| commit 作者 | worktree 里提交用的 `user.name` / `user.email`，建议是 agent 身份 |
| auto-merge 条件 | 默认 `observe`：只开 PR、不合并。要开自动合并，先确认 CI 门禁是真的 |

## 常用操作

**暂停取活**（升级数据库前必须做）：

```powershell
$body = '{"paused":true}'
# 5.1 没有 -NoProxy，这里直接用 HttpWebRequest 版本：
$request = [System.Net.HttpWebRequest]::Create("$api/executor/pause")
$request.Method = 'POST'
$request.ContentType = 'application/json'
$request.Headers.Add('x-orchestrator-request', '1')
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
$request.ContentLength = $bytes.Length
$stream = $request.GetRequestStream()
$stream.Write($bytes, 0, $bytes.Length)
$stream.Close()
$request.GetResponse().Close()
```

**重跑 setup 检查**：`POST setup/check`，等同于面板上的按钮。
**重试失败的 Ticket**：`POST tickets/<id>/retry`；先 `GET settings` 看 `sources[].problem` 有没有线索。

## 什么时候不该用 API

- 改 `stateDir`：面板和 API 都不支持，只能改 `cordis.patch.yml` 再重启。
- 换 dsh 版本、换上游 commit：那是 `scripts\build.ps1` + `restart` 的事。
- 绕过 `revision` 硬写：409 是保护，不是障碍；重新 GET 拿新 revision 再写。
