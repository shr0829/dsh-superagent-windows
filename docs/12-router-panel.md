# 12 · 路由器：一个工作区一个 router

本文件记录 Superagent 面板新增的 router 维度：它是什么、工单怎么归属、面板怎么展示，以及这一层没有改什么。

## 一、router 是工作区

router 在本仓库里只有一个含义：**一个工作区一个 router**。工作区是 DSH Session 的 `cwd`——人在哪个项目目录里开会话，那条消息就属于哪个工作区。

落地方式（`src/sources/chat.ts`、`src/core/tickets.ts`）：

- chat Source 生成 Trigger 时把 `session.header.cwd` 写进 `trigger.meta.workspace`；
- accept 建工单时读出它，写成 `ticket.workspace`（`src/core/model.ts` 的 `Ticket.workspace`）；
- 面板按 `ticket.workspace` 分组，每一组就是一个 router，id 由 `routerId(workspace)` 派生。

没有 workspace 的工单（GitHub、Feishu 这类没有会话目录的来源，以及这个字段加入之前的历史工单）归到**默认 router**，也就是 `machine.stateDir` 那个工作区。判断只看一个字段，不需要迁移：旧工单没有 `workspace`，自然落进默认组。

## 二、面板怎么看

面板新增一个 tab：**路由器**（`src/client/routers.tsx`）。

- 列表：每个 router 一行——工作区名（路径最后一段）、完整路径、工单总数、进行中、在跑、最近活动时间。
- 点进去：该 router 的工单列表。每张工单带三样东西：状态、订阅的线程（点进线程页）、执行它的 worker Session（可点开），以及 worker 最近一次报告的摘要。
- 再往下：该 router 的工单订阅过的全部线程，以及每个线程被几个工单订阅。

数据由 `src/app/views/routers.ts` 从 `Store` 现算，不额外建表：`routerList` 按工作区分组，`routerDetail` 取一个 router 的工单、worker 与线程。HTTP 路由是 `GET routers` 与 `GET routers/:id`（`src/app/http.ts`）。

routers 是推导出来的，不是注册出来的：一个工作区只有产生了第一张工单才会出现在列表里。这与"自适应构建工单"一致——router 跟着工作走，不预先占位。

## 三、这一层没有改什么

- **控制面仍是一个 main Session。** router 是数据与面板上的分组，不是每个工作区各起一个 DSH Session。要拆多 Session，得改 `Sessions.ensure` 的主 Session 生命周期、relay/notice 的投递目标和 assessment 的去向，属于另一层改动。
- **订阅直通没有改。** 同一线程上的后续消息仍直接进已有工单的 worker；已结束的工单仍会被人的消息唤醒。工单分叉靠 router 的 attach/accept，不靠取消直通。取消直通会让每条追问都付一次评估，和 `09-token-cost.md` 里的成本口径冲突，要做成开关另说。
- **没有为 router 建 DSH Workspace。** 见 `06-test-baseline.md` 里那次 `[fork]`：Session 只带 `cwd`，不进侧栏工作区列表。

## 四、验证

- `tests/routers.spec.ts`：分组、默认 router、router 详情里的 worker 与订阅线程、chat Trigger 的 workspace。
- `tests/panel-overview.spec.tsx`、`tests/panel-panel.spec.tsx`：tab 列表。
- 面板测试的假服务器 `tests/fixtures/panel-server.ts` 实现了两条新路由。
