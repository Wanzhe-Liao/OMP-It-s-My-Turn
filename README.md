# Its My Turn!

**Its My Turn!** 是一个 omp 插件：高级模型负责决策，经济模型负责执行；两者在**同一个会话、同一份上下文**中交替工作。目标是靠近成本与智能的 Pareto 前沿，而不是单纯减少 token。

## 原则

- 不创建子代理。
- 不复制会话，不生成额外 handoff 摘要。
- lead 纵览全局、统一口径、制定完整计划并处理例外。
- worker 只按 lead 的最新合同执行和验证；不擅自改变设计。
- 实际结果偏离预期、遇到阻碍或需要决策时，worker 停止执行并询问 lead。
- lead 作出决定后，worker 在同一会话中继续。

## 工作流

```text
用户任务
   ↓
LEAD：调查、消除歧义、制定执行合同
   ↓ turn_execute
WORKER：实现、运行检查、报告证据
   ↓ turn_ask（仅在需要决策时）
LEAD：分析证据、作出决定、修订合同
   ↓ turn_execute
WORKER：继续执行
```

worker 正常结束后，插件切回 lead 等待下一项任务，但不会因此额外发起一次模型请求。

### 执行合同

lead 调用 `turn_execute` 时，应提供自包含的：

1. 目标、范围和非目标；
2. 已确认的现状与证据；
3. 相关文件、约束和不变量；
4. 有序实施步骤；
5. 验收命令与预期结果；
6. 风险，以及需要交回 lead 的边界。

worker 调用 `turn_ask` 时，必须给出：需要 lead 决定的问题、预期与实际差异、已经尝试的步骤。

## 安装

### 从 GitHub 直接安装

```bash
omp plugin install github:Wanzhe-Liao/OMP-It-s-My-Turn
```

### 作为 omp marketplace 安装

```bash
omp plugin marketplace add Wanzhe-Liao/OMP-It-s-My-Turn
omp plugin install its-my-turn@wanzhe-liao-plugins
```

重启 omp 后生效。

### 本地开发链接

```bash
omp plugin link /path/to/its-my-turn
```

重启 omp 后生效。

### 单次显式加载

```bash
omp --extension /path/to/its-my-turn/index.js
```

也可以在 `~/.omp/agent/config.yml` 中配置：

```yaml
extensions:
  - /path/to/its-my-turn/index.js
```

## 使用

1. 用 `/model` 选择高级模型作为 lead。
2. 启用插件：

```text
/turn on
```

默认 worker 为 `@smol`。先通过 `/model` 的 Roles 页面设置它，或直接指定 worker：

```text
/turn on provider/economic-model
```

3. 正常描述任务。lead 完成计划后应调用 `turn_execute`，插件会在工具边界切换模型，下一次模型请求自然由 worker 接续，不额外创建唤醒 turn。
4. worker 遇到需要决策的情况时调用 `turn_ask`；插件切回 lead，lead 决策后再次调用 `turn_execute`。

命令：

| 命令 | 行为 |
| --- | --- |
| `/turn on [worker-model]` | 当前模型作为 lead，启用双模型模式 |
| `/turn status` | 查看当前角色、模型对、交接和求助次数 |
| `/turn off` | 禁用插件并恢复 lead 模型 |

## 边界

- 插件状态是**会话级**的；新会话需要重新 `/turn on`。
- 角色约束由协议和交接工具实现，不是权限沙箱；两个模型仍看到同一工具集和同一份历史。
- 交接工具应当单独调用；换模在工具边界完成，同一 agent loop 的下一次请求由新角色接续。
- 模型切换可能使供应商 prompt cache 失效。短任务或频繁求助不一定省钱，应按“验收通过任务的总成本”评估。
- 这不是自动难度路由器：lead 始终负责计划和最终决策，worker 始终负责执行。
- 如果模型切换失败，插件停止自动续跑并禁用自身，避免错误的模型悄悄接替另一角色。

## 开发

无需构建或运行时依赖：

```bash
bun test
```

入口为 `index.js`，包清单元数据位于 `package.json#omp.extensions`。
