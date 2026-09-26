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
leader。`agent headless`、`agent serve --remote <url>`、`--grok-ws-url` 和 Cursor worker
模式依赖官方服务，会被拒绝。leader 只支持 Unix；本次在 Linux 上验证，未在 macOS 或 Windows 上验证。

远程工作区通过 SSH 连接：`codsh --rust --remote ssh://[user@]host[:port]/abs/path`
（交互、`-p`、`--continue`、`--resume <id>`）会在那台主机上启动
`codsh --rust agent --leader stdio`（`--remote-command` 可改远端启动命令），并在本终端操作
它的会话。认证方式是 SSH 公钥加固定的主机密钥：`BatchMode=yes`、
`StrictHostKeyChecking=yes`，未知主机密钥或未授权的密钥都会被拒绝，也不会提示输入密码
（`--remote-identity FILE`、`--remote-known-hosts FILE`、`--remote-ssh PROG`）。每一轮都由
远端自己的配置、凭据、权限策略和沙箱执行。本机什么都不转发：不转发 agent、X11 和端口，
不带本机环境变量或服务商密钥，也不带本机 MCP 服务器、规则、记忆或模型选择。会话目录是
远端路径。本地文件不会被当作远端文件发送：`@file` 附件和图片会被拒绝，客户端也不向远端
提供文件系统访问。`--model`、`--permission-mode`、`--always-approve`、`--auto`、`--allow`、
`--deny`、`--sandbox` 等本机策略参数与 `--remote` 同用会被拒绝。连接断开时轮次仍在远端
运行；转录把它标为中断，断线期间不会发送 prompt，`/reconnect` 重新接入这一轮，不会重跑
任何东西。远端重启后，正在运行的轮次没有结果，外部效果报告为未知，也不会重试；
`/reconnect` 会恢复已保存的会话。`/remote` 和 `codsh --rust remote check <url> [--json]`
显示真实远端报告的内容（leader、沙箱、能否重新接入），以及远程会话没有的功能：steer、
`/btw`、计划、子代理、后台命令、goal、workflow、`/resume` 选择器、fork、rewind、导出、
记忆和插件。官方 Computer Hub（`workspace start --hub-url`）、云端工作区（`x.ai/cloud/*`）
和 Cursor worker 需要私有基础设施，仍然拒绝。本次在 Linux 上对本机 OpenSSH 服务器验证，
未对另一台机器、macOS 或 Windows 验证。

组织可以要求远程访问必须使用组织身份（ticket 207）。参考实现把已登录的组织 bearer
发给官方 Computer Hub；codsh 把它映射为你自己部署的 OpenID Connect 服务（用 Ory Hydra
验证）加上上面的 SSH 远端。在远端主机上，`requirements.toml`（或 `managed_config.toml`）
设置 `[remote_access] identity = "required"`、`issuer`、`audience`、`introspection_url`
（RFC 7662；https，或回环地址上的 http；官方 x.ai/grok.com 端点会被拒绝；可选
`introspection_client_id` 加只有属主可读的 `introspection_secret_file`）、`teams`、
`deny_subjects`、`recheck_secs`（默认 30）以及 `locked` 与 `lock_message`。用户自己的
`config.toml` 不能关闭它；读不出或不完整的策略会拒绝所有连接。此后 leader 代理只回答
`initialize` 和 `authenticate`，直到客户端出示一个身份服务报告为有效、签发方与受众匹配、
属于允许的团队、且不是 refresh token 的访问令牌；每个请求都会再问一次身份服务，连接期间
也按定时器复查，所以过期、在身份服务处撤销（包括 `codsh --rust logout`）、
`deny_subjects` 和 `locked` 都会结束连接并取消它启动的轮次（之前某个已关闭的连接留下仍在运行的
轮次，不会因之后的撤销而停止；可在主机上用 `codsh --rust leader kill` 停止）。客户端上，用该身份服务执行
`codsh --rust login`（`GROK_OIDC_ISSUER`、`GROK_OIDC_CLIENT_ID`、`GROK_OIDC_AUDIENCE`）
本身并不授予远程访问：令牌只发给 `[[remote_identity]] target = "ssh://host[:port][/path]"`
中列出、且 `audience` 相同的远端，只在远端要求的正是这个签发方时发送，JWT 的 `aud` 指向
别的受众时绝不发送。令牌会在过期前刷新，刷新后重新发送。两端都保存只有属主可读的 JSONL
审计（客户端 `$GROK_HOME/remote-identity.log`，主机 `remote-access.log`），记录用途、
目标、主体和令牌的 12 位十六进制 SHA-256 指纹，从不记录令牌本身；错误信息也不含令牌。
`remote check` 和 `/remote` 会显示结果。限制：检查在 codsh 的 leader 代理里，能开 shell
的密钥可以绕过；请把组织密钥限制为强制命令，例如 `restrict,command="/path/org-agent.sh"`，
由该脚本运行 `codsh --rust agent --leader stdio` 并传入 `SSH_CONNECTION`。`agent serve`
套接字和远程克隆不携带身份（要求身份的主机会拒绝远程克隆）。没有策略时远端行为与以前完全
相同。这背后没有官方 Computer Hub、SSO 或付费账号；本次在 Linux 上用回环地址的 Hydra 和
OpenSSH 验证，未在 macOS 或 Windows 上验证。

`codsh --rust clone [-b 分支] [--cone 路径]... [--full-history] <URL> [目录]` 用普通
git 代替参考实现的 Grove 懒克隆。它默认关闭，按参考实现的开关顺序打开：`GROK_CLONE` 或
`GROVE_CLONE`，然后是 `GROK_GROVE` 或 `$GROK_HOME/config.toml` 中的 `[cli] grove`，最后是
Grove 的 `~/.config/grove/config.toml`（你真实的 Home）中的 `[clone] enabled`；都没有设置时
以退出码 2 结束，并说明用哪个设置打开。各项 Grove 行为的替代方式：

| Grove（参考实现） | codsh 替代 | 差异 |
| --- | --- | --- |
| 所选分支深度 1 的引导克隆；`--full-history` 获取全部历史、分支和标签 | `git clone --depth=1 --single-branch --no-tags`；`--full-history` 为 `--no-single-branch` 并带标签 | 形态相同；`git fetch --deepen=N origin` / `--unshallow origin` 只加深所选分支，与文档一致。本地路径 URL 会让 git 忽略深度，摘要会说明（请用 `file://`） |
| 从内容存储懒加载 blob | 部分克隆 `--filter=blob:none` | 检出所需的 blob 在克隆时获取，其余在 git 需要时获取；服务器不支持过滤时会全部发送，摘要会说明 |
| `--cone` 投影 | `--sparse` 加 `git sparse-checkout set --cone` | 真实的稀疏检出，不是投影 |
| 守护进程、FUSE/NFS 挂载、`--leader-socket` | 无 | 克隆是磁盘上的真实检出；`--leader-socket` 会被拒绝；未与 Grove 做性能对比 |
| 守护进程认证：`GROVE_AUTH_TOKEN`、git 凭据、`GROVE_TOKEN_ROTATION` | git 自己的凭据助手、SSH 密钥、known_hosts、`GIT_SSH_COMMAND`；`GROVE_AUTH_TOKEN` 作为 https Authorization 头 | 令牌只通过 git 的环境配置发给 https（或本机回环 http）远端，从不写入 `.git/config`；轮换没有守护进程，报告为已忽略；git 从不使用 `codsh --rust login`；被拒绝的凭据报告为 `unavailable`（守护进程的 `expired-static` 与 `carrier-stale` 类别不适用） |

目标目录必须不存在或为空；非空目录、文件或符号链接会被拒绝（退出码 3）且保持不动。git
先写入一个隐藏的同级暂存目录，克隆和检出都成功后才重命名为目标，所以失败（退出码 1，
消息中去掉 URL）、凭据被拒（退出码 4）或 Ctrl-C（退出码 130）都不会留下任何东西，空目标
保持为空；被杀死的进程留下的暂存目录会在下一次克隆时清除。对已完成且 origin 相同的克隆
再次执行同一克隆，只会报告它而不获取任何内容（`-b` 不同则退出码 3）。摘要列出检出、
历史深度、blob 模式、后端（git 版本）和凭据来源，然后是 `Next: cd 目录 && codsh --rust`。
`--remote ssh://[user@]host[:port]/abs/base`（codsh 扩展；参考实现的克隆没有远程形式）在
那台主机上按远端自己的开关和 git 凭据执行同样的克隆，SSH 规则同上；`GROVE_AUTH_TOKEN`
不会发送，连接关闭会取消远端克隆并删除其未完成的目录，下一步是
`codsh --rust --remote <url>/<目录>`。工作树开关同样按参考顺序：`GROK_WORKTREE_TYPE`，
然后是 `[cli] grove_worktree` / `nfs_worktree` / `worktree_type`，再是 `GROK_GROVE` 或
`[cli] grove`。Grove 请求会记录在工作树上（`worktree show`），并回退为带完整检出的普通 git
工作树，与参考实现在 Grove 不可达时的做法一致。没有远程设置层。本次在 Linux 上对本机裸
仓库验证（file://、带令牌的本机 `git http-backend` http 服务，以及本机 OpenSSH 服务器），
未对 GitHub、真实 Grove、macOS 或 Windows 验证。

本地 MCP 服务器运行在 dsh 自己的 MCP 客户端里，codsh 不另起一套。
`codsh --rust mcp list|add|remove|enable|disable|doctor` 编辑并检查
`$GROK_HOME/config.toml` 中的 `[mcp_servers.<name>]`（stdio 的 `command`、`args`、
`env`、`cwd`，或 streamable HTTP 的 `url`、`headers`；支持 `${VAR}` 与
`${VAR:-default}` 展开）。受信任目录中的 `.grok/config.toml` 和 `.mcp.json` 可以新增或
覆盖服务器；未受信任时它们只显示为 untrusted，不会启动。Claude（`~/.claude.json`）与
Cursor（`~/.cursor/mcp.json`）的定义从隔离 Home 读取，可用 `[compat.claude] mcps = false`
或 `GROK_CLAUDE_MCPS_ENABLED=0` 关闭（Cursor 同理）。`disabled_mcp_servers` 或
`enabled = false` 可阻止服务器启动。每个会话在开始时挂载服务器；程序不存在、在
`initialize` 前崩溃或拒绝 `initialize` 都会按名称报告：plain 模式写到 stderr，终端界面显示
在状态行，`/mcps` 中也可见，其余服务器照常启动，会话不受影响。工具以 dsh 的
`mcp__<server>__<tool>` 出现，同时提供 Grok 的 `search_tool`（关键词搜索，返回
`server__tool` 名称和输入 schema）与 `use_tool`（`tool_name` 为 `server__tool`，参数放在
`tool_input`）。无论直接调用还是经 `use_tool`，每次调用只经过 dsh 管线一次：allow/ask/deny
规则和已记住的授权使用 `server__tool`（规则里写 `mcp__server` 表示该服务器的全部工具），
Hook 看到的 `tool_name` 是 `server__tool` 而不是分发器，Ctrl+C 或 ACP `session/cancel` 会向
服务器发送 `notifications/cancelled`。超过 `[mcp] max_output_bytes`（默认 20000，
`GROK_MAX_MCP_OUTPUT_BYTES` 或 `MAX_MCP_OUTPUT_BYTES` 可覆盖）的文本结果按 UTF-8 边界截断并
附上 Grok 的 `[MCP output truncated: ...]` 提示，完整内容写入 `$DSH_HOME/mcp/output/`。
`startup_timeout_sec`（默认 30 秒，`GROK_MCP_STARTUP_TIMEOUT_SECS` / `MCP_TIMEOUT`）以及
`tool_timeout_sec` / `tool_timeouts` 由 `codsh-rust` 内置的小型 stdio 启动器执行，它也保存
服务器的 stderr，供 `/mcps` 和 `mcp doctor` 显示；dsh 自身每次调用 60 秒的上限仍然有效。
服务器在调用中途退出时，dsh 会重新连接，失败的那次调用返回错误。`/mcps`（别名 `/mcp`）
列出服务器、状态、失败原因和工具；`/mcps enable|disable <name>` 保存修改，
`/mcps restart [name]` 或 `/mcps refresh` 通过在新的 dsh 中恢复同一会话来重启全部服务器
（轮次运行中会拒绝）。编辑器在 `session/new` 或 `session/resume` 中提供的 `mcpServers`
会在配置的服务器之后挂载。已知限制：dsh 只渲染结果中的文本部分（`use_tool` 仅在没有文本时
返回 `structuredContent`）；超过 64 个字符的工具名会被 dsh 哈希；直接的 `mcp__*` 工具与
`search_tool`/`use_tool` 同时可见；托管的 MCP allow/deny 策略（`allowedMcpServers`/`deniedMcpServers`）和
`disabled_mcp_tools` 尚未生效。已启用插件的服务器会加入同一列表（见插件一节）。经 `codsh --rust` 启动时，只有上面列出的 MCP 变量、`BROWSER` 和 `*_API_KEY` 会从宿主环境传入，
其他值请写在服务器的 `env` 表中。本次在 Linux 上用真实的 stdio 测试服务器验证，未在 macOS
或 Windows 上验证。

远端服务器（`url`，类型 `http` 或 `sse`；未写类型且 URL 以 `/sse` 结尾时按 SSE）经 codsh 的
远端代理运行，dsh 看到的是一个 stdio 服务器：支持 streamable HTTP（JSON 或 SSE 回复、
`Mcp-Session-Id`、协商出的 `MCP-Protocol-Version`，404 时重新初始化一次）和旧版 HTTP+SSE
传输（消息端点必须同源）。静态 `headers` 与 `bearer_token_env_var` 写入仅属主可读的
`<run>/<name>.remote.json`，不进入计划文件或命令行；请求头值里的 `${session_id}` 会替换为会话 id。
重定向一律拒绝（令牌不能跟随跳转）；请求在途中断开时只报告，不重发。服务器返回 401 时用 OAuth
登录：`codsh --rust mcp login <name>`（会话内 `/mcps auth <name>`，编辑器用
`x.ai/mcp/auth_trigger`）会发现授权服务器（RFC 9728 / RFC 8414，OpenID 兜底），在未设置
`oauth_client_id`（可选 `oauth_client_secret_env_var`、`oauth_scopes`，或带 `callback_port`
的 `oauth` 表）时动态注册公共客户端（RFC 7591），并经 `$BROWSER` 或系统打开方式、回环地址
`http://127.0.0.1:<port>/callback` 完成授权码 + PKCE S256 流程并带上 `resource`（RFC 8707）；
URL 也会打印出来。令牌存于 `$GROK_HOME/mcp_credentials.json`（0600，按服务器名和 URL 区分），
过期或遇到 401 时刷新一次；`mcp logout <name>` / `/mcps logout <name>` 会撤销（服务器提供
RFC 7009 时）并删除令牌，`mcp remove` 也会删除。`mcp login`/`logout` 和 `/mcps auth|logout`
是 codsh 的扩展；参考实现通过扩展面板和 ACP `auth_trigger` 登录。工具结果中的图片块原样交给
dsh（模型不支持图片输入时由 dsh 显示占位；`expose_image_base64 = true` 会另附 base64 文本）；
音频变为简短说明，内嵌文本资源变为文本。MCP elicitation（`elicitation/create`，表单和 URL
两种模式）只在有人能回答时才声明：TUI 弹出 MCP 卡片（↑/↓ 或 Tab 移动，Enter/Space 编辑或切换，
←/→ 选择选项或按钮，在 Accept 上按 Enter 校验并提交，`d` 拒绝，Esc 暂离键盘，Ctrl+C 取消，
`o` 打开 URL），编辑器收到 `x.ai/mcp/elicit`（以及 `x.ai/mcp/elicit_complete`，请求在别处被回答
或被撤回时收到 `$/cancel_request`）；无头 `-p` 不声明该能力。回答会按请求的 schema 再校验；
校验不通过或编辑器报错都按拒绝处理。dsh 每次调用 60 秒的上限包含用户作答的时间。编辑器还可用
`x.ai/mcp/auth_status` 和 `x.ai/mcp/read_resource`。尚未处理：`-32042`（需要 URL elicitation）
错误，其消息作为工具错误交给模型。本次在 Linux 上用无密钥的回环测试服务器（含 OAuth 授权服务器）
和 MCP TypeScript SDK 1.30.0 示例服务器及其演示 OAuth 服务器验证；未对托管服务、macOS 或 Windows 验证。

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
显示为 hook 输出，而不是模型回答；JSON 里的 `systemMessage`（与 Claude Code 相同）
在任何事件中都单独显示，取代原始输出。Hook 命令还会拿到 `CODSH_HOOK_HOST_PID`，
即运行它的 dsh 进程。允许 Hook 不能跳过随后的权限检查，也不能放宽
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
Rust 客户端里回合运行期间，Enter 把草稿放进队列，提示区显示 `Queued N` 和下一条；
空提示上按 Enter 立即发送队首一条。`Ctrl+Enter` 或 `Ctrl+I` 立即发送草稿（或选中的
队列行）：当前回合通过 dsh 取消，不显示 `[cancelled]`，该行作为下一回合执行。Apple
Terminal 另外支持 `Ctrl+O`；VS Code 系终端（vscode、cursor、windsurf、zed）改用
`Ctrl+L`。`Ctrl+Enter`/`Ctrl+I` 需要终端能区分上报（kitty 键盘协议）；其他终端不绑定
`Ctrl+O`。`Ctrl+;` 或 `Ctrl+'`（或空提示上按 ↑）打开队列面板：↑/↓ 选择，`e` 原地
编辑（Enter 保存，保存为空即删除，Esc 取消），Enter 立即发送，`x`/Del/Backspace 删除，
`Shift+J`/`Shift+K` 调整顺序，Esc 关闭。队列按顺序每回合执行一条，在回合结束或用
`Ctrl+C` 取消之后开始；待审批、压缩中或正在编辑的行会让队列等待，切换
`/minimal`/`/fullscreen` 不丢队列。忙碌时输入的斜杠命令作为单独的行排队。
`[ui] follow_up_behavior = "steer"` 改为把纯文本追问在下一模型步骤注入正在运行的 dsh
回合；dsh 没有用上的追问会回到队列。`[ui] combine_queued_prompts = true` 把相邻的纯文本
行合并成一个回合。`/queue` 列出队列。`/btw <问题>`（也可以写在消息中间）通过私有 dsh
控制通道、基于当前会话上下文、不带工具地提一个旁路问题；答案显示在面板里，Esc 关闭
（minimal 模式写入回看区），已关闭问题的迟到答案会被丢弃，问题和答案都不进入对话。
`codsh --rust -p "任务"`（或 `--single`、`--prompt-file <路径>`、`--prompt-json <内容块>`）通过同一个 dsh ACP 会话执行一次提示，stdout 只打印最终答案。`--verbatim` 按原样发送用户内容，不展开自定义斜杠命令。文件规则、`--rules`、`--system-prompt-override` 以及启用时的首轮记忆仍然生效：它们作为单独的前置内容块放在你原样的字节之前（dsh 会拼接相邻的文本块，所以模型先看到规则和笔记，再看到你的提示）。dsh 把 codsh 规则当作提示上下文接收，而不是单独的系统提示。权限策略仍走工具通道。纯文本回合没有时间上限：dsh 完成或失败、或收到信号时才结束。思考、工具卡片和错误不会进入 stdout；诊断写到 stderr。纯文本提示配合 `-c`/`--continue` 或 `-r`/`--resume <id 或标题>` 会继续该会话，`--fork-session` 会复制会话。`--max-turns <N>` 在模型步骤 N+1 之前停止，并在 stderr 说明该上限。`--tools` 与 `--disallowed-tools` 在第一次模型请求前屏蔽工具；`read_file`、`Bash` 这类公开名称会映射到 dsh 工具名，`Agent` 会移除所有已注册的子代理创建工具（`subagent` 与 `subagent_fork`）以及 `workflow` 工具，任意大小写的 `--disallowed-tools Agent(type)` 会移除这些子代理类型（见下方子代理说明）；`--tools Agent(type)` 与 `Agent()` 在调用提供者之前就会被拒绝，继承来的 `CODSH_PLAIN_TOOLS` 里的类型条目也一样。两者同时出现时 deny 生效，未知名称是错误。从父进程继承的 `CODSH_PLAIN_TOOLS` 或 `CODSH_PLAIN_MAX_TURNS` 在纯文本提示中遵循同样的规则；交互会话会忽略这两个值。`--allow`/`--deny` 仍然只控制执行，不会移除工具。`--tools`、`--disallowed-tools`、`--max-turns` 和 `--verbatim` 是无界面参数：没有纯文本提示时会打印警告并被忽略。`--cwd <路径>`、`--sandbox <配置>`、`--no-memory`、`--no-subagents` 和 `--disable-web-search` 同时适用于纯文本提示和交互会话。`--cwd` 会在读取配置、信任状态和沙箱之前进入该目录，因此沙箱的可写根就是这个目录。相对路径的 `--prompt-file` 在进入 `--cwd` 之后才读取，因此指向该目录里的文件。相对路径的 `--trust-folder` 或沙箱报告路径仍指向你运行命令时所在目录旁的文件。`--no-memory` 让笔记不进入首轮提示。`--disable-web-search` 为本进程关闭网页搜索与网页抓取，并从模型的工具列表中移除 `web_search` 与 `web_fetch`。`-m` 等同 `--model`，`-v` 等同 `--version`。重复的提示来源会在调用提供者之前拒绝。位置参数不会进入纯文本模式，管道里的 stdin 也不是提示。`codsh --rust help` 和 `-h` 打印帮助；`completions bash|zsh|fish|powershell|elvish` 打印对应 shell 的补全脚本。`--output-format` 可以是 `plain`（默认，只打印最终答案）、`json`（一个对象：`text`、`stopReason`、`sessionId`、`requestId`，dsh 发来推理时还有 `thought`）、`streaming-json`（每行一个 ACP 形状的对象，最后一行是 `end`）或 `streaming-messages-json`（`system`/`init`，然后是 `assistant` 与 `user` 消息，最后一行是 `result`）。`--include-partial-messages` 增加 `stream_event` 增量，并且只改变 `streaming-messages-json`；其他格式会打印警告并忽略它。工具参数、工具结果和推理按 dsh 更新原样复制，不会改写。`usage`、`modelUsage` 与 `num_turns` 取自本次提示所启动回合的 dsh 会话日志，包含子代理（见下文“用量与费用”）。某次模型调用没有上报用量时写 `usage_is_incomplete: true`，不补零；完全没有记录时终止对象写 `usage_absent: true`。dsh 不上报费用，所以 `cost_status` 为 `unknown`，不写任何费用字段。部分消息的 `message_start` 不写 `usage`，合计在终止对象里。截断停止（`max_tokens`）、模型错误，以及 SIGINT/SIGTERM（130/143）都会结束进程，不会把失败的回合报成 `end_turn` 成功。没有终端时的工具审批会在 dsh 内被拒绝并以退出码 1 结束；文件不变。`json` 与 `streaming-json` 打印 `{"type":"error",...}`，`streaming-messages-json` 打印 `is_error: true` 且 subtype 不是 `success` 的 `result`。它们都不会写 `end_turn`。同一提示走 `plain` 和走 `json` 使用同一条 dsh 会话路径，所以文件副作用和保存的会话一致。代理选择、计划、`--experimental-memory`、`--memory-flush` 和 `--json-schema` 会点名该参数并留给后续任务。不带值的 `-r`/`--resume` 暂时还不是“恢复最近会话”的快捷方式（由 ticket 159 负责）。未知选项和缺少的参数值退出码为 2。SIGINT 为 130，SIGTERM 为 143，dsh 仍在启动时也一样；dsh 或提供者错误为 1。

用量与费用。Rust 客户端的 `/usage`（别名 `/cost`）、`/session-info`、状态栏命令的负载（`context_window.session_input_tokens`、`session_output_tokens`、`session_usage`、`cost.total_api_duration_ms`）、无头输出以及 `codsh --rust usage <会话-id> [回合]`（JSON）读取同一份由 dsh 会话日志折叠出的账本。折叠覆盖整份日志，恢复会话不会重复计数。与参考一致，分叉会话的合计包含它继承的历史，而无头 `-p` 结果只报告该提示启动的回合。一次模型调用是一次 dsh 尝试（从 `step/start` 或重试开始到结束），token 取自服务商上报的用量（输入含缓存读写，输出含推理）。子代理会话计入启动它的父回合，并按模型路由分别列出。未上报用量的调用、被中断的调用、仍在运行或找不到日志的子代理都会把账本标为不完整（“可能少计”），不会补零。API 时间沿用 dsh 的 `llmMs`（尝试开始到结束）。会话日志之外的辅助调用（会话标题、压缩摘要、`/btw`、记忆）不计入。费用：dsh 不上报费用，固定版本的 dsh 源码也没有价格表，因此费用一律显示为不可用（未知），不做估算，也绝不显示 `$0`。
`codsh --rust` 中的子代理由 dsh 创建并执行。模型的 `subagent` 工具接受 `subagent_type`：`general-purpose`（拥有父代理的全部工具）、`explore` 与 `plan`（可读取、搜索和执行 shell，但不能写入或编辑）、`[subagents.roles.<名称>]` 角色（`description`、`default_capability_mode` = `read-only`、`read-write`、`execute` 或 `all`、`model`，以及 `$GROK_HOME` 下的 `prompt_file`），或 `.grok/agents/`、`$GROK_HOME/agents/` 中的代理文件（取其 front matter 的 `tools` 与 `model`）。类型的能力会变成 dsh 工具允许列表，被移除的工具不会出现在子代理的工具列表里，强行调用也会被拒绝。dsh 无法归类的工具（例如 MCP 工具）只在 `all` 下保留。子代理继承父代理的权限模式、规则、hook 和沙箱；它自己无法回答审批，所以子代理里的 ask 会被拒绝。创建子代理这一调用仍受父代理自己的审批策略约束。来自 `[subagents.models]`、角色或代理文件的模型会在子代理启动前检查；不可用时拒绝创建，什么也不会运行。`[subagents] enabled = false`、`GROK_SUBAGENTS=0` 或 `--no-subagents` 会移除该工具。`max_concurrent` 或 `GROK_MAX_CONCURRENT_SUBAGENTS`（默认 32；0 视为 1）按会话统计正在运行的子代理，`limit_behavior` 或 `GROK_SUBAGENT_LIMIT_BEHAVIOR` 决定达到上限时排队等待空位（`queue`，默认）还是直接拒绝（`fail`）。`max_depth` 或 `GROK_SUBAGENTS_MAX_DEPTH`（默认 1）限制嵌套层数。`[subagents.toggle] <类型> = false` 隐藏某个类型；纯文本提示里的 `--disallowed-tools Agent(type)` 或 `Agent(type, other)` 会移除这些类型（未知类型会让所有创建都被拒绝；`--tools` 不能放行 `Agent` 或某个类型；`Agent()` 是错误）。`run_in_background: true` 会立即返回 dsh 任务 id；模型用 `job_output` 取回结果，结果只交付一次。工具块显示 `Subagent running`、`started`（后台）或 `queued`，结束后显示 `completed`、`failed` 或 `cancelled` 及耗时；状态行统计仍在运行的子代理。`/tasks`（全屏模式下也可按 Ctrl+G）打开任务列表：↑/↓ 选择，Enter 或 Ctrl+F 打开该子代理的只读记录，`x` 取消它，`h` 隐藏已结束的项，Esc 或 `q` 关闭。在子代理视图里按 Ctrl+C 只取消这个子代理；在父回合上按 Ctrl+C 会取消它的前台子代理，后台子代理则继续运行，直到完成或被你取消。子代理会话不会出现在 `/resume` 或 `sessions list` 中。消息与续跑默认关闭。设置 `[features] active_agent_messages = true` 或 `GROK_ACTIVE_AGENT_MESSAGES=1` 后，父代理会获得 `send_subagent_message` 工具。它的参数是 `subagent_id`、`text`（最多 32 KB）和 `delivery`：`steer`（默认）并入子代理当前回合，`queue` 排到之后的回合，`interject` 插到待处理的 steer 之前，并提前结束阻塞中的 `job_output` 等待。每个子代理也有这个工具，可发给 `parent` 或它知道的兄弟子代理。未被取消或终止的已完成子代理会以同一身份被唤醒，作为 dsh 任务运行：行上显示 `· attempt N`，结束时有完成通知。以下情况会得到参考实现的拒绝文本：未知或不属于本会话的 id、已取消的子代理、空文本或超长文本、额度用尽（每个子代理 8 条未认领消息，总计 64 条；子代理对每个接收者最多 4 条在途，每次运行最多发 32 条）。对话记录中的行显示为 `Message sent to` / `queued for` / `interjected to`，后接子代理类型和带引号的描述；被拒绝时显示 `Message rejected · …`。只读的子代理视图（没有输入框）把消息显示为带标记的 `◎ Message from parent` 回合。`subagent` 工具的 `resume_from` 会启动一个新子代理，接续本会话中某个已完成子代理的对话记录和固定模型。它必须是同一类型，模型覆盖会被忽略；行上显示 `continues "…"`。开启该开关后，dsh 自带的 `send_message` 与 `interrupt_agent` 会被拒绝，改用新工具。与参考实现的差异：重启后不保留任何状态（不从磁盘冷恢复）；最多保留 32 个已结束的子代理（最早的先释放）。工作树隔离的子代理不能唤醒或续跑，工作流、调度和目标校验子代理不能接收消息。该行不支持 Right/Left 展开（详情见工具块的展开和 `/tasks`）；`ui.cancel_subagents_on_turn_cancel` 与 `x.ai/subagent/*` ACP 扩展方法未实现。persona 和 `--agent` 留给后续任务（工作树隔离见下文）；参考实现里的类型校验时限（远程类型 RPC）不适用，因为类型在本地解析。`subagent_fork` 不计入 `max_concurrent`。
`codsh --rust` 中的工作树：`-w`/`--worktree [名称]` 会在新的 git 工作树中启动会话（交互或 `-p`），位置为 `$GROK_HOME/worktrees/<仓库>/<名称>`，使用独立的 `codsh/<名称>` 分支。它从当前目录（`--cwd` 生效后）创建，并在读取配置、信任和沙箱之前完成，会话在工作树内保持相同的相对位置。不带 `--worktree-ref`（别名 `--ref`）时，从 `HEAD` 加上你未提交和未跟踪（非忽略）的文件开始，这些改动在工作树里提交为一个快照；你的检出、暂存区和分支都不会改变。带 ref 时是干净检出。名称已被目录或分支占用时追加 `-2`、`-3` 后缀，已有分支绝不会被复用或重置。不在 git 仓库中时 `-w` 会被拒绝，且不会创建任何东西。`-w -r <id>`（或 `-w -c`）把该会话以新 id 复制到新工作树并恢复这份副本；原会话保留自己的目录。状态栏显示工作树和分支。工作树对文件夹信任和记住的审批而言是独立工作区，因此两者都会重新询问。`codsh --rust worktree list`（`ls`；`--repo`、`--type session|subagent|untracked`、`--all`、`--json`）、`show <id>`、`apply <id>`、`rm <id>...`（`-f`、`--dry-run`）、`gc`（`prune`；`--max-age 7d`、`--dry-run`、`-f`）和 `db path|stats|rebuild` 用于管理，会话内的 `/worktree [list|show|apply|rm|gc]` 作用相同。`apply` 始终是显式操作：默认合并，只有检出中的文件仍是工作树创建时的内容才会写入；其他改动文件都报告为冲突并保持不动。`--overwrite` 采用工作树版本，`--dry-run` 只报告。`apply` 从不提交或暂存，并拒绝符号链接和经由符号链接目录的写入。`rm` 在工作树有未提交内容时拒绝，除非加 `-f`；分支只要包含提交就会保留。`gc` 不带 `--max-age` 时不会让任何工作树过期，并保留含未提交、未跟踪或非缓存忽略文件、含无分支或标签持有的提交、或仍有存活所有者进程的工作树。以 `isolation: "worktree"` 调用的子代理在父仓库的独立工作树（类型 subagent）中运行：结果、工具块和 `/tasks` 条目会写明工作树，不会把任何改动应用到你的检出；没有改动的工作树在子代理结束时删除（取消或失败也一样），有改动的保留下来供你检查并应用。检出上的权限规则同样覆盖工作树里对应的路径。`detach`、`salvage` 和 `clean-artifacts` 会被拒绝，因为没有 Grove 投影；运行中的会话里 `/fork --worktree` 会被拒绝（请用 `-w -r`）。新会话与分叉的工作树提示（`hints.*_worktree_mode`）、自动 gc、快速/btrfs 工作树以及 `x.ai/git/worktree/*` 编辑器扩展均未实现。在文件系统沙箱下，工作树中的 git 与子代理隔离只能写入配置文件写入根覆盖的位置（`$GROK_HOME/worktrees` 与源仓库的 `.git`）；否则会报告 git 的错误，且不会应用任何内容。只在 Linux 上验证过；macOS 与 Windows 未验证。
`codsh --rust` 中的计划模式、问答与待办由 dsh 负责：计划模式状态记录在会话日志中，`ask_user_question` 通过 dsh 的 user-questions 接口提问，`todo_write` 维护待办列表。客户端只显示 dsh 的提问并把答案送回。`/plan` 进入计划模式，`/plan <任务>` 进入后发送该任务，`/plan off` 退出；Shift+Tab 在 普通 → 计划 → 始终批准 → 普通 之间循环（`requirements.toml` 锁定关闭始终批准时跳过该档）。模型可以调用 `enter_plan_mode` 请求进入，走的是普通的审批提示。计划模式开启时，状态行以 `plan` 开头，所有编辑都会在执行前被拒绝，即使在 `--always-approve` 或 `--yolo` 下也一样；唯一例外是会话计划文件 `$GROK_HOME/sessions/<编码后的 cwd>/<会话 id>/plan.md`，写入它无需确认。与参考实现一致，不检查 bash，也不覆盖子代理。编码后超过 255 字节的目录名使用 `<slug>-<16 位十六进制>`；这里使用 SHA-256，参考实现使用 BLAKE3，因此这类长目录名与参考实现不同。`exit_plan_mode` 会把计划保存到该文件（调用中没有 `#` 标题的计划时从磁盘读回），并打开计划评审：方向键或 j/k 滚动，`a` 批准（输入的评论作为下一条消息附上），`s` 在输入框中提出修改（Enter 发送，Esc 返回），`c` 对一行或 Shift+方向键选中的范围评论，`y` 复制，`q` 放弃计划并退出计划模式，Tab 在预览与输入框之间切换。输入框中完整的斜杠命令会作为命令执行，并阻止 `a`。空计划仍会打开评审并显示“No plan written yet”。最小模式把计划打印到滚动历史并保留三行提示条。`/view-plan`（`/show-plan`、`/plan-view`）只读显示已保存的计划。问题卡片：方向键或 j/k 移动，Tab/Shift+Tab 循环，←→、h/l 或 `[` `]` 切换问题，`1`–`9` 与 `a`–`f` 选择，`z` 输入自定义答案，Space 切换多选项，Enter 选择、前进或提交，Esc 先清除答案再把键盘停放到滚动区（Tab 或 Space 返回），`y` 复制，Shift+X 放弃回答（模型会被告知用户拒绝回答），Ctrl+F 展开。待处理的工具审批优先于卡片。`[features] ask_user_question` / `GROK_ASK_USER_QUESTION` 与 `--no-ask-user` 移除该工具；`--no-plan` 移除计划模式。`[toolset.ask_user_question] timeout_enabled` 与 `timeout_secs`（默认开启，1800 秒；`GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED` / `_SECS`）会关闭未回答的卡片，迟到的答案会被拒绝。计划评审不会超时。单次提示（plain）与编辑器（`agent stdio`）会话没有卡片：提问返回无人应答文本，计划评审自动批准，与参考实现的无头模式一致。待办面板跟随 dsh 当前提示的列表，Ctrl+T 隐藏。隐藏参数 `--todo-gate` 在模型结束回合但仍有待处理或进行中的待办时，最多两次把它送回继续工作。
`codsh --rust` 中的工作流：模型的 `workflow` 工具运行参考格式的 Rhai 工作流脚本（先是 `let meta = #{ name, description, phases, ... }` 映射，然后是 `args`、`agent()`、`parallel()`、`phase()`、`log()`、`complete()`，脚本的返回值即结果）。引擎是参考实现的 `xai-workflow` crate（Apache-2.0），放在 `rust/upstream/xai-workflow` 下，由原生二进制作为独立进程运行；每个 `agent()` 调用和每个 `parallel()` 项都会启动一个真实的 dsh 子代理，使用脚本给出的 `prompt`、`label`、`model`、`effort`、`agent_type`、`capability_mode` 和 `isolation_worktree`，检查方式与 `subagent` 工具相同（模型不可用或类型未知时该调用失败，什么也不会运行）。代理循环仍是 dsh。`source` 必须且只能给一个：内联 `script`，或指向以 `meta.name` 命名的 `.rhai` 文件的 `script_path`，文件须位于项目内（仅限已信任的文件夹）或 `$GROK_HOME/workflows`；符号链接和超过 1 MiB 的文件会被拒绝。`args` 绑定到脚本的 `args`；`agent_budget`（默认 128，最多 1024）限制本次运行累计的代理调用数，会超出预算的 `parallel()` 组在任何子代理启动前整体拒绝。同一次运行最多同时有 32 个子代理（核数较少的机器上更少）；可在 `config.toml` 中设置 `[subagents] workflow_max_concurrent`，或设置 `GROK_WORKFLOW_MAX_CONCURRENT_AGENTS` 来修改（环境变量优先；文件中 0 或更小的值按 1 处理）。这个同时运行上限与 `agent_budget` 相互独立：比上限更宽的并行组会排队，每一项仍计入预算；子代理按运行计数，不计入 `max_concurrent`，`codsh --rust inspect` 会显示该值。`output_schema` 要求子代理以符合该 JSON Schema 的 ```json 代码块结尾（用参考实现的 `jsonschema` crate 编译；无效的 schema、远程 `$ref` 或超过 256 KiB 的 schema 在子代理启动前被拒绝）；答案不符合时，同一个子代理会得到一次纠正回合，重试不计入预算，结果的 `output` 是解析后的 JSON，否则为 `success: false` 并带有 `structured output validation failed: …`。`write_scratch_file(name, text)` 和 `read_scratch_file(name)` 把本次运行的文件保存在 `$GROK_HOME/sessions/<项目>/<会话>/workflows/<运行 id>/scratch` 下（只能是单个文件名，每个文件 10 MiB，最多 64 个文件，总计 64 MiB，不允许符号链接），`git_diff_since(commit)` 返回会话工作目录相对某个提交哈希的 `git diff`（20 秒，256 KiB）。失败或被取消的子代理是 `success: false` 的结果，被拒绝的子代理（未知类型、模型不可用）在 `parallel()` 结果中是 `()`，从未启动的子代理绝不会被报告为成功；运行结束、失败或被取消时，所有子代理都会被关闭。一次运行最多启动 2048 个代理（含重试）。`validate_only: true` 只编译脚本并走一条预设路径，不启动代理。每次调用都会在会话中启动一个后台运行：引擎开始执行脚本后，工具立即返回 `Workflow 'name' started in the background.`，回合继续进行。每个运行有一个会话内唯一的显示名称（重复的 `meta.name` 依次变为 `name-2`、`name-3`……）；脚本和 `args` 在启动时固定，与引擎记录已完成代理调用的日志一起保存在 `$GROK_HOME/sessions/<项目>/<会话>/workflows/<运行 id>/` 下。一个会话最多同时有 4 个工作流在运行。运行完成、失败、被取消或因代理预算停止时，所属会话每次启动或恢复只收到一条完成通知（空闲时是一个 `◎ Task completed · workflow name [status]` 回合，忙碌时在下一回合，被取消丢弃时会重新放回），其中包含状态、耗时以及结果或原因；模型自己发起的暂停或停止不会再报告给它。`/workflow`（或 `/workflow runs`）列出本会话的运行及其阶段、代理计数、耗时和目标；`/workflow pause|resume|stop <名称>`（也可写成 `/workflow <名称> pause`）按显示名称控制某个运行，模型也可以用 `source: { type: "pause" | "stop" | "resume", ... }` 按名称或运行 id 做同样的事。暂停和停止会取消该运行的子代理并结束其引擎（5 秒内未停止则强制结束）。恢复会用原始脚本和参数重新启动，并重放日志：已完成的代理调用直接返回记录的结果，不会再启动子代理；被取消或失败的步骤会重新执行，因此尚未完成的步骤的副作用可能发生两次，这里没有任何恰好一次的保证。因代理预算停止的运行只能在提高绝对 `agent_budget` 后恢复；脚本自己的 `pause()` 会带着其消息暂停运行。运行只能在启动它的 codsh 进程中恢复：重启后 `/workflow runs` 仍会列出它们，原本活动的运行显示 `interrupted`，所有恢复都会以这个原因被拒绝。工具块显示 `Workflow running: 'name' · 阶段 · N agents (M running)`，之后显示状态（`complete`、`user paused`、`budget limited`、`failed`、`cancelled`、`interrupted`）及耗时，恢复后重新显示为运行中；`/tasks` 列出带有 `workflow <名称>` 标记的子代理和一个 Workflows 区域，状态行会统计活动的工作流。Ctrl+C 取消的是回合，而不是后台运行。纯文本 `-p` 提示随回合结束，因此在那里工具会等待运行结束，并返回通知本应携带的内容块；取消该提示会停止运行。语法错误或无效元数据在任何东西启动前被拒绝，永不结束的脚本由引擎的操作数上限（1 亿次操作，约几秒 CPU）停止。这些限制只约束脚本本身，不是安全沙箱：脚本启动的代理照常使用自己的工具和权限。只有顶层会话拥有该工具：子代理（包括工作流子代理）调用会以 `workflow_depth_exceeded` 拒绝，`[subagents] enabled = false` 或 `--no-subagents` 也会移除它。每次运行的可编辑脚本副本、`resume_from`（dsh 无法用已结束的子代理为新子代理提供种子）和 `fork_context` 会以明确错误拒绝。子代理结果中的 `tokens_used` 为 0，因为 dsh 不回传子代理的 token 数。只在 Linux 上验证过；macOS 与 Windows 未验证。
`codsh --rust` 中已保存的工作流：`<项目根>/.grok/workflows`（git 根目录；不在 git 中时为工作目录；仅在已信任的文件夹中加载）或 `$GROK_HOME/workflows` 中以 `meta.name` 命名的 `<名称>.rhai` 文件就是一个已保存的工作流。同名时项目副本优先于个人副本；未信任的文件夹只加载个人目录。发现过程只读取每个文件的 `meta`，从不运行脚本。解析失败、元数据无效、文件名与 `meta.name` 不符、是符号链接或超过 1 MiB 的文件会带着原因被跳过，符号链接的目录不会被扫描。`/workflows` 用几行概括目录：每个工作流及其作用域、被项目工作流遮蔽的个人副本、无效文件（最多列出 10 个）、已启用插件的工作流、扫描过的文件夹，以及排在最前面的内置工作流（见下文的深度研究）；`/workflows <名称>` 显示单个工作流的描述、`when_to_use`、运行方式、路径和它遮蔽的副本，或同名文件未被加载的原因。斜杠菜单为每个名称未被命令、技能或自定义命令占用的已保存工作流提供 `/<名称>`，每次打开菜单时刷新。`/<名称> [参数]`、`/workflow <名称> [参数]` 以及模型的 `source: { type: "name", name }` 都会像脚本运行一样启动后台运行。斜杠参数采用参考格式：开头的 `--agent-budget N` 和 `--effort LEVEL`（已知的推理等级，用于没有自行设置 `effort` 的子代理），之后是 JSON 对象（绑定到 `args`；也可以在其中设置一次 `agent_budget` 和 `effort`）或文本（绑定为 `args.query` 和 `args.objective`）。未知名称和同名的无效文件（`workflow 'x' is not loaded: <路径> is invalid: …`）会带着原因被拒绝，什么也不会启动；同一作用域中定义两次的名称会以有歧义为由被拒绝。运行保留启动时解析到的脚本：运行期间编辑或删除文件不会改变它，恢复时重放保存的副本，只有下一次启动才会读取编辑后的文件。每个回合的第一步，模型会收到参考格式的已保存工作流清单（名称、描述、适用场景、绝对路径；每个工作流的描述最多 400 字节），只有清单变化时才会再次发送；宿主侧的 `/<名称>` 启动会连同运行 id 告知模型。`/workflow save <名称>` 把运行保存的脚本写入 `<项目根>/.grok/workflows/<meta.name>.rhai`：只适用于以自身 `meta.name` 显示的运行（不是 `name-2` 这样的句柄），只在已信任的文件夹中，从不经过符号链接的目录，也从不覆盖已有文件（文件以原子方式创建，同名文件已存在时拒绝保存）。没有可写的项目目录时，回复会说明这一点，并给出运行保存的脚本位置以及可复制到的 `$GROK_HOME/workflows` 路径。`/workflow` 和 `/<名称>` 需要一个活动的 dsh 会话（先发送一条提示）。已启用的插件也可以提供工作流：其 `workflows/` 目录（或清单中的 `workflows` 路径或列表）里的 `.rhai` 文件在插件处于活动状态时（已安装、已信任、已启用、文件存在；项目插件还需要工作区信任）排在项目和个人工作流之后加入目录。插件工作流始终可以用 `/<插件名>:<名称>`（以及 `source: { type: "name", name: "<插件名>:<名称>" }`）运行；只有当没有同名的项目或个人工作流、也没有其他活动插件提供同名工作流时，裸 `/<名称>` 才会运行它，否则裸名称运行项目或个人工作流，或以有歧义为由被拒绝并给出两个限定名称。`plugin list --json`、`inspect` 与 `/plugins` 展开行会列出插件的工作流（只读取 `meta`，安装不会运行任何东西），`/workflows <插件名>:<名称>` 显示插件的版本、许可、作用域、信任状态、来源和提交。停用、被阻止、缺失或被遮蔽的插件的工作流会带着插件状态被拒绝，卸载后这些名称即为未知。从插件启动的运行会连同脚本副本记录来源（插件、版本、提交），`/workflow runs` 会显示：更新或停用不会影响正在进行的运行；暂停的运行只有在插件重新处于活动状态时才能恢复，且仍重放启动时的脚本（概览会注明当前安装的版本）；只有下一次启动才会读取更新后的插件。只在 Linux 上验证过；macOS 与 Windows 未验证。
`codsh --rust` 中的深度研究：`/deep-research <问题>` 在后台启动内置的 `deep-research` 工作流（`/workflow deep-research [--agent-budget N] <问题>` 和模型的 `source: { type: "name", name: "deep-research" }` 运行同一个脚本）。脚本就是参考实现的 `deep_research.rhai`，从 grok-build `a28ee2b`（Apache-2.0）逐字节复制到 `rust/upstream/workflows/`，其 SHA-256 记录在 `rust/upstream/import.json` 中，并编译进二进制；单元测试会用该摘要校验副本。它最多规划四个相互独立的问题，每个问题由一个只读研究代理使用 `web_search` 和 `web_fetch` 调查，候选结论交给两个独立的验证代理，它们必须打开每个引用的来源，最后把带引用的报告写入本次运行的 `scratch/report.md`。只有验证代理用自己的证据和来源支持的结论才会进入报告；失败的分支、研究代理的不确定项（缺少网页工具、搜索被限流或失败）、被否定或无法打开的来源、返回错误结论 ID 的验证代理，以及 `[Sn]` 引用校验不通过的报告正文，都会列在覆盖范围说明中，结果标记为 **Partial**（完成通知和 `/workflow runs` 中显示 `Result status: partial`；只有没有任何缺失时才是 `verified`）。停止、代理预算用尽或缺少问题时，运行分别以 `cancelled`、`budget_limited` 或 `blocked` 结束，不会产出报告。网页搜索与抓取使用已配置的替代服务（见下文的 `codsh --rust web search` 与 `web fetch`）；未配置时研究代理会如实说明，不会验证任何内容。不带问题的 `/deep-research` 会显示用法。内置工作流优先于项目、个人和插件工作流：同名文件会显示为被遮蔽（插件的同名工作流仍可用 `/<插件>:deep-research` 运行），`/workflow save` 会拒绝这个名称。没有打包（下载）的工作流作用域。该流程只用无密钥的模拟模型和本机回环上的假搜索与页面服务测试过；尚未用真实模型和在线网页搜索运行过。只在 Linux 上验证过；macOS 与 Windows 未验证。
`codsh --rust` 中的后台命令是 dsh 任务（job）。Ctrl+B 把正在前台运行的 shell 命令移到后台，当前轮次带着任务 id 继续。超过 `[toolset.bash] foreground_block_budget_ms`（默认 `15000`；`0` 表示等满整个超时）仍在运行的命令会自动移到后台；设置 `auto_background_on_timeout = false` 时命令留在前台，到超时后被终止。命令运行时执行立即发送（有排队行时在空输入框按 Enter，或 Ctrl+Enter）会把命令移到后台并运行你的这一行，命令不会被杀掉。Ctrl+C 仍会取消当前轮次并终止前台命令。模型也可以用 `run_in_background: true` 直接启动后台命令，并用 `job_output` 读取输出。状态栏在子代理旁边统计运行中的命令；模型用 `job_output` 的 `wait: true` 阻塞等待时会显示 `send a message to interrupt`，此时你发送任何消息都会结束这次等待，命令继续运行。`/tasks`（全屏下 Ctrl+G）列出命令及最新输出；`x` 停止选中的命令，模型会在下一步得知。命令结束时 dsh 会通知模型；空闲的会话会被唤醒，显示一个 `◎ Task completed` 轮次和随后的回答。dsh 允许在你没有发消息的情况下连续唤醒三次，之后的通知会随你的下一条消息送达模型。`/new`、切换会话和退出都会停止该会话的命令，不会留下运行中的进程。恢复的历史保留工具结果，并说明其中的命令已不在运行；它们不会被重新启动。纯文本 `-p` 和编辑器 ACP 保持 dsh 自带的前台 shell（不移动、不唤醒）。`codsh --rust inspect config` 显示解析后的 `backgroundCommands` 设置，无效值会给出警告并使用默认值。
`codsh --rust` 中的监控（monitor）同样是 dsh 任务。模型用一段脚本和一个描述调用 `monitor`（`timeout_ms` 默认且最多 10 小时；`persistent: true` 让它一直运行到被停止或会话结束）；脚本打印的每一行（stdout 与 stderr）都成为模型收到的事件，每 200 毫秒合并一批，并按参考实现限速（先 10 个事件，之后每 2 秒一个；持续刷屏 30 秒的脚本会被停止并结束进程）。空闲的会话会以 `◎ Monitor event · <描述>: <行>` 轮次被唤醒；dsh 的预算同样适用——在你没有发消息的情况下最多连续唤醒三次，之后的事件随你的下一条提示送达模型。模型工作时，若有工具调用正在运行，事件会加入它的下一步；在它撰写回答时到达的事件会先等待，并在该轮结束后合并为一次唤醒（按 Ctrl+C 后则等你的下一条消息），因此事件不会带来超出预算的模型请求。脚本退出时，会有一个 `◎ Task completed` 轮次报告一次。状态行统计正在运行的监控，`/tasks`（全屏下 Ctrl+G）列出它们的超时与事件数，`x` 可停止其中一个；模型会被告知是你停止的，且不要重新启动它。模型也可以用 `job_output` 读取监控输出、用 `job_kill` 停止它。`/new`、切换会话与退出都会停止该会话的监控。该工具只在交互式客户端中提供：子代理、纯 `-p`、编辑器 ACP 与共享服务器都不会获得它。
`codsh --rust` 中的定时提示由 dsh 运行。`/loop [间隔] <提示>`（例如 `/loop 30m check the deploy`）请模型调用 `scheduler_create`；模型从你的话里读出间隔（`s`、`m`、`h`、`d`，最短 60 秒），没有间隔时会先问你。只输入 `/loop` 会显示用法。每次触发都把保存的提示作为独立的默认类型后台子代理运行，沿用本会话的权限与审批，不会进入你的对话；它的最终状态只回报一次，并像完成的后台命令一样唤醒空闲会话（受 dsh 唤醒预算限制）。触发不会接着上一次触发的记录继续，而是带着上一次触发的最终状态重新开始。上一次触发仍在运行时本次跳过；每个会话最多 50 个循环；循环 7 天后过期。状态栏统计运行中的循环，Ctrl+G 或 `/tasks` 列出循环及下次触发时间、触发次数和最近状态；在循环行上按 `x` 删除它（已在运行的触发仍会回报）。模型也可以列出和删除循环，触发出的子代理不能再创建循环。循环随会话保存在 `$DSH_HOME/codsh-schedules/<会话>.json`（原子写入，仅所有者可读写）：退出、dsh 重启、崩溃或切换会话时循环停止，恢复该会话（`--continue`、`--resume`、`/resume`）时连同触发次数和最近状态一起回来。`durable: true` 会被接受并以同样方式保存；只有在没有会话所有者可供保存时才会被拒绝。停机期间错过的触发在恢复后只补触发一次，不论错过了多少个间隔；已超过 7 天有效期的循环会被直接移除，不再触发。进程结束时仍在运行的触发显示为 `outcome unknown`，绝不会重新运行；下一次触发会被告知上一次被中断，需先检查当前状态再重复任何外部操作。只有持有会话所有者锁的客户端才会保存和触发循环：同一会话的第二个客户端会被拒绝；客户端退出或失去锁的 dsh 会停止循环且不写文件，因此不会有两个进程触发同一个循环。触发不保证恰好一次（exactly-once）：被中断的触发报告为结果未知，而不是重试。删除只有在保存成功后才报告完成；到期却无法保存移除结果的 durable 循环保持暂停，而不会在以后重新出现。循环行显示 `saved`、`durable` 或 `not saved`（原因见详情）、`paused`、最近一次触发的结果，以及权限模式与创建时不同时的 `permissions changed`（触发按当前模式运行）。无法读取的循环文件保持原样，该会话中新建的循环不会被保存。`/loop` 需要子代理；使用 `--no-subagents` 时，已保存的循环显示为暂停（仍可删除），不会触发。普通 `-p`、编辑器 ACP（`x.ai/scheduled_task_*` 扩展标记为不支持）和共享服务器不提供调度器，也不会改动已保存的循环；分叉或回退（rewind）得到的新会话不带循环。
`codsh --rust` 中的 `/goal <目标> [--budget <token 数>]` 设定一个长期目标，dsh 以目标轮次（记录中显示为 `◎ Goal round N/M`）持续推进直到完成；`/goal status`、`pause`、`resume`、`clear` 用于查看和管理，新的 `/goal <目标>` 会替换当前目标。模型自称完成不算完成：每次完成声明都由独立的验证子代理检查（`GROK_GOAL_VERIFIER_N`，默认 3，范围 1-5；多数或平票通过），未通过时列出差距并保持目标继续进行；被拒绝的声明达到 `GROK_GOAL_CLASSIFIER_MAX` 次（默认 10）后目标停止，需 `/goal resume` 继续。验证无法运行时（例如子代理已关闭）目标会停止而不是放行。可选的 token 预算只统计目标进行期间该会话及其子代理的服务商 token，与工作流的代理数量限制互不相干；达到预算后目标以 budget-limited 停止（用 `/goal clear` 重新开始）。仍有后台命令在运行时完成声明会被拒绝；在目标轮次中按 Ctrl+C 会暂停目标；目标进行中你发送的消息会先得到回答。状态行显示阶段、轮次、token 与预算、验证进度和停止原因，状态在 `--resume` 后保留。`[goal] enabled = false` 或 `GROK_GOAL=0` 关闭目标模式。

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
隔离目录里的 `[ui] screen_mode`。`/dashboard`（别名 `/agents-dashboard`、`/sessions`）以及设置了 `GROK_OPEN_DASHBOARD_AT_STARTUP=1` 的 `codsh --rust dashboard` 在全屏打开代理仪表盘。它与 `/resume`、`sessions list` 显示同一会话 id、标题、活动和未读标记。`Ctrl+/` 过滤，`Ctrl+R` 重命名选中行，`Ctrl+T` 固定，`Ctrl+G` 在状态分组与目录分组之间切换。最小模式会拒绝仪表盘并提示运行 `/fullscreen`。`/resume` 打开会话选择器；输入先按标题过滤，再在 `Extended search results` 下匹配对话正文。选中后恢复该 dsh id，不会把上一会话的输出写进新会话。目录不匹配或写入锁已被占用时，仍留在当前会话并显示 `occupied`。同一目录里 dsh 以 already active 拒绝恢复时，不会关闭当前会话；打开的选择器或仪表盘会显示 `already active` 并保持打开。`/rename <title>`（别名 `/title <title>`）保存手动标题，自动生成不会覆盖它。`/rename --auto` 与单独的 `/title` 把标题交回已配置模型（`base_url`、模型 id 和凭证）。提示只发给该提供商，不会写入提示行、URL 或调试日志。缺少模型或凭证是错误，不会改用备用标题。`/new` 开始新的 dsh 会话，并保留已配置的提供商、模型、推理档位、权限和设置补丁。仪表盘派发同样如此。两者都不会静默改用另一个提供商。`/cd` 会为下一个会话重新加载受信任的工作区配置。`/clear` 只清空可见记录。`/session-info`（别名 `/info`）显示标题、id、目录、模型和活动。`/memory`（别名 `/mem`）浏览 `$GROK_HOME/memory` 下的本地笔记。全局笔记适用于所有项目。工作区笔记按 Git `origin` 的 `org/repo` 归属，因此同一仓库的克隆和工作树共用一个目录，其他项目不会混入。文件列表与生成的索引分开。Enter 只读预览，`/` 按名称和内容过滤，`y` 复制路径，连续按两次 `x` 删除会话笔记，`t` 只切换本会话的记忆开关且不改写 `config.toml`；笔记只会在会话的第一条提示时发送，若第一条提示已经发出，此时再打开 `t` 也无法影响本会话的任何提示，且 `/new` 会丢弃这个开关并重新按 `config.toml` 决定，不会带到下一个新会话。浏览器不能删除 `MEMORY.md`，无论它是人工笔记还是生成索引。弹窗会高亮选中的文件。宽度不足 80 列时隐藏预览，按 Enter 才阅读。`/remember [text]` 在确认后才追加到工作区 `MEMORY.md`；`n` 或 Esc 不会写入。没有文本时，下一行成为笔记。保存后会显示 `Memory saved to` 以及该 `MEMORY.md`。记忆默认关闭，直到 `[memory] enabled = true` 或 `GROK_MEMORY=1`。显式 `[memory] enabled = false` 即使设置了 `GROK_MEMORY=1` 也保持关闭；`/memory` 仍然打开，`t` 只为本次会话打开记忆且不改写 `config.toml`。`/new`、切换会话、`/fork` 和 `/rewind` 会丢掉这个开关，新会话重新按配置决定。`--no-memory` 与 `GROK_MEMORY=0` 会在本进程隐藏 `/memory`，但不会删除文件。新会话的第一回合会把全局和工作区 `MEMORY.md` 的有限摘录发给 dsh，不包含生成索引。该回合里的关键词还会带上匹配的会话日志。同一会话之后的回合不再重复这段内容。`/cd` 后再 `/new` 读取新目录的工作区，不会带上上一个项目的笔记。`codsh --rust memory clear`（默认 `--workspace`，也可 `--global` / `--all`）只在带上 `--yes` 后删除所选范围。工作区清除会删掉该范围的 `MEMORY.md`、`sessions/` 和 `index.sqlite`。全局清除只删掉全局 `MEMORY.md`。关闭记忆不会上传笔记。`index.sqlite` 是 SQLite FTS5 关键词索引。损坏的索引进程会报告并按笔记重建，并且不会覆盖笔记。不是该索引的 SQLite 文件会原样保留。开启记忆时，会话结束会把一份元数据摘要保存到 `sessions/`（至少 3 条输入的提示且合计 50 字节，最多 5 个主题，UTC 日期，不调用模型；`[memory.session] save_on_end`）。`/flush` 把本会话最近 20 条消息发给会话模型（或 `[compaction.memory_flush] flush_model`），并把返回的 markdown 追加到 `sessions/<日期>-user_requested-<id>.md`；空闲时的 flush 在对话有增长时每隔 `idle_timeout_secs`（300；0 表示关闭）做同样的事。`/dream` 把其他会话日志合并进工作区 `MEMORY.md`；自动 Dream 在启动时以及每隔 `[memory.dream] check_interval_secs` 检查一次，满足 `min_hours`（24）和 `min_sessions`（5）后在跨进程的 `.dream-mutex` 锁下运行。每次后台调用都会显示服务商/模型、发送的消息数与字符数以及服务商报告的 token 用量；费用不显示（服务商未报告）。已有的会话日志只追加、不覆盖；Dream 运行期间被编辑过的 `MEMORY.md` 会保留且不写入任何内容；旧的 `MEMORY.md` 和已整理的日志移到 `sessions/.archive/`。失败或取消的 Dream 不会关闭门槛。`/memory` 后按 `s` 显示不含内容的诊断信息（捕获游标、队列、最久待处理时间、门槛、租约、最近结果、归档数量），按 `y` 复制；查看诊断不会启动任何任务。`[memory_v2] enabled = true` 会被拒绝并关闭记忆捕获：该存储没有实现。`GROK_MEMORY_LOG=1`（或一个路径）把不含内容的事件行写到 `$GROK_HOME/logs/memory.log`；路径不可写时会报告。`--memory-flush` 在 `-p` 回合之后做一次 flush，没有写入日志就返回失败。压缩前的 flush 没有接入（压缩由 dsh 负责），语义去重需要本客户端没有的向量嵌入。向量嵌入没有实现。`/cd [path]` 只改变下一个新代理的目录，当前会话历史保持不动。路径不存在、按 Esc 或取消都会保留原目录。拿不到写入锁的第二个客户端会显示为占用，并且不会改动另一份历史。最小模式下的 `/dashboard` 等模式专用命令会
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
`codsh --rust` 的剪贴板、终端诊断、wrap 与通知（ticket 155）：所有复制（回滚区的 `y`/`⇧Y` 与鼠标复制、问题卡与计划卡、memory 路径、`/export` 到剪贴板，以及 `/copy [N] [path]`——复制倒数第 N 条回复的源 Markdown，或写入文件）都会尝试原生工具（macOS `pbcopy`；Linux Wayland 用 `wl-copy`、X11 用 `xclip`/`xsel`；Windows `clip.exe`）、tmux 内的 `tmux load-buffer -`，以及 OSC 52（Linux 总是发送；macOS/Windows 只在 tmux 内、SSH 下、无显示的容器中或 `codsh wrap` 之下发送；tmux 内同时发送普通形式和 DCS 透传形式），并且总会把备份写入 `$GROK_HOME/last-copy.txt`（`GROK_COPY_FILE` 可改位置，`~` 展开为真实主目录）。只有可信的一路成功时提示才说 `Copied!`：本机原生工具，或者中间没有复用器、且文档确认支持 OSC 52 的终端。只进了 tmux 缓冲区会如实说明；无人能确认的 OSC 52 写入标为 “unconfirmed” 并给出备份路径；没有任何可用路径时显示 “Clipboard unreachable” 和备份路径。SSH 下或无显示容器里的原生工具写的是远端剪贴板，从不算送达。`GROK_CLIPBOARD_NO_OSC52` 关闭 OSC 52 这一路。`codsh --rust doctor [--json]` 与 `/doctor`（别名 `/terminal-setup`、`/terminal-check`、`/terminal-info`）报告检测到的终端及识别它的变量、TERM/COLORTERM 与色深、复用器（以及用 `tmux show-options` 读到的 `set-clipboard`、`allow-passthrough`、`extended-keys`、`terminal-features`）、SSH、容器、显示服务、换行键、每一路剪贴板、备份路径、预期复制结果和通知设置，外加带 id 的发现项和本构建未验证的清单；发现项从不改变退出码。`doctor fix [<id>...] [--yes]`（或 `/doctor fix <id> --yes`）只会向你真实的 `~/.tmux.conf`（byobu 下为 `$BYOBU_CONFIG_DIR/.tmux.conf`，未设置时拒绝）追加 `terminal.tmux-clipboard`、`terminal.dcs-passthrough`、`terminal.tmux-extended-keys` 或 `terminal.tmux-truecolor` 对应的行：先打印计划，在 TTY 上询问或要求 `--yes`，保留 `.tmux.conf.codsh-backup-<时间>` 备份以及文件权限和换行风格，打印撤销命令，遇到冲突或条件式的已有赋值以及符号链接文件时拒绝，并且从不执行 `tmux source-file`（只显示该命令）。`terminal.ssh-wrap`、`terminal.newline-fallback`、`terminal.iterm2-clipboard-permission`、`terminal.wezterm-kitty`、`terminal.byobu-screen` 和 `clipboard.unreachable` 只是建议。`codsh --rust wrap <command> [args...]`（Unix；例如 `wrap ssh host`）在本地伪终端里用你的真实环境运行该命令，并加上 `GROK_OSC52_SINK=1` 与 `LC_GROK_OSC52_SINK=1`（`LC_` 形式能通过 OpenSSH 默认的 `SendEnv LC_*`），转发按键和窗口尺寸，把它发出的 OSC 52 写入（跨读取拆分或经 tmux 包装的也行，自动去重）通过同样的路径复制到本机剪贴板，拒绝 OSC 52 读剪贴板请求；命令退出或连接掉线时恢复它遗留的状态（备用屏幕、鼠标与焦点报告、括号粘贴、隐藏光标、应用光标键/小键盘、kitty 键盘、modifyOtherKeys、同步输出）以及外层 termios，然后以该命令的退出码退出（被信号杀死时为 128+信号）。未经 wrap 启动的 SSH 会话会显示一次提示，指向 `/doctor`；`[ui.contextual_hints] ssh_wrap = false` 可关闭。`[ui.notifications]` 支持 `method`（`auto`|`osc9`|`osc99`|`osc777`|`bel`|`none`；auto：iTerm2/WezTerm/Warp 用 OSC 9，Kitty 用 OSC 99，Ghostty/VTE/foot 用 OSC 777，Zellij 及其他用 BEL）、`condition`（默认 `unfocused`，还有 `always`、`never`）、`idle_threshold_secs`（3）、`events`（默认 `turn_complete` 与 `approval_required`；还支持 `agent_error`、`session_ready`）以及 `[[ui.notifications.hooks]]`（`command` 通过 `sh -c` 运行，带 `GROK_EVENT`、`GROK_MESSAGE`、`GROK_SESSION_ID`；`events`、`only_unfocused` 默认 true、`timeout_secs` 默认 10）。焦点来自终端的 DECSET 1004 报告；从不报告焦点的终端视为一直聚焦，所以默认保持安静。失焦通知要等终端失焦达到阈值才发出，期间焦点回来则取消；tmux 内会包装成透传序列。`sleep_prevention`、`progress_bar`、`title`、`session_recap*` 和 `task_complete` 尚未实现，会给出配置警告。`GROK_EXIT_TIMEOUT_SECS`（默认 20，`0` 关闭）在退出清理卡住时先恢复终端再强制退出，5 秒后仍未退出则硬退出。此处未验证：macOS `pbcopy`、Windows `clip.exe`、真实终端（iTerm2、Kitty、Ghostty、WezTerm、Alacritty、Apple Terminal、Windows Terminal、编辑器终端）是否接受 OSC 52 或显示 OSC 9/99/777、真实 tmux 服务器、经 wrap 的真实 SSH，以及真实显示服务上的 wl-copy/xclip；测试在真实 PTY 上使用假工具、假 `tmux` 和假远端程序，从不改动用户的终端或 tmux 配置。
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

`codsh --rust` 中的图片：在你指定服务之前，图片生成与编辑都是关闭的。
`[models] image_gen` 指向一个带 `base_url` 与 `supports_image_generation = true`
的 `[model.<id>]` 表；同一表上的 `supports_image_edit = true`，或单独的
`[models] image_edit`，启用编辑。没有该标记的聊天模型不会被当作图片服务，
单模型默认值也不会把图片服务选成聊天模型；官方主机（`api.x.ai`、`grok.com`）
作为配置错误被拒绝。`protocol` 选择线路格式：`xai`（默认）是参考实现的 JSON
请求体（`prompt`、`aspect_ratio`、`resolution`、data URL 参考图、`b64_json`
回复），`openai` 是 OpenAI Images 形态（`size` 取自 `image_size`，编辑用
multipart `image[]`），本地 stable-diffusion.cpp 的 `sd-server` 使用这种格式。
`env_key` / `api_key` 可选，无密钥的本地服务也能用；写了 `env_key` 但变量为空
是错误。`timeout_secs` 默认 300。

```toml
[models]
image_gen = "sd-local"

[model.sd-local]
base_url = "http://127.0.0.1:1234/v1"
protocol = "openai"
supports_image_generation = true
supports_image_edit = true
image_size = 512
```

配置了服务后，模型会得到 `image_gen`（提示词，可选 `aspect_ratio`）与
`image_edit`（提示词，一到五个 `image` 参考图：同一条消息里的 `[Image #N]` 标签、
绝对路径、`file://` URL 或 `data:image/...` URL）。`/imagine <描述>` 让模型把你
的原话不加改写地交给 `image_gen`。每次图片请求都走 dsh 工具审批：卡片显示
`Allow Generate image "<提示词>" via <主机>?`（或 `Edit image (N refs)`），并
说明会发送什么，以及 codsh 不知道该服务的价格、费用由该服务决定。Read 拒绝规则
同样会拒绝参考图路径。`GROK_IMAGE_GEN=0` / `GROK_IMAGE_EDIT=0`（或
`features.image_gen = false`）关闭对应工具，`GROK_IMAGE_GEN_MODEL_OVERRIDE` /
`GROK_IMAGE_EDIT_MODEL_OVERRIDE` 更换请求里的模型，
`tools.media_gen.max_parallel_image_gen_calls`（默认 4）限制一步里的调用数，
超出的调用带原因失败。运行中的行显示已用时间；Ctrl+C 取消请求，不保存任何
文件。结果会先校验（确实是 png/jpeg/webp/gif 字节），再原子地保存为
`<会话>/images/<n>.<扩展名>`（目录权限 0700，不覆盖已有文件）；服务拒绝、返回
URL 而不是图片数据、字节损坏、HTTP 错误或超时都不保存文件，并显示原因。
`/images` 列出本会话的图片，`/images open [N]` 打开其中一张（不带 N 时为最新
一张），使用 `CODSH_IMAGE_OPENER`，否则 macOS 用 `open`、其他系统用 `xdg-open`。
`--resume` 之后这些行保留标题，`/imagine` 按输入原样显示，`/images` 仍能列出并
打开同样的文件。`codsh --rust image generate|edit|list`（`--json`）在会话外使用
同一服务，`codsh --rust inspect` 显示解析出的服务以及被拒绝的原因。编辑器 ACP
服务（`codsh --rust agent stdio`）不提供图片工具。测试使用回环假服务；`openai`
格式另外在本机用真实的 stable-diffusion.cpp `sd-server`（SD-Turbo 模型）验证过。

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
来源和许可。安装需要 `--trust`，仍不会授予执行权限。`plugin enable|disable`
（或在 `/plugins` 中按空格）会通过与你自己文件相同的发现和 Hook 执行器，加入或撤回
已安装且已信任插件的贡献：`rules/*.md` 排在全局规则之后、项目规则之前；Skills 与
命令以 `/插件名:名称` 调用（若没有原生、内置或其他插件占用，也可用裸 `/名称`）；
`agents/*.md` 成为 `插件名:agent` 类型；`workflows/*.rhai` 以 `/插件名:名称` 加入已保存工作流目录（见已保存的工作流）；`hooks/hooks.json`（或清单中的 `hooks`
路径/表）里的命令 Hook 按常规 Hook 约定运行，并带有 `GROK_PLUGIN_ROOT` 与
`GROK_PLUGIN_DATA`。`.grok/plugins/` 下的项目插件还需要工作区信任。启用插件从不
授予工具权限：工具调用仍遵循权限模式与规则。运行中的会话会在下一次提示时生效
（若 Hook 或 agent 变化，dsh 会在同一会话上重启）；更新、停用和卸载会撤回旧内容。
`plugin list --json`、`inspect` 与 `/plugins` 展开行会显示每个插件的 `state`
（`active`、`disabled`、`blocked`、`missing`、`shadowed`）、贡献与插件级问题；
单个损坏文件不会影响其他插件。
插件声明的 MCP 服务器（插件根目录的 `.mcp.json`，或清单中的 `mcpServers`：路径、路径列表
或内联表）经由与你自己的服务器相同的发现、计划、dsh MCP 客户端和审批门挂载到会话：仅在插件
处于 active 时生效，优先级低于所有其他来源（同名的用户、项目或导入服务器胜出；插件之间按
名称先到先得）；相对的 `command`/`cwd` 在插件目录内解析（越出插件目录则该服务器无效）；
进程环境与 `${...}` 展开中提供 `GROK_PLUGIN_ROOT`/`GROK_PLUGIN_DATA`（以及 `CLAUDE_PLUGIN_*`
别名）。`mcp list` 与 `/mcps` 以 `plugin: <名称>` 标注来源，`mcp enable|disable` 认得这些
名称；`plugin list --json`（`contributions.mcpServers`）与 `/plugins` 展开行给出每个服务器
的状态（`ready`、缺少程序时的 `failed`、`shadowed`、`invalid`、`disabled` 或插件自身状态；
TUI 中还会显示实时的 `connected (N tools)` 或“下一次提示时撤回”）。安装或启用插件不授予任何
工具权限：除非规则或已记住的批准覆盖，每次调用都会询问。停用、更新、卸载插件，或服务器名称被
其他插件接管时，会忘记该服务器已记住的批准（拒绝保留）；运行中的 TUI 或编辑器会话会在下一次
提示前于新的 dsh 中恢复，旧工具随之消失；更新会挂载新的定义。
Ship 是 `codsh --rust` 的可选一方插件，不属于默认界面。
`codsh --rust plugin install bundled:ship --trust` 从安装包复制它（`bundled:<名称>`
只读取启动器自带的 `extensions/` 目录）；安装后仍是停用状态，`plugin enable ship`
才会启用；`plugin disable ship` 或 `uninstall ship` 会再次移除 `/ship`。未安装或未启用时
没有 `/ship` 命令、没有 Ship Hook，也不会产生任何 Ship 状态。启用后，`/ship <想法>`
（或 `/ship:ship`）经 dsh 发送旧版首轮约定，并由 dsh 执行全部 agent 跑完旧版完整流程：
预检、wayfinder、grill、to-spec 与 tickets（两道闸门自动确认；闸门 1 封存 Mission
Contract）、在隔离 worktree 中并行落地并串行 `merge --no-ff`、按旧版校验处理合并冲突
（最多三次，之后记录 `## Blocker`）、独立的最终验证轮，以及合并回 `Original-Branch`。
Stop Hook 会用下一阶段续跑当前轮（连续最多 8 次）；裸 `/ship` 会从任意阶段恢复
`docs/specs` 中唯一未完成的 spec。它的 Hook 沿用旧版记录（`<spec>.ship.json` 保存封存的
原始需求，`<spec>.ship.answers.json` 保存每张已回答的问题卡，以及 Mission Contract 与
`.scratch/<slug>/issues`）和旧版保护（想法冲突、原始需求被改、多个未完成 spec、答案
文件损坏、封存的合约缺失或损坏）。被关闭或取消的问题卡不会留下记录；失败或被取消的
子 agent 从不被合并或勾选：其 worktree 会保留，下一次 `/ship` 会带提示重新派发该
ticket。运行状态丢失时会从文件重建。Alignment Gate 与漂移扫描尚未移植，详见
`packages/cli/extensions/ship/README.md`。
`/ship` 会打印一行，例如 `Ship graph · docs/specs/x.md · Status: wayfinding ·
待认领 1 · 已认领 1 · 已关闭 2 · 2 of 4 decision answers recorded ·
http://127.0.0.1:<端口>/<令牌>/`，之后只在内容变化时再打印；该 URL 打开的是与旧版
`/ship` 相同的实时 Web 全景图，每次轮询都从同一批文件重新汇总，因此浏览器与终端显示
相同的 Status、分桶计数和问答。服务只监听 `127.0.0.1`，只响应这条随机路径，不读取
页面之外的内容；会话结束、dsh 退出或卸载插件时停止；恢复会话（`--continue`、
`--resume`）会重新打开同一 URL，已打开的页面自动重连。`/ship` 不会自动打开浏览器。
该插件不增加快捷键、不覆盖内置命令，也不使用 Goal 或 Rhai。旧版 `codsh` 的 `/ship`
保持不变。
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
和 Grok 设置文件，不会自行迁移旧会话（见下文 `codsh --rust import sessions`）。已配置的 `env_key`（例如 `XAI_API_KEY`
以及其他 `*_API_KEY`）会传给 dsh；不会自动导入 `~/.dsh` 或 `~/.grok` 中的凭据文件。
显式、可逆的复制请使用 `codsh --rust import`。如果预览 Home/Profile 是符号链接，
或与 `DSH_HOME`/`GROK_HOME` 重叠（包括大小写不敏感文件系统上的大小写别名），
会在写入前拒绝启动。重叠检查比较目录及其祖先的设备号/inode 身份，包括
尚不存在路径的已有祖先，避免 macOS firmlink 别名通过不同 realpath 字符串绕过。
通过这些别名访问的独立 Home 仍受支持；无法取得目录身份时会在写入前拒绝。
如果任一 Home 尚不存在，仅大小写不同的潜在重叠会在
所有平台保守拒绝，不会通过创建路径来探测文件系统规则。

旧会话只在明确要求时复制。`codsh --rust import sessions` 列出旧客户端的会话
（来自 `$DSH_HOME`，默认 `~/.dsh`），并说明副本会保留和丢失什么；
`import sessions <id>...`（或 `--all`）只预览，加 `--apply` 才复制。旧 dsh Home
以只读方式打开，不写入、不加锁、不迁移，所以普通 `codsh` 仍能恢复原来字节不变的
会话，回到旧程序也不需要它理解新格式。每个副本都是 `~/.codsh-rust/dsh` 下的新会话、
使用新 id（用 `codsh --rust --resume <id>` 恢复）；新旧程序从不写同一个会话，也没有
实时同步，在任一边继续的工作只留在那一边。消息、工具调用与结果、标题、图片和文件附件
（按内容地址复制）以及子代理会话都会带过来；副本内的会话 id 会改成副本的 id，旧的
agent preset 会去掉（本客户端用自己的 agent 与工具继续）。本版本不读取的事件（旧客户端
标记为可跳过）、不显示的内容块、未完成的回合、缺失的附件或子代理日志都会明确报告，
不会隐藏；缺失数据默认阻止 `--apply`，需 `--allow-partial` 才复制其余部分。损坏的日志、
不支持的日志格式或未知的必需事件会被拒绝。每个副本写入后都会重读比对，通过后才算完成；
失败或中断的复制会被清除。来源信息（旧 Home、会话 id、日志文件、字节摘要、报告）保存在
`~/.codsh-rust/dsh/session-migrations/<副本 id>.json`，`/session-info` 会显示。
再次导入未变化的会话会指出已有副本；旧会话之后有变化则报告冲突，需 `--again` 才生成
新副本（旧副本保留）。
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

携带客户端的包照常用 `npm install -g @deepseek-ai/dsh codsh-cli` 安装（Node
22.19+，无需 Rust 工具链）。每个支持的平台在 `codsh-cli` 内有自己的预编译目录
（macOS 为 `darwin-arm64` 与 `darwin-x64`，Linux 为 `linux-x64`）；Apple 芯片上请
使用 arm64 版 Node.js，在 Rosetta 下运行的 x64 Node 会选用 Intel 版本。
`codsh --rust install-check`（脚本可加 `--json`）在不启动任何程序、不写入任何文件
的情况下检查安装：本平台客户端、其 SHA-256 与可执行文件 CPU、是否属于当前
`codsh-cli` 版本，以及将使用的 dsh 是否满足最低版本。客户端缺失、损坏、为其他
CPU 构建或是未完成更新的残留时，`codsh --rust` 拒绝启动并给出修复命令（`npm
install -g codsh-cli@<版本>`）；dsh 缺失或版本过低时同样拒绝（`npm install -g
@deepseek-ai/dsh`）；绝不改为启动旧版运行时或官方 Grok 运行时。更新用 `codsh
update` 或 `npm install -g codsh-cli@<版本>`，回退用 `npm install -g
codsh-cli@<旧版本>`。两种情况下 Rust Home `~/.codsh-rust`（会话、设置、凭据）都
保留，下一次 `codsh --rust` 会提示一次之前使用的版本，旧的 `~/.dsh`/`~/.grok` 不受
影响。用过 `codsh --rust` 的用户在 `codsh update` 后，如果新包无法在本机运行
Rust 客户端，会立即看到提示和回到原版本的命令。macOS 预编译产物须在 Mac 上构建
和检查；本仓库的安装包测试目前只在 Linux 上运行过。

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
