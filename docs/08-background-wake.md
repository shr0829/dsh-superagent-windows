# 08 · 后台自跑：为什么会有、怎么关

一个后台任务结束之后，DSH 默认会叫醒空闲的会话，自己开一个新回合接着干。这是一个真实的行为，不是残留进程；它按 `completionDelivery` 配置项决定，默认是开着的，而且连续唤醒次数不设上限。本文件说明它是怎么发生的、代价是什么、开关在哪、以及哪些唤醒路径这个开关管不到。

## 1 两套生命周期不同步

回合（turn）和后台任务（job）不是一回事：

- 前台的工具调用只是"等到 `waitTimeoutMs` 收一段输出"。超时就把命令转入后台，注册成一个 job（`jobId` 形如 `pwsh-8a6ea1208b504638`），工具返回"已转后台，稍后用 `job_output` 收"。
- job 的生命周期不挂在回合上。`@deepseek-ai/dsh-jobs` 的 `lib/index.js:84` 写明：`Registrations outlive producer and controller fibers. Owner and service disposal cancel live work`；真正杀掉 job 的只有会话归档/停止那一条路——`installJobArchiveAdmission`（:19）在 `session archived` 时 `registry.kill(job.id, sessionId, "session archived")`（:34）。

所以"这一轮已经答完了"和"后台那个命令跑完了"是两个时间点，中间的空档正是唤醒发生的地方。

## 2 结算通知怎么变成一个回合

`@deepseek-ai/dsh-tool-jobs` 在 job 结算时构造一条通知（`source.kind = "tool-jobs"`、`form = "notice"`，`lib/index.js:333-337`），然后三选一（:345-357）：

| 条件 | 结果 |
| --- | --- |
| `delivery === "wakeup"` 且属主空闲，且没配 `maxConsecutiveWakes` | `owner.followup(message)` —— 开一个新回合，无上限 |
| 同上，配了 `maxConsecutiveWakes`，本轮还没用完预算 | `owner.followup(message)` —— 开一个新回合，预算用完就停 |
| 其余情况（`quiet`、属主正忙、预算用尽） | `owner.inject(message)` —— 塞进收件箱，等属主下一次跑 step 时随上下文带进来 |

默认值（`lib/index.js:91-95`）：`waitTimeoutMs: 30000`、`maxWaitTimeoutMs: 600000`、`completionDelivery: "wakeup"`、`maxConsecutiveWakes` 未设（`z.number().min(1)`，不配就是无界）、`inlineOutputBytes: 2048`。

## 3 代价：一次唤醒 = 一次完整请求

唤醒就是新回合，新回合就是一次请求：整段上下文重新发一遍。DeepSeek 的前缀缓存只让重复前缀按缓存价计费，新增的 delta 全价。

本机 2026-11-11 的实测（最近 60 个会话，共 5938 个 step）：由非用户消息触发的 step 有 111 个，占 1.9%——其中 `tool-jobs` 87、`subagent-settled` 11、`agent-message` 13。那批数据里 87 次 `tool-jobs` 注入全部落在回合内（模型都按提示先 `job_output` 收走了），**真正"叫醒空闲会话"的那一跳一次都没发生**。也就是说：这条路径当时没烧钱，但它的上限由 `maxConsecutiveWakes` 决定，而默认没配。

用量没法从本地日志精确回算：`dsh-session` 的事件类型白名单里没有 usage/token 事件，`.dsh/telemetry`、`.dsh/storages` 下也没有账本。只能按 step 数估。

## 4 开关

`scripts/set-background-wake.ps1` 往 profile 的 `cordis.patch.yml` 写一条 `tool-jobs` override：

```yaml
- id: tool-jobs
  config:
    completionDelivery: quiet
    maxConsecutiveWakes: 1
    waitTimeoutMs: 30000
    maxWaitTimeoutMs: 600000
```

```powershell
# 看当前值（只读）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-background-wake.ps1 -Profile superagent

# 关：后台任务结束不唤醒，通知等你下次说话时带进来
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-background-wake.ps1 -Profile superagent -State off

# 开：唤醒，最多连续 3 次
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-background-wake.ps1 -Profile superagent -State on -MaxWakes 3
```

`install.ps1` 的第 5 步会替你写 `off`，所以新装的 profile 默认就是关的。写前备份成 `cordis.patch.yml.bak-<yyyyMMdd-HHmmss>`，重复跑不会改动已是最新状态的文件。改完要重启 DSH 才生效（配置在进程启动时装载）。

**为什么要把 `waitTimeoutMs` / `maxWaitTimeoutMs` 一起写进去。** Cordis 的 patch 对 `config` 是整块替换，不做深合并：`@deepseek-ai/cordis-plugin-include` 的 `applyPatches` 里就是 `for (const [key, value] of Object.entries(overrides)) { target[key] = value }`（`lib/index.js:262-265`）。只写 `completionDelivery` 会把等待参数一起抹掉，退回 DSH 默认的 30000 / 600000。脚本会先读出现有值再抄进新块，手改时也一样要抄。

## 5 这条 override 命中谁

profile 的 patch 按 `id` 找目标，而 `applyPatches` 建索引时只登记两类行：顶层条目，以及 `group: true` 且 `config` 是数组的组里的条目（`buildMap`，`lib/index.js:222-227`）。agent 预设（`name: '@deepseek-ai/dsh-agent-preset'`）把插件写在 `config.plugins` 里——那是一个对象字段，不是数组——所以预设内部的行**不会被 profile 的 id 命中**。

结论：这条 override 只改到默认预设下的会话，也就是人自己开的那种会话；本仓库 `cordis.patch.yml` 里 worker / router 两个预设的 `tool-jobs`（`waitTimeoutMs: 5000`、`maxWaitTimeoutMs: 5000`、`wakeup`）保持原样。

这是有意的，不是漏改。那两个预设里的唤醒是执行器的主回路：worker 的前台等待 5 秒就转后台，job 结束时把它叫醒收结果、汇报 assignment；把那里改成 `quiet`，assignment 会在 job 还没汇报时就被收尾。要改那种会话的行为，得改预设本身（`cordis.patch.yml` 的 `- id: dsh-superagent-worker-preset` 段），并同步 `tests/bundle-patch.spec.ts` 里对 `tool-jobs` 配置的精确断言。

## 6 这个开关管不到的唤醒路径

关掉 `tool-jobs` 的 `wakeup` 不等于"没敲字就绝不会有新回合"。还有两条：

- **子代理结算**。`@deepseek-ai/dsh-subagent` 结束时也在唤醒父代理（`lib/index.js` 里 `parent.followup(message)`、`sendWaking(parent, ...)`），行为与 `tool-jobs` 同构。它的 Config 里没有 delivery / wake 开关——`delivery` 只出现在子代理控制 payload 的 `queue|steer` 里，那是另一件事。所以这条路径只能靠"不派子代理"来避，配置层面关不掉。
- **本插件之外的其他注入**：`agent-message`、`agent-instructions`、`working-directory`、`user-approval`，以及 `dsh-superagent` 自己的 chat 推送（把人的消息/任务结果推回 Session）。这些同样是"没敲字也会动"，但都不归 `tool-jobs` 管。

## 7 验证

```powershell
# 配置层：看写进去的四个字段
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-background-wake.ps1 -Profile superagent

# 运行层：重启后随便起个长命令，然后走开
powershell -NoProfile -ExecutionPolicy Bypass -Command "& { <长命令> }"
```

关掉之后的行为差异要能看出来：回合不再自己续上，通知停在收件箱里；下次你说话时，`[some output was dropped from memory; full output: ...]` 那类通知随上下文一起进来，`job_list` / `job_output` 仍然随时能收。代价是失败也不会主动通知你——想要"跑完自己接着干"，就把 `-State on` 加回去，用 `-MaxWakes` 限制连续次数，而不是回到无上限。
