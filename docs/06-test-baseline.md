# 06 · 测试基线（Windows）

上游的测试在 POSIX 上写的：`sh`、信号、`tmux`、POSIX 权限位、`#!/bin/sh` 假 CLI、`docs/007-architecture.md`。
这份文档记录它们在 Windows 上的处理结果、每条的依据，以及**哪些行为在 Windows 上仍然没有断言**。

`pnpm test` 现在是绿的，但绿不等于全都测到了：21 条按平台显式跳过，另有 8 处产品能力在 Windows 上确认失效或未生效（见 §5）。
这些跳过的条目在 `docs/01-windows-deltas.md` 的差异表和"未验证项"里有对应的行。

## 测量

起点（源码入仓后第一次全量，2026-11-11 13:37）：

```
node v24.18.0 · pnpm 11.7.0 · vitest 4.1.8
Test Files  9 failed | 50 passed (59)
Tests       42 failed | 1155 passed (1197)
Duration    64.32s
```

调整后（2026-11-11 14:04，同一台机器、同一套依赖）：

```
node v24.18.0 · pnpm 11.7.0 · vitest 4.1.8
Test Files  58 passed | 1 skipped (59)
Tests       1176 passed | 21 skipped (1197)
Duration    14.91s
```

42 条失败的去向：**21 条转绿，21 条显式跳过**（`tests/service-script.spec.ts` 15 条 + `tests/sources.spec.ts` 6 条）。
总数 1197 不变——没有删测试、没有减少断言，跳过的条目在原文件里仍带原断言，只是多了一个平台条件。

口径修正：本文件早先把失败数写成 43，但同一张表相加是 41，复测是 42。43 是早期一次记录错误，
以工具输出为准（`.artifacts\test-results.json`）。现在只保留一个口径：`vitest run` 的汇总行原样抄录。

## 逐文件处理

| 文件 | 起点失败 | 处理 | 依据 |
| --- | --- | --- | --- |
| `tests/service-script.spec.ts` | 15 | **整组 `describe.skipIf`** | 测的是上游的 Python 脚本 `scripts/dsh-superagent`，它没随 fork 入仓（fork 用 `scripts/dsh-superagent.ps1`）；套件还依赖 `python3`、`fcntl.flock`、假 `ps`/`tmux`、`trap "" INT` |
| `tests/sources.spec.ts` | 6 | **逐条 `it.skipIf(windows)`** | 假 lark-cli 是 `#!/bin/sh` 脚本，生产代码 `spawn(cli)` 在 Windows 上执行不了；同 describe 第 3 条不依赖 CLI 就绪、本来就绿，保留真跑（所以不整组跳） |
| `tests/environment.spec.ts` | 7 | **改写**（3 条 Windows 分支改为断言 shim 文本） | worker-bin shim 是 `#!/bin/sh`，NTFS/CreateProcess 不执行 shebang；留下的断言仍然检查 shim 内容、拦截文案、`git` 不在 worker-bin 里 |
| `tests/commands.spec.ts` | 4 | **改写** | `env`/`echo`/`sleep`/`sh` 在 Windows 上没有；换成 `node -e`，断言（`exited with code N`、`AbortError`、`still\n`、`< 4000ms`）一条没动；`kill -9 $$` 在 win32 走 `process.kill(process.pid,'SIGKILL')`，实测 libuv → `TerminateProcess(_,1)`，故 Windows 断 `exited with code 1` |
| `tests/deployment.spec.ts` | 5 | **改写 + 一处源码修正** | `probe` 原本靠 `#!/bin/sh` 假 CLI 直接执行；现在剥离 POSIX `env NAME=value …` 前缀、按 `delimiter` 解析 PATH、`#!` 脚本交给 Git for Windows 的 bash；目录符号链接在 Windows 用 `'junction'`；`stateDir` 的绝对路径正则见下 |
| `tests/docs.spec.ts` | 2 | **收编上游文档 + 分隔符归一** | `docs/upstream/007-architecture.md`（LF）入库；路径比较把 `\` 归一成 `/`。按此归一后模块表 111/111、测试表 59/59 命中，表格同步检查仍然有效；文档缺失时两条转 `skipIf` 而不是崩 |
| `tests/prompts.spec.ts` | 1 | **改写** | 临时目录从 `%TEMP%`（C:）挪到仓库内 `.artifacts`（E:），`path.relative` 不再跨卷返回绝对路径 |
| `tests/runtime.spec.ts` | 1 | **改写** | 期望的 `worker-gitconfig` 内容没把反斜杠转义成 `\\`（源码 `gitQuote` 是对的）；另把 `PATH.split(':')` 换成 `split(delimiter)`——原来是**假绿**：Windows 上整串 PATH 是一个元素，`not.toContain` 恒成立 |
| `tests/store.spec.ts` | 1 | **分平台断言** | `mode & 0o777 === 0o700/0o600` 只在非 win32 断；Windows 断目录存在 + 文件存在，不断言 ACL（ACL 继承随机器而变，做断言只会变成 flaky 假信号） |

### 改到源码的一处

`src/deployment.ts:13` 的 `absolute()`：上游只认 `/^\//`，而本仓库发布用的样板
`config/profile.cordis.patch.yml:24` 写的是 `stateDir: 'C:/Users/CHANGE_ME/.dsh/state/superagent'`。
按上游正则这个值会被当成相对路径拒绝——Windows 部署连配置都加载不了。改成

```ts
const absolute = (value: string) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value)
```

覆盖 POSIX 绝对路径、盘符路径、UNC 路径，行上方有 `[fork]` 注释说明原因。

## 跳过的 21 条，逐条理由

`tests/service-script.spec.ts` 15 条（profile 锁、双实例拒绝、status JSON、SIGINT 优雅停止、日志保留 20 份、退出码分流）
——全部验证的是 `scripts/dsh-superagent`（Python）的行为。fork 把这个脚本换成了 `scripts/dsh-superagent.ps1`，
两者不是同一份实现，跑上游脚本等于测一个本仓库不发布的文件。**注意代价：`.ps1` 侧现在没有任何行为断言**（见 §5.8）。

`tests/sources.spec.ts` 6 条（事件行消费、Source 关闭后丢弃、45 s 就绪超时、告警转 error、5 s 内停消费、重启续跑）
——fixture 与生产路径都要求 `spawn` 一个可执行的 lark-cli；Windows 上生产代码本身就走不通（见 §5.3），
所以这些断言在 Windows 上只会测出"环境不存在"，测不出逻辑。

## 对分支的约束

- 验收判据不是"测试数量不变"，而是**失败条目要么转绿、要么按平台显式跳过并写明原因**。
  静默删除测试不算完成；跳过必须留 `skipIf` 条件与原断言。
- 新增测试默认要能在两个平台跑；写死 `sh`、`tmux`、`fcntl`、`mode & 0o777` 的测试进不来。
  需要 POSIX 语义时，用 `process.platform` 分支保留两侧断言，不要只留 POSIX 那条。
- 每条跳过都在 `docs/01-windows-deltas.md` 有对应的一行；测试是那张表的证据。

## 已知的产品缺口（测试绿了，功能没绿）

1. **worker-bin 隔离在 Windows 上不生效。** `src/infra/environment.ts:89` 写 `#!/bin/sh` shim 且 `mode: 0o755`，
   `:93-98` 用 `IFS=:` 剥 PATH，而 `:120` 用 `delimiter` 拼——两处口径不一致，剥不掉；即使剥掉，
   CreateProcess 也不会执行无扩展名的 shebang 文件。后果：`gh`/`lark-cli`/`blockedCommands` 三层隔离
   在 Windows 上是静默跳过，不是拒绝。
2. **setup 探测用 `env` 当 argv[0]。** `src/deployment.ts:73-76` 的 `workerProbe` 和 `:120` 的飞书探测都发
   `['env','PATH=…', …]`，Windows 没有 `env` 程序。测试里由注入的 probe 模拟，真实启动会失败。
3. **飞书实时事件通路不可用。** `src/sources/feishu-loops.ts:71` `spawn(bot(ctx).cli, …)` 直接执行配置路径：
   Windows 上无扩展名或无 `.cmd` 必然 ENOENT，npm 装的 `lark-cli` 落成 `lark-cli.cmd` 也一样（Node 不加 `shell:true` 不解析 `.cmd`）。
   历史游标与轮询补拉不 spawn CLI，正常。
4. **状态文件的权限意图没生效。** `src/app/store.ts:59` 的 `mkdirSync(..., mode: 0o700)` 与 `:63` 的
   `chmodSync(path, 0o600)` 在 Windows 上是空操作（实测 `mode & 0o777` 均为 0o666），权限来自父目录 ACL。
   上游靠这个保护 sqlite 里的凭据与会话数据，Windows 侧需要显式 `icacls`。
5. **`promptFile` 隐含只接受相对路径。** `src/app/skill-files.ts:13,30` 跨卷时拼出 `prompts\C:\…`，
   最终以 `Missing packaged file:` 暴露——报错信息指向错误的层。
6. **`policy.ts:94` 是同类 POSIX 假设。** `directory` 的 refine 只接受 `/` 开头或空，
   Windows 下 `<stateDir>/work`（`C:/…`）会被拒。本轮未改，等执行侧的 Windows 路径约定定下来再一起动。
7. **`rmSync({ recursive: true })` 在 Windows 上偶发 EPERM/ENOTEMPTY。** `tests/sources.spec.ts:1040` 的
   `afterEach` 曾因此失败（被杀的子进程仍持句柄）。跳过后不再触发，但其它 `mkdtemp` + `rmSync` 套件有同类风险。
8. **`.ps1` 服务脚本零行为断言。** profile 锁、tmux→新窗口、`ps` 扫进程、Ctrl+C 优雅停止、日志留 20 份、
   退出码 0/1/2/3 分流——这些契约只有 POSIX 版 spec 覆盖，而那份 spec 现在整组跳过。
   `.ps1` 目前只被 `scripts/test-scripts.ps1`（BOM + 语法）与 `doctor.ps1`（环境体检）管到。

前 6 条是"Windows 上能跑，但某条能力没接上"；7、8 是测试基建与覆盖缺口。修 1–4 会改变运行时行为，
需要单独一轮并补 Windows 侧的真断言，不在本轮测试调整范围内。


## 本轮补全：3.3 链式召回 / 4.1 接管 / 7.2 批处理

按《Super-agent 设计探索》（pack `693d39f53e`）第 3.3、4.1、7.2 节补的三项能力，以及它们的测试。
测量环境：Windows 11，node v24.18.0，vitest 4.1.8。

| 项 | 值 |
| --- | --- |
| Test Files | 61 passed \| 1 skipped (62) |
| Tests | 1195 passed \| 21 skipped \| 0 failed (1216) |
| Duration | 15.26s |

新增三个 spec：`tests/recall.spec.ts`（6）、`tests/takeover.spec.ts`（6）、`tests/router-batch.spec.ts`（7）。
`npx tsc --noEmit` exit 0，`pnpm build` 通过。

### 3.3 链式召回：`tests/recall.spec.ts`

实现：`src/app/recall.ts` 的 `linksOf(pairs)` 把"关系名 → 资源地址"编译成 `links` 投影，没有目标的链接不输出；
`trigger/<id>`、`thread/<key>`、`decision/<id>` 三个投影各自带上通向下一个对象的地址（trigger→thread/decision/ticket/replied_to/around，
thread→ticket 与最近的 decision，decision→thread/ticket/trigger）。
`ticket/<id>` 详情**不加** links：它已经用 id 列出 trigger、decision 和 thread，再加地址会顶破
`tests/tools.spec.ts:341` 的 3000 字节一页预算（加进去实测 3085，测试红了，于是保留预算、不加）。

测法：这个能力的断言不是"字段存在"，而是"列出来的每条路都能走通"。所以 `tests/recall.spec.ts` 用真正的
`readResource` + 一个 fake `MainResourceHost`（`context.sessionController.inspect` 必须存在，否则 transcript 路由会抛），
把投影里出现的每个 `links[].read` 立刻交给同一个 router 读一遍：

1. `trigger/<id>` 的 links 齐全，且每条 `read` 都能读回一个对象；
2. `trigger → thread → ticket → trigger` 闭链：ticket 详情里的 `trigger_id` 与 `threads[0].thread` 能回到链上；
3. 没有目标时（无 decision、无 fanout）不出空链接；
4. `around_before` / `around_after` 指向真实邻居；
5. worker 视角读不到 decision，且 JSON 里不出现 decision id；
6. `ticket/<id>` 的 report、transcript、result 三个子资源都能读。

`npx vitest run tests/recall.spec.ts` → 6 passed。

### 4.1 接管：`tests/takeover.spec.ts`

实现：Executor 端口新增 `interrupt(ticket, assignment)`（`src/core/ports.ts:69-74`），
`src/core/tickets.ts:166-186` 的 `interrupt(ticketId)` 只做三件事——取消当前回合（`cancel({kind:'user'},{keepInbox:true})`）、
往 `inputs` 追加一条 `kind: 'note'` 的接管痕迹并进 `undelivered`、结束。它不 `stopWork`、不结束派工、不动工单状态和目录；
闲置时抛 `nothingToInterrupt`，工单已结束抛 `ticketEnded`。主 Session 多一个 `orchestrator_ticket_interrupt` 工具。

测法（6 条）：断言的是"接管之后什么都没坏"：

1. 派工、工单状态、execution 记录三样在接管前后逐字段相等，`stop` 与 `deliver` 没被调用；
2. note 落在 `inputs` 末尾，`undelivered` 恰好等于 `[note.id]`；
3. 回合已经结束（`turnRuns` 为 false）时拒绝 `nothingToInterrupt`；再送一次输入后又可中断；
4. 已结束工单 `ticketEnded`、未知工单 `Unknown ticket`；
5. 工具只注册在主 Session 的 toolset，Executor 的 toolset 里没有；
6. 真调 `worker.cancel({ kind: 'user' }, { keepInbox: true })`，且 inbox 前后一致；`ticket/<id>/inputs` 的首项是
   `{ kind: 'note', undelivered: true }`。

`npx vitest run tests/takeover.spec.ts` → 6 passed。

### 7.2 批处理：`tests/router-batch.spec.ts` 与 `bench/router-batch.mjs`

`tests/router-batch.spec.ts`（7 条）走真实链路 `Intake.receive → Engine.evaluateDue → Evals.start → Assessor.request`
（fake host 与 `tests/core-engine.spec.ts` 同一套，不用 spawn、符号链接和权限位），断言：
一轮里到达的 N 条 trigger 只产生一次 Assessor 请求、载荷里 N 条都在、代表 trigger 是最强的那条（同强度取最新）、
跨 thread 不合并、`mode: 'drain'` 之外的模式各自只取自己那一批。

`bench/router-batch.mjs` 是量级演示，不是基准工具：`spawnSync` 自重入带 `--experimental-transform-types`，
动态 import 真实 Engine，跑三种到达节奏，结果写 `.artifacts/bench-router-batch.json`：

| 模式 | trigger | eval | avgBatch | 稀释 |
| --- | --- | --- | --- | --- |
| drain（每轮都清） | 720 | 240 | 3.00 | 3.00x |
| hold（eval 撑 4 轮） | 720 | 72 | 10.00（max 12） | 10.00x |
| serial（不合并） | 720 | 720 | 1.00 | 1.00x |

三种模式下 `everyTriggerInExactlyOneEval` 均为 true——合并只改变调用次数，不丢也不重复处理 trigger。

与文章 7.2 的三处差别（本轮未改代码）：批的 key 含 thread，不跨 thread 合并；没有时间窗，成员是 pass 时刻
`thread.pending` 的全集（`src/app/passes.ts:28` 的 2000ms 是轮询间隔，不是 debounce）；文章说的 prefill 并行是模型侧行为，
仓库只能证到"一次调用载多条"。

### 顺带修掉的三个 Windows 缺口（都有断言）

1. `src/deployment.ts` 的 `workerProbe` 原来以 `env` 为 argv[0]，Windows 没有 `env`，保存 Source 时报
   `spawn env ENOENT`。改成把 PATH 放进 `runAsWorker` 的 env 参数；`tests/runtime.spec.ts:852-856` 断言
   `check.argv[0] === AGENT()` 且 PATH 里没有 worker-bin。
2. `src/app/sessions.ts` 的主 Session 工具白名单写死 `bash`，Windows profile 里只有 `pwsh`，恢复 Orchestrator 会话时
   `tools.restrict()` 直接抛 `names unknown global tool "bash"`，插件不激活、`/orchestrator/api/*` 全 404。
   改成按实际存在的工具过滤（`['skill','bash','pwsh',…]`），且必须带 parent scope 才取得到。
3. `scripts/install.ps1` 往刚生成的 `cordis.patch.yml` 里追加条目时，文件里还留着 `[]` 占位，写出来的 YAML 既是数组又是序列，
   服务静默起不来。改成先删 `[]` 再追加，并对已损坏的 profile 做幂等自愈。

局限：面板没有接管按钮和端点，接管目前只能由主 Session 的工具发起；链式召回没有索引层（无向量、无全文检索），
多跳靠模型一次次 `orchestrator_read`（跨 Session 的记忆另有 `orchestrator_memory_search` 做词匹配，仍无向量检索，
见 [07 记忆](07-memory.md)）；批处理的两个"没做"见上。

## chat 信道：会话里说一句话就走完整个流程

文章 4.2 要的是"同一个任务在多信道之间连续推进"，上游只有 Feishu 和 GitHub 两个 Source——人的一句聊天消息不是入口。
本轮补上第三个 Source：`src/sources/chat.ts`（导出为 `./chat-watch`，`cordis.patch.yml` 里 `dsh-superagent-chat` 默认启用）。

链路：`session/event` → `chatMessage` 只认 `source.kind === 'user'` 的 `user/message`（插件自己的 relay/notice 是
`dsh-superagent` 或 `tool-jobs`，被排除；子 agent 的 prompt 按 `session.header.origin === 'subagent'` 排除；主 Session
与 worker 由 `SessionContext.owns` 排除）→ `chatTrigger`（thread `chat:<sessionId>`、`actor chat:operator`、`human: true`、
`addressed: 'direct'`、`channel.address.session`）→ `SourceContext.receive` → Intake/Engine → 工单 → 回答经
`SourceChannel.send` 回到原会话，`deliver` 用 `{ inject }` 模式投递，不唤醒那个会话自己的 agent。

`tests/chat.spec.ts`（9 条）分层测：

1. `chatMessage`：只取人的消息，拼接 text 块；relay、tool-jobs、assistant、空白、非 message 事件全部返回 undefined。
2. `chatTrigger`：一处 Thread、actor、addressed、channel、meta 的完整形状（逐字段断言）。
3. `chatAccepts`：Source 关闭、主 Session、worker、subagent（`origin`/`parentSession`/`delegationDepth`）都不接。
4. `scope`：`{ listened: true, observed: false }`。
5. Channel：`send` 调 `deliver(session, id, text, { inject: 'super-agent reply' })`；address 里没有 session 时返回 `'gone'`。
6. Policy：`allowed` 里有 operator 时 gate 判 `explicit`（`via: 'addressed'`）；没有时 `not_a_member`。
7. 端到端（`tests/fixtures/host.ts` 的真 Runtime）：在一个人会话里发一条消息 → `store.triggers` 有记录、`chat:<session>`
   Thread 建出、主 Session 收到 candidate；relay、subagent、主 Session 自己的消息都不产生 trigger。
8. `ensurePolicy` 只在缺整段时写一次，人被改过之后（改成 `allowed: []`）再跑不会覆盖回去。
9. `sessions.deliver` 对不存在的会话返回 `'gone'` 而不是抛错。

全量：`npx vitest run` → Test Files 62 passed | 1 skipped (63)，Tests **1204 passed | 21 skipped (1225)**，0 failed，15.39s；
`npx tsc --noEmit` exit 0；`scripts\build.ps1` 产出 `lib/index.js` 457,764 B、`lib/client.js` 359,636 B、`lib/chat-watch.js` 5,384 B。

局限：面板没有"在这里发起"的按钮（入口是聊天框本身）；chat 的 Thread 与 DSH Session 是一对一，换会话就是换 Thread；
operator 的 id 固定为 `chat:operator`，没有多用户身份；回答用 `inject` 落地，那个会话的模型不会看到这条消息。
## 本轮：GitHub 变成可选（chat-only 部署）

`[fork]` 起点是一个真问题：插件装好但没填 GitHub 仓库时，`setup` 一直停在 `setupPending`，`health.runtime = paused`，
chat 发来的消息只进 `received`、不进评估。改法是把 GitHub 的账号与仓库当成"GitHub Source 打开时才有"的东西。

- `src/deployment.ts`：`repository?: string`、`github?: GithubAccount`（新增 `GithubAccount` 接口）。
- `src/app/setup.ts`：`resolve()` 只在 `settings.sources.github && enabled !== false` 时调 `resolveDeployment`，否则 `{...machine}`。
  ticket 目录走 `settings.executor.directory || join(stateDir,'work')`；代码里没有 `git clone`，所以没有仓库也能开工。
- `src/infra/environment.ts`：无账号时 `gh` shim 写 `gh is unavailable: this installation has no GitHub account.`；
  `workerGitConfig` 不写 `[credential "https://github.com"]` 与 `[url "https://github.com/"]`；blocked 文案不再提 `use gh`；
  `verifyEnvironment` 的期望值变成 `['']`。
- `src/infra/commands.ts`：`repository` 返回 `''`，新增 `githubCli()`；没有账号时调用 Git 相关命令抛
  `This installation has no GitHub account.`，不是静默跑错 CLI。
- 其余取值点改成可选链：`src/app/http.ts`（`agent: … ?? null`）、`src/app/runtime.ts`、`src/app/tools/executor.ts`、
  `src/sources/github.ts`（4 处 `login`、`values`、`facts`、repository）、`src/sources/github-channel.ts`、`src/sources/github-pull.ts`。

测试：新增 `tests/chat-only.spec.ts`（5 条）。

1. 无账号时 `worker-bin/gh` 的内容是 fail 文案，且不含 `exec `；
2. `worker-gitconfig` 保留 `[user] useConfigOnly`，但没有 GitHub 的 credential helper 与 URL 重写；
3. `blockedCommands` 的 shim 文案是 `personal-gh is blocked in this installation.`，不含 `use gh`；
4. `verifyEnvironment` 在无账号部署上通过；磁盘上若残留一份带 helper 的 worker 配置（模拟从有账号的安装降级），它仍然抛 `gitTooOld`；
5. `Commands.repository === ''`，`gh()` 抛 `This installation has no GitHub account.`。

同时修了一个测试环境问题：桌面应用本身跑着 dsh-superagent 时，`applyEnvironment` 改写的 `process.env` 会被子进程继承，
所以 `tests/runtime.spec.ts` 里"环境被还原"的三条断言在这样一台机器上必挂（`GIT_CONFIG_GLOBAL` 已有值、PATH 首位是
worker-bin）。spec 现在在 `beforeEach` 里清掉这 8 个 agent 变量、`afterAll` 还回去，断言重新对齐"从没跑过插件的机器"。

全量：`npx vitest run` → Test Files 63 passed | 1 skipped (64)，Tests **1209 passed | 21 skipped (1230)**，0 failed，15.35s；
`npx tsc --noEmit` exit 0；`scripts\build.ps1` 产出 `lib/index.js` 457,879 B、`lib/client.js` 359,636 B、`lib/chat-watch.js` 5,384 B。
## 会话不再各自占一个 Workspace

`[fork]` 起于一个可见的问题：插件每开一个 Session 就在侧栏多一个工作区——主 Session 建出 `superagent-desktop`，
每张工单建出 `<stateDir>/work/<工作树名>-<工单号>`。原因是 `src/app/sessions.ts` 先
`ctx.workspaceRegistry.create(cwd)`，再把 `workspaceId` 交给 `sessionController.create(...)`。

DSH 的 `SessionCreateRequest` 里 `workspaceId` 与 `cwd` 是两个可选字段，且 `create()` 明确拒绝同时给两者
（`gateway/bad-request: session.create accepts workspaceId or cwd, not both`）。会话的 cwd 取 `workspace?.path ?? request.cwd ?? defaultCwd`，
只有给了 `workspaceId` 才会 `workspace.attachSession(sessionId)`——也就是只有那样才会进侧栏的工作区列表。

- `src/app/sessions.ts` 的 `ensure()` 只传 `cwd`，不再建工作区；主 Session 的 cwd 仍是 `stateDir`，工单 worker 的仍是
  `ticket.execution.directory`。
- `src/index.ts` 的 `inject` 去掉 `workspaceRegistry`：不再依赖它。
- 结果：Router 与每张工单的 worker 都隐式跑在底层（不进侧栏工作区），Super-agent 面板照旧按自己的 view 展示主 Session
  与工单；人自己的工作区列表不再被插件改动。

测试：新增 `tests/workspace.spec.ts`（2 条），断言 `sessionController.create` 收到的请求是
`{ sessionId, cwd, agentPreset }` 且不含 `workspaceId`——主 Session 的 cwd 等于 stateDir、preset 是
`dsh-superagent-router`；工单 worker 的 cwd 等于 `ticket.execution.directory`、preset 是 `dsh-superagent-worker`。

全量：`npx vitest run` → Test Files 64 passed | 1 skipped (65)，Tests **1213 passed | 21 skipped (1234)**，0 failed，17.76s；
`npx tsc --noEmit` exit 0；`scripts\build.ps1` 产出 `lib/index.js` 458,349 B、`lib/client.js` 359,636 B、`lib/chat-watch.js` 5,384 B。
## 记忆：数据库优先、Markdown 兜底

文章 3.3 的链式召回要求"每次召回本身也 inline 下一跳的摘要与 id"，上一轮只把这条规则用在工作对象之间；Session 一换、
模型一换，跨会话的事实仍无处可存。本轮新增 src/memory/，设计见 [07 记忆](07-memory.md)，这里只记可核对的断言。

- **两种形态同时写。** `openMemory(stateDir)` 给出 `memory.sqlite` 与 `memory/`；`save` 落到两边，
  `get` 先数据库后 Markdown，`all` 按 id 合并、数据库赢、按 `at` 倒序。数据库打不开（把 `memory.sqlite`
  先建成目录即复现）时返回 Markdown 单形态，`status().fallback` 带原因，读写照常。
- **链在读取时现算。** 卡片 `memoryCard` 只给 `memory_id/title/kind/at/tags/next/chars/read`；读
  `memory/<id>` 才把 `next` 逐条换成 `links`，目标已消失的一跳被丢掉（`memoryTarget`），正文按 4000
  字符分页，资源侧去掉卡片自己的 `read`。关系名由 `memoryRelation` 给：记忆之间是 `continues`，
  工作对象用前缀。
- **id 与地址。** `mem_` + FNV-1a 八位十六进制 + 两位种子里程；`next` 只接受 `memory/`、`ticket/`、
  `thread/`、`decision/`、`trigger/` 五种前缀，存不进别的地址。`thread/` 与 `trigger/` 的键由 Source 定义，
  允许冒号（`thread/feishu:oc_team:om_1`），不允许斜杠。
- **模型面。** `orchestrator_memory_save`、`orchestrator_memory_search`、`orchestrator_memory_merge`、
  `orchestrator_memory_forget`；资源 `memories`、`memory/<id>`。`tests/model-surface.spec.ts` 的
  `BUDGET.orchestrator` 从 61_000 提到 63_000（实测 62_004）。
- **遗忘与合并。** `remove` 对每个后端各删一次、吞掉单个后端的错误，返回 `{id, removed}`，再删返回 `false`。
  `merge` 要求至少两条存在的记录；正文按 `## 标题` 拼接，标签与 `next` 取并集并减去被合并的 id，
  `supersedes` 记下来源，先写新记录再删旧记录。两者都不自动发生。
- **面板与 HTTP。** `memory` 一级页（列表、搜索、详情、一跳、合并、遗忘）对应 `GET memories`、
  `GET memories/:id`、`POST memories/merge`、`POST memories/:id/forget`；面板与 `memory/<id>` 共用
  `src/app/views/memory.ts` 的链接解析。

测试：`tests/memory.spec.ts` 10 条（Markdown 往返、双写、数据库缺失兜底、合并顺序、链式召回含死跳丢弃与分页、
带冒号的 thread 键与 `source` 回跳、正文分页、四位置词搜索、两份都删的遗忘、合并的 `supersedes` 与正文拼接），
加 `tests/panel-memory.spec.tsx` 2 条（列表→详情→一跳→遗忘；按词过滤→勾选→确认→合并）。`docs/upstream/007-architecture.md`
的模块表与测试表同步登记。

全量：`node_modules\.bin\tsc.CMD --noEmit` exit 0；`node_modules\.bin\vitest.CMD run` →
Test Files 66 passed | 1 skipped (67)，Tests **1225 passed | 21 skipped (1246)**，0 failed，17.31s。
面板从 6 个一级 tab 变成 7 个（`memory` 插在 `execution` 与 `settings` 之间），`tests/panel-overview.spec.tsx`
与 `tests/panel-panel.spec.tsx` 的 tab 断言同步改了。