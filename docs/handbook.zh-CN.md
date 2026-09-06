# Contexture TypeScript 使用手册

Contexture 让不断增长的 MCP application 仍保持可导航。模型先看到简短的路由卡片，
逐层打开相关分支，最后才获得 Skill 流程或 Tool schema。它不选择模型、不运行 agent loop，
也不替代应用自身的授权。

本手册描述当前存在的 TypeScript binding。公开语法遵循 TypeScript 原生习惯；可观察的
披露和 gateway 行为受 Contexture specification 约束。

## 1. 创建项目

使用 Node.js 20.19+ 与 npm 11。包提供的原生 `project` 模板会创建一个惰性声明、一个
只读 Tool 和本地命令工作流：

```bash
npx contexture new operations --template project
cd operations
npm install
npm run check
npm run list
npm run inspect -- --all --summary
npx contexture call operations-assistant/ping --input '{"target":"local"}'
```

`new` 会从参数推导稳定的 package 与 Role 名称，并拒绝覆盖已存在的目录。它刻意保持很小：
只增加你的 application 实际拥有的能力。

## 2. 声明一个 application

生成的 `assistant/app.js` 导出 `app`。这个 declaration 是惰性的：它不会构造节点、打开
Channels、启动 MCP server，也不会导入 Host SDK。

```js
import { defineApplication, defineTool } from '@contexture/mcp';
import { z } from 'zod';

const status = defineTool({
  kind: 'tool',
  name: 'status',
  description: 'Return one service status.',
  readOnly: true,
  input: z.strictObject({ service: z.string() }),
  invoke: ({ service }) => ({ service, healthy: true }),
});

export const app = defineApplication({
  name: 'operations',
  roots: [
    () => ({
      kind: 'role',
      name: 'operations',
      description: 'Operate services.',
      instructions: 'Inspect evidence before changing anything.',
      skills: [
        () => ({
          kind: 'skill',
          name: 'diagnose',
          description: 'Diagnose an unhealthy service.',
          instructions: 'Read status, then explain the evidence.',
          uses: ['operations/status'],
        }),
      ],
      tools: [() => status],
    }),
  ],
});
```

`Contexture(declaration)` 是 `defineApplication` 的具名公开别名。两者都会保留惰性
factory 并规范化 application 名称。每个 Role、Skill、Tool 都应通过 factory 声明；编译会
从这些 factory 创建新的不可变 graph snapshot。

## 3. 选择正确的节点

| 使用  | 适用情形                                         |
| ----- | ------------------------------------------------ |
| Role  | 一个职责边界，或多个明确分支之间的选择。         |
| Skill | 面向模型的流程、顺序规则或证据要求。             |
| Tool  | Contexture 校验并调用的确定性 application code。 |

不要只为整理文件而增加 child Role。模型打开一个 Role 时会同时得到其全部直接成员，所以同一
职责所需的 Skill 与 Tool 通常应该留在同一个 Role 下。`uses` ref 用于声明 Skill 需要的 Tool；
应从 `list` 或已披露的卡片取得规范 ref，而不是凭记忆拼接。

## 4. 启动 Host 前先在本地工作

| 问题                     | 命令                                   |
| ------------------------ | -------------------------------------- |
| declaration 能否编译？   | `npm run check`                        |
| 存在哪些 ref？           | `npm run list`                         |
| Agent 会收到什么？       | `npm run inspect -- --all --summary`   |
| 一个只读 Tool 返回什么？ | `npx contexture call REF --input JSON` |

`check` 会编译但不会打开 application Channels。`call` 使用和 serving 相同的、已经校验的
Tool Binding。默认只允许 read-only Tool；writing Tool 必须显式传入 `--allow-write`。

## 5. 检查 Agent 可见 context

`inspect` 是 transport-free replay，而不是近似模拟。它构建的 instructions、discovery
payload、open card 和恢复文本，都来自 native server implementation 所用的同一实现。

```bash
npx contexture inspect operations --all --summary
npx contexture inspect operations/runbook --read
npx contexture inspect --all --json > contexture-trace.json
```

`--all` 会按 Role 的广度优先顺序逐一访问每个可见 ref。`--summary` 保留 token estimate 和
Host-limit finding、隐藏 payload body。`--json` 适合 CI diff。`--read` 只运行无参数、只读的
内容 Tool，因此仅在确实需要本地读取时使用。在 project 外执行时，`inspect` 会刻意重放内置
demo，并把提示写到 stderr，以保证 JSON stdout 仍然有效。

## 6. 提供由人控制的导航

Prompt 面向在 Host 菜单中做选择的人，而不是模型的第二个 surface。一个声明的 Prompt 打开一个
固定 ref；每个已服务的 application 还会发布 `goto`，它所需的 `ref` 参数让人无需先要求模型导航
就能浏览已知路径。

```js
export const app = defineApplication({
  // roots: [...],
  prompts: [
    {
      name: 'open-change-window',
      opens: 'operations/change-window',
      description: 'Open the change-window procedure.',
      modelMayOpen: false,
    },
  ],
});
```

具名 Prompt 与 `goto` 都使用同一条由人控制的打开路径。其文本会说明 ref、提供但不披露内容的
ancestor signpost，最后展示正常 node payload。`modelMayOpen: false` 会把已声明 capability 保留在
模型导航之外；它不会对拥有 Host 的人隐藏该 capability。不要把 Prompt 当成 business Tool，也不要在
description 中重复其 procedure。

## 7. 通过 MCP Host 提供服务

服务时不改变 declaration。server adapter 提供四个固定的 Contexture gateway Tool；业务 Tool
不会注册为 MCP 顶层 Tool，而是被渐进披露在 gateway 后面。

```bash
npm run serve
npx contexture demo --transport streamable-http --port 8000
```

stdio 是默认 transport。只有在明确配置 Host 与网络时才使用 `--transport streamable-http`。
非 loopback 启动需要对应的 Host、origin 和 anonymous-access 决策；应处理 server option error，
而不是放宽这些限制。

Claude Code、Cursor 和 Codex 配置请使用 `@contexture/mcp/server` 的 `Launch`。它从 server
command 渲染 Host configuration，而不是复制 application 已声明的 context。

## 8. 保持合同真实

提出改动前运行完整 package gate：

```bash
npm run check
```

它会执行格式化、lint、类型检查、native test、build 和 package 检查、打包后的 external consumer
检查，以及打包后的生成项目工作流。不要为了让 binding 通过而修改 golden output：这些文件是
跨语言 protocol contract。

请阅读 [architecture.md](architecture.md) 了解依赖边界，阅读
[CONTRIBUTING.md](../CONTRIBUTING.md) 了解贡献规则，阅读 [RELEASING.md](../RELEASING.md)
了解刻意保持关闭的发布流程。只有全部 product-parity 和 release gate 确实满足后，包才会取消
private 状态。
