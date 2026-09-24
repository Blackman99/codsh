<p align="center">
  <a href="https://blackman99.github.io/codsh/zh.html">
    <img src="assets/banner.svg" width="900"
         alt="codsh — 面向 DeepSeek 的终端编码 agent">
  </a>
</p>

<p align="center">
  <a href="https://blackman99.github.io/codsh/zh.html"><b>站点</b></a> ·
  <a href="https://blackman99.github.io/codsh/gallery.zh.html">展示画廊</a> ·
  <a href="https://www.npmjs.com/package/codsh-cli">npm</a> ·
  <a href="README.md">English</a> | 中文
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codsh-cli"><img src="https://img.shields.io/npm/v/codsh-cli.svg" alt="npm version"></a>
  <a href="https://github.com/Blackman99/codsh/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Blackman99/codsh.svg" alt="MIT license"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-1f6feb" alt="dsh-plugin topic"></a>
  <a href="https://dshfind.com/zh/plugins/Blackman99/codsh?ref=badge"><img src="https://dshfind.com/api/badge/Blackman99/codsh?lang=zh" alt="dshfind"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://cdn.rawgit.com/sindresorhus/awesome/d7305f38d29fed78fa85652e3a63e154dd8e8829/media/badge.svg" alt="Awesome"></a>
</p>

> npm：[`codsh-cli`](https://www.npmjs.com/package/codsh-cli) · 命令：`codsh`

**codsh** 是面向 DeepSeek —— 以及任何 OpenAI 兼容端点 —— 的终端编码 Agent，直接构建在 [dsh](https://github.com/deepseek-ai/deepseek-harness) 之上，绝非 fork。

核心命令 **`/ship`** 可将一句话需求自动转化为已验证的代码，提供贯穿终端与浏览器的即时任务流全景图。

想看看实际能做出什么？[逛逛展示画廊](https://blackman99.github.io/codsh/gallery.zh.html)，查看真实截图并试玩作品。所有项目均从**一句话需求**开始，仅经**一轮交互**，**所有问题均采用推荐答案**完成落地。

## 安装

```sh
npm install -g @deepseek-ai/dsh codsh-cli
export DEEPSEEK_API_KEY="your-api-key"
codsh
```

常用命令与参数：
- `codsh -p "任务"` — 直接执行非交互式任务
- `codsh --rust -p "任务"` — 用真实 dsh 执行一次纯文本任务，答案写到 stdout 后退出
- `codsh --continue` — 继续上一次会话
- `codsh --resume <id>` — 恢复指定会话
- `codsh update` — 升级启动器与 profile runtime

## 隔离的 Rust 客户端（本地候选包）

`codsh --rust` 显式选择并行开发的 Rust 客户端；直接运行 `codsh` 仍使用旧版。
Rust 界面通过 ACP/JSON-RPC 把提示提交给隔离 Home 中真实的 `dsh --profile acp`。
`codsh --rust agent stdio` 是编辑器入口，使用同一 dsh 会话：ACP 版本 1，
`session/new`、`session/load`（dsh 恢复并只读回放历史）、`session/prompt`、
`session/cancel`、`session/set_config_option`（模型、推理力度和
`permission_mode`）以及审批请求。模型和推理力度在下一次 prompt 之前写入
`$GROK_HOME/model-selection.toml`，并在 `session/load` 和终端恢复时恢复，
包括不是 `config.toml` 目录 id 的已公布模型。两者都不是的模型会被拒绝。终端
`/dontAsk` 与 `/acceptEdits` 设置同一会话权限模式，并且在 dsh 启动前写入策略文件。专有 `x.ai/*` 方法、`session/delete`、
`session/fork` 和 `session/set_mode` 返回 JSON-RPC method-not-found，而不是成功桩。
关闭编辑器会释放写入者；持有期间第二个客户端会被拒绝。在 Zed 中把自定义 Agent
服务器的命令设为已安装的 `codsh`，参数为 `--rust`、`agent`、`stdio`。本次没有启动
Zed 或其他图形编辑器；可重复检查是外部 ACP 客户端通过标准输入输出驱动协议。

共享服务需要显式开启；普通启动不会常驻服务，也不会监听端口。
`codsh --rust agent serve` 通过带认证的 WebSocket（`/ws`，默认 `127.0.0.1:2419`）
提供同一套 ACP。密钥来自 `--secret`、`GROK_AGENT_SECRET`，否则自动生成并只打印一次；
客户端发送 `Authorization: Bearer <secret>` 或 `?server-key=<secret>`，`--bind`
不是回环地址时会打印警告。`codsh --rust agent leader` 在 `$GROK_HOME/leader.sock`
上运行每用户一个的 leader（权限 0600，只接受同一用户的连接）。`agent --leader stdio`
或 `[cli] use_leader = true` 会为编辑器启动或复用它；`--no-leader` 优先。每个活动会话
只由一个 dsh 进程执行。对本进程已在运行的会话调用 `session/load` 会直接接入，不会出现
第二个执行者：已保存的轮次、正在运行的轮次和待处理的审批会重新发送。审批请求发给所有
已接入的客户端，第一个回答生效，迟到的回答会收到 `_codsh/stale_response`。轮次运行期间
的第二个 prompt 会被拒绝，不会排队。选项修改以 `config_option_update` 通知其他客户端。
客户端断开不会取消轮次。dsh 退出会以 `_codsh/runtime_exited` 报告；正在运行的轮次效果
未知，不会重试。沙箱配置不是 `off` 时，会话留在编辑器自己的进程里，不进入 leader；leader
客户端也不能带自己的模型或权限参数。`codsh --rust leader list|info|kill` 查看并停止
leader。`agent headless`、`--remote`、`--grok-ws-url` 和 Cursor worker 模式依赖官方服务，
会被拒绝。leader 只支持 Unix；本次在 Linux 上验证，未在 macOS 或 Windows 上验证。

流式回答、提供商给出的思考、空回答和失败都按 dsh 的实际结果显示；协议不匹配
或找不到 dsh 会明确拒绝，不会伪造成功。它复用具有合法许可证的 Grok Rust
界面组件，无需官方账号，不启动旧版 Bundle、官方 Agent 核心、更新检查、遥测
或反馈上传。已连接时按 Enter 会把草稿交给 dsh；未连接时明确提示执行不可用，
不发送草稿。文件读取、写入和编辑走真实 dsh 工具。shell 命令走 dsh 的 bash 工具：卡片显示标准输出、标准错误和退出码，包括 0。非零退出不会显示成成功。Ctrl+C 会取消正在运行的命令，dsh 把它报告为已中止。被拒绝的命令不会运行。acp 配置没有挂载 dsh 的持久终端，窗口缩放也不是 dsh 的工具，所以交互终端会话不可用。后台任务使用同一个 bash 工具。`--sandbox <profile>`（或 `GROK_SANDBOX`，或隔离 `$GROK_HOME/config.toml` 里的 `[sandbox] profile`）会在启动 dsh 之前把 Seatbelt（macOS）或 Landlock（Linux）应用到本进程。默认 `off` 不加文件系统约束。`workspace` 可读范围较宽，只能写工作区、`$GROK_HOME` 和临时目录。`read-only` 与 `strict` 收窄写入。`devbox` 不保护全局 hook 和配置文件；继承 `devbox` 的自定义配置仍由内核实施其 `deny` 列表。自定义配置写在 `$GROK_HOME/sandbox.toml` 或 `.grok/sandbox.toml`（`extends`、`read_only`、`read_write`、`deny`）。`$GROK_HOME` 是符号链接、`hooks-paths` 目标含符号链接或缺失、配置损坏，或内核无法实施策略时，启动会被拒绝，而不是无约束继续。`$GROK_HOME/sandbox.toml` 与 `.grok/sandbox.toml` 对同一自定义配置定义不同时，启动采用用户文件、发出警告，并写出两份路径；定义相同则不警告。相对 deny glob 只覆盖工作区：`**` 按路径段匹配，不会拒绝同级目录或只是前缀相同的路径。`**` 只能作为完整路径段（`**/`、`a/**`）；`**.pem` 或 `certs/**.pem` 这种贴着别的字符的写法会拒绝启动。Seatbelt 按解析后的路径匹配，所以每个 deny 路径和每个 deny glob 的字面前缀都会通过其最深的已存在祖先解析（例如 `/tmp` 解析为 `/private/tmp`，或符号链接目录解析为其目标），两种形式都会被拒绝；启动后才创建的被拒绝文件也同样覆盖。相对 glob 所锚定的工作区即使名字里含 `[`、`*` 或 `?` 也按字面处理。位于悬空符号链接下、或含控制字符的 deny 路径无法写成能匹配的内核规则，会拒绝启动。deny glob 锚定在其字面前缀上，因此该前缀目录及其在可写根以内的已存在祖先都被固定，不能被重命名或删除。祖先遍历停在解析后的可写根：`/tmp` 与 `/private/tmp` 是同一个根，所以位于 `/tmp` 下的工作区不会把 `/tmp` 或 `/private/tmp` 本身固定，锚定在工作区的 glob 也不会固定工作区之外的目录。glob 尾部内部的目录（包括启动后才创建的）同样由目录正则固定：Seatbelt 按解析后的路径匹配，把该目录重命名到另一个可写根会把已匹配的文件带出正则。Seatbelt 只看源路径，因此留在 glob 内部的目录重命名同样被拒绝。受沙箱约束的子进程无法通过 launchd（`launchctl submit`、`launchctl bootstrap gui/$UID`）让未受约束的进程读取被拒绝的文件：该逃逸在配置下被内核阻止，与参考 nono 配置的 `mach-lookup` 规则一致（探针确认只有关闭沙箱时才会成功）。deny 条目里任何位置的 `.` 或 `..` 段（包括 `a/./secret`）也会拒绝启动。`[!a]` 和 `[^a]` 在 macOS 配置里都表示否定。POSIX 字符类、空的 `//` 段、尾斜杠，以及只能当字面量的 `^`，会拒绝启用而不是套用。`codsh --rust inspect` 与 `inspect --json` 不套用沙箱。它们打印解析出的配置名和全部配置错误（包括损坏的 `fail_closed` 文件），而不是停在第一条错误上。非 inspect 启动仍会在 dsh 启动前拒绝该文件。`[sandbox] profile` 与 inspect 使用同一个配置加载器：已签名的 `requirements.toml` 锁定值优先于 `--sandbox`、`GROK_SANDBOX`、`GROK_CONFIG` / `GROK_CONFIG_PATH` 以及更低层的文件。托管默认值没有这个锁定，上述来源可以覆盖它。不受信任的项目文件不会选中配置。`--sandbox`、`GROK_SANDBOX` 或 requirements 锁定值点名自定义配置，也不会因此信任 `.grok/sandbox.toml`。只存在于该不受信任文件里的定义会拒绝启动。用户 `$GROK_HOME/sandbox.toml` 里的定义仍然可用，两边都定义同一名称时仍采用用户文件。不受信任的项目文件不会被套用。能解析的内容只在两边定义不一致时用来指出两份路径；损坏、无法读取或为符号链接的不受信任项目文件不会否决用户定义。受信任的项目文件若损坏，启动仍会被拒绝。`[sandbox]` 是用户配置和受信任项目配置里的已知策略键，已签名的 `fail_closed` 要求生效时也一样。macOS 上，受保护路径从其父目录一直到包含它的可写根的每一级已存在祖先（不只是直接父目录）都不能被重命名到另一个可写根。Linux 的 Landlock 不能拒绝写根内部的路径，因此需要该保护的配置会在那里拒绝启动，而不是套用只含允许规则的策略。状态行写明当前配置及其可写范围。受保护的配置和 hook 文件不会被改写；权限模式的改动只留在本次会话。`restrict_network`（内置 `read-only`、`strict`，或自定义配置）用 macOS Seatbelt 的 `(deny network*)` 拒绝本进程及其子进程的网络。未开启的配置仍允许网络。dsh 的逐条文件模式不是这个开关，也不是网络沙箱。Linux 的 Landlock 网络限制是另一种机制，一次 macOS 运行不会把它标成已实施：要求网络隔离而当前平台无法实施时，启动会被拒绝，而不是带着开放的网络继续。Windows 的网络约束未实现，同样拒绝启动。`sandbox.toml` 里的 `[shell_environment_policy]`（`inherit` 为 `all`/`core`/`none`，以及 `exclude`、`include_only`、`set`、`ignore_default_excludes`）过滤本客户端启动的 shell 子进程环境，包括 `sh -c`。除非设置 `ignore_default_excludes`，匹配 `*KEY*`、`*SECRET*` 或 `*TOKEN*` 的名称会被去掉。未知的 `inherit`，或不是 `*`/`?` 通配的模式，会拒绝启动。该策略生效时，过滤结果就是随后启动的 dsh 进程的环境，所以 dsh 的 bash 工具同样看到它：dsh 用自己的环境构造该子进程，只会追加变量。没有该策略时，dsh 仍使用启动时的允许名单。已经套用的 Seatbelt 配置内仍然不会再套用第二份。已处于 Seatbelt 下的进程无法再套用另一份 Seatbelt 策略，所以 dsh 自己的逐条 bash 沙箱在 codsh 配置内无法运行。配置生效期间，codsh 启动 dsh 时把它的逐条文件模式设为 `danger-full-access`（写在 `$DSH_HOME/codsh-kernel-sandbox.yml`）。审批不变，改由内核策略约束 dsh、它的 bash 子进程和子代理；写入范围以该配置的可写根为界，而不是 dsh 的 workspace-write 范围。一次 macOS 验证不会把 Linux 或 Windows 标成已支持。允许/询问/拒绝规则、按项目记住的授权
以及权限模式（`ask`、`auto`、`always-approve`/`--yolo`、`dontAsk`、
`acceptEdits`）在 dsh 工具执行前生效。显式 deny、hook 拦截和被锁定的
always-approve 不能被 `--always-approve` 或旧授权绕过。已发布的 dsh 不执行
Grok Hook，因此 `codsh --rust` 在 SessionStart、UserPromptSubmit、PreToolUse、
PostToolUse、Stop 和 SessionEnd 运行 `$GROK_HOME/hooks/*.json`、已信任项目的
`<project>/.grok/hooks/*.json`，以及 `config.toml` 里 `hooks` 表中的命令 Hook
（含 Cursor 驼峰别名）。退出码 2 或 `{"decision":"deny"}` 阻断提示或工具；其他
非零退出、超时或畸形输出记为失败，不会显示成成功。Hook 的 stdout 和 stderr
显示为 hook 输出，而不是模型回答。允许 Hook 不能跳过随后的权限检查，也不能放宽
沙箱或权限拒绝。未信任的项目 Hook 仍然跳过。HTTP Hook 不运行。`updatedInput`
重写不会被套用，该调用会被阻断，而不是带着原参数执行。无法拆分的
shell（`$(...)`、参数展开如 `$x`、`${x}`、`$1`、`"$1"`、`$@` 或 `$*`、控制流）不会被当成一条 glob allow；Read/Edit 的 deny 也
作用于 shell 操作数；`timeout`、`nice`、`ionice`、`sudo`、`nohup`、`xargs`、`env FOO=1` 这类包装会被剥掉（只消耗真正的时长/优先级参数；`sudo -u` 和 `xargs -n` 保留各自的选项值），deny 仍看内层命令，`env -S` 会询问。路径中的符号链接按目标适用 Read/Edit 的 deny 与 ask；无法解析的链接会询问。花括号命令组、引号或反斜杠转义的命令词、`eval`，以及 ANSI-C 的 `bash -c $'…'`（含反斜杠换行）不能藏过 deny。带路径的可执行文件（如 `/bin/rm`、`./rm`、`RM.EXE`）按命令名匹配且不区分大小写，因此 `Bash(rm -rf *)` 在 always-approve 下仍然拒绝。前面多一个词（如 `time /bin/rm`、`exec /bin/rm`、`builtin rm`）也藏不过。会吃掉下一个词的 shell 选项（如 `bash -o errexit -c`）会先被消耗，内层命令仍被拒绝。命令词里未加引号的 `*`、`?` 或 `[` 不会被展开：`./r*`、`./*m`、`./r?` 这类路径通配可能变成 `rm`，即使前面还有 `time`、`exec`、`builtin`、`command`、`sudo`，或写在 `bash -o errexit -c` 里，always-approve 也不会执行。`sort -o`（含紧贴写法 `sort -oFILE` 和组合 `sort -uoFILE`）/`--output` 以及 `sort --compress-program` 的唯一前缀不算只读。冻结指南列出的 git 只读子命令会自动允许；git 写入不会，包括 `git branch <名称>`、`-f`/`--force`、`-u`/`--set-upstream-to`（含紧贴写法 `git branch -uorigin/main`）、`git branch --delete`/`--move`/`--copy`/`--force` 的唯一前缀、不带操作数的 `git branch -u`/`-t`、`git branch --track` 及其唯一前缀（如 `--tr`，没有操作数也是写入）、`git diff`/`log`/`show`/`blame`/`rev-list --output`，以及 `git cat-file --filters`。Claude 规则读取 `~/.claude`，并从工作目录向上走到仓库根。always-approve 会跳过记住的授权和非 shell 的 `ask`。
策略文件缺失或损坏时拒绝变更类工具，而不是丢掉 deny。记住的文件授权按路径生效，`a` 不是永久允许所有编辑。界面显示将执行的操作及
dsh 给出的差异，`y` 允许该次调用，`a` 只记住当前项目，`n` 拒绝且不写入。
`/revoke-approvals` 撤销当前项目已记住的授权。记住的授权不会被说成永久全局规则；
保存失败时仍只允许这一次。文件搜索走 dsh 的 `grep` 和 `glob`（随附的 ripgrep，不是 shell）。结果有上限（`glob` 100 条路径，`grep` 250 条匹配），并说明如何继续读取；更大的 `grep` 在挂载了 spill 时把完整列表存进去。`read` 用 `offset` 和 `limit` 续读，并给出下一次的 offset。空搜索只说 `No matches found` 或 `No files found`，不编造内容。二进制文件报 `binary file` / `FS_NOT_TEXT`，不会被当成文本。读过之后又被改过的文件，编辑会以 `FS_STALE_VERSION` 失败且不写入。代码导航是 dsh 的 `lsp`（`goToDefinition`、`findReferences`、`goToImplementation`、`hover`）。没有配置语言服务时，调用失败（`no LSP provider handles` 该文件；dsh 错误码 `LSP_UNAVAILABLE`），不返回位置。Read/Edit 的 deny 覆盖指定的搜索根、每一条 grep/glob 命中，以及 `rg` 这类 shell 搜索参数；被拒绝的文件不会出现在模型结果或工具卡片里，换一个工具也读不到它。文件不存在、工具错误、
取消或重复的审批回复都显示为失败，不会伪造成功。`Ctrl+C` 在有草稿时只清空草稿、
不取消正在执行的回合；草稿为空时通过 dsh `session/cancel` 取消当前回合。Esc
从不取消回合或待审批请求，只取消选中并提示改用 `Ctrl+C`。被取消的工具不会因迟到的
允许或进程退出再次执行；未知的外部结果显示为已取消，而不是成功。取消后可以继续
提交新回合。尚未有任何回合时，空草稿上的 `Ctrl+C` 仍会退出。
`codsh --rust -p "任务"`（或 `--single`、`--prompt-file <路径>`、`--prompt-json <内容块>`）通过同一个 dsh ACP 会话执行一次提示，stdout 只打印最终答案。`--verbatim` 按原样发送用户内容，不展开自定义斜杠命令。文件规则、`--rules`、`--system-prompt-override` 以及启用时的首轮记忆仍然生效：它们作为单独的前置内容块放在你原样的字节之前（dsh 会拼接相邻的文本块，所以模型先看到规则和笔记，再看到你的提示）。dsh 把 codsh 规则当作提示上下文接收，而不是单独的系统提示。权限策略仍走工具通道。纯文本回合没有时间上限：dsh 完成或失败、或收到信号时才结束。思考、工具卡片和错误不会进入 stdout；诊断写到 stderr。纯文本提示配合 `-c`/`--continue` 或 `-r`/`--resume <id 或标题>` 会继续该会话，`--fork-session` 会复制会话。`--max-turns <N>` 在模型步骤 N+1 之前停止，并在 stderr 说明该上限。`--tools` 与 `--disallowed-tools` 在第一次模型请求前屏蔽工具；`read_file`、`Bash` 这类公开名称会映射到 dsh 工具名，`Agent` 会移除所有已注册的子代理创建工具（`subagent` 与 `subagent_fork`），任意大小写的 `--disallowed-tools Agent(type)` 会移除这些子代理类型（见下方子代理说明）；`--tools Agent(type)` 与 `Agent()` 在调用提供者之前就会被拒绝，继承来的 `CODSH_PLAIN_TOOLS` 里的类型条目也一样。两者同时出现时 deny 生效，未知名称是错误。从父进程继承的 `CODSH_PLAIN_TOOLS` 或 `CODSH_PLAIN_MAX_TURNS` 在纯文本提示中遵循同样的规则；交互会话会忽略这两个值。`--allow`/`--deny` 仍然只控制执行，不会移除工具。`--tools`、`--disallowed-tools`、`--max-turns` 和 `--verbatim` 是无界面参数：没有纯文本提示时会打印警告并被忽略。`--cwd <路径>`、`--sandbox <配置>`、`--no-memory`、`--no-subagents` 和 `--disable-web-search` 同时适用于纯文本提示和交互会话。`--cwd` 会在读取配置、信任状态和沙箱之前进入该目录，因此沙箱的可写根就是这个目录。相对路径的 `--prompt-file` 在进入 `--cwd` 之后才读取，因此指向该目录里的文件。相对路径的 `--trust-folder` 或沙箱报告路径仍指向你运行命令时所在目录旁的文件。`--no-memory` 让笔记不进入首轮提示。`--disable-web-search` 为本进程关闭网页搜索与网页抓取，并从模型的工具列表中移除 `web_search` 与 `web_fetch`。`-m` 等同 `--model`，`-v` 等同 `--version`。重复的提示来源会在调用提供者之前拒绝。位置参数不会进入纯文本模式，管道里的 stdin 也不是提示。`codsh --rust help` 和 `-h` 打印帮助；`completions bash|zsh|fish|powershell|elvish` 打印对应 shell 的补全脚本。`--output-format` 可以是 `plain`（默认，只打印最终答案）、`json`（一个对象：`text`、`stopReason`、`sessionId`、`requestId`，dsh 发来推理时还有 `thought`）、`streaming-json`（每行一个 ACP 形状的对象，最后一行是 `end`）或 `streaming-messages-json`（`system`/`init`，然后是 `assistant` 与 `user` 消息，最后一行是 `result`）。`--include-partial-messages` 增加 `stream_event` 增量，并且只改变 `streaming-messages-json`；其他格式会打印警告并忽略它。工具参数、工具结果和推理按 dsh 更新原样复制，不会改写。`usage` 只在 dsh 的提示响应里带了 `_meta.usage` 对象时复制该对象。没有该对象时，终止对象写 `usage_absent: true`，不编造 token 数或费用。部分消息的 `message_start` 在 dsh 送来账本之前也不写 `usage`。截断停止（`max_tokens`）、模型错误，以及 SIGINT/SIGTERM（130/143）都会结束进程，不会把失败的回合报成 `end_turn` 成功。没有终端时的工具审批会在 dsh 内被拒绝并以退出码 1 结束；文件不变。`json` 与 `streaming-json` 打印 `{"type":"error",...}`，`streaming-messages-json` 打印 `is_error: true` 且 subtype 不是 `success` 的 `result`。它们都不会写 `end_turn`。同一提示走 `plain` 和走 `json` 使用同一条 dsh 会话路径，所以文件副作用和保存的会话一致。代理选择、计划、worktree、`--experimental-memory`、`--memory-flush` 和 `--json-schema` 会点名该参数并留给后续任务。不带值的 `-r`/`--resume` 暂时还不是“恢复最近会话”的快捷方式（由 ticket 159 负责）。未知选项和缺少的参数值退出码为 2。SIGINT 为 130，SIGTERM 为 143，dsh 仍在启动时也一样；dsh 或提供者错误为 1。
`codsh --rust` 中的子代理由 dsh 创建并执行。模型的 `subagent` 工具接受 `subagent_type`：`general-purpose`（拥有父代理的全部工具）、`explore` 与 `plan`（可读取、搜索和执行 shell，但不能写入或编辑）、`[subagents.roles.<名称>]` 角色（`description`、`default_capability_mode` = `read-only`、`read-write`、`execute` 或 `all`、`model`，以及 `$GROK_HOME` 下的 `prompt_file`），或 `.grok/agents/`、`$GROK_HOME/agents/` 中的代理文件（取其 front matter 的 `tools` 与 `model`）。类型的能力会变成 dsh 工具允许列表，被移除的工具不会出现在子代理的工具列表里，强行调用也会被拒绝。dsh 无法归类的工具（例如 MCP 工具）只在 `all` 下保留。子代理继承父代理的权限模式、规则、hook 和沙箱；它自己无法回答审批，所以子代理里的 ask 会被拒绝。创建子代理这一调用仍受父代理自己的审批策略约束。来自 `[subagents.models]`、角色或代理文件的模型会在子代理启动前检查；不可用时拒绝创建，什么也不会运行。`[subagents] enabled = false`、`GROK_SUBAGENTS=0` 或 `--no-subagents` 会移除该工具。`max_concurrent` 或 `GROK_MAX_CONCURRENT_SUBAGENTS`（默认 32；0 视为 1）按会话统计正在运行的子代理，`limit_behavior` 或 `GROK_SUBAGENT_LIMIT_BEHAVIOR` 决定达到上限时排队等待空位（`queue`，默认）还是直接拒绝（`fail`）。`max_depth` 或 `GROK_SUBAGENTS_MAX_DEPTH`（默认 1）限制嵌套层数。`[subagents.toggle] <类型> = false` 隐藏某个类型；纯文本提示里的 `--disallowed-tools Agent(type)` 或 `Agent(type, other)` 会移除这些类型（未知类型会让所有创建都被拒绝；`--tools` 不能放行 `Agent` 或某个类型；`Agent()` 是错误）。`run_in_background: true` 会立即返回 dsh 任务 id；模型用 `job_output` 取回结果，结果只交付一次。工具块显示 `Subagent running`、`started`（后台）或 `queued`，结束后显示 `completed`、`failed` 或 `cancelled` 及耗时；状态行统计仍在运行的子代理。`/tasks`（全屏模式下也可按 Ctrl+G）打开任务列表：↑/↓ 选择，Enter 或 Ctrl+F 打开该子代理的只读记录，`x` 取消它，`h` 隐藏已结束的项，Esc 或 `q` 关闭。在子代理视图里按 Ctrl+C 只取消这个子代理；在父回合上按 Ctrl+C 会取消它的前台子代理，后台子代理则继续运行，直到完成或被你取消。子代理会话不会出现在 `/resume` 或 `sessions list` 中。给子代理发消息、`resume_from`、worktree 隔离、persona 和 `--agent` 留给后续任务；参考实现里的类型校验时限（远程类型 RPC）不适用，因为类型在本地解析。`subagent_fork` 不计入 `max_concurrent`。
`codsh --rust --continue` 会恢复此目录上次的 dsh 会话；`--resume <id-or-title>` 加载
指定会话。UUID 一律当作 id。标题匹配所有工作区并忽略大小写；唯一的手动 `/rename` 优先于自动标题，其余重名会列出 id。`codsh --rust sessions list` 与 `sessions search <query>` 读取隔离 dsh Home 的全部工作区，再套用 `--limit`。手动标题标为 title，自动标题和对话正文标为 content。空结果不会编造会话。`codsh --rust export <id> [file]` 把该会话写成 Markdown，并保留已存储的用户文本、助手文本、工具名、工具结果和附件路径。它会说明这不是脱敏。`-c` / `--clipboard` 复制同一份记录。`/export [file]` 作用于当前会话，省略路径时复制到剪贴板。多出来的参数会在创建任何文件之前被拒绝。会话根、项目目录、会话目录或会话日志如果是符号链接，会被拒绝，既不会读取也不会上传。`codsh --rust share <id>` 与 `/share` 只在你明确执行时上传，并且只发往所选的 `endpoints.share_url`、`CODSH_SHARE_URL` 或 `--url`。没有服务、上传失败、重定向、超时、响应超过 64 KiB、HTTPS 证书不受信任，或目标是官方 `grok.com`、`api.x.ai`、`sentry` 主机时都会报错且不上传。HTTPS 使用 native TLS，并信任已配置的 `GROK_EXTRA_CA_BUNDLE` 或 `SSL_CERT_FILE` 额外根证书。重定向不会被跟随。`sessions delete <id> --yes`、`/delete`、`/resume` 的 `d` 再按 `y`，以及仪表盘两次 `Ctrl+X` 都是阻塞。已发布的 dsh persistence 只有 create、open、flush、stat、list，没有删除操作，因此会话目录、日志、附件和 sidecar 都不会被删除。`/delete` 用 `n` 或 Esc 取消提示，同样什么都不删除。`codsh --rust du`（别名 `disk-usage`，可用 `--json`）按从大到小列出隔离 Home 的目录，并包含 `$GROK_HOME` 旁边的隔离 dsh 目录树。它不删除文件，也不统计 worktree 池。`--fork-session` 配合 `--resume`/`--continue` 会把该对话复制到新的
dsh 会话 id。`/rewind` 与 `/undo`（或空闲时空草稿上的 Esc Esc）通过 dsh 分叉
仅对话历史；`/fork` 复制当前历史。磁盘文件不会被回滚；`--restore-code` 会被拒绝。
界面从 dsh 日志恢复已持久化的回合（不是第二套会话库）。中断或
未完成的工具显示为 `[interrupted]` / unknown，并且不会自动重放副作用。
全屏和最小模式都会在记录本身画出该标记、`[cancelled]`、`[empty answer]`
以及压缩摘要句；已完成但状态为 unknown 的工具不会被当成中断回合。
第二个客户端若不能取得写入权会被明确拒绝，而不会再开一个执行核心。
默认 fullscreen 使用备用屏幕。`/minimal`（或 `--minimal`）按官方内联渲染
把已提交内容写入终端原生历史；`/fullscreen`（别名 `/full`）切回全屏。
最小模式下 `/rewind` 与 `/fork` 会重置该原生缓冲，而不是把已丢弃回合追加进去。官方 `xai-grok-markdown` 渲染流式 Markdown、表格、代码、mermaid 节点、思考以及 dsh 工具卡/差异，会话会保留标题、代码、表格和差异的颜色。美化模式与官方 markdown 一致，因此 `Vec<T>`、比较运算符、围栏里的 Rust 以及行内 HTML 标签都会保留，并把 ZWJ 表情保持在同一个单元格；失败的工具用失败色显示 `failed` 和 `[error]`，而不是成功。Esc 关闭完整内容并恢复折叠后的记录。长结果会折叠；Tab 后按 `l`/`→` 展开，`r` 切换原文，Enter 打开完整内容，`y` 复制原文。最小模式下 `/expand` 会重印上一个折叠块；`/transcript`（`/log`）用 `$PAGER` 打开完整原文。
切换在同一进程内完成，正在执行的 dsh 回合、草稿和待审批都会保留。
`--minimal` / `--fullscreen` 与 `GROK_SCREEN_MODE` 只作用于当前会话，不会改写
隔离目录里的 `[ui] screen_mode`。`/dashboard`（别名 `/agents-dashboard`、`/sessions`）以及设置了 `GROK_OPEN_DASHBOARD_AT_STARTUP=1` 的 `codsh --rust dashboard` 在全屏打开代理仪表盘。它与 `/resume`、`sessions list` 显示同一会话 id、标题、活动和未读标记。`Ctrl+/` 过滤，`Ctrl+R` 重命名选中行，`Ctrl+T` 固定，`Ctrl+G` 在状态分组与目录分组之间切换。最小模式会拒绝仪表盘并提示运行 `/fullscreen`。`/resume` 打开会话选择器；输入先按标题过滤，再在 `Extended search results` 下匹配对话正文。选中后恢复该 dsh id，不会把上一会话的输出写进新会话。目录不匹配或写入锁已被占用时，仍留在当前会话并显示 `occupied`。同一目录里 dsh 以 already active 拒绝恢复时，不会关闭当前会话；打开的选择器或仪表盘会显示 `already active` 并保持打开。`/rename <title>`（别名 `/title <title>`）保存手动标题，自动生成不会覆盖它。`/rename --auto` 与单独的 `/title` 把标题交回已配置模型（`base_url`、模型 id 和凭证）。提示只发给该提供商，不会写入提示行、URL 或调试日志。缺少模型或凭证是错误，不会改用备用标题。`/new` 开始新的 dsh 会话，并保留已配置的提供商、模型、推理档位、权限和设置补丁。仪表盘派发同样如此。两者都不会静默改用另一个提供商。`/cd` 会为下一个会话重新加载受信任的工作区配置。`/clear` 只清空可见记录。`/session-info`（别名 `/info`）显示标题、id、目录、模型和活动。`/memory`（别名 `/mem`）浏览 `$GROK_HOME/memory` 下的本地笔记。全局笔记适用于所有项目。工作区笔记按 Git `origin` 的 `org/repo` 归属，因此同一仓库的克隆和工作树共用一个目录，其他项目不会混入。文件列表与生成的索引分开。Enter 只读预览，`/` 按名称和内容过滤，`y` 复制路径，连续按两次 `x` 删除会话笔记，`t` 只切换本会话的记忆开关且不改写 `config.toml`；笔记只会在会话的第一条提示时发送，若第一条提示已经发出，此时再打开 `t` 也无法影响本会话的任何提示，且 `/new` 会丢弃这个开关并重新按 `config.toml` 决定，不会带到下一个新会话。浏览器不能删除 `MEMORY.md`，无论它是人工笔记还是生成索引。弹窗会高亮选中的文件。宽度不足 80 列时隐藏预览，按 Enter 才阅读。`/remember [text]` 在确认后才追加到工作区 `MEMORY.md`；`n` 或 Esc 不会写入。没有文本时，下一行成为笔记。保存后会显示 `Memory saved to` 以及该 `MEMORY.md`。记忆默认关闭，直到 `[memory] enabled = true` 或 `GROK_MEMORY=1`。显式 `[memory] enabled = false` 即使设置了 `GROK_MEMORY=1` 也保持关闭；`/memory` 仍然打开，`t` 只为本次会话打开记忆且不改写 `config.toml`。`/new`、切换会话、`/fork` 和 `/rewind` 会丢掉这个开关，新会话重新按配置决定。`--no-memory` 与 `GROK_MEMORY=0` 会在本进程隐藏 `/memory`，但不会删除文件。新会话的第一回合会把全局和工作区 `MEMORY.md` 的有限摘录发给 dsh，不包含生成索引。该回合里的关键词还会带上匹配的会话日志。同一会话之后的回合不再重复这段内容。`/cd` 后再 `/new` 读取新目录的工作区，不会带上上一个项目的笔记。`codsh --rust memory clear`（默认 `--workspace`，也可 `--global` / `--all`）只在带上 `--yes` 后删除所选范围。工作区清除会删掉该范围的 `MEMORY.md`、`sessions/` 和 `index.sqlite`。全局清除只删掉全局 `MEMORY.md`。关闭记忆不会上传笔记。`index.sqlite` 是 SQLite FTS5 关键词索引。损坏的索引进程会报告并按笔记重建，并且不会覆盖笔记。不是该索引的 SQLite 文件会原样保留。自动采集、向量嵌入和 Dream 整理不属于这条命令。`/cd [path]` 只改变下一个新代理的目录，当前会话历史保持不动。路径不存在、按 Esc 或取消都会保留原目录。拿不到写入锁的第二个客户端会显示为占用，并且不会改动另一份历史。最小模式下的 `/dashboard` 等模式专用命令会
拒绝并提示改用 `/fullscreen`。全屏下有回合时 `Tab` 把焦点交给回看区；`/find [text]`
搜索对话，`/jump` 预览回合，关闭这些弹窗会回到原先的阅读位置且不改草稿。
点击折叠或选中；拖拽复制且不会误触折叠。选区在流式更新和缩放后按回合身份保留。`/vim-mode` 切换回看区 Vim 键并把
`[ui] vim_mode` 写入配置，不改 `ui.simple_mode`。开启
`[ui] mouse_reporting_toggle`（或 `GROK_MOUSE_REPORTING_TOGGLE`）后，回看区
`Ctrl+R` 或 `/toggle-mouse-reporting` 切换鼠标捕获；退出时总会关闭上报。
`GROK_SCREEN_MODE_SWITCH=exec` 会按同一会话
重新启动，而不是原地切换，也不会保留未保存的草稿。非空草稿里输入 `/`
会暂存草稿并执行斜杠命令，结束后恢复同一草稿。提示编辑继续使用官方
textarea：Enter 提交，Shift+Enter 或 Alt+Enter 插入换行，`/multiline`（别名
`/ml`，终端能区分时也可用 Ctrl+M）对调这两个键。`/history` 模糊搜索已提交
提示；空草稿上的 ↑/↓ 浏览历史且不发送。Tab 补全 `/` 命令，在 `!` shell 模式下
补全 HISTFILE；Esc 取消补全并恢复原草稿。`/edit-prompt` 按 `$VISUAL`、
`$EDITOR`、`vi` 打开空草稿；最小模式下 Ctrl+G 保留当前文本。保存只替换草稿，
空文件会清空且不提交。`[ui] simple_mode = false` 启用提示 Vim（`i`/`Esc`/`h`/`l`/`x`），
与 `/vim-mode` 的滚动区键位无关。下一提示幽灵文本（付费 suggestPrompt）本票
未接线：回合结束后宿主不传入建议，因此 Tab 与 Right 不会接受幽灵文本。
建议行保持阻塞，`PARITY-150-suggestions` 仍为未验证。`@` 打开工作区文件
选择器。查询以 `!` 开头之前，点文件和 `.gitignore` 匹配项保持隐藏，包括
嵌套目录里的 `.gitignore`、`**/*.log` 这类 `**` 模式，以及含 `/` 的模式
（`logs/*.log`、`/secret.rs`，锚定在拥有该 `.gitignore` 的目录）。Enter 或 Tab
把所选文件附成芯片；`:10-50`
保留该行范围，`:2` 只保留这一行，带空格的路径写成 `@"my file.rs"`。粘贴
工作区路径等于拖入，但点文件或 `.gitignore` 匹配项仍作为文本留下且不会
读取；只是在句子里提到路径的粘贴也仍作为文本插入。芯片上按
Backspace 移除，Ctrl+Z 恢复。回合进行中按 Enter 会把草稿和芯片排队；
Alt+Up 把最早的排队提示放回空输入框。提交时才读取文件：已移除的芯片不会
发送；文件缺失、超过 256 KiB、没有读取权限，或预览后内容已变化，都留在
输入框并给出明确提示，且不会带上文件字节。dsh 和模型收到的是获准的文本。
恢复会话时显示同一个 `@path` 引用。在 macOS 上，Ctrl+V 从剪贴板读取图片。终端把 Cmd+V 作为括号粘贴送来；空的括号粘贴（剪贴板只有图片时就是这样）同样读取剪贴板图片，只含空白的粘贴不插入任何内容。Windows 的剪贴板图片尚未实现：Alt+V 和空粘贴会说明这一点，不附加任何内容（留给 Windows 与跨平台工单 #200/#201）。Linux 通过 `xclip` 或 `wl-paste` 读取，同样尚未在此验证。粘贴或拖入图片文件的绝对路径或 `file://` URL 会把该文件作为图片附加；相对文件名、夹在文字里的路径，或与其他路径混在一起时，仍按原来的文本或 `@file` 方式处理。以 `codsh-image:` 或 `data:image/...;base64,` 开头的括号粘贴同样会附加图片。草稿里是不可拆开的 `[Image #N]` 芯片；指针悬停在芯片上，或光标停在芯片上时，提示行显示 `Pasted image #N`、识别出的尺寸（png、gif、jpeg、webp）、字节数、短摘要，以及文本模型已保存时的路径。这是冻结指南 03 的元数据行，不是 Kitty、OSC 1337 或半块拼图。Backspace 一次移除芯片及其字节。`input_modalities` 含 `image` 的模型收到 ACP 图片块（`data` 为规范 base64，`mimeType` 为 png、jpeg、webp 或 gif）。没有声明 `image` 的模型不会收到该块：原图保存在隔离 dsh Home 的 `attachments/pasted/`，提示里只带 `<pasted-image>` 路径。这条路线上，附加时的提示会说明当前模型看不到图片、只会拿到保存路径。规则、会话规则和首轮记忆注记只包住用户文本一次，不会复制到该 `<pasted-image>` 元素或附件正文上。不会改走另一个视觉提供商。空剪贴板、不是 png/jpeg/webp/gif 的内容，以及超过 256 KiB 的文件都留在输入框并给出提示，不会发送。`GROK_CLIPBOARD_NO_NATIVE_READ` 只要出现（包括值为 `0`）就关闭 macOS 原生剪贴板读取；`CODSH_CLIPBOARD_IMAGE` 是替代用的受控文件。打包启动器会转发这两个变量，因此会话读到的是受控文件，空文件就是空剪贴板。切换 `/model`、`/minimal` 或 `/fullscreen` 后芯片和暂存的图片字节都不变，不只是占位文本。关闭模型菜单后同一草稿放回。与参考版本一致，草稿只存在于当前运行的进程里：不会写入磁盘，下次在任何项目启动时输入框都是空的，已发送的提示不会再回来。exec 重启（`GROK_SCREEN_MODE_SWITCH=exec`）恢复的是会话，不是草稿。`--resume` 按实时显示时的样子展示已发送的图片轮次及其 `[Image #N]` 占位（文本模型的 `<pasted-image>` 路径是模型输入，不是用户输入的文字），并且不会重新发送任何内容。在某个模型下排队的提示，会按发送当时选中的模型重建：文本模型得到路径，而不是排队时的图片块。`chips=false` 只表示当前草稿没有附件。中文/组合字符、大段粘贴、缩放
都会保留未发送草稿。提交被拒绝（包括尚无可用 provider 的首次运行）会把该草稿放回输入框，窄屏仍显示 `Execution unavailable`。编辑器失败也会保留草稿。`/edit-prompt` 只打开空草稿；最小模式下 Ctrl+G
保留当前文本。HISTFILE 的 Tab 补全在 `GROK_SUGGESTIONS` 关闭时仍可用；边输入
边补全需 `GROK_SUGGESTIONS=true`。`GROK_SUGGESTIONS_AI` 此处不是已接线的 AI
门控。

`/voice` 把听写插入当前草稿。启动时不会录音，转写也不会自动提交，仍由
Enter 发送。再次 `/voice`、`/voice stop` 或 Esc 会停止或取消。录音时输入
`/` 会暂存草稿；斜杠命令结束或 Esc 取消补全后放回同一草稿。录音中补全仍打开时，一次
Esc 会离开录音并放回暂存草稿，不会让补全层继续开着，也不会把草稿换成
`/`。只有草稿文本本身变了，迟到的转写才会被丢弃。仅当 `[ui] voice_keybind_enabled` 为真时，Ctrl+Space 与
F8 才按 `[ui] voice_capture_mode`（`hold` 或 `toggle`）工作；关闭快捷键后
`/voice` 仍然可用。按住说话需要终端上报按键释放，否则客户端拒绝该快捷键并
提示改用 `/voice` 或切换模式。`[ui] voice_stt_language` 覆盖 `[voice] language`
（`auto` 不发送 language 字段）。音频只发往 `[voice] api_base`，未设置时才
继承 `[endpoints] xai_api_base_url`，路径为 `/audio/transcriptions`。官方
`api.x.ai` / `grok.com` 会被拒绝。Bearer 令牌来自 `[voice] env_key`（默认
`XAI_API_KEY`），不是官方账号登录。`/voice doctor` 与
`codsh --rust voice doctor`（`--json`）只列出输入设备，不会打开麦克风。
没有设备时报告 `voice.no-input-device`。macOS 上以静音形式出现的权限拒绝
无法被这次列举发现。本进程打开真实麦克风尚未验证；`CODSH_VOICE_FIXTURE`
是通向替代转写服务的已支持录音路径。Linux 与 Windows 的采集未验证，不会被
说成可用。`GROK_VOICE_MODE` 可关闭该功能。`GROK_VOICE_CAPTURE` 选择
`inprocess`（默认）或 `helper`；没有夹具时 helper 会被拒绝。

`codsh --rust web search <query>` 与 `codsh --rust web fetch <url>`（`--json`）
调用已配置的替代服务。会话里 dsh 的 `web_search` 与 `web_fetch` 调用同一命令。
搜索和获取分别启用。未启用的一侧不会注册，模型看不到它。搜索使用
`[models] web_search` 或 `GROK_WEB_SEARCH_MODEL`，以及该模型的 `base_url`。
`[model.<id>] protocol` 选择线路格式。`responses`（默认）发送一次 OpenAI
Responses 请求，并且需要凭据。`searxng` 不带密钥，向
`{base_url}/search?q=...&format=json` 发 GET，并读取 `results[].url`、
`results[].title` 与 `results[].content`。不会发送 API 密钥。
`supports_backend_search` 表示检索由该替代服务完成。`responses` 的凭据优先
使用非空的环境变量，否则使用模型里的 `api_key`。空的内联密钥不算已配置。
`searxng` 不需要这两项也算已配置。`[toolset.web_search] allowed_domains` 与
`excluded_domains` 互斥；两者同时设置时允许名单生效，阻止名单被丢弃并给出
警告。搜索名单为空或未设置时不限域名。随附的 dsh `web_search` 工具没有域名
参数；`responses` 替代服务在工具过滤器里收到的是已配置名单。`searxng` 请求
不带这份名单。结果 URL 只有符合同一允许或拒绝规则时才保留，因此模型参数不能
扩大允许名单。官方主机对实例地址和结果 URL 都拒绝。
获取由 `[features] web_fetch` 或 `GROK_WEB_FETCH=1` 打开。`GROK_DISABLE_WEB_FETCH` 与
`disable_web_search` 分别关闭对应工具。指南 26 将 `features.web_fetch` 与
`models.web_search` 标为 requirements `pin`：requirements 的值优先于用户文件、
环境变量和托管配置。域名名单与 `proxy_endpoint` 是 requirements `yes`、managed
`user`，用户文件可以覆盖舰队默认值和 requirements 的值。托管配置不是锁。
`[toolset.web_fetch] allowed_domains` 覆盖内置公共文档名单。条目可以是 `host`、
`host:port`、`host/path` 或 `host:port/path`。显式空名单会阻止每一次获取。每一次
重定向都会重新检查路径前缀、端口和私网规则。设置了 `proxy_endpoint` /
`GROK_WEB_FETCH_PROXY` 时，流量只走该代理，失败不会改走直连。支持的代理是
`http` CONNECT 代理；`https` 源站先建隧道，再用与其他 HTTPS 相同的 native TLS
根证书校验。`allow_local` / `GROK_WEB_FETCH_ALLOW_LOCAL` 只增加显式
回环主机。私网、链路本地和云元数据地址始终拒绝。任一解析地址为私网时拒绝该名称，
连接只使用这次检查得到的地址。跨主机重定向只报告、不跟随。认证、限流、取消和
网络失败返回错误，不返回响应正文。`--json` 在可读 `text` 之外带有搜索 `citations`，
以及获取的 `url`、`status`、`contentType`、`content` 和 `truncated`。`content`
是页面本身；会话使用这个字段，不会从 `text` 里拆出来。分块正文按块大小读取，
载荷里出现块结束标记也不会被截断。零长度块之后的 trailer 字段以空行结束，
报文到此为止。取消会关闭套接字，不会返回迟到的正文。
`codsh --rust inspect` 标出设置该值的文件：只来自托管配置的名单是 `managed`，
不是 `config.toml`。策略在启动时读取，会话中途修改不会生效。官方主机会被拒绝。
`responses` 搜索的费用是这一次模型请求。`searxng` 与获取不产生账号费用。
Responses 形态的替代服务用本地夹具检查。SearXNG 协议同样用本地夹具检查，
并在本机 localhost 上的一个真实 SearXNG 进程上验证过。公共 SearXNG 主机不在
本次检查内。

预览的用户配置是 `$GROK_HOME/config.toml`（默认
`~/.codsh-rust/.grok/config.toml`）。`[ui] theme`、紧凑模式、时间戳、状态行、
`confirm_before_rewind` 与 `ui.fork_secondary_model` 也写在这份文件里。兼容的 `[model.<id>]` 字段
（`base_url`、`env_key`、`api_key`、`model`、`name`、`provider`、`api_backend`、
`supports_reasoning_effort`、`reasoning_efforts`、`reasoning_effort`、
`context_window`）以及 `models.default` / `models.default_reasoning_effort`
会映射到隔离的 dsh `settings.yaml`，两份文件不会互相覆盖。
`provider` 默认等于目录 id。两条目录项如果写了同一个 provider，并且密钥、后端、URL 和请求头相同，就变成该 provider 下的两个模型。再用同一 provider 配不同的凭据或后端会被拒绝，不会写出重复的 YAML 键。支持的后端是
Grok 的 `chat_completions`、`responses`、`messages`（对应 dsh 的
`openai-completions`、`openai-responses`、`anthropic-messages`）。同名模型
在不同后端上是两条目录项，不是同等能力。`/model`（别名 `/m`）与 `/effort`，
以及 `--model`、`--effort` / `--reasoning-effort`，只选择已公布的选项。
不支持的后端或推理等级会明确拒绝或显示不可用，不会静默切换提供商。运行中
变更作用于下一回合，并写入 `$GROK_HOME/model-selection.toml`。用量、费用和
上下文限制在提供商或显式 `context_window` 给出之前保持未知，不会伪造为零。
dsh 的上下文占用显示为 `occupancy=N (dsh estimate)`，不当作提供商用量。
`/context` 显示这些 dsh 事实以及可得的 system/tools/messages 启发式分类；缺失值保持未知，不会显示为 0。`/model` 切换后使用该模型公布的 `context_window`。`/compact [指示]` 由 dsh 执行压缩（进度、摘要、失败与取消），不另造一套历史；可选指示只进入 summarizer 请求（`purpose=compaction`），并记录目的地提供商/模型。自动压缩把 `session.auto_compact_threshold_percent` / `GROK_AUTO_COMPACT_THRESHOLD_PERCENT` 映射为 dsh `thresholdRatio` 以及兼容的 `retainRatio`（0–100 以外的值会被忽略；`0` 会关闭自动压缩，而不会写入会导致插件加载失败的非法比例）。`GROK_COMPACTION_WALL_CLOCK_SECS` 限制压缩耗时，`0` 关闭该预算。压缩后恢复会话会投影 dsh 检查点及保留的工具/待办；失败时原记录仍在日志中。
非必要遥测、会话跟踪、内容分享和 trace 上传默认关闭。`[features] telemetry`、
`feedback`、`trace_upload` 只有在 `endpoints.telemetry_url`、
`endpoints.feedback_base_url` 或 `endpoints.trace_upload_url` 指向替代目的地时
才会生效。官方 `grok.com`、`api.x.ai` 和 Sentry 按解析后的主机名拒绝，
路径或查询里的同名文本不会误拒；只接受 `http` 与 `https`。
`privacy.share_content` 默认关闭，提交时会脱敏标题、详情和 area。
`privacy.share_session` 只在已开启的 trace 上传里附上会话 id。
`codsh --rust feedback` 与 `/feedback` 把草稿留在隔离 dsh Home 的
`feedback_drafts.json`，直到显式发送。`/feedback` 打开 Write 与 Drafts
（Enter 发送，Ctrl+S 仅保存，Escape 关闭，Drafts 可编辑、重试和删除）。
`/feedback <文本>` 立即发送。提交失败会保留草稿。请求体使用 schema 1 的
`structured_feedback`（`type`，以及可选的 `task_category` 与 `failure_mode`）；
`GROK_USER_METADATA` 不能覆盖该字段。`feedback preview` 说明脱敏边界：诊断只
含 kind、ok 和 count，不含提示、回答、密钥或路径。模型调用只走已配置提供商的
`base_url`，不是遥测。锁定的 `requirements.toml` 可以强制关闭这些开关。
`GROK_DEBUG_LOG=1` 只把同样的计数追加到 `$DSH_HOME/privacy.log`，不会上传。
`GROK_LOG_FILE` 与 `GROK_HOOKS_LOG` 未接线：启动器不转发，Rust 端也不读取，
不会创建日志，也不会改变上传内容。
`codsh --rust inspect` 与 `inspect --json` 列出每项生效值及来源（命令行
`--model`/`--effort`、环境变量、`GROK_CONFIG` 覆盖层、工作区
`.grok/config.toml`、已保存选择、用户 `config.toml`、`managed_config.toml`、
锁定的 `requirements.toml`、默认值），包括 `ui.theme`、紧凑模式、时间戳和
`[ui.status_line]`。`/settings`（`/config`）编辑这些生效控件；`/theme`（`/t`）
在全屏下预览主题，Escape 取消且不保存。最小模式使用终端自身调色板并拒绝
`/theme`。状态行脚本 10 秒超时、清空 `BASH_ENV`/`ENV`，退出时清理进程组。
无效的 `config.toml` 会保留原文，并报告路径和原因。被锁定的要求不能被后置的
命令行、环境、覆盖层、工作区或用户配置绕过。不认识的安全字段或无效策略会
诊断有效键、来源与限制，而不会被静默忽略。未信任工作区会先出现信任提示，
不会自动应用项目配置、Hooks、插件或项目说明；`--trust` / `--trust-folder [path]`
把授权写入 `$GROK_HOME/trusted_folders.toml`，`--revoke-trust` 撤回授权，只读
Home 会报告保存失败而不会假装授权已持久化。未信任的 Hooks、插件和项目能力
不会执行。已信任的目录会加载兼容的项目规则、Skills、agent 定义和自定义
命令，并把这些上下文交给 dsh。主目录规则（`$GROK_HOME/rules/*.md`、已启用的
`~/.claude` 与 `~/.cursor` 规则，以及绝对路径或 `~/` 开头的 `[paths]
extra_rule_dirs`）对每个项目生效。相对路径或缺失目录不会加载，并会给出诊断。
项目文件从 git 根目录到当前工作目录依次加载：`Agents.md`、`Claude.md`、
`CLAUDE.md`、`CLAUDE.local.md`、`AGENT.md`、`AGENTS.md`，以及 `.grok/rules/`
（和已启用的 `.claude/rules/`、`.cursor/rules/`）里直接存放的 `*.md`。更深的
文件在提示里更靠后。被 gitignore 的说明文件名（例如 `CLAUDE.local.md`）会跳过；
单个规则文件没有字符上限。Skills 来自当前目录、再到 git 根的每一层祖先里的 `.grok/skills/` 与
`.agents/skills/`，然后是用户目录、已启用的 Claude/Cursor 根和 `[skills] paths`。
更靠近当前目录的定义优先；同一目录里同名的两项都保持可调用，并使用限定名。
嵌套的 `SKILL.md` 按冻结遍历：深度从技能根下的第一层目录起算，只有深度大于 5 才返回，因此 `.grok/skills/a/b/c/d/e/f/SKILL.md` 会加载，第七层不会。已经有 `SKILL.md` 的目录仍会进入，其子目录里的 Skill 也会记录。配置的 `[skills] paths` 目录本身是深度 0：它自己的 `SKILL.md` 会加载，子目录从深度 1 起算，第六层子目录不会加载。`paths.extra_skill_dirs` 不是发现根。
`[skills] ignore` 隐藏路径。`[skills] disabled` 仍列出 Skill（含正文）但不可调用。
`user-invocable` 默认开启，只有 `false`、`no`、`off` 或 `0` 会把它从菜单隐藏。
发给 dsh 的 Skill 正文最多 25,000 token，截断会被诊断。`.grok/commands/`、
`.agents/commands/` 和已启用的 `.claude/commands/` 下的扁平 `*.md` 是斜杠命令，
不是 Skill。Skill 根目录不按 `.gitignore` 过滤。`codsh --rust` 会转发 `GROK_CLAUDE_SKILLS_ENABLED` 与
`GROK_CURSOR_SKILLS_ENABLED`，用来关闭对应厂商扫描。`inspect --json` 是一个 JSON
对象，顶层包含 `assets.skills` 与 `assets.commands`。资产目录出现之前暂存的本机候选仍返回这两个数组：启动器从 `.grok` 的 Skill 与命令补上，并在对应开关关闭时跳过 `.claude` 或 `.cursor`。`shell`、`canvas`、
`statusline` 只在 `.claude/` 与 `.cursor/` 下被丢弃。与内置命令同名时，内置命令
保留短名称（`/compact`、`/login`、`/logout`、`/feedback`），资产以
`/local:name`、`/ancestor:name`、`/repo:name` 或 `/user:name` 出现。菜单不把
该资产列成短名称，提交短名称仍执行内置命令。`--rules`（别名 `--append-system-prompt`）
为本会话追加一段 `<human_rules>`。`--system-prompt-override`（别名
`--system-prompt`）替换发给 dsh 的文件规则和 `--rules`；键入的提示仍会发送。被
gitignore 的项目说明（含 `*.local.md` 和被忽略的目录）会跳过。已禁用或
不可由用户调用的 Skill 不会出现在菜单里。`/reload-assets` 在新增或删除文件后
重新扫描；空项目目录不会增加项目命令。`inspect` 列出每项资产的来源、启用状态、
冲突和截断。未信任的项目仍显示全局规则，但不会注入项目规则、Skills、命令或
agent 定义。
`codsh --rust plugin marketplace add|list|update|remove` 管理本地 git/路径目录。
`plugin install|update|uninstall|list` 把插件文件复制到隔离 Home，并记录版本、
来源和许可。安装需要 `--trust`，仍不会授予执行权限；启停由后续任务处理。
下载、校验、冲突、离线或取消失败不会留下成功安装。
`GROK_MARKETPLACE_REQUIRE_SHA` / `[marketplace] require_sha` 也会拒绝未钉死
的远程更新并保留原安装。官方 marketplace 默认不
自动注册，除非设置 `GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER`。同一目录中的
多个插件各自安装；git 更新会记录 clone HEAD。托管层
`extra_known_marketplaces` 以先写入的 pin 为准。一旦存在
`strict_known_marketplaces`，目录加载、按名安装、目录条目的实际 clone URL
以及之后的 git 更新都会受其约束：未列入的 git 来源会被丢弃，本地路径会被拒绝，
除非管理员 pin 指明该路径；空列表或格式错误会拒绝一切添加与安装。后续用户或
工作区列表不能放宽更早的封锁。URL 只折叠 scheme 与 host（含 GitHub），并只去掉一个结尾
`.git`。仓库路径区分大小写，因此 `ACME/Plugins` 与 `acme/plugins` 是不同来源。`/plugins`
与 `/marketplace` 打开插件目录。卸载不会删除用户无关文件。个人与项目
作用域互不污染。首次运行缺少凭据时只给出
可操作提示：不打开 grok.com 登录，不访问默认官方遥测/上传，也不自动导入
`~/.dsh` 或 `~/.grok` 中的旧凭据。`codsh --rust import --preview`（以及 `import --json`）
会根据当前 dsh 的 `$DSH_HOME/settings.yaml`（`llm-pi-ai` 提供商、`llm-deepseek`、
`agent-default-model`）、`$DSH_HOME/code-cli-thinking.json` 与
`$DSH_HOME/code-cli-ui.json` 列出转换、冲突和不支持项。`density` 的
`compact`/`comfortable` 会映射为隔离配置里的 `[ui] compact_mode`；
`coding-cli-runner` 的 `bell`、`notify` 和 bang 限制没有对应控件，会列为不支持项。
一条路由列出多个模型时，导入 `agent-default-model` 点名的模型，其余模型留在预览里。
内联 `apiKey` 不会被复制；缺少 `apiKeyEnv` 记为不支持项，而不会替补成 `XAI_API_KEY`。
`headers` 与 `compat` 也列为不支持项。已有的嵌套设置（例如 `[ui.status_line]`）会保留。
不会把过时的
`code-cli-settings.json` 当作提供商来源。`import --apply` 把所选提供商和偏好
写入 `~/.codsh-rust/.grok/config.toml`。官方令牌、`.credentials.yaml`、`.env`
以及原信任/执行权限都不会被复制。预览、取消和失败中断不会改动源文件或已有
新设置。模型必要凭据须已导出（`--authorize-env`）或在导入后自行设置。普通
`codsh` 仍读取原来的 Home。`codsh --rust login` / `logout` / `setup`
（以及 `/login` `/logout`）只对接已配置的替代身份或管理服务。仅使用模型 API
key 时不必登录，除非 `GROK_DISABLE_API_KEY_AUTH` 或团队限制
（`GROK_FORCE_LOGIN_TEAM_ID` / `auth.force_login_team_uuid` / 锁定
`requirements.toml` 顶层 `force_login_team_uuid`）要求匹配的身份会话。启动和 `inspect` 会刷新已过期的 `auth.json`；无法刷新时清除它，因此仅有团队限制不会让过期会话保持就绪。清除后不阻止 `login`，也不阻止原本可用的 API key。成功的 `/login` 会重新加载该会话并重新应用设置。凭据环境、就绪状态或设置补丁发生变化时替换 dsh，且在没有活动客户端时于同一步连接。设置写入失败时保留现有连接并报告错误。替换后的 dsh 进程会收到身份会话（`GROK_AUTH_PATH`、`GROK_AUTH_ACCESS_TOKEN`，以及已配置时的 `GROK_AUTH_PROVIDER_COMMAND`）。其他父进程 `GROK_AUTH_*` 变量不会转发。`/logout` 会先在 `GROK_AUTH_REVOKE_URL` 或发行方的 `revocation_endpoint` 撤销该会话，再清除 `auth.json`；撤销失败时保留本地文件以便重新登录，并断开正在使用该会话的连接。会话令牌写入 `$GROK_HOME/auth.json`（Unix 上为 0600），不会
转授给模型提供商、MCP、Grove 或其他外部服务。不复制 grok.com / auth.x.ai
登录、订阅计费、自动充值或官方团队权益。`GROK_MANAGED_CONFIG_URL` 仅在替代
公钥能验证且签名指向当前调用方时安装组织策略。部署密钥本身就是调用方主体，即使响应省略 `deployment_id` 且会话没有 team 也一样。签给其他主体、签名负载同时省略 deployment 与 team、磁盘上已有的同类不匹配，以及 fail-closed 但没有公钥也没有 sidecar 的策略都会被拒绝。写好带 `base_url` 的提供商后，再设置对应的
`env_key`（例如 `XAI_API_KEY`）。首次运行时空回车会重新加载该文件，
提供商就绪后连接且不提交提示。父进程的 `GROK_HOME` 会被忽略；预览把
`GROK_HOME` 固定为 `~/.codsh-rust/.grok`。

预览使用 `~/.codsh-rust/dsh` 与 `rust` Profile，忽略继承的 `DSH_HOME`
和 Grok 设置文件，不迁移旧会话。已配置的 `env_key`（例如 `XAI_API_KEY`
以及其他 `*_API_KEY`）会传给 dsh；不会自动导入 `~/.dsh` 或 `~/.grok` 中的凭据文件。
显式、可逆的复制请使用 `codsh --rust import`。如果预览 Home/Profile 是符号链接，
或与 `DSH_HOME`/`GROK_HOME` 重叠（包括大小写不敏感文件系统上的大小写别名），
会在写入前拒绝启动。重叠检查比较目录及其祖先的设备号/inode 身份，包括
尚不存在路径的已有祖先，避免 macOS firmlink 别名通过不同 realpath 字符串绕过。
通过这些别名访问的独立 Home 仍受支持；无法取得目录身份时会在写入前拒绝。
如果任一 Home 尚不存在，仅大小写不同的潜在重叠会在
所有平台保守拒绝，不会通过创建路径来探测文件系统规则。
任何尚不存在且含非 ASCII 字符的路径分量也会在写入前被拒绝，即使它属于
独立 Home：Unicode 小写转换或规范化不能可靠判断文件系统身份。请使用
已存在的独立 Unicode 目录，或仅缺少 ASCII 分量的路径。已存在的 Unicode
祖先目录与独立 Home 仍使用原生文件系统解析，其下缺少的 ASCII 子路径仍受支持。
显式或默认旧 Home 路径中的未解析符号链接也会在写入前被拒绝；请先修复
悬空链接或符号链接循环。指向独立旧 Home 且可解析的链接仍受支持。
隔离检查遵循已发布 dsh 的 `DSH_HOME` 规则：空白值视为未设置，`~`、`~/`、
`~\` 展开为操作系统 Home，然后对相对路径及 `..` 做词法规范化。
非空 `GROK_HOME` 则按字面解释（不展开波浪号、不裁剪空白）。预览会保守拒绝
**`GROK_HOME` 中的任何 `..` 路径分量**，即使指向已存在的独立 Home，
也不猜测符号链接的遍历结果；请改用不含父级遍历的路径。
即使设置了覆盖值，默认 `~/.dsh` 和 `~/.grok` 也始终受保护。
`Ctrl+Q` 退出。`Ctrl+D` 退出，但全屏回看区里它改为半页滚动。`Ctrl+C` 清空
草稿，空草稿取消正在执行的回合，尚未有回合时退出。`--continue` 与 `--resume <id>`
恢复同一 dsh 会话；`--fork-session` 把对话复制到新 id；`/rewind` 不恢复文件。
第二个写入者会被拒绝。`--minimal` 与 `--fullscreen` 选择
当前会话的渲染模式。不支持的参数明确报错；`codsh --rust --help` 说明此路径。
模拟模型测试只在 dsh 提供商边界注入夹具（`CODSH_ACP_PATCH` /
`DSH_CODE_CLI_MOCK_TOOL`）；Rust 客户端与 dsh 执行核心都是真实产物。

维护者通过 `pnpm run build:rust` 构建本机候选产物，再本地打包、安装
`packages/cli`；npm 入口携带预编译二进制与许可证，候选包用户无需编译 Rust。
缺少对应平台产物时会提供明确错误，不会静默回退。这不代表正式发布或默认版本
切换。构建、安装产物验证和平台限制见 [贡献指南](CONTRIBUTING.md)。

## `/ship`：一句话到已验证代码

```sh
/ship 让超长 diff 用分页器打开而不是刷屏滚过
```

`/ship` 自动驱动 7 阶段工程交付流水线：

1. **前检（Pre-flight）** — 检查工作区状态，创建独立的 `ship/<slug>` 分支。
2. **Wayfinder** — 明确交付目标与关键约束，提前解决取舍决策。
3. **Grill** — 结构化设计树访谈，每题自带推荐默认答案。
4. **Spec（Gate 1）** — 产出用户故事、公开接缝与明确的 Out of Scope 边界。
5. **Tickets（Gate 2）** — 拆解垂直切片，构建带显式依赖关系的 DAG 任务网。
6. **落地（Landing）** — 在并行的 Git worktree 中执行 TDD 落地，持续集成与验证。
7. **完成（Done）** — 全量验收通过且仓库无新增失败后，合回原分支。

### 即时任务流全景图
- **终端 Teaser**：状态行常驻显示票据即时读数（`待认领 n · 已认领 n · 已关闭 n`）、并行 worktree 状态与 Web 流程图链接。
- **双环 ASCII 全景浮层（`Ctrl+G`）**：终端内全屏查看任务依赖 DAG 与认领状态，按 `Ctrl+G` 或点击 Teaser 展开/收起。
- **本地 Web 流程图**：本地回环 React Flow 可视化全景（`127.0.0.1:<port>`），完整展示决策背景、问答历史与阶段切片。

### 自主恢复与抗冲突
- **自动冲突解决**：三方合并冲突（含 lockfile 与重命名冲突）自动由 agent 协调修复，保留双方意图并自动验证重试。
- **安全中断与续跑**：随时按 `Ctrl+C` 安全中断；输入裸 `/ship` 即可继续未完成的任务。

## 界面

专为纯键盘高效开发打造的终端交互界面：

- **自成空间的终端界面**：备用屏幕全屏呈现，输入框钉底，退出后完整还回原始 shell。
- **折叠式思考流**：思考过程默认只占单行，实时流式更新（按 `Ctrl+O` 或点击展开/折叠）。
- **子代理视图矩阵**：后台与并行子代理以独立视图运行（按 `Ctrl+H` 查看列表，点击进入，`Esc` 退出）。
- **时间线任意穿梭**：通过 `Shift+←/→` 或 `/jump` 快速跳转轮次；支持用 `/rewind` 从任意轮次分叉探索。
- **快捷交互与操作**：
  - `Shift+Tab`：切换 Plan 模式
  - `Ctrl+Q`：Agent 响应时继续打字排队
  - `Ctrl+C`：快速中断当前操作
  - `Ctrl+V`：直接从剪贴板粘贴图片
  - `/view`、`/diff`、`/copy`：在内置阅读器中查看文件、未提交改动或代码块

## 第三方端点

在 `$DSH_HOME/settings.yaml`（默认 `~/.dsh/settings.yaml`）中配置任何 OpenAI 兼容网关：

```yaml
llm-pi-ai:
  providers:
    acme-gateway:
      displayName: Acme Gateway
      apiKeyEnv: ACME_GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.acme.example/v1
      compat:
        thinkingFormat: deepseek
        supportsDeveloperRole: false
        maxTokensField: max_tokens
      models:
        - id: acme-large
          contextWindow: 65536
          maxTokens: 4096
```

切换并设为默认模型：
```sh
/model acme-gateway/acme-large
```

密钥解析优先级：环境变量 → `$DSH_HOME/.credentials.yaml` → `<cwd>/.env` → `$DSH_HOME/.env`。

## 它怎么跑

`codsh` 是一个零依赖启动器，它定位本机的 `dsh`，将 [`codsh-bundle`](https://www.npmjs.com/package/codsh-bundle) 注册进 `code` profile，并启动 `dsh --profile code`。

也可以直接使用 dsh 命令运行：
```sh
dsh plugin --profile code add codsh-bundle
dsh --profile code
```

## 终端

| 等级 | 终端 | 兼容标准 |
|---|---|---|
| 一等 | iTerm2、Terminal.app、VS Code 集成终端、tmux、Windows Terminal + WSL | 核心支持，阻塞发版标准 |
| 二等 | Ghostty、kitty、Alacritty、Warp | 现代终端特性良好支持，出问题作 bug 处理 |
| 尽力支持 | 原生 Windows（pwsh） | 基础交互可用，受限环境暂不支持持久 PTY |

在支持的终端上自动启用 Kitty 键盘协议、焦点感知、OSC 11 颜色查询与内联图像。

## 开发

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```sh
pnpm run dev          # 启动本地开发界面
pnpm test             # 运行单元测试
pnpm run typecheck    # TypeScript 类型检查
pnpm run test:e2e     # 运行 E2E 测试
```

## 交流与反馈

遇到问题、有新想法，或从 Claude Code / Cursor 迁移过来？欢迎提交 [Issue](https://github.com/Blackman99/codsh/issues) 或加入 [Discussions](https://github.com/Blackman99/codsh/discussions)。

## 许可

[MIT](LICENSE)
