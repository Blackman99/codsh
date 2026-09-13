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

`/ship <一句话需求>` —— 前检隔离、先 grill、两次确认、自主 TDD、双层 DoD：

0. **前检与分支隔离** —— 检查工作区（有改动时弹出 `ship · preflight` 选择暂存/带走）；自动切出 `ship/<slug>` 独立特性分支，保护原分支不受污染。
1. **Grill** —— 按 grill-me skill：先自己 recon，再按设计树访谈；每轮把当前未阻塞的 frontier 整批发问并给出推荐答案，`header` 为 `ship · grill`；←/→ 可回改本轮已答过的题；需要自填的选项聚焦后就是行内输入框。卡片把整道题换行显示，不再截成两行省略号。前沿清空并确认后才往下走。
2. **Spec (Gate 1)** —— 按 to-spec skill 自动合成（穷尽用户故事、公开 seam、Out of Scope）。你确认。记录分支、基底 Commit、验收命令，并写一份 `.scratch/` 副本（配了 tracker 就发到 tracker）。
3. **Tickets 与基线 (Gate 2)** —— 按 to-tickets skill 切成带 DAG 的垂直切片，每张票有原子验收清单和 `.scratch/.../issues/` 文件，并注入发版合规任务。你批准。先跑业务与仓库全局基线。
4. **落地** —— 按 tdd skill：先写并亲眼看到一条失败测试，再写最少绿码，再跑全套；单 Ticket 3 轮修错熔断；续跑级联重验；每个变绿的 ticket 产生单次全绿提交。较大的计划以 fresh agent 的 Ralph 循环执行；一轮进行中，工作行显示这一轮及其最近一次调用（计划行已经钉在 chrome 里，不再叠一份进度），spec 里的勾选一变、计划行随即更新，轮次结束的那一行写明做了多少事——Esc 会中断整个循环，哪怕 ticket 还没做完。
5. **完成 (双层 DoD)** —— 验收命令实跑 Exit Code 0 且仓库全局零新增报错；弹出合流选择（`ship · deliver`：合并、提 PR、保留分支）。

每次 `/ship` 只注入一份合同（grill / to-spec / to-tickets / TDD），避免后面阶段把正在执行的合同挤掉。MetaBar 芯片和计划行跟着磁盘上的 Status 与勾选走。裸 `/ship` 会对已有进度级联重验后继续续跑未完成的 spec。

Gate 1 Confirm 会冻结 Main Track（一句话 idea、编号 Track-N 决策、Out of Scope），并编译一份由 runner 持有的密封 Mission Contract（`.scratch/<slug>/mission.contract.json`）；之后每一轮都前置这份快照和合同摘要，落地阶段不能改写设计。密封后若改写 Main Track 会写回磁盘恢复；落地阶段每次只注入当前未完成的 Active Ticket；Alignment Gate / Drift Detector / Verifier 继续把执行钉在密封合同上。若会话里已有无关的 `/goal`，`/ship` 会先暂停它并弹出 `ship · occupancy`（Replace / Abort）；管道里自动 Replace。运行期间 `/goal` 显示带 `[ship]` 标记的指南针。Chrome 不变：不加新行，也没有 GoalBar。

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
- 思考和长工具输出可折叠：点一块开一块，Ctrl+O 开合全部；手动开合的选择跨轮次保留。写完的回答始终整段留下。压缩——自动的，或 `/compact`——也留下一个折叠块：多少条历史、多少 token 变成了摘要、哪个模型写的，以及摘要本身；进行中 hint 行会显示 `compacting history…`。
- 正在运行的进程内子代理是一个视图：子会话一出现，卡片就会写 `click to enter`。点进去后子代理的 transcript 替换父级并实时流出；Esc 回退一层。这里不能打字——这是查看，不是跟进。Workflow/Ralph 的回合仍然只是一行：那些子会话跑在 worker 线程里，点进去只会打不开。
- `/view 1` 把一条回答摊成整屏，`/view 1:1` 打开它的第一个代码块；Esc 原样还回会话。`/copy` 用的是同一套编号——原始 Markdown，或去掉围栏的代码。
- `/diff` 把未提交的改动送进同一个阅读器，而不是让它刷过去；装不下自己的 diff 卡片，点一下也在那里打开。管道里它依然只是若干行。

**干活**

- 备用屏幕；输入框钉底；退出原样还回你的 shell。
- todo 常驻 chrome（Ctrl+T / `/todos`）。Markdown、思考、工具卡片流式画出。回答里代替 Markdown 的内联 HTML 也会渲染：`<font color>` 和 `<span style>` 的颜色（ANSI 色名用终端自己的调色板，其余走真彩或最接近的调色板项）、`<b>`、`<i>`、`<u>`、`<s>`、`<code>`、`<br>` 和实体；不认识的标签原样保留。拖选即复制，对话和输入框都是。
- Ctrl+V 粘贴图片。光标停在 `[Image #N]` 上时，屏幕中央浮出一张预览卡：能画图的终端直接显示原图——Ghostty、kitty、WezTerm 走 Kitty graphics，iTerm2 走它自己的协议——其余终端显示彩色半块马赛克。Ctrl+O 或点一下卡片，用系统看图器打开原图。（原生视觉；DeepSeek 文本模型自动借用 Vision Exp；其他文本路由仍落盘并可选 sidecar。）
- `/` 命令、`$` skill、`!` shell、`@` 文件 —— 菜单在输入框上方。⇧Tab 是 plan 模式。
- agent 工作时照样可以打字，回车进入队列，输入框下方显示 `↳ queued: …`。排在一起的消息在回合结束时合并成一条发出，中间空一行；`!` 命令和 `/` 命令保持原来的顺序、单独执行。Ctrl+Q 或点击那一行打开队列面板：Enter 把一条拉回输入框编辑，`d` 删除，Shift+↑/↓ 调序，`s` 把它插进正在运行的回合。支持 kitty 键盘协议的终端上 Ctrl+Enter 直接从输入框插话，送达前显示为 `↳ steering:`。Esc 一律中断，队列保留并作为下一条消息发出。↑ 仍然逐条回溯。
- `/ui compact|comfortable` 决定对话占多少地方。compact 是默认，上面描述的也都是它的形状；comfortable 只是多给空间——轮次之间空一行、思考流式时留两行预览、展开的 diff 更晚才切到分页器。这个选择会跨会话保存。
- 审批、`/model`、`/resume`、`/thinking`（或 `/effort`）用方向键；还有 `/clear`、Esc Esc、`/init`、`/update`。`!cmd` 打在会话里，agent 看得到输出。
- `/thinking [level]`（别名 `/effort`）配置模型思考深度（如 `off`、`low`、`high`、`max`，或快捷指令 `on`/`off`），支持 TTY 交互式选择、按模型独立持久化，并在状态栏 MetaBar（如 `deepseek-chat (high)`）及 `/status` 报告中常驻显示。
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

`MOCK=<mode>` 用无 key 的 mock 模型启动：`write`（默认）、`bash`、`heredoc`、
`slow`、`steer`（占住回合 3 秒并报告插话是否送达）、`tall`、`spec`、`markdown`、
`reasoning`、`echo`、`vision`，以及自动图像
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
