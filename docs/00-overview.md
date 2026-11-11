# 00 · 架构总览：从设计文章到 dsh-superagent 原型

本仓库是 `dsh-superagent` 的 Windows 部署壳：上游 TypeScript 原型保持只读，本仓库补上 POSIX 之外缺失的那一层运维与执行环境，并把两者的差异写成可核对的清单。本文件讲架构：文章里的四个特征如何落成五个模块、每个模块的机制是什么、实验数字能支撑到什么程度、文章概念对应上游哪个文件。平台的替换细节在 [01 · Windows 与上游的差异清单](01-windows-deltas.md)。

## 一、它要解决什么

一个人同时能跟进的活跃 Session 是 3–5 个。这个上限与模型无关：单任务能推进多远由模型决定，能同时推进几件由人的注意力决定。Session 是承载对话的容器，也是目前最贵的认知单位——每个 Session 都要求人记住它做到哪、卡在哪、下一步该问什么。活跃会话数超过 5 以后，成本不再是线性增加，而是漏看与误判增加。

Super-agent 的处理方式是把 Session 从人的界面上移走。人面对的是 Ticket：每个 Ticket 有自己的 stage（`person/review`、`working/queued`、`idle` 等，`src/core/stage.ts:5-23`），Session 是 Ticket 的执行细节，由系统创建、替换、重启。面板因此不显示会话列表，只回答三个问题：什么需要我、什么在跑、什么出了问题（`docs/005-panel.md:52`）。

3–5 这个数字的机制在于上下文重建成本，而不是并发能力：切回一个 Session 时，人要重读它最近几步、确认它有没有在等自己、想清楚下一句该说什么。这一步的成本与 Session 的历史长度成正比，所以会话越多、每个会话越久没看，切换成本越高。这也是为什么"多开几个窗口"不能解决问题——它增加的是并发度，不降低重建成本。

代价随之转移：Session 一旦不再是人的界面，系统必须自己回答三件事——这条消息算不算工作、这项工作派给谁、它做完没有。第二节的五个模块都是为回答这三件事存在的。

三个问题各自对应一段可检查的代码，也各自对应一种失败模式：

| 系统要回答的问题 | 由谁回答 | 答错的代价 |
| --- | --- | --- |
| 这条消息算不算工作 | `Policy.gate` 的确定性规则，再过 assessment 的语义判断（`src/core/evals.ts:96-100`） | 漏接真实请求，或被 bot 通知淹没 |
| 这项工作派给谁 | Thread 上有 Subscription 就直通，否则由 Router 在 accept 时划定范围（`src/core/intake.ts:38-59`） | 两处同时改同一个文件，或工作永远停在队列里 |
| 它做完没有 | Ticket stage、Assignment 状态与 Channel 回写（`src/core/stage.ts`） | 人以为在跑，其实早就断了 |

三问的答案由系统给出，人只在第三问的答案里被通知。这就是"Session 是实现细节"的具体含义：不是把界面藏起来，而是把判断权交出去之后仍然可核对。

把这三件事交给现有做法，三种形态各失败在一处：

- 聊天机器人只回答被 @ 的那一句，没有 Thread 记忆，人换一个话题就得重新交代背景。它回答了第一问，答不了第二、三问。
- IDE 里的 agent 有一个完整工作区和一条长会话，但一次只能服务一个人、一条线；第二个请求必须排队，因为环境与上下文都是独占的。
- 定时机器人按 cron 轮询，看得见仓库的所有变化，却没有"谁在处理什么"的概念，于是同一条线会被当成新任务反复开工。

原型的做法是把三者拆开再拼起来：事件流来自定时轮询（第三种），执行放在互不干扰的独立 Session 里（第二种），判断与交接靠 Thread 与 Subscription（第一种）。剩下的两个问题——判断准不准、任务怎么排队——在第五节。

衡量它成功与否也就有两组指标，不能合并成一组：一组是任务侧的（完成时间、返工率、人需要介入的次数），另一组是人侧的（被通知的次数、每次通知是否值得看、切换回某条线要花多久重建上下文）。7.1 量的是前一组，文章没有量后一组——但"多任务上限取决于注意力"这个出发点，恰恰要求后一组也成立。

## 二、四个特征 → 五个模块

| 特征 | 承担它的模块 | 一句话机制 |
| --- | --- | --- |
| 连续 | 双层架构（Router / Worker） | Router 常驻，Worker 一 Ticket 一个，Session 可换而任务不断 |
| 高效 | 事件驱动（两级过滤） | 程序层先判，模型层后判，绝大多数事件不进模型 |
| 主动 | 面向人的交互（直通 / 内联+指针 / 多信道） | 已订阅 Thread 直发 Worker，人在的地方回写，消息有硬长度 |
| 持久 | 存算分离与执行环境解耦 | 状态入库，Agent Loop 无状态，环境是显式变量表 |
| 保障 | Watchdog | 主系统之外的定时检查，看进程也看组件 |

五项不是并列的：双层架构是骨架，另外四项挂在它上面——事件驱动决定什么时候唤起 Router，面向人的交互决定 Worker 怎么收到消息与怎么回话，存算分离决定服务能不能重启，Watchdog 决定出问题时谁先知道。所以下面按依赖顺序写，而不是按特征顺序。

### 2.1 双层架构：Router 与 Worker

Router 是主 Session（代码与 prompt 里叫 `orchestrator`），持 `dsh-superagent-router` preset；每个 Ticket 起一个 Executor Session，命名 `worker-<ticket id>`，持 `dsh-superagent-worker` preset（`src/app/sessions.ts:48`、`src/executor/dsh.ts:24`）。

两套 preset 是权限的物理分离，不是两段提示词。Router 的 fs 工具是 `write: false, edit: false`（`cordis.patch.yml:163-167`），Worker 有 fs、shell、jobs、skill、todo、subagent（`cordis.patch.yml:63-120`）。`cordis.patch.yml:121-124` 把 Router 裁掉的东西列全了：subagent、web、file search、写文件、todo、向人提问、presenting、plan mode、plugin manager、scheduling、goals、workflows。Router 自己保留 shell，但同样是 5 秒转后台（`:145-156`），所以它能跑一条命令核实事实，改不了代码、也起不了第二个 agent。

两个 preset 的 shell 都把前台命令在 5 秒后转后台（`cordis.patch.yml:44-56`、`148-156`），并把 jobs 的等待上限同样设为 5 秒（`:69-74`）。这不是性能调优：一个正在跑长命令的 Worker 必须在下一步就能收到人的消息，否则"异步 ReAct"退化成同步阻塞（`docs/003-execution.md:27`）。

分层的实质是两种生命周期：Router 活整个服务进程；Worker 活一个 Assignment，Ticket 结束后它的工具调用被拒（`docs/007-architecture.md:532`）。

合起来的失败模式很具体：如果 Router 与 Worker 共用一条 Session，Ticket 一多，Router 的上下文就被各条线的执行细节填满，压缩会先吃掉早期判断；而判断是输入不是结论，丢了没法从数据库恢复。

### 2.2 事件驱动：两级过滤

第一级是程序层 Fast Path。`Policy.gate(trigger, thread, tickets)` 用确定性规则回答"可不可以"：发送者是否在该 Source 的允许名单里、有没有匹配的规则、强度是 `explicit` 还是 `inferred`（`src/core/evals.ts:96-100`、`src/policy.ts`）。这一步是纯代码，零 token，过不了的 Trigger 只留一条 disposition 记录（`src/core/intake.ts:26-29`）。

第二级是语义层 Slow Path。只有过了 gate 的 Trigger 才组 batch 进 Router 做 assessment。它读到的是 Trigger 文本（≤4000 字符）、相关 Ticket（≤8）、Thread 窗口（前 5 条 + 两侧各 5 条，普通消息 400 字符、近邻 1200 字符）与当前 Policy 版本；其余消息以 50 字符 stub 出现，按 id 展开（`docs/007-architecture.md:540-546`）。产出只有四种 Decision：`accept` / `stop` / `ignore` / `unavailable`（`docs/001-domain.md:109`）。

两级的分工在于成本结构：gate 便宜且永不出错，但只能判"谁可以提"；assessment 贵且可能判错，但它能判"该不该接、接到什么范围"。把两者顺序反过来（先模型后规则）会让每条 bot 通知都付一次模型调用。

规则本身是版本化的 Policy（`src/policy.ts`），改判据是改数据，不是改 prompt。这一点决定了调优方式：误判增多时先看 disposition 与规则是否过期，而不是去调 Router 的措辞。

一个 Thread 同时只跑一个 Eval，期间到达的 Trigger 合并进下一批（`docs/001-domain.md:43`）。批处理首先是为了让一次判断看到完整上下文，其次才是省推理时间——7.2 的数据说明后者也成立。

### 2.3 面向人的交互：直通、内联与指针、多信道

订阅直通。Trigger 进入 intake 后先按 Thread 找 Subscription：命中的 Ticket 直接 `addInput` 并 `wake`，不进 Eval（`src/core/intake.ts:38-59`）；没有 Ticket 拥有的 Trigger 才 `queueForEval` 回 Router（`:58`）。所以"已经有人在处理这条线"时，Router 完全不参与。

直通有边界：只有人的消息能唤醒已结束的 Ticket，bot 与 CI 不能；Ticket 被人 stop 撤销 Mandate 后什么都收不到（`src/core/intake.ts:40-44`）。授权与上下文在这里是两套东西——Subscription 给上下文，Mandate 给授权。

Inline & Spill 与链式召回。所有对象都有 id（Ticket、Trigger、Thread、Assignment、Input），投递时先给摘要与 id，超限截断但保留 `read` 路径。硬数字：Assignment 1500 字符、Trigger 600 字符（`src/executor/dsh.ts:113`）；截断时 `capped()` 返回 `{ text, chars, read }`（`:115-116`），资源路径形如 `ticket/<id>/input/<id>`（`:150`）。模型要全文就顺 id 逐跳展开，不要就永不读——上下文按需付费，而不是一次性铺满。

多信道。Channel 是 Thread 的写侧，地址由 Source 定义：GitHub 的评论与 review thread、飞书的 topic 回复。输出有硬规定：acknowledgement ≤100 词（`docs/007-architecture.md:548`）。这条规定与"少打扰"同源：一条消息占一个人的注意力，所以先限长度，再要求只在需要人行动或结果可用时说话。

三件事合起来才构成"主动"：agent 在人已经在的地方说话（Channel），说的是人能直接用的长度（100 词），且不需要人先打开它的会话。

三个机制各自的失效方式也清楚：直通失效是"漏订阅"，消息进了 Router，成本上来但结果还不错；内联失效是"没留指针"，模型只能看到被截断的摘要，于是靠猜；多信道失效是"回错地方"，结果留在 Worker 的日志里而 Thread 上没有，人只能去翻面板。三种失效里最贵的是第三种，因为它的表现是沉默。

### 2.4 存算分离与执行环境解耦

状态与计算分开。Decision、Ticket、Assignment、Input、Report 都落在 `orchestrator.sqlite`（`docs/006-deployment.md:236`）；Session 只是执行载体，服务重启后 running Assignment 以 "host restarted" 结束，替换者带 recovery note 重启（`docs/003-execution.md:146`）。

Agent Loop 无状态。Source 持有自己的读位置，重启不重放事件（`docs/001-domain.md:27`）；Eval 不持有状态，输入是 Trigger 批、Thread 快照、Ticket 列表与当前 Policy（`:33`）。所以进程可以随时换掉。

端侧是 daemon。DSH host 只负责进程与 Session 托管，模型走 BYOM：Router 与 Worker 各有 role model，在 Session 创建时确定，之后不随设置改（`src/app/sessions.ts:150`、`docs/003-execution.md:143`）。

执行环境是显式的：每个 Ticket 一个目录（默认 `<stateDir>/work`）、一次 prepare 命令、一组注册变量（`DSH_SUPERAGENT_DIR`、`_NAME`、`_TICKET`、`_BLOCKED_COMMANDS` 等，`docs/003-execution.md:63-76`）。环境定义能力，prompt 只描述能力。

环境层的两个边界要记住：prepare 有十分钟上限、一生只跑一次（`docs/003-execution.md:51`），所以它适合建目录、装依赖、拉分支，不适合做需要重试的步骤；`blockedCommands` 只是把 shim 前置到 PATH 的拦截，文档自己写明它不是安全边界（`:78-80`）。安全靠账号权限，不靠命令黑名单——这一点对移植很关键：Windows 上拦截失效不构成新的越权，只构成操作风险（见 `01-windows-deltas.md` 第 4 条）。

### 2.5 Watchdog

文章里的 Watchdog 是主系统之外的定时消息驱动 Session：它跑在另一个 profile 里，服务本身挂掉时它还在；判据有两条，进程活着没有，任务有没有实质进展。

原型实现了前半截。`docs/006-deployment.md:133-141` 的每小时检查建在你日常使用的 profile 里，读 `scripts/dsh-superagent status` 的 exit code 与 JSON 中的 `errors` / `setup` / `manually_stopped`。它看的是进程与组件健康，不看某个 Ticket 是否卡住。

后半截由数据补，而不是由巡检补：Ticket stage 把"等人"和"在跑"分开（`person/*` vs `working*`，`src/core/stage.ts:5-23`），overview 报"最近一小时没有后续判断的 unavailable Eval"（`docs/006-deployment.md:187`）。这是被动暴露，不是主动巡检。

结论：原型里的 Watchdog 是"运维脚本 + 面板指标"，不是文章描述的独立监督 Session。这是实现与设计方向的差，不是配置项（据上游实现推断：代码中不存在 Watchdog 实体，`docs/007-architecture.md` 也没有对应章节）。巡检的判据也因此必须便宜：它读几个布尔值与退出码，不读日志、不问模型。

### 2.6 一条消息的完整路径

五个模块串起来看，一条 GitHub 评论要走九步，其中只有一步花模型 token：

1. Source 轮询拿到事件（`src/sources/github.ts`），落成 Trigger；同一事件重复到达只产生一条（`src/core/intake.ts:19-30`）。
2. Trigger 按 Thread 归属：仓库 + Issue/PR 号 + 类型构成 Thread 的键（`src/core/model.ts:157`）。
3. `Policy.gate` 过一遍：谁可以提、规则是否匹配、强度是 `explicit` 还是 `inferred`（`src/core/evals.ts:96-100`）；不过的只留一条 disposition。
4. 按 Thread 找 Subscription：命中就把 Trigger 作为 Input 追加给对应 Ticket，`wake` 它的 Executor，路径到此结束（`src/core/intake.ts:38-59`）。
5. 没命中才 `queueForEval`，进 Router 的 batch（`:58`）。
6. Router 在 assessment 里读 Trigger 批、相关 Ticket、Thread 窗口与 Policy 版本，产出 Decision（`docs/007-architecture.md:540-546`）。
7. `accept` 生成 Mandate 与 Ticket，并把 Thread 写进 Subscription（`src/core/tickets.ts:417`）。
8. Ticket 排 Assignment，Executor 建 `worker-<id>` Session 与目录，跑一次 prepare 后接手（`src/executor/dsh.ts:24`、`docs/003-execution.md:51`）。
9. 结果经 Channel 回到原 Thread（`src/sources/github-channel.ts`），同时更新 Ticket stage；这条 Thread 上的下一条消息走第 4 步而不是第 6 步。

第 4 步与第 6 步的分叉是整个架构的枢纽：一次 accept 之后，同一条线上的后续消息不再经过 Router。7.1 里拿掉直通导致 Router 决定数 +30%、token +37%，量的就是这个分叉的宽度。

这条路径的开销分布是倾斜的：第 1–4 步是轮询与字符串匹配，成本随事件数线性增长；第 6 步是唯一花 token 的地方，成本随 Thread 数增长；第 8 步花的是墙钟时间与机器资源。可优化的点因此只有两个——降低第 6 步的发生率（直通），或缩短第 8 步的时长（拆任务、换模型）。"高效"落在事件驱动而不是执行侧，就是因为前者的杠杆是数量级，后者只是常数。

第 6 步的另一种结局是 `unavailable`：模型不可达时不假装判断失败，而是把 Eval 记成"没判"，一小时内没有后续判断的会出现在面板上（`docs/006-deployment.md:187`）。这类"未完成"必须与 `ignore` 分开——一个是没看，一个是看了不作数。

## 三、数字口径：7.1 与 7.2

先给设置，再给数字，最后给限制。

文章给了两组实验：7.1 是消融，回答"每个部件值多少"；7.2 是批处理，回答"负载上来时哪里先坏"。两组跑在同一条构造出来的消息流上，所以读法一致——任何一条脱离限制的数字都不成立。

**7.1 消融实验。** 约 300 条消息的会话流，其中约 20 条是工作请求；每个方案跑 5 次；编码类任务用只消耗时间的工具替代真实编译与测试；消息间隔与工作时长按 1/4 缩放。

- Super-agent：p50 12.4 min，p95 15.7 min。
- 中性提示的单 Session + Subagent：5 次运行一次都没有主动委派；p95 29.5 min。
- 去掉订阅直通：Router 的决定数增加约 30%，总读缓存 token 从 2323 万升到 3177 万（+37%），完成时间基本不变。

**7.2 批处理。** Trigger 到达率从 1 条/分钟升到 40 条/分钟：平均 batch 1.0 → 2.8；单次请求耗时 2.5 s → 3.9 s；单个决定分摊的推理时间 6.4 s → 1.6 s。

怎么读这三组：

- 直通那组最能说明架构。拿掉直通后完成时间没变、token 涨 37%，说明直通买的不是速度，而是 Router 的判断次数与重复读上下文。只按完成时间评估，会得出"直通没用"的错误结论。
- "5 次一次都没委派"是行为观察，不是统计结论。它说明中性提示下模型不会自发把工作交出去，所以双层架构必须由规则（Policy）和接线（Subscription）驱动，靠 prompt 请求不成立。
- 批处理那组是吞吐与延迟的交换：batch 变大，单位决定的推理成本降到约 1/4，代价是单次请求多等 1.4 s。文章只测到 40 条/分钟，没给拐点。

**口径限制（必须与数字一起读）：**

- 合成负载：消息流是构造的，不是真实团队一个月的记录；工作请求的难度分布、追问比例、失败率都不代表生产。
- 简化环境：编码任务用只耗时的工具替代，绝对时长不含真实编译、测试与 CI 等待。跨方案比较有效，绝对值不能当 SLA。
- 初步参考：每方案 5 次，没有置信区间；1/4 缩放意味着这些分钟数不能换算成真实工时。

因此可以说的：在同等设置下，Super-agent 的尾部完成时间约为单 Session 方案的一半；直通降低的是 Router 负载与 token，不是时延。不能说的：生产环境 p95 是 15.7 分钟，或者"花了 2323 万 token 才能撑住一个团队"——后者是同一批构造负载下的读数，不是团队规模的换算。

## 四、概念落地映射表

职责一列据上游 `docs/001-domain.md`；落点一列是代码位置。只在文档里有定义、代码里没有同名实体的项，在落点里写明。

| 概念 | 职责 | 原型落点 |
| --- | --- | --- |
| Source | 一条事件流：kind 是可复用实现，instance 是一份配置；持有读位置与自己的 bot 身份 | `src/sources/registry.ts`、`src/sources/kind.ts`，实现见 `src/sources/github.ts`、`feishu.ts` |
| Trigger | 一条不可变事件，属于一个或多个 Thread；重复接收只产生一个 Ticket | `src/core/model.ts:23`、`src/core/intake.ts:19-30` |
| Thread | 按时间排列的 Trigger；Eval 的串行单位与上下文边界 | `src/core/model.ts:157`、`src/core/intake.ts:34-48` |
| Correlation | 同一 Trigger 所属 Thread 之间的关系；只加上下文，不路由 | `src/core/intake.ts:37` |
| Eval | 一批 Trigger 的两层判定（gate + assessment），无状态，产出 Decision | `src/core/evals.ts`、`src/policy.ts` |
| Policy | 版本化的准入规则，加上每个 Source 的名单、同步与 bot 列表 | `src/policy.ts`、`docs/002-authorization.md` |
| Ticket | 一个被授权的工作单元；自带 stage、Channels、Inputs | `src/core/tickets.ts`、`src/core/stage.ts` |
| Mandate | accept 授予的强度、范围、Policy 版本与匹配规则；不可变 | `src/core/model.ts:126` |
| Subscription | Ticket 与 Thread 的多对多，由 Thread 持有 | `src/core/tickets.ts:417` |
| Assignment | Ticket 与一个 Executor 实例的绑定，pending → running → ended | `src/core/assignments.ts` |
| Executor Session | 每 Ticket 一个 DSH Session（`worker-<id>`）与一个目录 | `src/executor/dsh.ts:24`、`src/app/sessions.ts:138-150` |
| Channel | Thread 的写侧，地址由 Source 定义 | `src/sources/github-channel.ts`、`src/sources/feishu-channel.ts` |
| Watchdog | 文章中的外部定时监督者 | 原型无此实体；最接近的是 `docs/006-deployment.md:133-141` 的每小时检查（据上游实现推断） |
| stateDir | 数据库、锁、`worker-bin` shim、`worker-gitconfig` 的根，必须是绝对路径 | `src/deployment.ts:16`、`src/infra/environment.ts:19-20` |
| Input | 追加给 Ticket 的一条 Trigger 引用，投递时按 600 字符截断 | `src/executor/dsh.ts:113`、`:150` |
| Report | 执行结束后写回 Thread 的结构化结果，与 stored work 一起留在 Ticket 上 | `docs/003-execution.md:155` |

表外的三项是组装层，文章没给名字：Engine 私有化 batching、授权、fan-out、resume 的规则（`docs/007-architecture.md:96`）；Runtime 把它们接到 DSH 的 Session、subprocess 与 webserver 上（`src/app/runtime.ts`）；两个 Session preset 在 `src/app/sessions.ts:127`、`:48` 选择，串起了上面整张表。

名字有分歧，读代码时对一下：文章与本文叫 Router，代码里的角色名是 `orchestrator`，preset 叫 `dsh-superagent-router`，管理接口挂在 `/orchestrator/api/state`（`scripts/dsh-superagent:83-95`），面板文案写"主 Session"。四个名字指的是同一个 Session。

## 五、三点补充与两点保留

### 补一：control plane / data plane

Router 是控制面：决定做什么、谁做、何时停，产出的状态很小（Decision、Ticket、Mandate），可审计、可重放，适合进数据库。Worker 与执行环境是数据面：读写工作树、跑命令、开 PR，状态很大且易失（Session 历史、目录、后台 job）。上游的存储切分与这个视角吻合：控制面在 `orchestrator.sqlite`，数据面在 `<stateDir>/work` 与 Session 里（`docs/006-deployment.md:236`、`docs/003-execution.md:150`）。这也解释了为什么重启是安全操作——丢的是数据面的中间态，不是控制面的决定。

对运维的直接含义：备份只需要备份控制面（`orchestrator.sqlite`）与 `stateDir` 下的少量配置，工作树可以重建。反过来说，把任何"谁在处理什么"的信息只存在 Session 里，就等于让它不可备份。

### 补二：Agent as a Service

对外它不是被调用的工具，而是一个有身份的成员：GitHub 账号加飞书 bot，接口是 Issue、评论、mention（`docs/001-domain.md:79`）。所以它的延迟指标不是 API 响应时间，而是从请求到第一个可审阅结果的时间；可用性里还包含"人是否知道它在做什么"，acknowledgement 与 Ticket stage 就是为这一项存在的。acknowledgement ≤100 词也因此不是文风要求，而是服务承诺的一部分：承诺里包含不打扰。

### 补三：Sandbox as the Agent Tool

执行环境不是背景设施，而是 agent 的工具界面：prepare 命令决定目录怎么来，注册变量决定它知道什么，`worker-bin` 决定它能调哪些 CLI（`docs/003-execution.md:51`、`:63-76`；`docs/006-deployment.md:224-225`）。"能力"由环境定义，prompt 只是说明。这条对 Windows 移植是决定性的：环境层（shim、prepare 的 shell、路径、编码）不成立时，模型再强也调不动工具。

落地检验也因此不在 prompt 上：装完之后先跑 prepare，确认目录生成、变量可见、`gh` 走的是 `gh-agent` 那套配置；这三项过不了，后面的判断与调度都没有意义。

### 保留一：Router 凭什么知道派给谁

它靠的不是更强的模型，而是输入天然带边界：一个群、一个仓库、一条 Issue/PR 线程本身就是封闭上下文。订阅直通正是把这个边界变成路由规则——Thread 上有订阅就不问 Router。

前提是边界成立。如果一条 Thread 里混了三件不相关的事，gate 帮不上（gate 只判"谁可以提"），Router 只能靠语义猜；跨 Thread 的任务没有天然归属，而 Correlation 明确只加上下文、不路由（`docs/001-domain.md:30`）。所以直通比例取决于输入是否天然分线程：这个前提在 IM 单聊里最弱，因为单聊里所有请求共享一个 Thread；在"一 Issue 一请求"的仓库里最强。

有个可用的操作性判据：如果一条消息用一句话就能说清"这件事属于谁"，直通可靠；如果需要三句话交代来龙去脉，它就该开新 Thread，而不是塞进现有订阅。

反例也具体：一条 PR thread 里同时有 review 意见、CI 失败和新需求，三条订阅会同时命中，实际谁先跑取决于写入顺序而不是重要性——这里缺的不是路由，而是同一 Thread 内的优先级。

### 保留二：异构任务的队列与调度没有回答

Eval 在 Thread 内串行、跨 Thread 并行（`docs/001-domain.md:43`），worker slot 有并发上限，人的消息可以占用额外一个 slot（`docs/003-execution.md:55-61`）。但没有优先级、没有按预计时长调度：一条 20 分钟的编码任务和一个 30 秒的查询抢同一组 slot，只能靠"多留一个 slot 给人"绕过。任务时长呈长尾时会出现队头阻塞；7.2 的批处理降低的是单位决定的推理成本，不改变这个结构。

这不是实现缺陷，是设计假设：它假设一个人的团队任务量不足以排队。任务量上来后需要队列策略（优先级、时限、抢占），文章没有给。

拐点可以粗判：当同时活跃的 Ticket 数长期接近 slot 数时，队头阻塞开始出现；在那之前，"多给人类一个 slot" 这条设计足够用（`docs/003-execution.md:55-61`）。

要补的话，最小改动是三样：给 Ticket 一个 deadline 与优先级；把 slot 分配从"先到先得"改成可抢占（抢占意味着 Assignment 能暂停并保留 Session，否则抢占只是重启）；让 Router 在 accept 时给出工作量估计——估计可以不准则无意义，标定之后才能按估计排队。

读法建议：先读上游 `docs/001-domain.md` 的定义，再看本文件的模块；数字只用于比较方案，不用于对外承诺。
