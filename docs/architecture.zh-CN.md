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
这仍不是完整产品等价：请求级 HTTP root 选择、完整文档和场景映射、以及干净检出环境
发布审计仍未完成。
