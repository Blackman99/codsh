# codsh

> npm 包名：[`codsh-cli`](https://www.npmjs.com/package/codsh-cli) · 命令：`codsh`

[English](README.md) | 中文

一款汲取了当今主流 agent CLI 交互体验精髓的终端编码 agent，组合在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件运行时之上。codsh 是一个 dsh *bundle*：它携带交互式 TTY 界面与编码 agent preset，其下的一切——agent 循环、工具、会话、沙箱、模型适配器——都是 npm 上已发布的 dsh 包。

## 安装

```sh
npm install -g @deepseek-ai/dsh codsh-cli   # 已有 dsh？只需：npm install -g codsh-cli
codsh
```

[`codsh-cli`](https://www.npmjs.com/package/codsh-cli) 是一个**零依赖启动器，只有几十 KB**——它从不捆绑 dsh 运行时，一台机器无论装多少工具都只有一份 dsh。启动器自动找到你的 dsh（`DSH_BIN`、可解析的 `@deepseek-ai/dsh`、或 PATH 上的 `dsh`），首次运行把 [`codsh-bundle`](https://www.npmjs.com/package/codsh-bundle) 运行时注册进 `$DSH_HOME`（默认 `~/.dsh`）下的 dsh `code` profile——自带的 `code-cli` agent preset 会在首次启动时自动安装——之后每次运行直接进入提示符。profile 安装走你的 pnpm store，运行时的包与机器上其他 dsh 内容共享。模型密钥从 `DEEPSEEK_API_KEY` 读取（环境变量或 `.env`）。

`codsh` 严格等价于 `dsh --profile code`——启动器只做一次性注册（升级启动器时会连带升级 bundle）。`codsh` 之后的参数直达应用：`codsh --resume <会话 id>`、`codsh --continue`、`codsh -p "一次性任务"`。

完全不想要启动器？它包装的那两行可以直接用，profile 名任取：

```sh
dsh plugin --profile code add codsh-bundle
dsh --profile code
```

## 你会得到什么

- **会话是自己的空间**：codsh 进入备用屏幕，你的 shell 滚回历史原封不动、退出即恢复。transcript 在会话自有的缓冲里滚动——鼠标滚轮、PgUp/PgDn、Shift+↑/↓——输入框钉在底部从不移动；向上翻阅时视口会标注离尾部多远，新输出继续累积而不把你拽回去。每一帧以同步更新原子绘制；退出时向 shell 留下两行摘要（会话 id、用量、`--resume` 命令）。
- **接管键盘的输入框**：多行编辑（Alt-Enter）、跨会话历史，命令、参数与 `@` 文件提及（全工作区模糊搜索）的补全随输入自动打开。
- **流式渲染**：Markdown 带代码高亮与表格排版，推理模型的思考在 `✻ thinking` 下暗色显示，工具调用按 presenter 驱动的卡片渲染（含 diff），Ctrl-O 完整重印最近被截断的输出。
- **决定用选择**：审批、提问、`/model` 与 `/resume` 都是方向键组件；Shift-Tab 切换 plan 模式并为框着色。
- **会话流**：`/clear` 原地开新会话，`/resume` 从带标题和时间的会话列表里选，连按两次 Escape 召回上一条消息编辑，`!cmd` 在你自己的 shell 里运行并把结果注入为模型可见上下文——不花回合。
- **固定 prompt**：`/init` 起草 `AGENTS.md`；`$DSH_HOME/commands/` 或 `<工作区>/.dsh/commands/` 下的 Markdown 文件即成为斜杠命令，支持 `$ARGUMENTS` 模板。
- 状态行（模型、preset、权限、token、剩余上下文、分支）、终端标题跟随、有决定等待时的铃声，以及面向脚本的 `--print` 模式。

非 TTY 环境（管道、脚本）下同一界面降级为行读取器：选择变为键入回答、组件变为列表、不绘制任何东西。

## 开发

```sh
pnpm install
pnpm run dev          # build → 同步进 .dev-home → 启动；秒级迭代
MOCK=markdown pnpm run dev    # 无 key，对着 e2e mock 模型
pnpm run build        # tsdown 运行时 bundle + tsc 声明文件，输出到 lib/
pnpm run typecheck
pnpm test             # 单测（纯函数模块：editor、markdown、transcript……）
pnpm run test:e2e     # 打包本仓库、注册进 dsh profile，然后经管道与真实 PTY
                      # 驱动 npm 安装的 dsh 可执行文件
```

`pnpm run dev` 在 `.dev-home` 维护一个仓库本地的 dsh home：首次运行对打包后的工作树做一次真实 profile 安装，之后每次只把新构建的 `lib/` 覆盖到 profile 里解包的本包上——改动秒级到达运行中的界面。`MOCK=<write|bash|slow|markdown|reasoning|echo|tall>` 换上 keyless e2e 模型、无 key 调 UI；参数透传（`pnpm run dev -- --resume <id>`）；`INSPECT=1` 在应用进程上打开 Node inspector（`chrome://inspect` 或 VS Code attach）。逻辑问题优先用管道形态单步——`printf 'task\n/exit\n' | MOCK=echo pnpm run dev`——那里没有 raw mode 和重绘区域的干扰；在 TTY 上调试不要用 `console.*` 打点（会撕裂受管理区域），改写文件日志。

e2e 测试的是发布产物：`npm pack` 的输出装进真实 profile，由 npm 上的 dsh launcher 启动，配 keyless mock 模型。那里通过的就是用户装到的。

### 对着 dsh 源码调试

日常里 dsh 是普通的 npm 依赖。需要单步进 harness 代码时，把 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) clone 到本仓库旁边并构建（`pnpm install && pnpm run build`），然后把要调试的包指向 checkout：

```jsonc
// package.json —— 调完删掉；npm 始终是默认
"pnpm": {
  "overrides": {
    "@deepseek-ai/dsh-agent-loop": "link:../deepseek-harness/packages/core/agent-loop"
  }
}
```

再执行 `pnpm install`。想进上游的改动以普通 PR 提交到 harness 仓库；本仓库绝不 fork 它。

### 跟随 dsh 发布版本

codsh 消费的是已发布的 `@deepseek-ai/dsh-*` npm 包，所以"与 dsh 同步"跟踪的是 harness 的**发布**，不是合并源码。三层机制让这件事全自动：

1. **发现**——[Renovate](renovate.json) 盯着 `@deepseek-ai/dsh-*`（及同步发布的 cordis 包）自动开依赖 PR；[夜间 sync 工作流](.github/workflows/sync-dsh.yml) 不依赖第三方服务也能做同样的事。
2. **升级**——`pnpm run sync:dsh` 把所有 `@deepseek-ai/dsh-*` 范围改写到最新发布版、刷新锁文件、写 changeset；`--check` 模式在存在新版本时以退出码 1 报告（夜间任务就靠它判断）。
3. **验证**——同一命令重新核对 `cordis.patch.yml`：每个被禁用/配置的插件 id 必须仍被已安装的 dsh bundle 声明，每个 insert 的包必须可解析；然后跑 typecheck/build/单测（加 `--e2e` 会真正启动打补丁后的 bundle），CI 在生成的 PR 上再全部跑一遍。

因为所有 dsh 包都是预发布版本（`0.1.0-rc.N`），普通 semver 范围**不会**跨版本浮动——同步命令才是事实来源，`pnpm update` 不是。

## 许可

MIT
