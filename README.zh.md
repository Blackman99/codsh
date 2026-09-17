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

[![/ship 流程](assets/ship-demo.zh.gif)](https://blackman99.github.io/codsh/zh.html)
<p align="center"><a href="assets/codsh-ship-demo.zh.mp4">中文口播版 · 70 秒</a></p>

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
