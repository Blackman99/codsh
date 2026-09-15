<p align="center">
  <a href="https://blackman99.github.io/codsh/zh.html">
    <img src="assets/banner.svg" width="900"
         alt="codsh — 面向 DeepSeek 的终端编码 agent">
  </a>
</p>

<p align="center">
  <a href="https://blackman99.github.io/codsh/zh.html"><b>站点</b></a> ·
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

又一个 agent CLI。给已经在跑 [dsh](https://github.com/deepseek-ai/deepseek-harness) 的人，给想用 DeepSeek（或自己的网关）而不是闭源 agent 的人，给受不了默认 TUI 的人。不是 fork：一个 coding profile，加上一个自成空间的终端。

[![/ship 流程](assets/ship-demo.zh.gif)](https://blackman99.github.io/codsh/zh.html)
<p align="center"><a href="assets/codsh-ship-demo.zh.mp4">中文口播版 · 70 秒</a></p>

## 安装

```sh
npm install -g @deepseek-ai/dsh codsh-cli
codsh
```

密钥：`DEEPSEEK_API_KEY`。已经有 dsh？只要它够新，`npm i -g codsh-cli` 就够；太旧的话启动器会直接给出安装命令，而不是在缺导出时崩溃。

`codsh --resume <id>` · `codsh --continue` · `codsh -p "任务"` · `codsh --version` · `codsh update`

## `/ship`

`/ship <一句话需求>` —— 前检隔离、wayfinder、grill、两次自动确认闸门、Landing wave、双层 DoD。每次 HITL 回答后，同一次调用继续推进；`/goal` 保持解除武装。双环全景（overlay、teaser、Web）始终在场：

0. **前检与分支隔离** —— 检查工作区（有改动时弹出 `ship · preflight` 选择暂存/带走）；自动切出 `ship/<slug>` 独立特性分支，保护原分支不受污染。会话里已有无关 `/goal` 时，TTY 上仍会询问 occupancy（`ship · occupancy`）。
1. **Wayfinder** —— 在 grill 前明确目标并解决待决问题。每次运行都会绘制带名称的决策图及有依赖关系的决策票（已配置 tracker 时发到 tracker；否则用 `.scratch/<slug>/wayfinder/` 下的本地 Markdown）；内环为空也合法。这些是决策，不是实施任务。尚未完成时保持 `Status: wayfinding`。运行器在同一次调用里于每次 HITL 后继续，父会话每次最多被一张未阻塞的非研究类决策票叫醒。路线已经明确的小任务会记下确认的无图交接并自动进入 grill。该合同随 codsh 提供，无需另装 skill。
2. **Grill** —— 按 grill-me skill：先自己 recon，再按设计树访谈；每轮把当前未阻塞的 frontier 整批发问并给出推荐答案，`header` 为 `ship · grill`；←/→ 可回改本轮已答过的题；需要自填的选项聚焦后就是行内输入框。卡片把整道题换行显示，不再截成两行省略号。前沿清空并确认后才往下走。答完一轮后，同一次调用会注入下一轮。
3. **Spec (Gate 1)** —— 按 to-spec skill 自动合成（穷尽用户故事、公开 seam、Out of Scope）。`## Original Requirement` 单独保留用户原话，与精简的 Main Track 分开。运行器自动 Confirm，并在 transcript 里留下通知；中断仍会中止。密封后不再弹出 Edit 模态——矛盾写成 `## Blocker`。记录分支、基底 Commit、验收命令，并写一份 `.scratch/` 副本（配了 tracker 就发到 tracker）。
4. **Tickets 与基线 (Gate 2)** —— 按 to-tickets skill 切成带 DAG 的垂直切片，每张票有原子验收清单和 `.scratch/.../issues/` 文件，并注入发版合规任务。运行器同样自动 Confirm。先跑业务与仓库全局基线。
5. **落地** —— 按 tdd skill：先写并亲眼看到一条失败测试，再写最少绿码，再跑全套。Landing wave 把当前所有未阻塞、未认领的落地票派发到并行 worktree；父会话按 Ready-set（最低 `landing:N`）串行合并再证明。没有落地轮数熔断；未解决的 `## Blocker` 会停止自动推进，直到归档。级联重验只取消失败证明及其已关闭的 DAG 依赖票。仓库调查、研究、单票实施和独立审查交给全新上下文的 `subagent`（不是 fork 历史）。父会话保留提问、闸门和协调，并独立重跑最终验收。子代理最多回 20 行，并给出证据/日志路径。运行器派发的进程内子代理是 Child view Fold，不是伪造的 `subagent` 卡片。`/ship` 不调用 Ralph；该工具保留供流程之外显式请求使用。Esc 会中断协调，包括尚未完成的 ticket。
6. **完成 (双层 DoD)** —— 验收命令实跑 Exit Code 0 且仓库全局零新增报错；交付自动选择 Merge back（能快进就快进，否则 squash）。覆盖链是原始需求 → Track-N → 验收 → ticket → 证据；绿测试不能掩盖漏掉的需求或越界改动。

每轮访谈中，↑/↓ 移动焦点；多选题用空格切换 `[x]` 勾选，Enter 提交（未勾选时，Enter 选中当前焦点项）。← 返回上一题，→ 回到下一道已访问的题，之前的选择和已提交的自填答案会恢复。编辑文字时，←/→ 优先移动光标，到达文本边界后才切换题目。切换选项会保留自填草稿。本轮结束时，每道已答题只输出一次最新提交的答案。Esc 关闭本轮剩余问题，不中止 `/ship`；尚未提交的题返回空答案。焦点选项的说明会完整显示，关闭颜色后仍可通过 `❯` 看出焦点。

grill、wayfinder、occupancy 或 preflight HITL 之后，同一次 `/ship` 调用会再次注入——不必再敲一遍 `/ship`。双环全景始终在场：钉住的 TTY overlay（Ctrl+G 或点击 teaser）、计划行上方一行 teaser `待认领 n · 已认领 n · 已关闭 n`，以及打印 URL 的回环 Web panorama。`/goal` 保持解除武装。

每次 `/ship` 只注入一份合同（wayfinder / grill / to-spec / to-tickets / TDD），避免后面阶段把正在执行的合同挤掉。运行时为阶段、goal、界面和完成绑定一份 spec。多份未完成 spec 会弹出选择器；管道里拒绝猜测。状态栏从 `ship · wayfinder` 开始，与计划行一起跟随这份绑定 spec（落地芯片是 closed/total）。spec 的 `## Wayfinder` 保存决策图链接，供 grill 和规格合成读取。已有 `interviewing`、`confirmed`、`planned`、`landing` spec 保持原阶段含义，恢复时不重跑 wayfinder。裸 `/ship` 续跑未完成工作，且不会把原始需求抹空；恢复实施任务时先级联重验。

Gate 1 Confirm 会封存 Main Track 和验收标准。运行器在相邻的 `<spec>.ship.json`（例如 `widget.md` → `widget.ship.json`）里持久化原始需求，以及确认时已有的封存 Main Track 和验收标准；这份文件由运行器管理，模型不得改、删或重生成。将它原样随 spec 提交，以便重新检出代码后仍保留措辞比较基线。后续阶段和续跑在阶段边界核对该快照；不匹配或损坏就停下，而不是接受改写。第一份快照无法核对其之前的历史，因此这是有限保护，不是防篡改沙箱。plan 模式不写快照。与这份措辞快照分开，Confirm 还会编译一份由 runner 持有的密封 Mission Contract（`.scratch/<slug>/mission.contract.json`）：REQ / NEG / ACC 编号、不可变 Main Track 的写入保护、Alignment Gate / Drift Detector / Verifier，以及后续轮次前置的合同摘要，落地阶段不能改写设计。密封后，受保护内容的写入会在执行前拒绝；外部改写 Main Track 会停止运行并保留磁盘现场供检查，不自动恢复后继续。最终交付还必须具有已记录的验收证据。落地阶段 HITL 前置 in-flight / Ready-set，而不是一张 Active Ticket。goal 仍可选；裸 `/ship` 仍保留原始措辞。守卫是身份、快照、阶段检查，加上审查和实跑证明——不保证语义零漂移。若会话里已有无关的 `/goal`，`/ship` 会先暂停它并弹出 `ship · occupancy`（Replace / Abort）；管道里自动 Replace。运行期间 `/goal` 显示带 `[ship]` 标记的指南针并保持解除武装——运行器可以自动续跑；通用 goal-round 不能与当前阶段打架。Chrome 仍是 MetaBar 芯片、计划行和 panorama teaser；没有 GoalBar。

```sh
/ship 让超长 diff 用分页器打开而不是刷屏滚过
```

## 它怎么跑

`codsh` 是零依赖启动器。它找到你的 dsh，把 [`codsh-bundle`](https://www.npmjs.com/package/codsh-bundle) 注册进专用的 `code` profile，然后启动 `dsh --profile code`。找到的 dsh 必须达到本版本的 harness 下限；更旧的版本会在启动时被拒绝，而不是缺导出崩溃。

有新版本时会话里会有一行提示。`codsh update` 在 shell 里升级，`/update` 在会话里升级，
两条路都会把 code profile 里的配套 runtime 一并升好——只有裸 `npm install -g codsh-cli` 落下的 runtime 才由下次启动补注册。
`CODSH_UPDATE_CHECK=off` 关掉自动检查；主动问依然会问。

不用启动器：

```sh
dsh plugin --profile code add codsh-bundle
dsh --profile code
```

任何 OpenAI 兼容端点都是一条 dsh 路由 —— 声明一次，然后 `/model`。见 [第三方端点](#第三方端点)。

## 界面

[站点](https://blackman99.github.io/codsh/zh.html)上每一屏都是实机抓取。一句话：

**读一段长会话**

- 刚提交的提问占住视口顶部，回复从下方填进空出来的位置。往回读历史再回来，回来的是同一帧——滚轮和 PgDn 都落得回去。
- 不管读到哪里，问出这段内容的那条提问会吸附在顶部；下一条提问再把它推走。
- 右侧一列时间线标出当前在第几轮——刻度和箭头可点击跳转，悬停预览真实的提问内容。Shift+←/→ 是键盘上的同一件事，`/jump` 则是可搜索、可撤回的预览。`/rewind` 从你选定的某一轮之前分叉出对话继续；原会话留在 `/resume` 里，Esc Esc 仍然找回上一条提问。
- 思考直接流进对话，停在它的计时行（`✻ thought for 3.2s`）下面保持展开，直到下一条提问把它折成这一行；每次工具调用只占一行——做了什么、`+n -m` 或 `· 12 lines`、`✔` 或 `✗`、失败时还带上原因——输出收在这一行后面。点一块开合一块，Ctrl+O 开合全部（有折着的就全部展开，都开着就全部折起）；手动开合过的块跨轮次保留那个形态。写完的回答始终整段留下。压缩——自动的，或 `/compact`——也留下一个折叠块：多少条历史、多少 token 变成了摘要、哪个模型写的，以及摘要本身；进行中 hint 行会显示 `compacting history…`。
- 正在运行的进程内子代理是一个视图：子会话一出现，卡片就会写 `click to enter`。点进去后子代理的 transcript 替换父级并实时流出；Esc 回退一层。这里不能打字——这是查看，不是跟进。Workflow/Ralph 的回合仍然只是一行：那些子会话跑在 worker 线程里，点进去只会打不开。
- 本会话发起的子代理常驻在输入框下方计数——`subagents 2 · 1 running · 1 done · Ctrl+H`。Ctrl+H 或点这一行打开列表：每个子代理的状态、用时、调用数和最近一次调用；Enter 或点击进入其中一个，状态行会写明是哪一个。跑完的子代理仍留在列表里，可以只读打开。`/subagents` 打印同一份列表。
- `/view 1` 把一条回答摊成整屏，`/view 1:1` 打开它的第一个代码块；Esc 原样还回会话。`/copy` 用的是同一套编号——原始 Markdown，或去掉围栏的代码。
- `/diff` 把未提交的改动送进同一个阅读器，而不是让它刷过去；装不下自己的 diff 卡片，点一下也在那里打开。管道里它依然只是若干行。

**干活**

- 备用屏幕；输入框钉底；退出原样还回你的 shell。
- todo 常驻 chrome（Ctrl+T / `/todos`）。Markdown、思考、工具卡片流式画出。回答里代替 Markdown 的内联 HTML 也会渲染：`<font color>` 和 `<span style>` 的颜色（ANSI 色名用终端自己的调色板，其余走真彩或最接近的调色板项）、`<b>`、`<i>`、`<u>`、`<s>`、`<code>`、`<br>` 和实体；不认识的标签原样保留。拖选即复制，对话和输入框都是。
- Ctrl+V 粘贴图片。光标停在 `[Image #N]` 上时，屏幕中央浮出一张预览卡：能画图的终端直接显示原图——Ghostty、kitty、WezTerm 走 Kitty graphics，iTerm2 走它自己的协议——其余终端显示彩色半块马赛克。Ctrl+O 或点一下卡片，用系统看图器打开原图。（原生视觉；DeepSeek 文本模型自动借用 Vision Exp；其他文本路由仍落盘并可选 sidecar。）
- `/` 命令、`$` skill、`!` shell、`@` 文件 —— 菜单在输入框上方。⇧Tab 是 plan 模式。
- agent 工作时照样可以打字，回车进入队列，输入框下方显示 `↳ queued: …`。排在一起的消息在回合结束时合并成一条发出，中间空一行；`!` 命令和 `/` 命令保持原来的顺序、单独执行。Ctrl+Q 或点击那一行打开队列面板：Enter 把一条拉回输入框编辑，`d` 删除，Shift+↑/↓ 调序，`s` 把它插进正在运行的回合。支持 kitty 键盘协议的终端上 Ctrl+Enter 直接从输入框插话，送达前显示为 `↳ steering:`。Esc 一律中断，队列保留并作为下一条消息发出。↑ 仍然逐条回溯。
- `/ui compact|comfortable` 决定对话占多少地方。compact 是默认，上面描述的也都是它的形状；comfortable 只是多给空间——轮次之间空一行、展开的 diff 更晚才切到分页器。这个选择会跨会话保存。
- 审批、`/model`、`/resume`、`/thinking`（或 `/effort`）用方向键；还有 `/clear`、Esc Esc、`/init`、`/update`。`!cmd` 打在会话里，agent 看得到输出。
- `/thinking [level]`（别名 `/effort`）配置模型思考深度（如 `off`、`low`、`high`、`max`，或快捷指令 `on`/`off`），支持 TTY 交互式选择、按模型独立持久化，并在状态栏 MetaBar（如 `deepseek-chat (high)`）及 `/status` 报告中常驻显示。
- 状态栏显示下一次请求预计使用的上下文量与窗口容量，例如 `context 32k/128k (75% left)`。正常使用及 `/resume` 后都保持显示，剩余 25% 时警告，10% 时变红。未知数据用 `?` 表示，两项数据都未获得时不显示。窄终端优先省略目录、保留上下文，必要时缩为剩余百分比。`/status` 提供完整的 token 分类统计。
- 人不在窗口时，等待决定或一轮超过十秒结束会响铃并发桌面通知：iTerm2、WezTerm、Ghostty、kitty、Windows Terminal 走 OSC 9，Terminal.app 走 `osascript`，其它 Linux 终端再加 `notify-send`；窗口有焦点时什么都不发。`bell` 和 `notify` 是两个开关。
- 审批会点名这次调用——`Allow bash: git push origin main?`——第三个答案把它记下来：`bash(git push *)` 写进 `.dsh/permissions.local.json`（个人文件，请加入 gitignore），同一前缀在这个项目里不再询问。`.dsh/permissions.json`（可提交）和 `~/.dsh/permissions.json` 手写，形如 `{ "allow": ["tool", "tool(prefix *)", "tool(exact command)"] }`；复合命令——`&&`、`;`、`|`、换行——永远不匹配前缀。

非 TTY 降级为行读取器：无组件、不绘制。

## 终端

三个等级决定一次发版不能破坏什么：

| 等级 | 终端 | 含义 |
|---|---|---|
| 一等 | iTerm2、Terminal.app、VS Code 集成终端、tmux、Windows Terminal + WSL | 这里出回归就不能发版 |
| 二等 | Ghostty、kitty、Alacritty、Warp | 这里出回归是 bug，不阻塞发版 |
| 尽力支持 | 原生 Windows（pwsh） | 持久终端在那里不可用；其余功能应当可用 |

协议是渐进使用的：kitty 键盘协议、焦点上报、OSC 11 主题探测都会发出请求，终端答应了就生效；不答应的终端走传统路径——Ctrl+Enter 插话需要 kitty 协议，其它终端用队列面板里的 `s` 做同一件事。开着软件流控的终端会悄悄吞掉 Ctrl+Q，那时点击 `↳ queued:` 那一行也能打开面板。内联图像也照这个办法选，而且看的是终端真正实现了什么、而不是它是谁——Ghostty、kitty、WezTerm 走 Kitty graphics，iTerm2 走 `OSC 1337`，其余终端用半块马赛克；tmux 和 screen 两种都不转发，所以在它们里面不发图。

## 第三方端点

任何 OpenAI 兼容端点都是一条 dsh 路由。在 `$DSH_HOME/settings.yaml`（默认 `~/.dsh/settings.yaml`，热加载）里声明一次，然后用 `/model` 选中：

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

`/model acme-gateway/acme-large` 切换过去并保存为默认；`/status` 会显示当前路由。密钥按请求解析，顺序是：指定的环境变量、`$DSH_HOME/.credentials.yaml`、`<cwd>/.env`、`$DSH_HOME/.env`。网关拒绝请求形状时看 `compat`：完整的开关表、按模型的 `reasoningEfforts`（含 `false`，表示这个模型永远不收思考字段）以及修正单个目录模型的 `modelOverrides`，都在 `@deepseek-ai/dsh-llm-pi-ai` 的 README 里。

## 开发

```sh
pnpm install
pnpm run dev                 # build → .dev-home → 启动
MOCK=markdown pnpm run dev   # 无 key，对着 e2e mock
pnpm test
pnpm run typecheck
pnpm run test:e2e            # 打包、安装，驱动真实二进制
pnpm run site:screens        # 用真实二进制重拍站点上的终端截屏
```

`MOCK=<mode>` 用无 key 的 mock 模型启动：`write`（默认）、`bash`、`fail`（打印一行后以 3 退出的命令）、`heredoc`、
`slow`、`steer`（占住回合 3 秒并报告插话是否送达）、`tall`、`spec`、`markdown`、
`reasoning`、`reasoning-slow`（长到来得及中断的思考）、`reason-write`（思考、写文件、再思考、回答）、`echo`、`todo`、`questions`、`workflow`、`subagents`（两个后台子代理，其中一个失败）、
`context`（32k 输入用量、128k 窗口；`cli-mock-pro` 为 64k）、
`ship-wayfinder`（`/ship SMALL_WAYFINDER` 验证确认后进入 grill；`/ship PENDING_WAYFINDER` 留下可续跑的规划记录）、`ship-delegate`、`ship-landing`、`vision`，以及自动图像
描述背后的 `auto-vision`、`auto-vision-slow`、`auto-vision-fail`。`INSPECT=1`
只对 app 进程打开 Node inspector，断点因此不会把它前面的构建一起停住。

`CODSH_TRACE=<路径>` 把视口写出的每一个字节、以及当时的窗口尺寸,一并录进文件。
画面错乱是「本 surface 发出的字节」和「终端拿它做了什么」之间的分歧,而前一半事后
就找不回来了;把文件回放进任意终端模拟器,就能还原它画出的屏幕。不设该变量则不开启。

`pnpm run sync:dsh` 跟踪已发布的 `@deepseek-ai/dsh-*`。本仓库绝不 fork harness。

## 说话

Windows、别的模型、从 Claude Code 迁过来、渲染不对 —— 开 [issue](https://github.com/Blackman99/codsh/issues)。长一点的话题走 [Discussions](https://github.com/Blackman99/codsh/discussions)。改界面见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

MIT
