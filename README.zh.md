<p align="center">
  <a href="https://blackman99.github.io/codsh/zh.html">
    <img src="assets/banner.svg" width="900"
         alt="codsh — 架在 DeepSeek Harness 上的终端编码 agent">
  </a>
</p>

<p align="center">
  <a href="https://blackman99.github.io/codsh/zh.html"><b>站点</b></a> ·
  <a href="https://www.npmjs.com/package/codsh-cli">npm</a> ·
  <a href="README.md">English</a> | 中文
</p>

> npm：[`codsh-cli`](https://www.npmjs.com/package/codsh-cli) · 命令：`codsh`

架在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上的终端编码 agent。**`/ship`** 把一句话变成已验证的代码。

## 安装

```sh
npm install -g @deepseek-ai/dsh codsh-cli   # 已有 dsh？npm i -g codsh-cli
codsh
```

零依赖启动器。`codsh` 即 `dsh --profile code`。密钥：`DEEPSEEK_API_KEY`。

`codsh --resume <id>` · `codsh --continue` · `codsh -p "任务"`

不用启动器：

```sh
dsh plugin --profile code add codsh-bundle
dsh --profile code
```

## `/ship`

[![/ship 流程](assets/ship-demo.zh.gif)](https://blackman99.github.io/codsh/zh.html)

`/ship <一句话需求>` —— 先 grill，两次确认，此后自主：

1. **Grill** —— 设计树访谈；事实自己查，每轮问当前 frontier，并给出推荐答案。
2. **Spec** —— 自动合成（to-spec）。你确认。每条标准写明证明它的命令。
3. **Tickets** —— 自动切成可独立验证的垂直切片。你批准。写代码前先跑基线。
4. **落地** —— 在 spec 记下的 seam 上 TDD；每个变绿的 ticket 提交一次。
5. **完成** —— 每条标准重跑并汇报。

裸 `/ship` 会续跑未完成的 spec。

```sh
/ship 让超长 diff 用分页器打开而不是刷屏滚过
```

## 界面

[站点](https://blackman99.github.io/codsh/zh.html)有实机演示。一句话：

- 备用屏幕；输入框钉底；退出还原你的 shell。
- 阅读长回复时，产生当前内容的用户输入会吸附在顶部；下一条输入会把上一条逐步推走。
- 长块可折叠；点击一块，Ctrl+O 全部；悬停报名字。
- todo 钉在 chrome（Ctrl+T / `/todos`）。
- 拖选即复制。Markdown、思考、工具卡片流式画出。
- Ctrl+V 粘贴图片（原生视觉；DeepSeek 文本模型自动借用 Vision Exp；其他文本路由仍落盘并可选 sidecar）。
- `/` 命令、`$` skill、`!` shell、`@` 文件 —— 菜单在输入框上方。
- 审批和 `/model` `/resume` 用方向键。⇧Tab 是 plan 模式。
- `/clear`、`/resume`、Esc Esc、`/init`。`!cmd` 打在会话里，agent 看得到输出。

非 TTY 降级为行读取器：无组件、不绘制。

## 开发

```sh
pnpm install
pnpm run dev                 # build → .dev-home → 启动
MOCK=markdown pnpm run dev   # 无 key，对着 e2e mock
pnpm test
pnpm run test:e2e            # 打包、安装，驱动真实二进制
```

`pnpm run sync:dsh` 跟踪已发布的 `@deepseek-ai/dsh-*`。本仓库绝不 fork harness。

## 许可

MIT
