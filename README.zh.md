<p align="center">
  <a href="https://blackman99.github.io/codsh/zh.html">
    <img src="assets/banner.svg" width="900"
         alt="codsh — 一款汲取了当今主流 agent CLI 交互体验精髓的终端编码 agent，组合在 DeepSeek Harness 之上">
  </a>
</p>

<p align="center">
  <a href="https://blackman99.github.io/codsh/zh.html"><b>站点与展示</b></a> ·
  <a href="https://www.npmjs.com/package/codsh-cli">npm</a> ·
  <a href="README.md">English</a> | 中文
</p>

> npm 包名：[`codsh-cli`](https://www.npmjs.com/package/codsh-cli) · 命令：`codsh`

一款汲取了当今主流 agent CLI 交互体验精髓的终端编码 agent，组合在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件运行时之上。codsh 是架在你的 dsh 之上的两个小包：零依赖启动器（`codsh-cli`）和携带交互式 TTY 界面与编码 agent preset 的 dsh *bundle*（`codsh-bundle`）。其下的一切——agent 循环、工具、会话、沙箱、模型适配器——都是 npm 上已发布的 dsh 包，一台机器只装一份。

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
- **一句话需求落地——`/ship`**：输入 `/ship <一句话需求>`，agent 先调研你的仓库，再一次只问一个问题地把设计追问到不再变化，写出一份由你确认的 spec，给出一份由你批准的实施计划，然后自主落地——小任务在会话内完成，大任务走 fresh-agent Ralph 循环——直到 spec 的验收标准全部通过、测试变绿。
- **todo 状态常驻可见**：agent 写下 todo 清单后，一行常驻读数把它钉在状态行之上——进度、正在做的那一项，或者下一项该做什么——不会随那次写入一起滚走。Ctrl+T 展开为完整清单、再按收起；`/todos` 把同一份清单打印到 transcript；`--resume` 恢复时直接接上上次的清单。
- **接管键盘的输入框**：多行编辑（支持 kitty 键盘协议的终端——Ghostty、kitty、WezTerm、iTerm2、foot——可用 Shift-Enter，其余终端 Alt-Enter）、跨会话历史，命令、参数与 `@` 文件提及（全工作区模糊搜索）的补全随输入自动打开。
- **粘贴图片，哪怕模型只认文字**：Ctrl+V 直接读取系统剪贴板，图片以 `[Image #N]` 标记挂进输入框（退格一次整体删除）。当前路由支持图像时（在 `$DSH_HOME/settings.yaml` 里为模型声明 `inputModalities: [text, image]` 即可打开这扇门），图片经 dsh 的持久附件仓库作为一等内容块随消息发送；在默认的纯文本 DeepSeek 路由上，图片被存成 agent 可以用工具操作的文件，并且——当 `CODSH_VISION_BASE_URL` + `CODSH_VISION_MODEL`（可选 `CODSH_VISION_API_KEY`）指向任意 OpenAI 兼容的多模态端点（GLM-4V、Qwen-VL、本地 llava）时——一份逐字转写的详细描述会随同一条消息送达，替模型看见。
- **流式渲染**：Markdown 带代码高亮与表格排版，推理模型的思考在 `✻ thinking` 下暗色显示，工具调用按 presenter 驱动的卡片渲染（含 diff）。超过一屏的已完成块——思考、工具输出、长回答——在你继续往下走时折叠成头几行；点一下即单独展开那一块、在块内任意处再点一下即收起，Ctrl-O 则一次性开合全部。鼠标停在某个块上时，该块首行加下划线，输入框下方同时报出它是什么、有多少行、点下去是展开还是收起（`thinking · 42 lines · click to expand`）——点之前就知道会发生什么，块比屏幕还高时也知道自己正处在哪一段。`--resume` 恢复会话时，历史会以同样的折叠形态重放，昨天那段长输出今天依然能展开。每个段落左侧还有一道竖线标出边界——你自己的消息用粗线、工具块用细线、失败的调用变红，回答本身齐头不加标记；框选跨过竖线时复制出来的是正文，不带那道线。
- **决定用选择**：审批、提问、`/model` 与 `/resume` 都是方向键组件；Shift-Tab 切换 plan 模式并为框着色。
- **会话流**：`/clear` 原地开新会话，`/resume` 从带标题和时间的会话列表里选，连按两次 Escape 召回上一条消息编辑，`!cmd` 在你自己的 shell 里运行并把结果注入为模型可见上下文——不花回合。
- **固定 prompt**：`/init` 起草 `AGENTS.md`；`$DSH_HOME/commands/` 或 `<工作区>/.dsh/commands/` 下的 Markdown 文件即成为斜杠命令，支持 `$ARGUMENTS` 模板。
- 状态行（模型、preset、权限、token、剩余上下文、分支）、终端标题跟随、有决定等待时的铃声，以及面向脚本的 `--print` 模式。

非 TTY 环境（管道、脚本）下同一界面降级为行读取器：选择变为键入回答、组件变为列表、不绘制任何东西。

## 从一句话到落地

`/ship` 用恰好两次确认、再无其他看护，把一个想法从 0 推到 1：

1. **访谈**——agent 先通读你的仓库，再一次只问一个问题（用户、成功标准、范围、非目标、约束、边界情况），直到回答不再改变设计。随命令粘贴的 mockup 或截图就是需求材料。
2. **Spec（关口 1）**——商定的设计落成仓库里的一个文件（默认 `docs/specs/<slug>.md`，仓库有自己的惯例则从之）。每条验收标准都写明证明它的精确命令，`Status:` 行让文件可续跑；由你确认。
3. **计划（关口 2）**——里程碑、测试、以及证明它们的命令；由你批准。批准后计划以复选框形式**写进 spec 文件**，并在写任何代码之前先把证明命令跑一遍记录基线——本来就红的基线在这道关口暴露，而不是压在你的 diff 底下。
4. **落地**——此后全程自主，spec 文件就是工作记忆：每个里程碑开始前重读、变绿即打钩并提交一次。小计划在会话内按 todo 清单走实现→测试→修复→提交；大计划跑 fresh-agent Ralph 循环——有轮数上界，连续两轮无进展即停下汇报而不是空转。
5. **完成**——每条标准都以跑它自带的命令、读真实输出来验证（Ralph 循环返回后由会话亲自全部重跑），然后按"标准 → 命令 → 实际输出"逐条汇报。

```sh
/ship 让超长 diff 用分页器打开而不是刷屏滚过
```

不带参数运行会先提议续跑任何未完成的 spec——中断不丢任何东西——然后才问你那句话。中途改变的决定先写回 spec 文件，文件永远说明正在构建什么。

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

所有 dsh 包都是预发布版本（`0.1.0-rc.N`），而 caret 范围**是会**浮动的：`^0.1.0-rc.7` 能匹配到 `0.1.0-rc.8`。真正把本仓库钉住的是锁文件；没有锁文件的安装——用户装出来的 profile、以及 e2e 现搭的那个——都会解析到最新的 `rc`。所以务必让这些范围保持同步，而不要指望它们自己锁定：运行时与插件集来自不同 `rc` 时能正常加载，直到第一个签名变过的调用才炸。上游还会在不移动 `latest` tag 的情况下发布 `rc`，因此 `pnpm run sync:dsh` 读取的是**已发布**的最高版本，`pnpm update` 永远不是事实来源。

## 许可

MIT
