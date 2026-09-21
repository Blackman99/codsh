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
- `codsh --continue` — 继续上一次会话
- `codsh --resume <id>` — 恢复指定会话
- `codsh update` — 升级启动器与 profile runtime

## 隔离的 Rust 客户端（本地候选包）

`codsh --rust` 显式选择并行开发的 Rust 客户端；直接运行 `codsh` 仍使用旧版。
Rust 界面通过 ACP/JSON-RPC 把提示提交给隔离 Home 中真实的 `dsh --profile acp`。
流式回答、提供商给出的思考、空回答和失败都按 dsh 的实际结果显示；协议不匹配
或找不到 dsh 会明确拒绝，不会伪造成功。它复用具有合法许可证的 Grok Rust
界面组件，无需官方账号，不启动旧版 Bundle、官方 Agent 核心、更新检查、遥测
或反馈上传。已连接时按 Enter 会把草稿交给 dsh；未连接时明确提示执行不可用，
不发送草稿。文件读取、写入和编辑走真实 dsh 工具。界面显示将执行的操作及
dsh 给出的差异，`y` 允许该次调用，`n` 拒绝且不写入。文件不存在、工具错误、
取消或重复的审批回复都显示为失败，不会伪造成功。`Ctrl+C` 在有草稿时只清空草稿、
不取消正在执行的回合；草稿为空时通过 dsh `session/cancel` 取消当前回合。Esc
从不取消回合或待审批请求，只取消选中并提示改用 `Ctrl+C`。被取消的工具不会因迟到的
允许或进程退出再次执行；未知的外部结果显示为已取消，而不是成功。取消后可以继续
提交新回合。尚未有任何回合时，空草稿上的 `Ctrl+C` 仍会退出。
`codsh --rust --continue` 会恢复此目录上次的 dsh 会话；`--resume <id>` 加载
指定会话。`--fork-session` 配合 `--resume`/`--continue` 会把该对话复制到新的
dsh 会话 id。`/rewind` 与 `/undo`（或空闲时空草稿上的 Esc Esc）通过 dsh 分叉
仅对话历史；`/fork` 复制当前历史。磁盘文件不会被回滚；`--restore-code` 会被拒绝。
界面从 dsh 日志恢复已持久化的回合（不是第二套会话库）。中断或
未完成的工具显示为 `[interrupted]` / unknown，并且不会自动重放副作用。
第二个客户端若不能取得写入权会被明确拒绝，而不会再开一个执行核心。
默认 fullscreen 使用备用屏幕。`/minimal`（或 `--minimal`）按官方内联渲染
把已提交内容写入终端原生历史；`/fullscreen`（别名 `/full`）切回全屏。
切换在同一进程内完成，正在执行的 dsh 回合、草稿和待审批都会保留。
`--minimal` / `--fullscreen` 与 `GROK_SCREEN_MODE` 只作用于当前会话，不会改写
隔离目录里的 `[ui] screen_mode`。最小模式下的 `/dashboard` 等模式专用命令会
拒绝并提示改用 `/fullscreen`。`GROK_SCREEN_MODE_SWITCH=exec` 会按同一会话
重新启动，而不是原地切换，也不会保留未保存的草稿。

预览的用户配置是 `$GROK_HOME/config.toml`（默认
`~/.codsh-rust/.grok/config.toml`）。`[ui] confirm_before_rewind` 与
`ui.fork_secondary_model` 也写在这份文件里。兼容的 `[model.<id>]` 字段
（`base_url`、`env_key`、`api_key`、`model`、`name`、`api_backend`、
`supports_reasoning_effort`、`reasoning_efforts`、`reasoning_effort`、
`context_window`）以及 `models.default` / `models.default_reasoning_effort`
会映射到隔离的 dsh `settings.yaml`，两份文件不会互相覆盖。支持的后端是
Grok 的 `chat_completions`、`responses`、`messages`（对应 dsh 的
`openai-completions`、`openai-responses`、`anthropic-messages`）。同名模型
在不同后端上是两条目录项，不是同等能力。`/model`（别名 `/m`）与 `/effort`，
以及 `--model`、`--effort` / `--reasoning-effort`，只选择已公布的选项。
不支持的后端或推理等级会明确拒绝或显示不可用，不会静默切换提供商。运行中
变更作用于下一回合，并写入 `$GROK_HOME/model-selection.toml`。用量、费用和
上下文限制在提供商或显式 `context_window` 给出之前保持未知，不会伪造为零。
dsh 的上下文占用显示为 `occupancy=N (dsh estimate)`，不当作提供商用量。
`/context` 显示这些 dsh 事实以及可得的 system/tools/messages 启发式分类；缺失值保持未知，不会显示为 0。`/model` 切换后使用该模型公布的 `context_window`。`/compact [指示]` 由 dsh 执行压缩（进度、摘要、失败与取消），不另造一套历史；可选指示只进入 summarizer 请求（`purpose=compaction`），并记录目的地提供商/模型。自动压缩把 `session.auto_compact_threshold_percent` / `GROK_AUTO_COMPACT_THRESHOLD_PERCENT` 映射为 dsh `thresholdRatio` 以及兼容的 `retainRatio`（0–100 以外的值会被忽略；`0` 会关闭自动压缩，而不会写入会导致插件加载失败的非法比例）。`GROK_COMPACTION_WALL_CLOCK_SECS` 限制压缩耗时，`0` 关闭该预算。压缩后恢复会话会投影 dsh 检查点及保留的工具/待办；失败时原记录仍在日志中。
`codsh --rust inspect` 与 `inspect --json` 列出每项生效值及来源（命令行
`--model`/`--effort`、环境变量、`GROK_CONFIG` 覆盖层、工作区
`.grok/config.toml`、已保存选择、用户 `config.toml`、`managed_config.toml`、
锁定的 `requirements.toml`、默认值）。
无效的 `config.toml` 会保留原文，并报告路径和原因。被锁定的要求不能被后置的
命令行、环境、覆盖层、工作区或用户配置绕过。不认识的安全字段或无效策略会
诊断有效键、来源与限制，而不会被静默忽略。未信任工作区会先出现信任提示，
不会自动应用项目配置、Hooks、插件或项目说明；`--trust` / `--trust-folder [path]`
把授权写入 `$GROK_HOME/trusted_folders.toml`，`--revoke-trust` 撤回授权，只读
Home 会报告保存失败而不会假装授权已持久化。未信任的 Hooks、插件和项目能力
不会执行。首次运行缺少凭据时只给出
可操作提示：不打开 grok.com 登录，不访问默认官方遥测/上传，也不自动导入
`~/.dsh` 或 `~/.grok` 中的旧凭据。写好带 `base_url` 的提供商后，再设置对应的
`env_key`（例如 `XAI_API_KEY`）。首次运行时空回车会重新加载该文件，
提供商就绪后连接且不提交提示。父进程的 `GROK_HOME` 会被忽略；预览把
`GROK_HOME` 固定为 `~/.codsh-rust/.grok`。

预览使用 `~/.codsh-rust/dsh` 与 `rust` Profile，忽略继承的 `DSH_HOME`
和 Grok 设置文件，不迁移旧会话。已配置的 `env_key`（例如 `XAI_API_KEY`
以及其他 `*_API_KEY`）会传给 dsh；不会导入 `~/.dsh` 或 `~/.grok` 中的凭据文件。如果预览 Home/Profile 是符号链接，
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
`Ctrl+Q`/`Ctrl+D` 退出；`Ctrl+C` 清空
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
