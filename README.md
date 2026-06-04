# Lark CC

基于 [Agentara](https://github.com/MagicCube/agentara) 的飞书 × Claude Code 桥接工具。

Agentara 是 7x24 个人助手架构，Lark CC 在此基础上增加了增强的卡片渲染 + 飞书桥接启动层。

## 架构

```
Agentara 核心层:
  Kernel → SessionManager → TaskDispatcher → MessageGateway → FeishuMessageChannel

Lark CC 增强:
  src/card/                              -- 分阶段卡片渲染（推理段展示、Tool 面板）
  src/bridge/                            -- 飞书桥接启动入口
```

## 基于 Agentara

本项目 fork 自 [MagicCube/agentara](https://github.com/MagicCube/agentara)，保留了：
- 事件驱动架构（EventEmitter3）
- Session 管理与 JSONL 持久化
- Bunqueue 任务调度
- Claude Code / Codex AgentRunner
- Hono REST API + Web Dashboard

新增：
- `src/card/` — 增强的分阶段推理卡片渲染（phase-specific 图标、折叠面板、Tool 状态跟踪、中止按钮）
- CLI 启动入口

## 快速开始

```bash
# 安装依赖
bun install

# 配置飞书 App
# 编辑 ~/.agentara/config.yaml

# 启动
AGENTARA_HOME=~/.agentara bun run index.ts
```

## License

MIT
