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

**`/ship`** 把一句话变成已验证的代码。面向 DeepSeek —— 以及任何 OpenAI 兼容端点 —— 的终端编码 agent。

一个 coding profile，加上一个自成空间的终端，跑在 [dsh](https://github.com/deepseek-ai/deepseek-harness) 上。不是 fork。给想用 DeepSeek（或自己的网关）而不是闭源 agent 的人。

想看看实际能做出什么？[逛逛展示画廊](https://blackman99.github.io/codsh/gallery.zh.html)，查看原始需求、真实截图并试玩作品。所有项目均从一句话需求开始，仅经一轮交互，所有问题均采用推荐答案完成落地。

[![/ship 流程](assets/ship-demo.zh.gif)](https://blackman99.github.io/codsh/zh.html)
<p align="center"><a href="assets/codsh-ship-demo.zh.mp4">中文口播版 · 70 秒</a></p>

## 安装

```sh
npm install -g @deepseek-ai/dsh codsh-cli
codsh
```

密钥：`DEEPSEEK_API_KEY`。已经有匹配的 dsh？`npm i -g codsh-cli` 就够。太旧的话启动器会直接给出安装命令。

`codsh --resume <id>` · `codsh --continue` · `codsh -p "任务"` · `codsh --version` · `codsh update`

## `/ship`

```sh
/ship 让超长 diff 用分页器打开而不是刷屏滚过
```

`/ship <一句话需求>` 把这个想法走到已验证的代码：

1. **前检** — 工作区有改动会问；切出 `ship/<slug>` 独立分支
2. **Wayfinder** — 明确目标，解决待决问题
3. **Grill** — 按设计树访谈，带推荐答案
4. **Spec（Gate 1）** — 用户故事、公开 seam、Out of Scope；原话单独保留
5. **Tickets（Gate 2）** — 带 DAG 的垂直切片和验收清单
6. **落地** — 并行 worktree 里做 TDD，再合并证明
7. **完成** — 验收通过且仓库无新增失败；合回原分支

你回答问题，同一次 `/ship` 继续往下走。`/goal` 保持解除武装。流程进行中，全景持续可用：TTY overlay（`Ctrl+G` 或点 teaser）、一行票据计数并把本地 Web 流程图 URL 贴在这一行；`/ship` 默认不打开浏览器。

通过验收并完成交付后，终端清理 ship 阶段、票据计数、计划、旧待办摘要和已结束子代理摘要。仍在运行的子代理继续显示；`Ctrl+T` / `Ctrl+H` 仍可打开保留的历史记录，Web 流程图保留最终结果。中断或受阻的流程保留进度，方便续跑。

访谈：↑/↓ 焦点 · 空格切换多选 · Enter 提交 · ←/→ 回看 · Esc 关掉本轮剩下的题。

工作区不干净、或已有无关 `/goal` 时会先问。裸 `/ship` 续跑未完成的工作。Ctrl-C 中断协调。

合并冲突自动交给 agent 处理，包括锁文件和修改/删除冲突。它保留双方意图，校验失败时最多尝试三次，成功后继续落地和验证。涉及已封存需求的冲突、或重试耗尽时，会保留恢复快照并说明具体阻塞原因。

[展示画廊](https://blackman99.github.io/codsh/gallery.zh.html) 收录原始的一句话需求、实际截图和可试玩的作品。流程用语见 [CONTEXT.md](CONTEXT.md)。

## 它怎么跑

`codsh` 找到你的 dsh，把 [`codsh-bundle`](https://www.npmjs.com/package/codsh-bundle) 注册进 `code` profile，然后启动 `dsh --profile code`。

有新版本时会话里会有一行提示。`codsh update` 在 shell 里升级，`/update` 在会话里升级，两条路都会把 profile runtime 一并升好。`CODSH_UPDATE_CHECK=off` 关掉自动检查。

不用启动器：

```sh
dsh plugin --profile code add codsh-bundle
dsh --profile code
```

任何 OpenAI 兼容端点都是一条 dsh 路由 —— 声明一次，然后 `/model`。

## 界面

[使用指南](https://blackman99.github.io/codsh/guide.zh.html#see) 收录了终端实机抓取。简要：

- 备用屏幕；输入框钉底；退出原样还回你的 shell。
- 刚提交的提问钉在顶部，回复从下方填入。右侧时间线跳转轮次（`Shift+←/→`，`/jump`）。`/rewind` 从某一轮分叉；原会话留在 `/resume`。
- 思考进行中和完成后默认都只占一行（`Ctrl+O` 或点击展开）。每次工具调用只占一行（`✔` / `✗`），成功时的点是淡色，连续行之间空一行，输出收在后面。
- 正在运行的进程内子代理是一个视图（`click to enter`；Esc 弹出）。`Ctrl+H` 列出本会话的子代理。
- `/view`、`/copy`、`/diff` —— 回答、代码块、未提交改动，同一个阅读器。
- `/` 命令、`$` skill、`!` shell、`@` 文件。`⇧Tab` 是 plan 模式。agent 工作时照样可以打字进队列（`Ctrl+Q`）；Ctrl-C 中断。
- `Ctrl+V` 粘贴图片。`/thinking`（别名 `/effort`）设置思考深度。状态栏显示上下文余量。在对话、输入框和底部 chrome 上拖选即可复制。人不在窗口时，等待决定会响铃并通知。
- 审批会点名这次调用；第三个答案把前缀记进 `.dsh/permissions.local.json`。

非 TTY 降级为行读取器：无组件、不绘制。

## 终端

| 等级 | 终端 | 含义 |
|---|---|---|
| 一等 | iTerm2、Terminal.app、VS Code 集成终端、tmux、Windows Terminal + WSL | 这里出回归就不能发版 |
| 二等 | Ghostty、kitty、Alacritty、Warp | 这里出回归是 bug，不阻塞发版 |
| 尽力支持 | 原生 Windows（pwsh） | 持久终端在那里不可用；其余功能应当可用 |

Kitty 键盘协议、焦点上报、OSC 11、内联图像：终端答应了就生效，不答应走传统路径。Ctrl+Enter 插话需要 kitty 协议；队列面板里的 `s` 不需要。

## 第三方端点

在 `$DSH_HOME/settings.yaml`（默认 `~/.dsh/settings.yaml`）里声明一次，然后用 `/model` 选中：

```yaml
llm-pi-ai:
  providers:
    acme-gateway:
      displayName: Acme Gateway
      apiKeyEnv: ACME_GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.acme.example/v1
      compat:
        thinkingFormat: deepseek      # 思考等级在线上的写法
        supportsDeveloperRole: false  # 系统提示用 system 而不是 developer 角色
        maxTokensField: max_tokens
      models:
        - id: acme-large
          contextWindow: 65536
          maxTokens: 4096
```

`/model acme-gateway/acme-large` 切换过去并保存为默认。密钥按请求解析，顺序是：指定的环境变量、`$DSH_HOME/.credentials.yaml`、`<cwd>/.env`、`$DSH_HOME/.env`。兼容开关和按模型的 `reasoningEfforts` 在 `@deepseek-ai/dsh-llm-pi-ai` 的 README 里。

## 开发

见 [CONTRIBUTING.md](CONTRIBUTING.md)。`pnpm run dev` · `pnpm test` · `pnpm run typecheck` · `pnpm run test:e2e`。本仓库绝不 fork harness（`pnpm run sync:dsh`）。

## 说话

Windows、别的模型、从 Claude Code 迁过来、渲染不对 —— 开 [issue](https://github.com/Blackman99/codsh/issues)。长一点的话题走 [Discussions](https://github.com/Blackman99/codsh/discussions)。

## 许可

MIT
