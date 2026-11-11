# 06 · 测试基线（Windows）

源码入仓后的第一手测量：`pnpm test` 在本机跑出的失败集。这份清单是分支 2（`feat/worker`）的起点——
"测试全绿"这个判据在 Windows 上不是起点，而是要达成的结果。

## 测量

```
node v24.18.0 · pnpm 11.7.0 · vitest 4.1.8
Test Files  9 failed | 50 passed (59)
Tests       43 failed | 1154 passed (1197)
Duration    64.59s
```

上游在 POSIX 环境开发，测试与被测代码里写死了 `sh`、信号、`tmux` 与权限位。所以这些失败不是代码坏了，是**平台假设没被抽象出来**。

## 失败的 9 个文件

| 文件 | 失败数 | 失败长什么样 |
| --- | --- | --- |
| `tests/service-script.spec.ts` | 15 | 直接跑上游的 `scripts/dsh-superagent`（Python + `tmux` + `ps` + `SIGINT`） |
| `tests/environment.spec.ts` | 6 | `spawn sh ENOENT`；worker-bin 的 `#!/bin/sh` shim |
| `tests/sources.spec.ts` | 6 | 飞书消费进程用 `sh` 起子进程 |
| `tests/commands.spec.ts` | 4 | `sh -c` 执行命令行、信号与生命周期 |
| `tests/deployment.spec.ts` | 4 | 环境变量拼装、CLI 探测路径 |
| `tests/docs.spec.ts` | 3 | 校验上游 `docs/007-architecture.md` 的模块表与测试表——上游 docs 没有随源码入仓 |
| `tests/prompts.spec.ts` | 1 | 提示词文件的读写假定 POSIX 路径/换行 |
| `tests/runtime.spec.ts` | 1 | worker shim 的写出与还原 |
| `tests/store.spec.ts` | 1 | `statSync(...).mode & 0o777` 期望 0700/0600——Windows 没有 POSIX 权限位（实测 438 = 0o666） |

## 三类原因，三种处理

1. **`spawn sh` / 信号 / `tmux`**：把执行层抽成平台适配（分支 2 的 `executor/platform.ts`），测试改为按平台注入。
   这类占绝大多数，也是"Windows 上能不能跑"的核心。
2. **权限位**：Windows 的 ACL 不等于 `mode & 0o777`。测试要断言"owner-only"，得换成 ACL 检查或按平台跳过。
3. **文档表**：`docs.spec.ts` 校验的是上游 docs 的结构。本仓库的 docs 是自己的编号体系，
   两个选择——把上游 docs 收进 `docs/upstream/` 并改测试路径，或放弃这条测试并说明理由。**未定，留给分支 2**。

## 对分支的约束

- 分支 2 的验收不是"测试数量不变"，而是**这 43 条要么转绿、要么按平台显式跳过并写明原因**。
  静默删除测试不算完成。
- 新增测试默认要能在两个平台跑；写死 `sh` 的测试进不来。
- 每条失败都在 `docs/01-windows-deltas.md` 的差异表里有对应的一行；测试是那张表的证据。
