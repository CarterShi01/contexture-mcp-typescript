# Contexture TypeScript 实现

[English](README.md)

Contexture 的 TypeScript 实现。Contexture 是一个面向 MCP 应用的渐进披露框架，
用于在能力不断增长时保持上下文可导航。

语言实现：
[Python](https://github.com/CarterShi01/contexture-mcp) ·
[TypeScript](https://github.com/CarterShi01/contexture-mcp-typescript) ·
[Go](https://github.com/CarterShi01/contexture-mcp-go) ·
[跨语言规范](https://github.com/CarterShi01/contexture-mcp/tree/master/spec)

> **当前状态：Python 0.15 的非激活 inspect、Python 0.14 的可选 Role Publication、Python 0.13 的 path-selected
> surface 及所有适用的 0.12 产品条目均已验证，
> 但发布仍受保护。** 本仓库已具备
> 原生 CLI、脚手架、inspection、维护中的 demo、MCP transport、固定及请求级 HTTP
> path-selected surface、REST 与 bearer identity。剩余 parity 工作是文档、发布资产审查以及
> 干净检出环境的发布审计；在全部发布门禁通过前，npm 包保持 private。

公开入口包括 `@contexture/mcp`、`@contexture/mcp/core`、`@contexture/mcp/server`、
`@contexture/mcp/server/surface`、`@contexture/mcp/web`、`@contexture/mcp/demo`、
`@contexture/mcp/inspection` 与 `@contexture/mcp/cli`。发布检查会把打包后的 tarball 安装到
独立项目，并导入每个入口。

## 节点模型

TypeScript 使用声明对象，而不是照搬 Python 的运行时类。封闭节点集合在
`src/core/model/` 下拥有明确模块：`node.ts`、`role.ts`、`skill.ts` 和
`tool.ts`；`declarations.ts` 保留为兼容 barrel。应用组合根位于
`src/application.ts`：

- `RoleDeclaration`：职责与容器边界；
- `SkillDeclaration`：由模型遵循的操作过程；
- `ToolDeclaration`：拥有同一份 Zod schema、校验和处理函数的可执行能力；
- `NodeDeclaration`：上述三者的可辨识联合类型。

`kind` 字段承担 Python 中 `Role`、`Skill`、`Tool` 类的区分作用。TypeScript
接口在编译后的 JavaScript 中会被擦除，这是语言原生设计，并非缺少实现。

### 可选 Publication

当 Role 的收尾工作需要单独披露的流程和设备时，使用 `definePublication`，并把其惰性
factory 赋给 `publication`；省略该成员即关闭此义务。Publication 在线上仍是普通 Role，
可包含 Role、Skill、Tool 以及显式嵌套的 Publication。它是收尾设备，不是可替代的 child
branch，也不是自动 callback。打开 owner 会加入 Publication 卡片和框架收尾合约；打开
Publication 本身只披露流程。只有显式 Tool 调用才会产生副作用；blocked、failed 或等待
approval 的状态必须如实报告。

## 示例

```ts
import { z } from 'zod';
import { defineApplication, defineTool } from '@contexture/mcp';
import {
  compileRuntimeApplication,
  createContextureMcpServer,
  Gateway,
} from '@contexture/mcp/server';

const status = defineTool({
  kind: 'tool',
  name: 'status',
  description: 'Return one service status.',
  readOnly: true,
  input: z.strictObject({ service: z.string() }),
  invoke: ({ service }) => ({ service, healthy: true }),
});

const application = defineApplication({
  name: 'operations',
  roots: [
    () => ({
      kind: 'role',
      name: 'operations',
      description: 'Operate services.',
      instructions: 'Inspect before changing anything.',
      skills: [
        () => ({
          kind: 'skill',
          name: 'diagnose',
          description: 'Diagnose an unhealthy service.',
          instructions: 'Read status and explain the evidence.',
          uses: ['operations/status'],
        }),
      ],
      tools: [() => status],
    }),
  ],
});

const compiled = compileRuntimeApplication(application);
const gateway = new Gateway(compiled.disclosure, compiled.runtime);

await gateway.inspect(['operations', 'operations/diagnose']);
await gateway.open('operations');
await gateway.invokeReadOnly('operations/status', { service: 'api' });

const adapter = createContextureMcpServer({ name: 'operations', version: '0.1.0' }, gateway);
// 由 Host 将 adapter.server 连接到官方 MCP SDK transport。
```

业务 Tool 始终位于 Contexture 的五个固定网关 Tool 后面。核心层不依赖 MCP
SDK；`@contexture/mcp/server` 是官方 SDK 适配边界。`@contexture/mcp/web` 的
`RestSurface` 提供显式 allowlist REST 适配器，可挂载 Fetch handler 或启动可选 Node
listener，并与 Tool Binding 复用同一验证路径。`RestRouter` 保留为较低层的内存兼容适配器。

`Contexture(declaration)` 是 `defineApplication` 的具名公开别名；两者创建相同的
惰性 application 声明。

## 检查 Agent 可见 context

模型控制的 `contexture_inspect` 网关接受 1 至 32 个来自现有卡片、去除首尾空白且互不
重复的 ref。它先原子校验整个批次，再返回固定的候选评估提示，以及每个目标、其直接
member 和声明的 `uses` 对应的纯路由卡片。它保持请求顺序与声明顺序，不递归，也不披露
instructions、Tool schema 或读写分类、Publication 合约、内容或调用结果；它不会调用任何
Tool，并使用独立的 inspection telemetry。仅披露服务器提供 discover、inspect 和 open，
不提供调用网关。

同名的本地 CLI 命令保持原有行为：它仍是 transport-free 的诊断 trace，用于重放连接
instructions、discovery、open，以及显式请求的本地 read。

`contexture inspect` 会重放原生实现生成的准确 instructions、discovery payload 和
渐进披露卡片，不会启动 MCP transport。修改声明后、连接 Host 前使用它：

```bash
npx contexture inspect operations --all --summary
npx contexture inspect operations/runbook --read
npx contexture inspect --all --json > contexture-trace.json
```

`--all` 按 Role 的广度优先顺序逐一遍历每个可见 ref；`--summary` 保留成本和 Host
限制检查、隐藏 payload body；`--json` 生成可供 CI 比对的稳定 trace。`--read` 会额外
调用一个无参数、只读的内容 Tool，因此只应在确实需要本地读取时使用。未找到项目配置且
未指定 target 时，`inspect` 会重放内置 demo，并在 stderr 报告此回退。

## 创建并运行项目

原生命令会创建唯一支持的 `project` 模板。生成的 application 自己拥有本地工作流，
因此应在新项目中执行这些命令，而不是在本仓库中执行：

```bash
npx contexture new operations --template project
cd operations
npm install
npm run check
npm run list
npm run inspect -- --all --summary
npx contexture call operations-assistant/ping --input '{"target":"local"}'
```

`contexture new` 会拒绝已经存在的目标目录和未知模板。生成项目的 `check` 会校验而不
打开 application dependency；`call` 复用正式服务相同的 runtime Binding，写 Tool 则必须
显式传入 `--allow-write`。

## Host 配置

Host 配置应当指向启动服务器的命令，而不是复制应用已经声明的 context。`Launch`
可以生成 Claude Code、Cursor 和 Codex 所需的准确格式：

```ts
import { Launch, claudeCodeConfig, codexConfig } from '@contexture/mcp/server';

const launch = new Launch({
  name: 'operations',
  command: 'node',
  args: ['dist/cli/main.js', 'serve'],
});

console.log(claudeCodeConfig(launch)); // .mcp.json 或 .cursor/mcp.json
console.log(codexConfig(launch)); // ~/.codex/config.toml 的 stanza
```

`cliCommands(launch)` 会返回经过安全 shell 引用的 `claude mcp add` 和
`codex mcp add` 命令。使用自定义 stdio 入口的应用也可复用同一 API。

## 开发与一致性验证

需要 Node.js 20.19 或更新版本，以及 npm 11。

```bash
git clone https://github.com/CarterShi01/contexture-mcp-typescript.git
cd contexture-mcp-typescript
npm ci
npm run check
```

本实现锁定 `conformance/specification.json` 中记录的 Contexture Specification
0.15 提交。固定 fixtures 和 golden 输出保存在 `conformance/`；测试会先通过
TypeScript 实现生成真实观察结果，再与这些资产比较。

对于 streamable HTTP，`Contexture-Select: operations/diagnose` 会提升该完整 subtree，
但不暴露其 ancestor 或 sibling；`Contexture-Select: operations/*` 只选择 direct member。
application identity ceiling 只能进一步收窄 selection。`Contexture-Roots` 保留为 root-only
兼容 header，同时发送两个 header 属于无效请求。

## 仓库结构

请阅读 [TypeScript 使用手册](docs/handbook.zh-CN.md)、其[英文原文](docs/handbook.md)和
[架构文档](docs/architecture.zh-CN.md)。真实 Host 证据与复现步骤记录在
[Host verification](docs/verification/hosts.md) 中。

```text
src/application.ts        Contexture 应用声明与组合根
src/core/foundation/      共享常量与错误
src/core/model/           Role、Skill、Tool、Node、Binding、Index 与运行时模型
src/core/mcp-interface/   Prompt、Resource 与固定 MCP Tool 平面声明
src/server/               运行期编译、MCP SDK 适配器与 Host surface
src/web/                  显式 REST route 与 surface 适配器
test/                     定向一致性及包测试
conformance/              固定规范身份、fixtures 与 golden 数据
```

英文是项目第一语言；简体中文文档作为翻译持续维护。

## 许可证

Apache-2.0，参见 [LICENSE](LICENSE)。
