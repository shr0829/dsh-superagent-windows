# 07 记忆：数据库优先、Markdown 兜底

链式召回在上一轮只做到了"工作对象之间有链接"：Trigger、Thread、Decision 的投影里带 `links`，模型顺着
`links[].read` 一跳一跳读下去。它缺的是**跨 Session 的那一层**——一个 Runner 重启、模型换掉、Thread 关掉以后，
"这个仓库的发布脚本不能用 pwsh 7"这句话没有地方存。本轮补的就是这一层，并且按文章 3.3 的要求，让记忆本身
也长成一条链，而不是一个越堆越大的摘要池。

## 一、两种形态，默认数据库

`openMemory(stateDir)`（`src/memory/index.ts:12`）一次给出两样东西：

- `stateDir/memory.sqlite`：数据库形态。
- `stateDir/memory/`：Markdown 形态，一条记忆一个 `<id>.md`。

数据库能打开就两样都写：一次 `save` 依次落到数据库与 Markdown（`src/memory/store.ts:33`），所以数据库是默认的
读写路径，Markdown 是可读、可 diff、可手工修的副本。数据库打不开（文件被占、目录同名、`node:sqlite` 在该 Node
版本上不可用）时，`openMemory` 捕获异常，只返回 Markdown 形态，并把原因放进 `status().fallback`；此后所有读写
照常，只是少了数据库这一份。

读的时候按 id 合并：数据库先答，Markdown 补上数据库里没有的（`src/memory/store.ts:53`）。早期只有 Markdown 时
写下的记忆因此不会因为后来接上数据库而消失。

### 为什么是 SQLite

选它不是因为"关系型更正统"，是三条具体约束把别的选项排掉了：

1. **不加依赖。** 本仓库的运行时依赖只有 `proper-lockfile` 与 `zod`。`node:sqlite` 从 Node 22.5 起在标准库里，
   `engines` 要求 `^22.19.0 || >=24.0.0`，直接可用；换 Postgres/Redis 意味着多一个要装、要起、要备份、要给凭据的
   进程，而部署目标是"一个人的 Windows 机器"。
2. **和编排库同一种失效方式。** 编排状态已经在 `orchestrator.sqlite`（`src/app/store.ts`）。记忆用同一个引擎，
   备份、恢复、排障只有一套手法。
3. **单独一个文件。** 记忆库是 `memory.sqlite`，不是 `orchestrator.sqlite` 里的一张表。这样记忆子系统可以
   **fail-open**：记忆库损坏或被锁住时，编排照常跑，记忆退回 Markdown；反过来，如果它和编排库共用文件，
   一次 `SQLITE_BUSY` 会同时打断两件事。

表只有一列需要解释：

```sql
CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL)
```

`value` 是整条记录的 JSON。记忆的字段还会变（下一节就会加），而 `id` 与 `at` 是唯一需要索引的两列——列表按
`at` 倒序，取单条按 `id`。目录以 0700 建、文件降到 0600（`src/memory/sqlite.ts:19`）。

### Markdown 形态

一条记忆一个文件，文件名就是 id，内容是 JSON front matter 加正文：

```markdown
---
id: "mem_1a2b3c4d0e"
title: "发布脚本必须用 Windows PowerShell 5.1 语法"
at: "2026-11-11T07:40:12.000Z"
kind: "lesson"
tags: ["powershell", "scripts"]
next: ["memory/mem_9f8e7d6c05"]
---
`??` 与 `?:` 在 5.1 上直接语法错误，写脚本前先确认解释器版本。
```

front matter 的每个值都是 JSON 标量或数组，解析用 `JSON.parse`，不做 YAML 的那套隐式类型（`no` 不会被读成
布尔）。写入走临时文件加 rename，读者不会看到半个文件；权限 0600；解析失败的文件跳过而不是让整个目录读不出来。
正文里可以写任何 Markdown，包括代码块里的 `---`——分隔符只认文件开头的那一对。

## 二、一条记忆长什么样

```ts
interface MemoryRecord {
  id: string          // mem_<8 位十六进制><2 位长度>，FNV-1a(seed)
  title: string       // 卡片上那一行
  text: string        // 正文，留在资源后面
  at: string          // ISO 时间
  kind: 'note' | 'decision' | 'fact' | 'lesson'
  tags: string[]
  next: string[]      // 这条记忆继续/依赖的资源
  source?: string
  thread?: string
  ticketId?: string
  supersedes?: string[] // 这条记忆由哪些旧记忆合并而来
}
```

id 的哈希是 FNV-1a（`src/memory/model.ts:44`），默认种子是"时间 + 随机串"，所以同一条内容写两次是两条记忆；
调用方要稳定引用时可以自己给 `id`，哈希只负责把任意种子压成 URL 安全的短串。`next` 的合法形态由
`MEMORY_REF` 限定为 `memory/<id>`、`ticket/<id>`、`thread/<key>`、`decision/<id>`、`trigger/<id>`——也就是
资源路由本来就能读的那几种，记忆不能凭空发明一种地址。

## 三、链式召回怎么走

一篇记忆的**卡片**（`src/app/cards.ts` 的 `memoryCard`）是：

```json
{ "memory_id": "mem_…", "title": "…", "kind": "lesson", "at": "…",
  "tags": ["…"], "next": ["memory/mem_…", "ticket/t_…"], "chars": 214, "read": "memory/mem_…" }
```

卡片不带正文，只带长度和读法——这就是文章里的 Spill。读 `memory/<id>` 时，投影把卡片自己的 `read` 去掉，
换成 `links`，并把正文按 4000 字符分页：

```json
{ "memory_id": "mem_…", "title": "…", "text": "…", "total_chars": 214, "next_offset": null,
  "links": [ { "rel": "continues", "read": "memory/mem_9f8e…" },
             { "rel": "ticket", "read": "ticket/t_42" } ] }
```

- `rel` 由 `memoryRelation` 给：指向另一条记忆是 `continues`，指向工作对象就用它的前缀（`ticket`、`thread`、
  `decision`、`trigger`）。卡片上因此不需要再排一遍路径。`source` 单独加一跳：记忆指回产生它的 ticket 时
  `rel` 就是 `source`，它不参与 `next` 的并集，也不占合并时的去重。
- `links` 不是把 `next` 原样抄出来，而是逐条问"这个地址现在还读得到吗"（`src/app/views/memory.ts` 的
  `memoryTarget`）。记忆指向的 ticket 被清掉、thread 关掉，那一跳就不出现；指向一条不存在的记忆同理。
  模型因此不会拿到一条会 404 的链接。
- 正文超过一页时 `next_offset` 给出下一页的 offset，和既有资源的 `textPage` 是同一个约定。

于是召回是"搜索 → 卡片 → 一跳 → 再一跳"：`orchestrator_memory_search` 用词匹配找到入口，卡片给出下一跳的
id 与摘要，模型自己决定跳不跳。整个过程中没有任何一步需要把全部记忆读进上下文。

### 与既有 links 的关系

工作对象的链接在 `src/app/recall.ts` 与 `src/app/resources.ts` 里已经算好了（trigger 的 thread/decision/ticket、
thread 的最新 decision、decision 的 trigger 等）。记忆的链接是**读的时候现算**的，因为"目标还在不在"要问当前的
store，存进卡片会在对象消失后变成死链。两边合起来是一条闭环：ticket → 它的 thread → 那个 thread 上关于同一件事
的记忆 → 记忆继续的另一条记忆。

## 四、模型能用什么

| 工具 | 作用 |
| --- | --- |
| `orchestrator_memory_save` | 写一条记忆；参数 `kind`、`title`、`text`、`tags`、`next`、`source`、`thread`、`ticketId`、`id`；返回卡片加 `backends`（这次落到哪几种形态） |
| `orchestrator_memory_search` | 按词找记忆，`query` 里每个词都要命中（标题、正文、标签、thread、ticket），返回卡片列表，默认 10 条 |
| `orchestrator_memory_merge` | 把 2–20 条记忆合成一条：正文按 `## 标题` 拼接，标签与 `next` 取并集，原条目删除，id 记进 `supersedes` |
| `orchestrator_memory_forget` | 按 id 删除一条记忆，数据库与 Markdown 两份都删 |

资源侧是 `memories`（倒序列表）与 `memory/<id>`（卡片 + 一跳 + 正文分页）。`orchestrator_read memories` 拿到的
是列表页，`orchestrator_read memory/mem_…` 才是正文。提示词里加了一句说明，工具白名单与资源表由
`tests/model-surface.spec.ts` 的预算守着（`BUDGET.orchestrator` 61_000 → 63_000，实测 62_004）。

## 五、遗忘与合并

这两件事都不该由存储层自己决定，但也不该只剩"手工改文件"一条路。

**遗忘**（`Memory.remove`，`src/memory/store.ts:78`）对每个还活着的后端各删一次，任何一个后端报错都吞掉——
删不掉的原因会由下一次 `get` 暴露，而不是让整个调用失败。返回 `{ id, removed }`，`removed` 表示至少删掉了一份；
再删同一条返回 `false`，所以这个动作是幂等的。删除之后，别的记忆里指向它的那一跳也就不再出现：`memoryLinks`
本来就会问"目标还在不在"。

**合并**（`Memory.merge`）解决的是另一种情况：两条记忆各自只对了一半，删掉任何一条都会丢信息。规则是确定的：

- 至少两条、至多 20 条**存在**的记录；不足两条直接报 `Merging needs at least two existing memories`，不写半条。
- 正文按 `at` 排序后拼成 `## <title>\n\n<text>`，中间空一行；`title` 默认是各标题用 ` / ` 连起来并截到 200 字符，
  `kind`、`text`、`title` 都可以由调用方覆盖。
- `tags` 取并集；`next` 取并集后**减去指向被合并条目的那些**——否则新记忆会指回已经删掉的自己。
- `source`、`thread`、`ticketId` 取最早那条的，`supersedes` 记下被合并的 id。`supersedes` 只做记录：
  召回时不展开，面板上单独列出，方便事后追问"这条是从哪几条合出来的"。
- 先写新记录，再逐条删旧的；中途失败时旧记录还在，最多多出一条合并结果，不会两样都没有。

两个动作都不自动发生：没有定时去重、没有按相似度触发、没有"摘要压缩"。什么时候该合并由一个看着上下文的
调用方决定——现在是模型，面板上则是由人勾选。

## 六、面板记忆页

`memory` 是面板的一个一级页（`src/client/memory.tsx`），列表与详情分别对应 `GET memories` 与 `GET memories/:id`：

- 列表按 `at` 倒序，每行一个复选框、一个标题按钮（进详情）、kind 标签、时间、字符数与标签；搜索框写入 `q`，
  沿用 `search` 的与语义，命中为 0 时给"没有匹配"而不是空列表。
- 详情是卡片加正文，正文走 `MarkdownLite`；下面一节列 `links`，每条按 `rel` 给一个按钮，跳到记忆、ticket、thread、
  decision 或 trigger；`supersedes` 单独列出，只显示 id。删除走 `ConfirmButton`，成功后回列表并提示。
- 勾选两条以上时工具栏出现"合并所选"，弹窗里说明规则（正文怎么拼、原条目会删），确认后调
  `POST memories/merge`；成功后刷新列表并提示合并了几条。

HTTP 侧四个端点：`GET memories`（`q`、`offset`、`limit`）、`GET memories/:id`、`POST memories/merge`、
`POST memories/:id/forget`。请求类型写在 `src/app/api.ts`，视图逻辑在 `src/app/views/memory.ts`，
和 `memory/<id>` 资源共用同一套 `links` 解析——面板与模型看到的是同一条链，不是两套投影。


## 七、边界

- **没有向量检索，也没有全文索引。** `search` 是对全部记录做词包含判断（`src/memory/store.ts:69`），命中即返回，
  不排序、不算相关度。记忆量到几千条时这是几十毫秒的线性扫；到几万条才需要索引层，那时再谈 FTS5 或向量。
- **链是图遍历，不是一次展开。** 卡片只 inline 下一跳的 id 与标题，正文永远在资源后面。想一次拿三跳，就得读三次——
  这是文章 3.3 的刻意选择，不是实现偷懒。
- **ticket 详情仍然没有 links。** 页面预算 3000 字节（`tests/tools.spec.ts`）卡着，加了就红。记忆的入口因此是
  `memories`、`memory/<id>` 和搜索，不是从 ticket 卡片直接跳。
- **合并与遗忘不自动发生。** 没有定时去重、相似度触发或摘要压缩；什么时候合并由模型或面板上的人决定。
- **`supersedes` 只是记录。** 召回不沿它展开，面板只列 id；想知道合并前的原文，只能去 Markdown 目录翻
  （原条目已经被删掉，所以真要保留就该先复制一份）。
- **手工改 Markdown 立刻可读，但数据库副本优先。** `MarkdownMemory.get/list` 每次调用都读目录，不需要重启；但如果同一个 id
  在数据库里也有，合并时数据库那份赢（第八节验证第 4 条），所以要改一条已经在库里的记忆，改库或先删掉库里的那条。

## 八、验证

`tests/memory.spec.ts` 十条：

1. Markdown 往返：含中文、引号、代码块正文原样读回。
2. 一次 `save` 同时落数据库与 Markdown，两边都能 `get`/`all`。
3. 数据库打不开（把 `memory.sqlite` 先建成目录）时 `status().database === false`、`fallback` 有值、
   `save` 只写 `['markdown']`。
4. 合并：同 id 数据库赢；只有 Markdown 的旧记录仍然出现在 `all()` 里。
5. 链式召回：`memory/<id>` 的 `continues` 一跳可读，指向已消失 ticket 的一跳被丢掉，正文分页，卡片保留 `read`
   而资源去掉自己的 `read`。
6. `source` 回跳：记忆指回产生它的 ticket；`thread/feishu:oc_team:om_1` 这种带冒号的键能通过 `MEMORY_REF`，
   带斜杠的不行。
7. 正文分页：列表卡片只有 `chars`，`memory/<id>` 按 `limit` 分页，`next_offset` 与 `total_chars` 可拼回原文。
8. 搜索：标题、正文、标签、thread 四个位置各自能命中，多词是与关系。
9. 遗忘：两份都删，文件消失，指向它的一跳消失，第二次删除返回 `false`。
10. 合并：`supersedes`、拼接后的正文、标题与标签并集、`next` 去掉已合并 id、原条目消失、单条合并报错。

`tests/panel-memory.spec.tsx` 两条：列表→详情→一跳→遗忘；按词过滤→勾选→确认→合并请求与列表结果。
`docs/upstream/007-architecture.md` 的模块表与测试表同步登记了 `src/memory/*`、`src/app/views/memory.ts`、
`src/client/memory.tsx`、`tests/memory.spec.ts` 与 `tests/panel-memory.spec.tsx`；
`node_modules\.bin\tsc.CMD --noEmit` 与 `node_modules\.bin\vitest.CMD run` 全绿。
