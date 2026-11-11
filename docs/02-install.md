# 安装

从一台干净的 Windows 到"面板能打开、状态是 ready"，一共五步。上游 `docs/006-deployment.md` 的 Install 段是这五步的 POSIX 版本，
差别只在启动方式与凭据包装器；bundle 本身一行没改。

## 0. 前置

| 依赖 | 要求 | 检查 |
| --- | --- | --- |
| Windows | 10 / 11 | — |
| Node.js | `^22.19.0 \|\| >=24.0.0` | `node -v` |
| git | 2.32+（`worker-gitconfig` 的凭据配置需要） | `git --version` |
| dsh | 落在上游 `engines.dsh` = `^0.2.1-alpha.2` | `dsh --version` |
| pnpm | 无所谓，没有就退回 `npx pnpm@11.7.0` | `pnpm -v` |
| 模型 provider | 已在 DSH 里配好 | 面板里能正常对话 |
| 一个 GitHub 账号 | 给 agent 用，不要用你自己的 | — |

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\doctor.ps1
```

`doctor.ps1` 是只读的，14 项检查按 PASS/WARN/FAIL 打表。安装前正常的 FAIL 只有两三条：
`profile 'superagent'` 不存在、`profile cordis.patch.yml` 不存在。其余 FAIL 必须先解决，
安装脚本不会替你猜。

`dsh` 没装：

```powershell
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
```

版本钉在 `0.2.1-rc.3` 是因为上游文档就是这么写的；装 `0.2.2-rc.1` 也能跑（本机验证过 0.2.2-rc.1），
但上游 peerDependencies 全部钉在 `0.2.1-alpha.2` 这一代，跨 minor 升级时留意日志里的兼容性提示。

## 1. 构建上游

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build.ps1
```

`build.ps1` 只做四件事，全部围绕 `vendor\upstream.lock.json`：

1. `git clone --filter=blob:none --no-checkout <source> upstream`（已存在则跳过）；
2. `git fetch --tags --force` 后 `git checkout --force --detach <commit>`——按 commit 取，不跟分支；
3. `pnpm install --frozen-lockfile`（无 pnpm 时 `npx --yes pnpm@11.7.0 install --frozen-lockfile`）；
4. `pnpm build`（tsdown），然后确认 `upstream\lib\index.js` 与 `upstream\cordis.patch.yml` 存在。

两点行为说明：

- **fetch 失败不等于构建失败。** 第 2 步的 `git fetch` 只是为了让新 pin 的 commit 可达。断网或网络抖动时，
  脚本会用 `git cat-file -e <commit>^{commit}` 判断这个 commit 是否已在本地副本里；在就降级成警告继续构建，
  不在才报错退出。所以改完 `vendor\upstream.lock.json` 之后第一次构建仍然需要联网。
- **stderr 里有输出不是错误。** pnpm 与 tsdown 会往 stderr 写进度和建议（例如「建议用 ESM 格式」）。
  脚本默认 `$ErrorActionPreference = 'Stop'`，合并 `2>&1` 时这些行会变成 `ErrorRecord` 把脚本直接终止，
  看起来像构建失败。`build.ps1` 只在发起 pnpm 的那一段把错误偏好放宽，成败仍由退出码判定。

产物不提交进仓库：`upstream/` 在 `.gitignore` 里。换机器、清目录之后重跑一次即可复现同一个 commit。

## 2. 建独立 profile

```powershell
dsh superagent --from-default-profile web --dump-config > $null
```

要点：

- **必须是独立 profile。** 面板与插件图都跟着 profile 走，用你自己的 profile 会让 super-agent 的
  模型配置、插件图和会话历史和你的日常工作混在一起，而且重启会打断你手上的 Session。
- `--from-default-profile web` 从 Web profile 模板复制，拿到完整的 UI 插件图；纯 CLI 模板打开后没有面板。
- 这条命令**会覆盖**已存在的 profile 并删掉它的 `cordis.patch.yml`。`install.ps1` 因此做了判断：
  目录已存在且没给 `-Force` 就保留并提示；给了 `-Force` 先复制一份 `.bak` 再重建。

## 3. 挂 bundle

```powershell
dsh plugin --profile superagent add "link:C:\path\to\dsh-superagent-windows\upstream"
```

用 `link:` 而不是包名：上游是 `private: true`，没有发布会，`link:` 直接把构建产物挂进 profile 的插件图。
挂完之后 `%USERPROFILE%\.dsh\profiles\superagent\cordis.patch.yml` 里应该出现 `id: dsh-superagent`；
`doctor.ps1` 有一项专门查这个。

## 4. 机器配置

上游的机器配置只有三个键，其余在面板里改：

```yaml
# %USERPROFILE%\.dsh\profiles\superagent\cordis.patch.yml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082
- id: dsh-superagent
  config:
    stateDir: 'C:/Users/<you>/.dsh/state/superagent'
```

`config\profile.cordis.patch.yml` 是可抄的整份样板。三条硬规则：

1. `stateDir` **必须是绝对路径**，且**不含空格**。上游把 `<stateDir>\worker-bin` 插到 PATH 最前，
   空格会让 shim 的参数切错。
2. `stateDir` 里放数据库、锁、worker-bin shim、agent 的 git 配置、默认 Ticket 目录——**升级前先备份**。
3. 未知键或非法值会让 profile 启动失败（不是警告）。加键之前先看这个键是否在插件 schema 里。

`stateDir` 不能在面板里改；`promptMaxChars`、`admissionContextMaxPages`、`admissionContextTimeoutMs`
这类机器上限可以在 Settings → Deployment 或 Plugin Manager 里改，改完不用重启。

`install.ps1` 会替你做这一步：先备份 patch，再追加缺的块（已存在 `id: webserver` 就只补 `port`/`host`）。

## 5. agent 的凭据

agent 要有**自己的** GitHub 身份，否则它开的 PR、留的评论都会挂在你名下，后面出问题分不清是谁做的。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\new-agent-cli.ps1
gh-agent auth login                       # 用 agent 账号登录，不要用你的
gh-agent api user --jq .login             # 验证
```

`new-agent-cli.ps1` 生成的是两个 `.cmd` 包装器：

- `%USERPROFILE%\.local\bin\gh-agent.cmd` → `set GH_CONFIG_DIR=%USERPROFILE%\.config\gh-agent` 后转发给真实 `gh.exe`；
- `%USERPROFILE%\.local\bin\lark-bot.cmd` → `set LARKSUITE_CLI_CONFIG_DIR=%USERPROFILE%\.lark-cli-dsh-superagent`（只在接飞书时需要）。

把那个目录加进用户 PATH（脚本会问，或者加 `-AddToPath`）。然后在面板 Settings → Sources 里，
GitHub Source 的 CLI 填 `gh-agent`——上游会把 `worker-bin\gh.cmd` 指向它，在 worker 的 PATH 里优先命中。

飞书是可选 Source。要接：`lark-bot config init --app-id <cli_…> --app-secret-stdin`，
然后 `lark-bot config strict-mode bot --global`（host 会拒绝能作为用户身份行动的 CLI）。
不接就保持 `dsh-superagent-feishu` 的 `disabled: true`。

## 6. 启动与验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-superagent.ps1 start
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-superagent.ps1 status
```

`start` 打印 `started pid=<n> log=<path>`，然后最多等 60 秒（`-Timeout`）等 `runtime` 变成 `ready`。
`status` 输出 JSON，看 `health.runtime` 和 `errors`；退出码 0 才算起来。

```powershell
start http://127.0.0.1:3082/orchestrator
```

面板打开后，Settings → Deployment 里把机器上限、Sources、Policy 补齐——具体取值见 [04-settings-api.md](04-settings-api.md)。

想让它开机就在、挂了能自愈：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-task.ps1
```

注册两个计划任务：登录时 `start -RespectStop`，每小时 `watchdog.ps1`。都不需要管理员权限
（`InteractiveToken` + `Limited`）。

## 升级

```powershell
# 1. 等 Executor 空闲（面板上看 running=0）
# 2. 备份数据库 —— 新版本迁移过的库旧版本打不开，回滚只能靠这份备份
Copy-Item "$env:USERPROFILE\.dsh\state\superagent\orchestrator.sqlite" "$env:USERPROFILE\.dsh\state\superagent\orchestrator.sqlite.bak" -Force

# 3. 改 vendor\upstream.lock.json 的 commit，重构建
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build.ps1 -Force

# 4. 重启并看状态
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-superagent.ps1 restart
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-superagent.ps1 status
```

回滚：把 `.bak` 覆盖回去，`vendor\upstream.lock.json` 改回旧 commit，`build.ps1 -Force`，再 `restart`。

## 装失败时先看这里

| 现象 | 原因 |
| --- | --- |
| `start` 报 `dsh was not found` | `dsh` 不在 PATH；`-DshExe` 指定绝对路径 |
| `status` 的 `setup` 非空、退出码 3 | 面板里 Settings → Sources/Policy 还没配完，或 agent CLI 没登录 |
| `errors` 里有 `github` | agent CLI 读不到账号、或没权限推这个仓库 |
| 日志里 `agent-preset/not-found` | bundle 挂了但 preset 没进 profile：重建 profile 再 `plugin add` |
| 面板 `Failed to load plugins` | 升级后没重启实例 |
| 中文乱码/脚本语法错误 | `.ps1` 丢了 BOM，`scripts\test-scripts.ps1` 会指出是哪个文件 |

完整对照表在 [03-operate.md](03-operate.md)。
