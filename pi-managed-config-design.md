# Pi 远端托管配置改造说明

## 1. 文档用途

本文档用于把已经确认的需求交接给新的开发对话。目标是在 Pi 中原生增加远端托管配置能力，同时保持默认本地使用方式完全兼容。

本文档描述的是 Pi 客户端侧改造。远端 Web 管理界面和配置服务是独立系统，不需要嵌入 Pi。

实施状态（2026-08-05）：本文档描述的客户端能力已完成实现。第一版包含严格的 version 1 schema、启动时单次拉取、managed-only `ModelRuntime`、扩展 provider 隔离、last-known-good 缓存、CLI/环境变量/SDK 入口，以及单元、编译和本地 E2E 验证。

## 2. 核心目标

给现有 `pi` 增加一个可选的 `ManagedConfigResolver`：

- 未启用远端配置时，Pi 完全保持现有本地行为。
- 启用远端配置时，Pi 在进程启动阶段拉取一次配置。
- 远端配置是 provider 和 model 的唯一来源，不与本地配置合并。
- 远端模式只支持由远端定义的 custom provider。
- custom provider 的 API key 必须由远端配置提供。
- 运行期间不热更新配置。

这里所说的“配置下发”采用启动时拉取模型：管理员在远端 Web 界面发布配置，Pi 在每次启动时获取一次并生效。不需要 WebSocket、长轮询或服务端主动推送。

## 3. 已确认的产品边界

### 3.1 保持同一个 Pi

- 继续使用原有 `pi` 命令和发行物。
- 不创建 `pi-managed` 命令或独立版本。
- 远端模式必须显式启用。
- 未启用远端模式的用户不应感知到这次改造。

### 3.2 不引入 providerPolicy

不需要 allowlist、denylist、优先级或按 provider 细分的策略系统。

系统只有两个互斥的配置来源：

```text
local mode   -> 使用 Pi 现有本地 provider 组合逻辑
managed mode -> 仅使用 ManagedConfigResolver 返回的远端配置
```

是否配置 `ManagedConfigResolver` 就是模式开关。

### 3.3 远端配置完整覆盖本地 Provider

进入 managed mode 后，远端 provider 列表是完整集合，而不是增量配置。因此必须屏蔽所有本地 provider 来源：

- Pi 内置 provider。
- 本地 `models.json`。
- 本地 `auth.json`。
- provider 认证相关环境变量。
- OAuth、登录态和 `/login` 等本地认证流程。
- 扩展通过 provider 注册接口注入的 provider。
- 自动发现或动态补充的 provider/model catalog。

不允许以下行为：

- 远端 provider 与本地 provider 合并。
- 远端缺少某个 provider 时回退到本地同名 provider。
- 使用本地 `auth.json` 或环境变量补齐远端 provider 的凭证。
- 远端配置失败后静默切换成本地模式。

### 3.4 Managed Mode 只支持 Custom Provider

远端模式不使用 Pi 的内置账号或认证体系。每一个 provider 都由远端完整定义，并使用 API key 认证。

远端配置至少需要提供：

- provider ID。
- Pi 已支持的 API/protocol 类型。
- `baseUrl`。
- `apiKey`。
- provider 下可用的完整 model 列表及其元数据。

custom provider 仍然复用 Pi 已有的协议实现，例如 Pi 已支持的 OpenAI 或 Anthropic 类协议；本次改造不重新实现模型调用协议。

### 3.5 只在启动时更新

- Pi 每次启动最多解析并启用一份远端配置快照。
- 配置在模型解析和会话进入可用状态之前完成加载。
- 运行期间不重新拉取配置。
- 远端配置发生变化后，需要重启 Pi 才能生效。
- 本次不实现文件监听、定时刷新、长轮询或 WebSocket。

## 4. 两种模式的行为对照

| 行为 | Local Mode | Managed Mode |
| --- | --- | --- |
| 启用条件 | 未配置 managed config | 显式配置 managed config 地址 |
| Provider 来源 | Pi 当前所有本地来源 | 仅远端配置 |
| Model 来源 | Pi 当前本地组合逻辑 | 仅远端配置 |
| Provider 凭证 | 现有 `auth.json`、环境变量、OAuth 等 | 仅远端配置里的 `apiKey` |
| 内置 Provider | 正常可用 | 完全屏蔽 |
| 本地 `models.json` | 正常读取 | 不参与运行时配置 |
| 本地 `auth.json` | 正常使用 | 不参与 provider 认证 |
| Provider 环境变量 | 正常使用 | 不参与 provider 认证 |
| 扩展注册 Provider | 正常支持 | 禁止或忽略 |
| 启动时远端请求 | 无 | 一次 |
| 运行时热更新 | 保持现状 | 不支持 |

## 5. 配置入口

Pi 需要一个很小的 bootstrap 配置，用于确定是否进入 managed mode，以及从哪里获取远端配置。例如：

```bash
pi --managed-config-url https://config.example.com/api/pi/config
```

最终入口同时支持 CLI 和环境变量，CLI 值优先：

```text
--managed-config-url      / PI_MANAGED_CONFIG_URL
--managed-config-token    / PI_MANAGED_CONFIG_TOKEN
```

入口保持以下语义：

- 没有 managed config URL：进入 local mode。
- 存在 managed config URL：进入 managed mode。
- 本地 bootstrap 配置不能定义或补充 provider。

如果配置服务需要鉴权，可以额外提供一个 bootstrap token。它只用于访问配置服务，不是 provider 凭证，也不能用于恢复本地 provider 认证逻辑。

## 6. ManagedConfigResolver 职责

建议引入一个职责单一的 `ManagedConfigResolver`，负责：

1. 在 Pi 启动阶段请求远端配置。
2. 校验 HTTP 响应和配置版本。
3. 校验配置结构与必要字段。
4. 校验 provider/model ID 的有效性和唯一性。
5. 校验声明的 API/protocol 是否受当前 Pi 支持。
6. 确认每个 provider 都带有远端 `apiKey`。
7. 返回一份规范化、不可变的 managed config 快照。
8. 对日志和错误信息中的 API key 进行脱敏。
9. 如采用缓存方案，读写上一份成功获取的远端快照。

`ManagedConfigResolver` 不负责：

- 合并本地和远端 provider。
- 决定 provider 优先级。
- 从 `auth.json` 或 provider 环境变量解析凭证。
- 运行期间刷新配置。

## 7. 建议的远端配置契约

以下结构仅作为第一版契约示意。字段命名和 model 元数据应尽量复用 Pi 当前 `models.json`/provider 类型，避免维护第二套不兼容模型：

```json
{
  "version": 1,
  "providers": [
    {
      "id": "company-gateway",
      "api": "openai-responses",
      "baseUrl": "https://gateway.example.com/v1",
      "apiKey": "<remote-issued-api-key>",
      "models": [
        {
          "id": "model-a",
          "name": "Model A",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 128000,
          "maxTokens": 32000
        }
      ]
    }
  ]
}
```

第一版应坚持完整快照语义：

- `providers` 是完整列表。
- 每个 provider 的 `models` 是完整列表。
- 不支持 patch、继承或删除标记。
- 不支持引用本地 provider 或本地凭证。
- `apiKey` 由远端响应直接提供，不解析成本地环境变量名。

## 8. 启动流程

建议的启动顺序：

```text
解析 CLI 和 bootstrap 配置
        |
        v
判断是否启用 ManagedConfigResolver
        |
        +-- 否 --> 执行 Pi 现有本地启动流程
        |
        +-- 是 --> 拉取并校验远端配置
                         |
                         v
              构造 managed-only ModelRuntime
                         |
                         v
              加载非 provider 类扩展和其他资源
                         |
                         v
                    进入正常会话
```

远端配置必须在以下行为之前确定：

- 默认模型解析。
- 模型列表展示。
- 会话创建。
- provider 认证解析。
- 扩展 provider 注册进入最终 runtime。

这样可以避免本地 provider 在启动过程中短暂可见或被选中。

## 9. ModelRuntime 集成方式

核心应是顶层配置源二选一，而不是在现有 provider 合并器末尾增加一个远端覆盖层：

```ts
const managedSnapshot = managedResolver
  ? await managedResolver.resolve()
  : undefined;

const modelRuntime = managedSnapshot
  ? await ModelRuntime.create({ managedConfig: managedSnapshot })
  : await ModelRuntime.create(/* existing local arguments */);
```

关键约束：

- local mode 继续调用现有 provider composition，尽可能不修改行为。
- managed mode 不应先加载本地 provider 再删除，而应从一开始只构建远端 provider。
- managed mode 中的 provider 注册入口必须拒绝或忽略扩展注入，并给出可诊断但不泄密的提示。
- 非 provider 类扩展仍可正常加载，不应因为 managed mode 被整体禁用。

前期代码调查显示，开发时应重点重新核对以下区域的当前实现：

- `packages/coding-agent/src/core/model-runtime.ts`
- `packages/coding-agent/src/core/provider-composer.ts`
- 本地 `ModelConfig`/`models.json` 加载逻辑
- `auth.json` 和环境变量凭证解析逻辑
- 扩展的 provider 注册入口
- Pi 启动阶段创建 `ModelRuntime` 的位置

具体文件和 API 可能随上游版本变化，实施前需要以目标 checkout 的当前源码为准。

## 10. 失败和缓存语义

必须遵守的底线：managed mode 发生错误时，绝不能静默回退到 local mode。

建议采用 last-known-good 远端缓存：

| 场景 | 行为 |
| --- | --- |
| 拉取成功且配置有效 | 原子启用新配置，并更新远端缓存 |
| 拉取成功但配置无效 | 拒绝新配置；如允许缓存则使用有效旧缓存，否则启动失败 |
| 拉取失败且存在有效远端缓存 | 使用上一份远端缓存启动 |
| 拉取失败且没有有效远端缓存 | 启动失败并给出明确错误 |
| 本地 provider 配置存在 | 在 managed mode 中始终忽略，不作为降级来源 |

缓存仍然属于 managed config，不是本地 provider 配置。由于缓存包含 API key，需要：

- 使用仅当前用户可读写的文件权限。
- 原子写入，避免进程中断产生半份配置。
- 校验缓存版本和结构。
- 禁止在日志、异常、debug dump 中输出明文 API key。

第一版已实现 last-known-good 缓存。默认路径为 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/managed-config-cache.json`；缓存以 `0600` 权限原子写入，绑定配置服务 URL，并在读取时重新校验版本、大小、文件类型、权限和完整 schema。“失败时不回退到本地 provider”的边界保持不变。

## 11. 配置服务鉴权与 Provider 鉴权

需要明确区分两类凭证：

```text
bootstrap credential
  仅用于 Pi -> 远端配置服务的请求

provider apiKey
  来自远端配置，仅用于 Pi -> 模型 Provider 的请求
```

“managed mode 不使用本地 auth”特指 provider 认证。配置服务若需要鉴权，仍需要一个最小的启动凭证，但它不能参与 provider/model 解析。

## 12. 安全要求

- 生产环境配置地址必须使用 HTTPS。
- API key 不得出现在普通日志、错误堆栈、遥测、配置摘要和测试快照中。
- 配置响应和缓存应按敏感数据处理。
- HTTP 错误只报告状态、地址和可行动原因，不打印响应中的敏感字段。
- 远端配置必须有明确 schema/version，不能对未知结构宽松合并。
- 应限制响应大小并设置连接和请求超时，避免启动无限等待。
- managed mode 下不得通过环境变量插值绕回本地 provider credential。

## 13. 明确不做的功能

本次不实现：

- 运行时热更新。
- WebSocket、SSE、长轮询或定时刷新。
- 远端与本地 provider 混用。
- 同名 provider 的覆盖/合并规则。
- `providerPolicy`、allowlist 或 denylist。
- 使用本地 `auth.json` 为远端 provider 提供认证。
- 使用 provider 环境变量为远端 provider 提供认证。
- 远端配置缺失时回退到本地 provider。
- 新的 `pi-managed` 命令或单独发行物。
- 在 Pi 内实现管理 Web UI。

## 14. 实施结果

1. 已定义 managed config schema 和内部类型，并复用现有 provider/model 字段。
2. 已实现 `ManagedConfigResolver` 的 HTTP 获取、校验、超时、大小限制和错误脱敏。
3. 已在 Pi 启动阶段接入 resolver，并在创建 `ModelRuntime` 前确定配置源。
4. 已为 `ModelRuntime` 增加 managed-only 构造路径，不执行本地 provider composition。
5. 已在 managed mode 中屏蔽 `models.json`、内置 provider、`auth.json`、provider 环境变量和 OAuth 登录。
6. 已在 managed mode 中忽略扩展注册的 provider 并输出诊断，同时保留非 provider 扩展能力。
7. 已实现 last-known-good 远端缓存。
8. 已增加 CLI、环境变量、SDK 入口、帮助文本和用户文档。
9. 已增加 schema、缓存、运行时隔离、扩展隔离和 CLI 参数测试。

## 15. 验收标准

### 15.1 向后兼容

- 未配置 managed config 时，Pi 当前 provider、model 和认证行为不变。
- 现有 `models.json`、`auth.json`、环境变量和扩展测试继续通过。

### 15.2 完整隔离

- managed mode 下，即使机器上存在有效的本地 `models.json`，也看不到其中的 provider/model。
- managed mode 下，即使 `auth.json` 中存在可用登录态，也不会被用于 provider 请求。
- managed mode 下，即使设置了 provider API key 环境变量，也不会被读取作为 provider 凭证。
- managed mode 下，Pi 内置 provider 不出现在模型列表中。
- managed mode 下，扩展无法把本地 provider 注入最终 runtime。

### 15.3 远端调用

- 远端返回的 custom provider 和 model 能出现在 Pi 模型列表中。
- Pi 能仅使用远端下发的 `baseUrl`、协议配置和 `apiKey` 完成一次真实模型请求。
- 远端 provider 列表发生变化后，重启 Pi 才加载新配置。
- Pi 运行期间不会再次请求配置服务。

### 15.4 失败行为

- 配置不可达、超时、HTTP 错误、JSON 错误和 schema 错误都有明确诊断。
- 无可用远端配置时启动失败，不回退到 local mode。
- 如果实现缓存，断网时只允许使用上一份有效的远端缓存。
- 所有错误路径均不会泄露 API key。

## 16. 最终设计结论

本次改造的本质不是给现有 provider 合并逻辑再增加一个远端层，而是给 Pi 增加两个互斥的配置源：

```text
没有 ManagedConfigResolver
  -> Pi 保持现有本地行为

启用 ManagedConfigResolver
  -> 启动时获取一次远端完整快照
  -> 只构造远端 custom providers
  -> provider API key 只来自远端配置
  -> 完全屏蔽本地 provider 和本地 provider 认证
```

这一边界应贯穿实现、测试和文档，避免后续又演化成复杂的 provider 策略或本地/远端混合模式。
