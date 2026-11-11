# 05 · 并发与解耦设计

这份文档记录三条开发分支（`feat/router`、`feat/worker`、`feat/context-chain`）共同遵守的设计共识。
它不是实现说明——代码写在哪里、函数叫什么，由各分支的 PR 决定；这里只定**边界、不变量和验收判据**。

前提是已经确认的四条选择：

| 决策 | 取值 |
|---|---|
| 基座 | 上游 `dsh-superagent` 源码入仓改造，不重写 |
| 顺序 | 分支 1 先合，分支 2、3 从合入后的 `main` 切出 |
| Router 形态 | 一个常驻 dsh Session，与 Worker 对称，不配 subagent/web/todo |
| v1 触发源 | 本地 CLI、HTTP 注入、GitHub 轮询（不做 webhook 隧道） |

以及关于边界的四条：

| 决策 | 取值 |
|---|---|
| 隔离边界 | workspace（一个目录 + 它下面的 Session 集合），一个 workspace 一个项目 |
| Router 密度 | 每个 workspace 一个 Router，按需起，闲置不烧预算 |
| 删除 | 软删除：标记 → 停派活、冻结在跑的 → `purge` 才物理删，purge 前列影响清单 |
| 并发 | 并行执行 + 目录锁，锁的设计借鉴分布式系统 |

---

## 1. 从分布式系统借什么，不借什么

本系统的部署形态是**单机、单进程、可能开两个实例**，不存在网络分区和副本。所以：

**借**——这些概念解决的是"多个执行者共享资源时如何不互相踩"，与是否跨机器无关：

- **分区 + 单一写者**：把状态切成互不相交的分区，每个分区任意时刻只有一个写者。这是消除锁的主要手段，而不是加锁。
- **至少一次投递 + 幂等**：消息会重复（重试、崩溃恢复），消费端按业务键去重。
- **截止时间传播**：请求携带绝对截止时间，下游每一步看剩余时间，过期即中止上报；它同时替代了"锁永不释放"这个失效模式。
- **监督树式失败隔离**：执行者崩溃不影响调度者，重新分配而不是抢救现场。
- **租约 + fencing token**：只在写外部资源时用，见第 6 节。

**不借**——共识算法、跨节点复制、两阶段提交。单机没有分区可容忍，用了只是把"进程崩了"伪装成"少数派问题"，增加复杂度而不增加正确性。

---

## 2. 分区：workspace + thread

分区键是 `(workspaceId, threadId)`。一个 Thread 的全部事件、状态、决策只由它的 Router 写；一个 Ticket 只由一个 Worker 会话驱动。

| 状态对象 | 唯一写者 | 其他人 |
|---|---|---|
| Thread 待处理事件、订阅者 | 该 Thread 的 Router | 只读快照 |
| Ticket 状态机 | 调度器（同一时刻一个 Assignment） | 只读 + CAS 迁移 |
| Ticket 执行现场（worktree） | 该 Ticket 的 Worker | 只读 |
| 决策日志、事件日志 | 各自所有者追加 | 只读、按 offset 消费 |

后果：

- **业务状态迁移不需要锁**，只需要版本号比较（上游 `PUT settings/<block>` 已经是这个模式，冲突返回 409）。
- **并行度被 workspace 内的共享点约束**：不同 workspace 可以真并行；同一 workspace 内的并行度取决于 git 仓库这一处共享资源（第 6 节）。
- **读不到自己刚写的**是正常现象。需要"读自己写"的调用方要拿版本号或读令牌，不靠猜。

---

## 3. 通信：跨 agent 一律走存储

已定：**跨 agent 一律走存储，agent 内部随便调。**

具体含义：

- Worker 之间没有直接通道，也没有共享对象。转交、上报、追问都写成存储里的消息，由目标分区所有者取走。上游已经是这个形状——结果作为新事件投递回来，而不是作为返回值（`core/intake.ts:38` 的订阅扇出、`core/evals.ts:66` 的 Thread 级待处理合并）。
- **消息流必须无环**：Worker 对 Router 只有异步上报，没有同步请求。一旦允许 Worker 同步等 Router 回答，而 Router 又在等 Worker 结果，就是死锁。
- **至少一次 + 去重**：消息按 `(partitionKey, messageId)` 幂等，重复投递不产生第二个 Ticket。
- **截止时间随消息走**：信封里的截止时间是绝对时间，不是相对超时。

代价要认：没有全局可变状态，出问题只能看日志。所以 append-only 决策日志与贯穿全链路的 trace id 是前置条件，不是可选项。

---

## 4. 任务信封与结果报告

Worker 拿到的是一份自足的信封，不需要读 Router 的记忆：

```
ticketId, workspaceId, threadId
workspaceRoot, cloneRoot, worktreePath, branch
task: 目标、验收条件、已知约束
contextRefs: [{ kind, id, summary }]     # 引用，不是内容
budget: { chars, deadlineAt }
```

结果报告**不强制 JSON Schema**（已定），但字段固定，且解析失败时的行为固定：

```
status: done | blocked | failed | abandoned
summary: 一句到三句
artifacts: [{ kind, ref }]
nextRefs: [{ kind, id }]                 # 供链式召回展开
cost: { turns, tokens, wallMs }
```

解析失败的降级：登记为 `unparsed` 报告，原文入档，Router 只看到 `status=unknown` 与摘要，**不猜意图、不重放**。这条是为了不让"自然语言回读"变成新的耦合面。

---

## 5. 上下文平面：共享引用，不共享对象

三个 agent 看到的是同一个 `ticketId` / `threadId` / `cardId`，各自通过只读接口取，取到的可能是不同时间点的快照。

- 卡片是引用的最小单位：`{ id, kind, summary, at, source, nextIds[] }`。`nextIds` 是链式召回的下一跳。
- 展开受预算约束，超预算截断并留下续读游标，而不是静默丢内容。
- 跨 workspace 只能通过显式迁移指针，检索边界不跨越。
- tombstone：被删除的对象保留 id 与"已删除"标记，指针不悬空。

`ContextView` 接口在分支 1 冻结，分支 3 只实现不改契约——否则分支 2 的调用方会被动跟着改。

---

## 6. 锁：只剩三处

分区已经消除了大部分锁，剩余的都是**物理资源**：

| 共享写入点 | 冲突后果 | 机制 |
|---|---|---|
| 同一 clone 的 `.git`（`worktree add/remove`、fetch、prune、refs） | worktree 元数据损坏、`index.lock` 残留 | clone 级独占租约 + 退避重试 |
| workspace 根（配置、repo → workspace 映射） | 后写覆盖前写 | workspace 级读写租约 |
| 外部副作用（推分支、开 PR、评论） | 重试产生重复 PR / 重复评论 | 幂等键，不是锁 |

规则：

- **层级与顺序固定**：`workspace(共享) → clone(独占) → ticket(独占)`，禁止反向获取。
- **租约 + fencing token**：租约 TTL 与心跳续租；token 单调递增并落库。写外部资源前比对 token，过期持有者的写入被拒。锁的安全由资源侧的 token 校验保证，不由"锁还在"保证。
- **Windows 原语**：`FileStream(..., FileShare.None)` 或 `LockFileEx`，进程崩溃由操作系统释放。网络盘与 SMB 语义不同，所以 workspace 根拒绝 UNC 与 OneDrive 路径。
- **双实例**：命名 Mutex `Global\dsh-superagent-<workspace>` 做粗互斥，库内 token 做细校验。两者都要——Mutex 只防同时启动，不防旧实例还活着。
- **git 自身的锁不受控**：`index.lock`、refs 锁冲突时退避重试并设重试预算，不挂着无限等。

不采用 Redlock / quorum：单机没有分区可容忍，它们只会把不确定性藏起来。

---

## 7. 失效模式与检测

| 失效模式 | 检测手段 |
|---|---|
| 同一 Ticket 被两个 Assignment 驱动 | 状态迁移 CAS 失败计数 |
| 消息重复投递产生重复 Ticket | 幂等键冲突计数（应为 0） |
| Worker 卡住不释放分区 | 截止时间到期 + 租约过期告警 |
| 租约过期后的旧持有者仍在写 | token 校验拒绝计数 |
| 同 repo 出现在两个 workspace | repo → workspace 唯一约束报警 |
| workspace 改名/移动导致指针全失效 | 稳定 id 与路径解耦；tombstone |
| 删除 workspace 留下孤儿子 Session | purge 前的 orphan 扫描 |
| 本地注入无身份 | 本地 token + 进程归属校验 |
| git 轮询游标丢失导致全量重放 | 游标独立于 workspace 生命周期存 |
| 决策日志被 compaction 改写 | 决策日志独立存储，不放在 Session 里 |

---

## 8. 验收判据

分支合入前必须能跑出这六条：

1. 100 条噪声事件 → 语义评估调用 0 次（Fast Path 全部拦下）。
2. 同一消息重复投递 10 次 → 1 个 Ticket。
3. 已订阅 Thread 的新事件 → Router 决策 0 次、Worker 1 次。
4. 一轮推理期间到达 3 条事件 → 1 次调用、3 条决策（批处理生效）。
5. 两个 workspace 并发执行 → 各自 prepare 成功、git 无残留锁。
6. Worker 崩溃后重建 → 从存储状态续跑，不重放已完成的副作用（幂等键命中）。

---

## 9. 未决项

这些问题还没有答案，写在这里以免被实现顺手定死：

- **租约 TTL 数值**：与一次 Worker turn 的时长相关（参考 `BACKGROUND_LIMIT_MS=30min`、`PREPARE_TIMEOUT_MS=10min`）。
- **接管策略**：TTL 过期自动接管，还是事件触发时接管。前者需要常驻扫描者，而扫描者自己也可能重复。
- **双实例检测**：Mutex、端口、库内心跳三者各有盲区，尚未选定组合。
- **预算单位**：当前上下文预算按字符（上游 `promptMaxChars`），是否改成 token 口径。
- **Router 记忆被 compaction 改写**：决策日志必须独立，但 Thread 摘要的回写时机未定。
- **fork 标记**：vendoring 之后 `git blame` 全指向我们，需要 `// [fork]` 约定与双向上游对照流程。
