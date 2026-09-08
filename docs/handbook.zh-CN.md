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

lazy declaration 在 compilation 时会校验 node 的 `name`、`description`、Role 与 Skill 的
`instructions` 以及每个 `uses` ref 均非空。Skill 可以引用另一个 Skill，包括 cycle：打开它会返回
自己的 instructions，并只为 `uses` 返回 routing card，绝不会返回被引用 Skill 的 instructions 或其
`uses`。打开 Role 同样会返回自己的 instructions 及其 contained member 的单层 routing card。这些有界
card 使声明的 reference cycle 保持安全，也避免一次 open 展开无关 procedure。

`defineTool(...)` 是 TypeScript 原生的 executable Tool constructor。它会立即校验 Tool identity、strict
Zod input、handler 和 `uses` shape，并 snapshot `uses` list。省略 `readOnly` 时默认是 `false`：未分类的
Tool 会按 writing 处理，这与 Python 的 `read_only` default 一致。推荐使用该 constructor，因为 bare object
没有 constructor default；它仍会在 compilation 时再次校验。每个 bound Tool 都会 snapshot 声明的 name、handler
和渲染出的 JSON schema，因此之后修改 caller-owned declaration 不会改变已经 serving 的 card 或 call path。
没有 Binding 的 Tool 只可存在于 disclosure-only Index；其 routing card 有意省略 `read_only` 与
`input_schema`，获取 Binding 或尝试 runtime call 都会得到 typed model-validation failure。

active Tool 或 Role 声明 `uses` 时也采用同一条单层规则。被引用的 node 是 routing card，因此该 response
绝不会展开它们自身的 instructions 或 dependencies。disclosure-only Tool 仍是 structural：其 card 同时省略
`read_only` 与 `input_schema`，但显式 open 的 Tool 仍可列出直接的 structural `uses` card。root selection 会在
渲染前过滤这些 card，因此 cross-root dependency 永远不会扩大一个 request 的范围。
`modelMayOpen: false` 的 Prompt reservation 会从其他 active node 的 `uses` card 中移除其 target。
与 prompt-only root 不同，该 target 的普通 containment card 仍会可见，因此模型可以把人引导到 Prompt；
模型 open 会被拒绝，而具名 Prompt 或 `goto` 会为该人打开相同的 canonical active payload。
`unrestricted()` 只移除 prompt-root 的模型所有权，保留已有的 root-selection ceiling。

`RootSelection` 表示 all-roots 或精确 root allowlist：它会 trim 请求的 root name、拒绝
descendant，并且只能收窄另一个 selection。`SelectedGraph` 只公开选中范围内的 `roots`、`walk`、
`find`、`refOf`、`parentOf`、`childrenOf`、`usesOf` 与 `dependentsOf`；cross-root uses 和
dependents 会被过滤。request header 使用同一 projection，不能泄露 identity ceiling 之外的 root。
`currentRootSelection()` 在 Tool 内返回 request-local projection，在 invocation 外返回兼容的
all-roots 值。

`currentPrincipal()` 在 Tool 运行期间返回 request identity。对于未认证调用以及 invocation 外部，
它返回 `undefined`；Contexture 绝不会虚构 anonymous Principal。某项 capability 是否要求 identity
由 application 自己决定。

`Principal.claims` 是供 application code 使用的 shallow、immutable snapshot，可能包含完整的
decoded token。其 `toString()`、Node `inspect`/console representation 以及 JSON representation
会刻意只公开 `subject`、`clientId`、`issuer` 和按 code point 排序的 `scopes`；不要记录原始 claims。
identity 穿过 MCP authentication adapter 时，如存在 `claims.iss`，它是 authoritative issuer。
因此 machine credential 可以保留 `clientId`、issuer、scopes 与 claims，但没有 `subject`。

`currentGraph()` 与 `currentTelemetry()` 更严格：它们只可在正在运行的 Tool 内访问，在没有 active
invocation 时会拒绝访问。`ToolCallContext` 保留 Host 所有的 `host` 与取消用的 `signal`，而 Contexture
会为这一次确切 call 重建其中的 `principal`、`channels`、`telemetry`、`graph` 与 `selection` facts。因而
handler 不会收到与其 request-local context 不一致的 caller-supplied framework snapshot。

对于 imperative embedding phase，可使用 `ControllerManager` 通过 `registerRole`、
`registerSkill`、`registerTool` 或 `registerRoot` 一次性捕获 root factory。它会校验完整的
captured tree 并拥有 deep snapshot；`roles`、`skills`、`tools` 与 `roots` 返回 defensive snapshot
（root 的顺序是 Role、Skill、Tool）。`application(name)` 和 `compile(name)` 总会生成新的 tree，
因此后续 registration 或 `rebindChannels()` 不会改变更早的 Application 或 compiled Index。Channels
有意按 identity snapshot：rebind 只影响之后生成的 Application。

`Channels` 是 nominal lifecycle base class：当 deployment dependency 必须在 serving 前打开、结束后
关闭时，应继承它。不要仅使用碰巧带有 `open` 和 `close` 方法的 plain object；它不是 lifecycle owner。
`ControllerManager` 也接受普通的、已经构造好的 deployment handle。它会不检查、不调用地保留该 exact
value，并且 Tool 会在 `context.channels` 中收到同一个由框架拥有的 identity。这适用于无需 lifecycle 的
client、configuration 或 test double。声明式 `defineApplication({ channels })` 刻意只接受 `Channels`
instance；普通 handle 请使用 `ControllerManager`。Contexture 会覆盖 caller 试图提供的
`context.channels` 值。
Manager 生成的 raw-handle snapshot 可被 runtime 和 server compilation 接受；但 disclosure-only
compilation 仍会拒绝任何已提供的 handle。

每个可执行 server 都暴露同一个有序四工具 `Gateway`：discover、open、read-only invoke 和
invoke。disclosure-only host 只暴露前两个 navigation entry。lookup 和 wrong-door failure 会在
这里被渲染为可执行下一步的 `RefusedError` recovery；`RootOutsideSelectionError` 保持 typed，
以便 authorization ceiling 不会泄露其他 root。Prompt reservation 只会在该 ceiling 之后检查。

如果 embedding 只需要模型导航，可以使用 `DisclosureAPI`。它接收一个 `Disclosure`，不依赖
Runtime 或 transport，只暴露同一个 Gateway 的前两个 door。它的 `discover`、`open` 和
`selectedGraph` 调用是无状态的，并使用同一个 request-local root ceiling。`openForPerson`（以及
兼容名称 `openForAPerson`）只绕过 model reservation 和 prompt-root visibility，绝不会扩大选中的
root。普通 lookup failure 会在这个 API 边界转换为标准 `RefusedError` recovery，而
`RootOutsideSelectionError` 仍保持 typed 且不泄露信息。若 Host 需要结构化 lookup facts，仍可直接
使用原始 `Disclosure`。

可选的 framework telemetry 可声明为 `telemetry: new InMemoryTelemetry()`。它会把成功的 Role 和
Skill open，以及成功或失败的 Tool invocation 聚合成 `NodeUsage`（`callCount`、`errorCount` 和
`lastUsedAt`）；不会观察 discover 或打开 Tool card。可使用自定义 `Telemetry` 做 export，exporter 的
rejection 或同步 throw 不会影响 navigation 或 business outcome。`compileRuntimeApplication` 会让
Disclosure、Runtime 和 gateway surface 共享同一个 collector。

声明门面保持 SDK-neutral。它公开 `Contexture`、`defineApplication`、
`ApplicationDeclaration`、原生 `Prompt` 与 `Resource` 数据 interface、node declaration，
以及 `Principal` 等 request facts。`Prompt` 和 `Resource` 是 TypeScript object shape，
而不是 Python 风格的 subclass base。`defineApplication` 会 snapshot 它们，并立即拒绝空白的
`opens`、`description`、`uri` 或显式提供的 `name`；显式提供的 `modelMayOpen` 也必须为 boolean。
解析 `opens` ref，以及校验 Resource 是否指向无参数、只读的 Tool，仍然属于 compilation 阶段。每个
公开 compilation entry point 都会应用同一份规范化，因此直接向 compiler 传入原始 JavaScript object
也无法绕过 declaration validation 或 Prompt reservation semantics。

foundation 拥有共享 declaration vocabulary：`PACKAGE_NAME` 是 framework 名称（`contexture`），
`PACKAGE_VERSION` 是这个 binding 的 release，`REFERENCE_SEPARATOR` 拼写的是 Contexture ref，
而不是 HTTP path 或 Resource URI。`DISCOVER_GATEWAY_NAME`、`OPEN_GATEWAY_NAME`、
`INVOKE_READ_ONLY_GATEWAY_NAME` 和 `INVOKE_GATEWAY_NAME`（以及按顺序排列的
`GATEWAY_TOOL_NAMES` inventory）是 model、MCP primitive projection 与 server 共用的封闭名称。
`Prompt` 与 `Resource` 同样是 foundation-owned、SDK-neutral 的 data shape；保留的
`core/mcp-interface` type export 只是 compatibility spelling，并非重复的 declaration。

TypeScript 中的 `modelMayOpen` 有意使用 boolean：省略或 `true` 表示 Prompt 可由模型导航，
`false` 则把这个已声明 capability 保留给人控制的 Prompt 或 `goto` 导航。它与 Python declaration
有相同的可观察保留语义，但不复制 Python 的语法。自定义嵌套 `Disclosure` `promptRoots` ref 是无效的，
并会抛出公开的 `ModelValidationError`；prompt-only ownership 只适用于完整 root，而非任意 descendant。

直接使用 compiled index 的调用者可通过 `NodeNotFoundError` 分类 lookup 失败。其 `reason` 是
`LookupFailure.EMPTY_REF`、`NO_SUCH_ROOT`、`NOT_A_CONTAINER`、`NO_SUCH_MEMBER` 或
`WRONG_KIND` 之一；稳定 facts 还包括请求的 `ref`、相关的 `segment` 或 `scope`，以及适用时
可用的 `known` 名称。lookup 会忽略空 slash segment，但 error facts 保留原始请求的 `ref`；空引用与
non-container 的 `known` 为空，其他 `known` 会按 canonical 顺序排序，`scope` 是 resolution 停止处的
node name。普通 runtime call 对未知 capability 仍会保持原有的 refusal surface。

所有 framework-domain failure 都继承 `ContextureError`。structural failure 仍可分类为
`ModelValidationError`，其中 `DeclarationError` 与 `DuplicateNameError` 是更窄的 category。
`NodeNotFoundError` 保存的是 facts，而非 agent prose：它的原生 `message` 与
`developerSummary()` 是简短的 field-shaped diagnostic；只有 local lookup 尚无完整 ref 时，
`within(ref)` 才会返回新的 immutable failure。只有 Gateway 会把这些 facts 渲染成 agent recovery
prose。direct runtime caller 会得到带有 `ref`、`readOnly` 的 typed `WrongDoorError`，其 message 会
明确 Tool 是 read-only 还是 writing；Gateway 可以将其包装为 agent-facing refusal。

### 已编译 Index 查询

`compileRuntimeApplication(...).index` 是公开且不可变的 `Index` facade（兼容类型名
`CompiledApplication` 仍然保留）。它记录一次 compilation snapshot：`has`、`size`、`isBound`、
root group、canonical `find`、`tool`、parent/child 与 dependency 查询都不会重新运行 factory，
也不会获取 Channels。`nodesWithRefs`、`skills` 与 `rolesWithRefs` 按声明顺序 depth-first 遍历
containment；`rolesByLevel` 按 breadth-first 遍历 Role。它们都不会跟随 `uses`，因为该 overlay
可以合法地形成 cycle。

`matchingRefs(value, limit)` 依次按完整 prefix、最后 segment prefix、任意 segment prefix 和
substring 对完整编译地址空间排序；tie-breaker 为 Unicode code-point length 和 order。其 `total`
是截断前数量；负 `limit` 会有意返回零个值，不会意外扩大受限 response。`signpost(ref)` 只返回
ancestor ref 与直接 sub-Role count；`crossings()` 列出离开其 root 的声明 `uses` edge。两者都是
结构事实，不是 disclosure card。

`bindingOf(ref)` 与 `schemaOf(tool)` 仅适用于 bound runtime Index。disclosure-only Index 仍支持
结构查询，但会拒绝这些 execution fact。schema、node value、pair 与结果 collection 都不可变。
`Index` 是从 `@contexture/mcp/server` 导出的 type-only export，不是 runtime constructor。TypeScript 的
`compileApplication`、`compileDisclosureApplication` 以及 server 的 `compileRuntimeApplication` 取代了
Python 的 `Index.of`、`bound` 与 `unbound` 构造形式；serving 仍由既有 runtime 与 Channels lifecycle 所有。
声明 root 则有意保持 SDK-neutral。`SelectedGraph` 在同一 matcher 上只处理 selected ref，因此不会泄露
另一个 request root。

每个已编译 Role 也有本地结构查询。`branches()` 返回直接 child Role；`members()` 按 declaration group
顺序返回直接 child Role、Skill、Tool；`member(name)` 在这三组直接成员中按 name 查找。name 不存在时会抛出
带 Role scope 和按规范排序 known name 的 typed `NodeNotFoundError`。这些方法会返回新的 frozen array，
其 node 仍属于同一个不可变 compilation snapshot，且绝不会执行 lazy declaration factory。每条 `uses` edge
只会在完整 forest 存在后被检查：必须非空、唯一、可解析，且不得指向 node 自己的 canonical ref。不同 node
之间的 reference cycle 仍然有效，因为 disclosure 只渲染一层 routing card。

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

原生 MCP completion endpoint 只服务 `goto` 的 `ref` 参数，并且只返回当前 selected root surface 内的
ref。它最多返回 100 个值；若还有更多匹配，最后一个可见值会说明剩余数量，而 response 仍保留真实的
`total` 与 `hasMore`。针对其他 Prompt 或参数的 completion request 不会返回任何 Contexture ref。

## 7. 发布可由 Host 读取的文档

`Resource` 为树中已存在的 Tool 内容提供稳定 URI。它必须指向一个无参数、只读的 Tool，因此 resource
read 使用的仍是与本地只读 call 相同的已验证 Binding，也就不可能修改外部世界。Host 列出的是 resource
metadata，读取的是 URI。

```js
export const app = defineApplication({
  // roots: [...], including a read-only `operations/runbook` Tool with no input
  resources: [
    {
      opens: 'operations/runbook',
      uri: 'contexture://operations/runbook',
      description: 'The current operations runbook.',
      mimeType: 'text/markdown',
    },
  ],
});
```

位于 Host selected root surface 外的 Resource 既不会被列出，也不可读取。不要用 Resource 实现带参数的
查询、写操作，或再实现一次 Tool；这类能力应当通过 Contexture gateway 使用已声明的 Tool。

## 8. 发布显式 REST surface

只有在明确要发布给人或服务的 API 时才使用 `RestSurface`。它不会创建可任意传 ref
的 dispatcher：每个固定 path 都必须指向一个已存在的 Tool。GET 和 HEAD 只能调用
read-only Tool；POST、PUT、PATCH 与 DELETE 只能调用 writing Tool。REST 与 MCP gateway
复用同一个 runtime Binding 来校验输入，因此不存在第二份业务实现。

```js
import { PermissionError, Principal, RejectedError } from '@contexture/mcp';
import { compileRuntimeApplication } from '@contexture/mcp/server';
import { RestSurface } from '@contexture/mcp/web';

const runtime = compileRuntimeApplication(app).runtime;
const rest = new RestSurface(
  runtime,
  [
    { method: 'GET', path: '/v1/status', ref: 'operations/status' },
    { method: 'POST', path: '/v1/restart', ref: 'operations/restart', status: 202 },
  ],
  async (request) =>
    request.headers.authorization === 'Bearer local-token'
      ? new Principal({ subject: 'operator' })
      : undefined,
);
const listener = await rest.listen({ host: '127.0.0.1', port: 8080 });
```

`fetch(request)` 可挂载到 Fetch-compatible Host。`listen()` 是内置的轻量 Node adapter，
它在整个 listener 生命周期内只打开一次 application Channels；关闭时调用
`await listener.close()`。GET/HEAD 输入来自 query parameter（重复 key 会成为 string
array）；command 接受可选的 `application/json` object body，默认最大 1 MiB。HEAD 会
fallback 到已声明的 GET route，保留 header 但永不发送 response body。

可选 authenticator 会拿到规范化的小写 header 和全部 query value，随后必须返回一个
`Principal`。没有 identity 时返回 401，未发布的 path 返回 404。无效 JSON、body shape、
content type、body size、Binding argument 和授权失败都会返回 no-store 的结构化
`application/problem+json` response。没有 authenticator 时不要信任自称 principal 的
header，也不要因为 Tool 在 application graph 中有效就发布它。

如需表达明确的业务结果，抛出 `new PermissionError(detail)` 会得到 403 `forbidden`
response，抛出 `new RejectedError(detail)` 会得到 422 `rejected` response。Binding
argument 无效同样会得到 422 `invalid-arguments`；普通的意外 `Error` 会得到 500
`controller-failed` response。这些是明确的 Contexture error type，不是依赖字符串名称的
约定。

Python 的 `Route` 允许 100 到 599 的所有 HTTP status。TypeScript 的 `RestSurface`
以 Fetch 为基础且始终序列化 JSON，因此会在 route construction 时拒绝 1xx、204、205 和
304：标准 Fetch `Response` 无法表示这些带 body 的最终 response。请使用 200 到 599
之间、且不为 204、205 或 304 的 Fetch-safe JSON status。

## 9. 通过 MCP Host 提供服务

服务时不改变 declaration。server adapter 提供四个固定的 Contexture gateway Tool；业务 Tool
不会注册为 MCP 顶层 Tool，而是被渐进披露在 gateway 后面。

```bash
npm run serve
npx contexture demo --transport streamable-http --port 8000
```

stdio 是默认 transport。只有在明确配置 Host 与网络时才使用 `--transport streamable-http`。
非 loopback 启动需要对应的 Host/origin 策略，并且必须提供 `auth` 或显式设置
`allowAnonymous: true`；应处理 server option error，而不是放宽这些限制。

程序化 HTTP 启动应把 request authentication 与 body boundary 放在 transport policy 上：

```ts
const options = new ContextureOptions({
  transport: 'streamable-http',
  auth,
  maxRequestBodyBytes: 1024 * 1024,
  path: '/mcp',
});
const handle = await buildServer(application).start(options);
```

现有调用方仍可使用 `buildServer(application, { auth })`，但不能同时在这里和
`ContextureOptions` 中设置 auth。stdio 会拒绝 HTTP-only option（包括 auth、body size 和
request-local root selection）。path 必须以 `/` 开头，不能包含 `?` 或 `#`，并使用
URL 规范化后的百分号编码形式。无论 overflow 来自声明的 Content-Length 还是 chunked
stream，body limit 都会在 MCP dispatch 前返回 413。绑定后，Contexture 会验证实际 TCP
host 并重新执行 public-bind policy；只有 `localhost`、`127.0.0.1` 和规范 IPv6 loopback
会被视为等价。

程序化启动时，`ContextureOptions` 还接受 `logLevel: 'debug' | 'info' | 'warn' |
'error'`。Contexture 的生命周期日志始终写入 stderr，因此 MCP stdio 独占 stdout。
嵌入式 Host 若需在启动前建立该策略，可使用 `configureLogging(level)`。

除非 application 显式提供 `instructions`，Contexture 会在 MCP 初始化响应中返回紧凑的广度优先
能力清单及固定导航合同。HTTP root selection 时，该清单按每个请求的 selected root surface 生成，
绝不会宣称被省略的 root。

Claude Code、Cursor 和 Codex 配置请使用 `@contexture/mcp/server` 的 `Launch`。它从 server
command 渲染 Host configuration，而不是复制 application 已声明的 context。

## 10. 保持合同真实

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
