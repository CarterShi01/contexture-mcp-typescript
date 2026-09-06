# Contexture TypeScript 实现

[English](README.md)

Contexture 的 TypeScript 实现。Contexture 是一个面向 MCP 应用的渐进披露框架，
用于在能力不断增长时保持上下文可导航。

语言实现：
[Python](https://github.com/CarterShi01/contexture-mcp) ·
[TypeScript](https://github.com/CarterShi01/contexture-mcp-typescript) ·
[Go](https://github.com/CarterShi01/contexture-mcp-go) ·
[跨语言规范](https://github.com/CarterShi01/contexture-mcp/tree/master/spec)

> **当前状态：正在推进的 0.12 产品移植，尚不是 Python 的可发布替代品。** 内核已有
> 定向证据；本仓库已具备原生 CLI、脚手架、inspection、维护中的 demo、MCP transport、
> 固定 root surface 与 HTTP bearer identity。请求级 HTTP root 选择、完整文档/场景映射
> 以及干净检出环境的发布审计仍待完成；在全部发布门禁通过前，npm 包保持 private。

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

await gateway.open('operations');
await gateway.invokeReadOnly('operations/status', { service: 'api' });

const adapter = createContextureMcpServer({ name: 'operations', version: '0.1.0' }, gateway);
// 由 Host 将 adapter.server 连接到官方 MCP SDK transport。
```

业务 Tool 始终位于 Contexture 的四个固定网关 Tool 后面。核心层不依赖 MCP
SDK；`@contexture/mcp/server` 是官方 SDK 适配边界。`RestRouter` 提供显式
allowlist REST 适配器。

## 开发与一致性验证

需要 Node.js 20.19 或更新版本，以及 npm 11。

```bash
git clone https://github.com/CarterShi01/contexture-mcp-typescript.git
cd contexture-mcp-typescript
npm ci
npm run check
```

本实现锁定 `conformance/specification.json` 中记录的 Contexture Specification
0.12 提交。固定 fixtures 和 golden 输出保存在 `conformance/`；测试会先通过
TypeScript 实现生成真实观察结果，再与这些资产比较。

## 仓库结构

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
