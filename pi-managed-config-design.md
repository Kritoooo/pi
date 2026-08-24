# Pi 远端托管配置改造说明

## 1. 文档用途

本文档用于把已经确认的需求交接给新的开发对话。目标是在 Pi 中原生增加远端托管配置能力，同时保持默认本地使用方式完全兼容。

本文档描述的是 Pi 客户端侧改造。远端 Web 管理界面和配置服务是独立系统，不需要嵌入 Pi。

实施状态（2026-08-24）：客户端采用严格的 version 1 完整快照。进入 managed mode 后，远端是所有托管设置和资源的唯一来源；缺少必要顶层字段、引用无效或快照不完整时直接启动失败，不使用本地内容补齐。第一版包含启动时单次拉取、managed-only `ModelRuntime`、扩展 provider 隔离、按故障类型启用的 last-known-good 缓存、CLI/环境变量/SDK 入口、远端安全运行时设置、system/append prompt、context files，以及 Skills/Extensions 下发和私有物化。

## 2. 核心目标

给现有 `pi` 增加一个可选的 `ManagedConfigResolver`：

- 未启用远端配置时，Pi 完全保持现有本地行为。
- 启用远端配置时，Pi 在进程启动阶段拉取一次配置。
- 远端配置是 provider 和 model 的唯一来源，不与本地配置合并。
- 远端模式只支持由远端定义的 custom provider。
- custom provider 的 API key 必须由远端配置提供。
- 运行期间不热更新配置。
- 指定远端 URL 后，远端快照是托管设置和资源的完整来源；本地设置和资源不能补齐远端快照，显式 CLI 选项仍优先。
- Project Trust 不由远端下发，始终由每台机器的本地信任存储和本地 CLI 选项决定。

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

远端 `settings`、system/append prompt、context files、Skills 和 Extensions 使用同一份启动快照；`/reload` 不重新拉取。优先级为：显式 CLI 选项、远端快照、产品内置默认值。本地自动配置和资源不参与 managed mode。`--no-context-files` 也会抑制远端 context files。

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
| 托管范围内的本地 settings | 正常读取 | 忽略 |
| 项目 settings | 按 Project Trust 读取 | 忽略 |
| 本地 system/append prompt 和 context files | 正常发现 | 忽略 |
| 本地/package/自动发现的 Skills/Extensions | 正常发现 | 忽略 |
| 本地 prompt templates/themes | 正常发现 | 忽略 |
| 本地 keybindings | 正常读取 | 忽略，使用内置按键默认值 |
| 远端 Skills/Extensions | 不适用 | 从完整快照加载 |
| 显式 CLI 资源路径 | 正常加载 | 仍可显式覆盖本次运行 |
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
--no-managed-config       / PI_MANAGED_CONFIG_DISABLED
```

入口保持以下语义：

- 没有 managed config URL：进入 local mode。
- 存在 managed config URL：进入 managed mode。
- 本地 bootstrap 配置不能定义或补充 provider。
- `--no-managed-config` 或 `PI_MANAGED_CONFIG_DISABLED=1/true/yes` 会跳过远端 URL，强制使用本地来源。

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
  ],
  "settings": {},
  "systemPrompt": null,
  "appendSystemPrompt": [],
  "contextFiles": [],
  "skills": [],
  "extensions": []
}
```

第一版应坚持完整快照语义：

- `version`、`providers`、`settings`、`systemPrompt`、`appendSystemPrompt`、`contextFiles`、`skills` 和 `extensions` 都是必要顶层字段。
- `providers` 是非空完整列表。
- 每个 provider 的 `models` 是完整列表。
- 不支持 patch、继承或删除标记。
- 不支持引用本地 provider 或本地凭证。
- `apiKey` 由远端响应直接提供，不解析成本地环境变量名。
- 空内容必须显式使用 `{}`、`[]` 或 `null`；省略字段属于 schema 错误，Pi 拒绝启动。

安全的运行时设置放在顶层 `settings` 中，并通过 `systemPrompt`、`appendSystemPrompt` 和 `contextFiles` 下发提示词与文字上下文。顶层 `skills` 和 `extensions` 下发严格校验的多文件文字包；Pi 将它们物化到 agent 私有的 content-addressed 目录，不安装 npm/git 依赖。`settings` 内部未声明的可选项使用产品内置默认值，不读取本地同名设置。`defaultProjectTrust`、本地路径和包来源不属于该快照。

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
              原子物化并加载远端 Skills/Extensions
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
| 拉取成功但 JSON/schema/引用无效 | 直接启动失败，不使用旧缓存掩盖发布错误 |
| HTTP 401/403/404 等认证或路由错误 | 直接启动失败，不使用旧缓存 |
| 拉取失败且存在有效远端缓存 | 使用上一份远端缓存启动 |
| 拉取失败且没有有效远端缓存 | 启动失败并给出明确错误 |
| 本地 provider 配置存在 | 在 managed mode 中始终忽略，不作为降级来源 |

缓存仍然属于 managed config，不是本地 provider 配置。由于缓存包含 API key，需要：

- 使用仅当前用户可读写的文件权限。
- 原子写入，避免进程中断产生半份配置。
- 校验缓存版本和结构。
- 禁止在日志、异常、debug dump 中输出明文 API key。

第一版已实现 last-known-good 缓存。默认路径为 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/managed-config-cache.json`；缓存以 `0600` 权限原子写入，绑定配置服务 URL，并在读取时重新校验版本、大小、文件类型、权限和完整 schema。只有离线模式、连接失败、超时、HTTP 408/425/429 和 HTTP 5xx 等可用性故障允许读取缓存。服务端成功返回但内容错误时必须显式失败。

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
- 远端 extension 会在启动时执行代码，因此 managed URL 是代码信任根；Project Trust 只约束项目本地资源，不能批准或拒绝远端 extension。
- 远端资源路径必须是可移植的相对 POSIX 路径，并拒绝路径穿越、符号链接复用、大小写重复、文件/目录冲突和非私有物化目录。

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
- 远端下发 Project Trust；信任状态是机器本地安全决策。

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
10. 已增加远端运行时 settings、prompt/context 必要快照字段、显式 managed mode 退出开关，并保持 Project Trust 本地化。
11. 已增加远端多文件 Skills/Extensions、私有 content-addressed 物化、必要完整集合、CLI 优先级、空集合禁用和本地篡改 fail-closed 校验。
12. 已在 managed mode 中屏蔽项目 settings、本地 prompt/context、自动发现资源和本地 keybindings；远端未声明的可选设置只使用产品内置默认值。
13. 已将缓存降级限制为远端可用性故障；无效发布、认证失败和路由错误不会回退到旧缓存。

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
- 远端默认模型、thinking level、default tools、运行时 settings、system/append prompt 和 context files 在启动时生效。
- 指定 `--no-managed-config` 或 `PI_MANAGED_CONFIG_DISABLED=1` 后，不请求远端且保留本地行为。
- `settings`、prompt/context、`skills` 和 `extensions` 缺少任一必要顶层字段时启动失败；空数组表示远端明确发布空集合，显式 CLI 路径仍优先。
- managed mode 不读取项目 settings、本地 prompt/context、package 或自动发现的资源，也不读取本地 keybindings。
- 远端 extension 的非 provider 能力正常加载，其 provider 注册仍被 managed-only `ModelRuntime` 忽略。
- Pi 运行期间不会再次请求配置服务。

### 15.4 失败行为

- 配置不可达、超时、HTTP 错误、JSON 错误、schema 错误和无效引用都有明确诊断。
- 无可用远端配置时启动失败，不回退到 local mode。
- 断网和临时服务不可用时只允许使用上一份有效的远端缓存；远端返回无效发布或非临时 4xx 时直接失败。
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
  -> 远端安全运行时设置、prompt/context 和 Skills/Extensions 是完整来源
  -> 省略必要字段或发布无效引用时直接失败，不从本地或旧缓存补齐
  -> 本地自动资源、项目 settings 和本地 keybindings 不参与 managed mode
  -> Project Trust 仍由本地信任边界决定
```

这一边界应贯穿实现、测试和文档，避免后续又演化成复杂的 provider 策略或本地/远端混合模式。

## 17. P1 规划

P1 的目标是让 managed mode 能远端管理跨机器可移植的行为和文字资源，同时保留必须由本机决定的引导、信任、路径和执行边界。

### 17.1 P1-0：配置中心协议同步与客户端先升级

继续使用 `version: 1` 和现有 `/v1/config` 端点，不增加 v2、双端点或协议协商。

不增加兼容层：

- 新版 Pi 只接受包含全部必要顶层字段的完整 v1 快照。旧配置中心返回的 provider-only v1 快照会被拒绝。
- 旧版 Pi 不需要支持配置中心发布的完整 v1 快照。
- 发布顺序必须是先升级所有使用该远端 URL 的 Pi 客户端，再让配置中心开始输出完整字段。升级窗口内旧配置中心不可用是已接受的代价。

配置中心需要从当前 Pi 版本更新 vendor schema、渲染、预检、编辑界面和发布历史。同时增加自动协议漂移检查，至少用共享 schema 快照或共同 fixture 保证“配置中心允许发布”与“新版 Pi 允许启动”一致，不再只依赖手工核对 vendor commit。

### 17.2 P1-1：可移植的声明式资源

P1 在 v1 快照中继续增加以下远端内容：

| 资源 | 远端形状 | 加载边界 |
| --- | --- | --- |
| Keybindings | action ID 到 key/key[] 的映射 | 校验 action ID 和按键语法，作为进程级 override，`/reload` 后仍保留 |
| Prompt templates | `name` / `description` / `argumentHint` / `content` | 直接构造内存模板，不映射成客户端路径 |
| Themes | `name` 与严格 Theme JSON | 复用现有 theme parser，不加载远端 JavaScript |
| Skills | `name` 与 `files[]` 文字包，根目录必须有 `SKILL.md` | 已实现私有目录原子物化；支持文字脚本/引用文件和 owner-only executable 位 |
| Extensions | `name` / `entry` / `files[]` 文字包 | 已实现 `.ts`/`.js` 入口和相对包内导入；不安装 npm/git 依赖；managed URL 是代码信任根 |
| Skill commands | `settings.enableSkillCommands` | 作为安全的运行时布尔设置纳入 managed settings |

集合字段使用完整快照语义：

- 当前已支持的 `skills` 和 `extensions` 是必要字段，也是该资源类型的完整托管集合；空数组表示明确发布空集合。
- 后续增加 keybindings、prompt templates 和 themes 时，同样直接纳入必要完整快照，不增加字段缺失时的本地回退。
- 显式 CLI 资源参数优先于远端；`--no-skills`、`--no-extensions`、`--no-prompt-templates`、`--no-themes` 和 `--no-context-files` 同样可以在单次运行中抑制对应远端资源。
- 远端资源与 provider/settings 使用同一份启动快照；`/reload` 不重新请求配置中心。
- Skills/Extensions 的名称、入口、frontmatter、文件总数和可移植路径在启动前严格校验；物化目录复用前校验精确文件集、内容、类型和 POSIX 权限，检测到本地修改后 fail closed。

### 17.3 P1-2：按机器选择远端 Profile

不同机器可能需要不同的 keybindings、theme、模型和资源集。这个差异不应在 Pi 客户端内实现 overlay 或 providerPolicy。

配置中心将 bootstrap token 绑定到一个 `profileId`，并直接返回该 profile 已解析的完整快照。Pi 仍只看到一份快照，不知道 profile 继承、差异或目标规则。不使用客户端上报的 hostname 作为信任依据。

Profile 适合处理跨机器的远端配置差异，但不代替 Project Trust。Project Trust 仍然按本机和工作目录保存在本地 `trust.json`，远端 profile 不得下发 `defaultProjectTrust` 或具体仓库的信任结果。

### 17.4 P1-3：快照身份、新鲜度与可观测性

配置中心已经保存单调版本、发布时间和 payload SHA-256，分发路由也已返回 ETag，但 Pi 客户端当前会丢弃这些响应元数据。P1 将其纳入运行时和缓存：

- 响应头增加并校验 revision、published-at 和 expires-at，ETag 作为 payload digest。
- 缓存记录上述元数据；过期缓存不得无限期启动，具体 TTL 由服务端发布策略决定。
- 客户端为每个端点记录已接受的最高 revision，拒绝较低版本的远端回放。配置中心回滚时继续发布新的更高 revision。
- `ManagedConfigResolution` 和启动诊断显示 `remote/cache`、schema 版本、revision、digest 前缀、缓存年龄和过期时间，不显示 token、provider key 或快照正文。
- 客户端请求可以上报 Pi 版本和支持的 schema 版本，用于配置中心诊断；默认不上报 hostname 或稳定机器 ID。

当配置会经过不可信存储或离线分发时，可再增加 Ed25519 脱离签名和本地预置公钥。对当前 HTTPS + Bearer token + 同一 Worker 渲染与分发的单人部署，签名不是 P1 主链路：若签名私钥也在同一个已被攻陷的 Worker 中，它不能防止攻击者签发恶意快照。

### 17.5 P1 不远端下发的内容

| 内容 | 原因 |
| --- | --- |
| Managed URL、bootstrap token、本地回退开关 | 它们是取得远端快照之前必须存在的最小引导配置 |
| Project Trust / `trust.json` | 是本机对具体工作目录的信任结果 |
| `externalEditor`、`shellPath`、`sessionDir`、`httpProxy` | 依赖本机路径、网络或可能含本地凭据 |
| `shellCommandPrefix`、`npmCommand` | 会改变本机执行的命令，不属于声明式配置 |
| `lastChangelogVersion`、`trackingId` | 本地内部状态或本地生成标识 |
| npm/git packages | 会安装外部供应链内容；远端 Extensions 只允许快照内文字文件和 Pi 已支持的模块，不执行包安装 |
| 二进制 skill/extension 附件 | 当前快照只承载文字内容，避免额外编码、平台和扫描边界 |
| 会话、历史、本地缓存 | 是本机运行状态，不是发布配置 |

运行时热更新、WebSocket/SSE/polling、本地与远端 provider 混合和 providerPolicy 仍不进入 P1。

### 17.6 实施顺序与完成标准

建议实施顺序：

1. 定稿严格完整的 v1 schema，不支持旧 provider-only 快照。
2. 同步配置中心 vendor、数据模型、渲染、预检和编辑 UI。
3. 已实现多文件 Skills/Extensions 的严格校验、私有物化和加载；继续实现 keybindings、prompt templates 和 themes。
4. 增加 token 到 profile 的服务端选择和远端快照元数据。
5. 完成 source、packed release、安装后 CLI 和真实 provider/cliproxy 的端到端验收。

P1 完成时必须满足：

- 新版 Pi 只接受新配置中心的完整 v1 快照；旧 provider-only 快照和旧客户端兼容性不属于目标。
- 除本地 bootstrap、Project Trust 和机器状态外，组织级 provider/model、安全 settings、prompts/context、keybindings、prompt templates、themes、Skills 和 Extensions 都可由远端完整下发。
- 必要字段缺失、空集合、本地禁用参数和 profile 选择的语义都有单测和安装版 E2E。
- 配置不可达、过期、回放、校验失败和无有效缓存时均 fail closed，不回退到本地 provider。
- 诊断可以证明当前生效的端点、profile、schema 版本、revision、digest 和 remote/cache 来源，但不泄露凭据或快照正文。
- Project Trust 和本机路径边界未被远端绕过；远端 extension 执行明确由 managed URL 授权，provider 注册仍不能绕过 managed-only runtime。
