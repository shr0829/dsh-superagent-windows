# GitHub CLI：让执行器自己推分支、开 PR

super-agent 的执行器没有鼠标。它做完一个 Ticket 之后要做的三件事——推分支、开 PR、回去评论——
只能通过 `gh`（GitHub CLI）完成。所以 `gh` 不是可选工具，而是执行链路的一部分：它登不上，
Ticket 就会卡在 `delivery` 阶段，面板上看到的是一条一直不结束的 Assignment。

这份文档写清楚**怎么把它配到能干活**，以及配好之后怎么验证。

## 一、三个必须同时成立的条件

| 条件 | 检查命令 | 不成立的后果 |
| --- | --- | --- |
| `gh` 装好且 ≥ 2.48 | `gh --version` | 上游 `docs/006-deployment.md` 明确要求 2.48+；setup check 直接报 `The agent GitHub CLI was not found.` |
| 认到一个账号 | `gh auth status` | 报 `The agent GitHub CLI cannot read its account` |
| 该账号对目标仓库有写权限 | `gh api repos/<owner>/<name> --jq .permissions.push` | 报 `@<login> cannot push to <owner>/<name>` |

三条都过了，`gh pr create` 才可能成功。少任何一条，后面的调试都是浪费。

## 二、本机的实际配置（已配好，可直接照抄）

```
gh 2.103.3        C:\Program Files\GitHub CLI\gh.exe        （winget install --id GitHub.cli --exact）
账号              shr0829
token scopes      gist, repo, workflow                      （缺 read:org，只影响 org 级命令）
git 凭据助手      credential.https://github.com.helper = !'C:\Program Files\GitHub CLI\gh.exe' auth git-credential
```

装包 ID 是 `GitHub.cli`（小写 `GitHub.CLI` 会 `No package found`），winget 的 `--exact` 必须带。

`gh` 装完当前终端可能还看不到它——PATH 是进程启动时复制的。要么重开终端，要么临时
`$env:Path = "C:\Program Files\GitHub CLI;$env:Path"`。`scripts\doctor.ps1` 两处都查，所以它不会误报。

## 三、为什么不用 `gh auth login --with-token`

直接用现成 token 登录会失败：

```
error validating token: missing required scope 'read:org'
```

`gh auth login` 会硬校验 `read:org`（还有 `gist`、`workflow`）。而本机 git credential 里那个
`gho_` 开头的 OAuth token 只有 `gist`、`repo`、`workflow`——够推分支、够开 PR、够改 workflow，
就是不够 org 级操作，于是被登录流程挡在门外。

两条出路：

1. **`gh auth refresh -h github.com`**：走一遍浏览器授权，把 `read:org` 补上。适合你确实要操作组织仓库。
2. **直接写 `hosts.yml`**（`scripts\setup-gh.ps1` 采用的路子）：gh 的登录状态就是这份文件，
   写它等于完成登录，`gh auth status` 之后只是把缺 scope 标成一行提醒，不影响任何仓库级命令。

文件位置与格式：

```yaml
# %APPDATA%\GitHub CLI\hosts.yml
github.com:
    user: shr0829
    oauth_token: gho_xxxxxxxx
    git_protocol: https
```

规矩：**UTF-8 无 BOM、LF 行尾、四空格缩进**。写成 CRLF 或带 BOM 时 gh 会读不到（YAML 解析失败），
表现是 `gh auth status` 说没登录，而你打开文件看一切正常。`setup-gh.ps1` 用
`Write-Utf8Text`（无 BOM）写、覆盖前先备份成 `hosts.yml.bak-<时间戳>`。

## 四、`gh auth setup-git` 做了什么

它往**全局** git config 写两条：

```
credential.https://github.com.helper = !'C:\Program Files\GitHub CLI\gh.exe' auth git-credential
credential.https://gist.github.com.helper = （同上）
```

作用：走 HTTPS 的 `git push` / `git fetch` 时，git 向 gh 要凭据，而不是去翻 Windows 凭据管理器。
影响范围只有 `https://github.com` 和 `https://gist.github.com`，**SSH 远端完全不受影响**
（本仓库的 `origin` 就是 `git@github.com:...`）。原有的 gitee 凭据配置也原样保留。

这条配置是"执行器能用上 gh 账号"的关键：上游在 `<stateDir>\worker-gitconfig` 里把 github.com 的
credential helper 指向 agent 的 CLI，正是同一套机制。没有它，worker 推分支时要用另一份凭据，
setup check 会报 `git does not read the github.com credential configuration dsh-superagent writes`。

## 五、配完之后的一键验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-gh.ps1 `
  -FromGitCredential -Repository shr0829/dsh-superagent-windows
```

脚本五步：装 gh（缺就 winget）→ 取 token 并写 `hosts.yml`（带备份）→ `gh auth status` 复核账号 →
`gh auth setup-git` → 用一次 API 调用验证推送权限、用 `gh pr list` 验证 PR 通道。
任何一步不成立都直接报错退出，不留下"看起来配好了"的状态。

`doctor.ps1` 里对应三行：`gh CLI`（版本 ≥2.48）、`gh 账号`（登录名 + scopes）、
`仓库 owner/name`（`permissions.push` 是否为 true）。

## 六、自动开 PR 的实际形态

执行器侧（或在你自己终端里手跑）就是三段：

```powershell
git push -u origin HEAD
gh pr create --repo shr0829/dsh-superagent-windows --fill --base main
gh pr merge --repo shr0829/dsh-superagent-windows --squash --auto --delete-branch
```

`--fill` 用分支上的 commit 标题与正文当 PR 标题与正文，不需要交互输入——这是"自动"的前提。
`--auto` 只有在仓库允许 auto-merge 时才生效（仓库 Settings → General → Allow auto-merge，
本仓库已开启）；没开时 `gh pr merge --auto` 会报 `Auto-merge is not allowed`，改用不带 `--auto` 的
`--squash` 直接合。

上游把"哪些 PR 可以自动合"放在 Settings → Prompts 里（auto-merge 条件、review bots、commit 作者），
判定在 Orchestrator 侧，`gh` 只负责执行。所以这里的配置只解决"有没有能力"，不决定"该不该合"。

## 七、agent 用独立账号时

上游的设计是**执行器用 agent 自己的 GitHub 账号**，与你本人的账号分开：PR 的 commit 作者、
评论者都是 agent，出了事能一眼分清谁做的。落地方式是 `gh-agent.cmd`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\new-agent-cli.ps1
# 生成 %USERPROFILE%\.local\bin\gh-agent.cmd，内容是：
#   set GH_CONFIG_DIR=%USERPROFILE%\.config\gh-agent
#   "C:\Program Files\GitHub CLI\gh.exe" %*
gh-agent auth login            # 登 bot 账号
gh-agent api user --jq .login  # 复核
```

`GH_CONFIG_DIR` 一换，gh 用的就是另一份 `hosts.yml`，两套账号互不覆盖。`doctor.ps1` 分开检查
`gh`（你的账号）与 `gh-agent`（agent 账号），因为它们的失败原因完全不同。

只用同一个账号也能跑通全部流程，只是 PR 上看不出"这是 agent 做的"。

## 八、故障对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `missing required scope 'read:org'` | 只出现在 `gh auth login --with-token` | 用 `setup-gh.ps1`（写 hosts.yml），或 `gh auth refresh` 补 scope |
| `gh` 命令找不到，但文件在 Program Files | 当前终端 PATH 是启动时的快照 | 重开终端，或临时前置 PATH |
| `hosts.yml` 看着对，`gh auth status` 说没登录 | BOM / CRLF / 缩进不是四空格 | 用 `Write-Utf8Text` 重写，或让 `setup-gh.ps1` 覆盖 |
| `HTTP 401: Bad credentials` | token 过期或被撤销 | 重新取 token 再跑 `setup-gh.ps1` |
| `push=true` 但 PR 创建 403 | 分支保护或仓库规则限制了 push 路径 | 看 Settings → Branches 的规则，不是 gh 的问题 |
| `Auto-merge is not allowed` | 仓库没开 allow auto-merge | Settings → General 打开，或去掉 `--auto` |
| `gh pr create` 提示无 upstream 分支 | 分支没 push 或没设 upstream | 先 `git push -u origin HEAD` |
| 执行器报 `@x cannot push to y` | agent 账号没有该仓库写权限 | 把 agent 账号加成 collaborator，或换有权限的账号 |

## 九、还没验的部分

- agent 用**独立** bot 账号跑完整 Ticket 的链路（本机只有 `shr0829` 一个账号，`gh-agent` 尚未登录 bot 账号）；
- PR 的 review bots 与 auto-merge 条件在 Orchestrator 侧的判定（属于 Settings → Prompts，不在本仓库范围）；
- GitHub Enterprise Server（上游明确只支持 github.com）。
