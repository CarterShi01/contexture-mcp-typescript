# 架构

[English](architecture.md)

此 binding 使用与 Python 参考实现一致的产品语义和明确的架构边界。

## 依赖方向

```text
公开声明 facade → application declaration → core/model
                                      ↑
core/foundation → core/mcp-interface │
                                      │
web route/surface ← server surface ← server/application
```

foundation 提供常量、错误和 SDK-neutral 的 publication declaration data。它为 package metadata、
reference segment、固定 gateway name，以及 `Prompt`/`Resource` data shape 提供唯一写法。model
负责声明校验、规范 ref、不可变 Index、根选择视图、disclosure、执行 binding 与生命周期协议。
MCP-interface 会 re-export 这些 publication shape 并声明其 MCP-plane projection，不能反向依赖
model；model 也不会导入这个 sibling package。core 不可导入 MCP、HTTP、CLI 或框架相关模块。

server 层将编译后的 API 映射到官方 MCP SDK 与 Host surface。业务 Tool 永远不会成为
顶层 MCP Tool；Contexture 只暴露固定的导航与调用 gateway。

仅声明的 `@contexture/mcp` 入口把 Python 的公开 authoring 概念映射为原生 TypeScript value/type：
`Contexture`、`Channels`、`Principal`、framework error、`Prompt`/`Resource`、Role/Skill/Tool declaration
type、package version 与当前 request accessor；它不会加载 Host SDK。`@contexture/mcp/server` 入口负责
`ApplicationRuntime`、compiled application container、`ContextureServer`、options/auth/selector、telemetry、
launch config、logging 与 compile/build helper。

`DisclosureAPI` 是该 gateway 可独立安装的导航半面。它接收已编译 `Disclosure`，不依赖 Runtime
或 transport，并通过不可变 tool inventory 只公开 `discover` 与 `open`。`selectedGraph` 使用与导航
相同的 request-local root ceiling。`openForPerson`（及兼容写法 `openForAPerson`）只绕过 model
reservation 与 prompt-root visibility，绝不会扩大 selected roots。普通 lookup failure 在该 API
边界转换为可执行恢复，而 `RootOutsideSelectionError` 保持 typed 且不泄漏。需要原始 lookup facts
而非 agent-facing recovery prose 的 Host 仍可直接使用 `Disclosure`。

## 当前实现状态

1. core 节点模型、注册、校验与不可变 Index；
2. disclosure API，以及精确 golden discover/open/refusal payload；
3. 强类型 Tool binding、执行上下文与固定 MCP gateway；
4. Prompt、Resource、completion 与选定 root 行为；
5. Channels 生命周期、identity、telemetry、HTTP 与显式 REST route；
6. 原生项目发现、scaffold、check/list/inspect/call/serve/demo 命令与安装包消费者检查；
7. Streamable HTTP 与 stdio 启动、固定 root surface、HTTP bearer identity，以及维护中的
   Kubernetes 参考应用。

内核区域拥有定向 conformance 证据；产品工作流拥有原生集成和已打包 npm 消费者证据。
这仍不是完整产品等价：完整文档和场景映射、以及干净检出环境
发布审计仍未完成。
