# 本地部署步骤

状态：部分部署已实际执行，最新证据见 ACCEPTANCE.md；以下步骤用于复现。执行目录以终端当前工作区为准，不依赖个人绝对路径。

## 1. 前置检查

在项目根目录运行 `npm run check`。准备 Node.js、Git、Docker Desktop 和 macOS Ollama 应用。当前机器是 M3 Pro / 18 GiB，建议先给 Docker 约 4 GB 内存，再根据实测调整。

Ollama 从 [官方 macOS 下载页](https://ollama.com/download/mac) 安装到 Applications，首次打开按提示配置命令行。检查：

```bash
node --version
docker compose version
ollama --version
```

Ollama 原生运行以使用 Apple GPU；Convex 使用容器。模型首次下载需要网络和磁盘，模型文件大小不等于运行内存。官方说明见 [macOS](https://docs.ollama.com/macos)、[FAQ](https://docs.ollama.com/faq)。

## 2. 运行 Ollama

退出菜单栏中的 Ollama 应用后，在单独终端运行，保持该终端开启：

```bash
OLLAMA_NUM_PARALLEL=1 \
OLLAMA_MAX_LOADED_MODELS=2 \
OLLAMA_KEEP_ALIVE=30m \
OLLAMA_NO_CLOUD=1 \
ollama serve
```

在另一个终端、项目根目录执行：

```bash
ollama pull qwen2.5:7b
ollama pull mxbai-embed-large
ollama create town-qwen -f models/Modelfile
ollama list
```

`models/Modelfile` 固定 8192 上下文和默认温度；调用方仍可能覆盖温度或输出参数，正式实验要记录实际请求。模型名称和文件来源见 [Qwen2.5 7B](https://ollama.com/library/qwen2.5:7b)、[Modelfile](https://docs.ollama.com/modelfile)。

## 自动诊断命令

根目录运行 `npm install`、`npm run tokenizer:setup` 后，模型下载完成即可执行 `npm run stage1`。该流程创建模型别名，先检查实际 4K/8K 窗口、生成接口和向量，再运行开发题与验收题。结果保存到 artifacts/local，未通过时退出码为 1。题集独立人工审核仍是额外验收条件。

单独运行：`npm run model:check`；`npm run model:pilot -- --config configs/model-pilot.development.json`；`npm run model:pilot`。

## 3. 接口验证

生成接口：

```bash
curl -fsS http://127.0.0.1:11434/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"town-qwen","messages":[{"role":"user","content":"你是咖啡店老板，用一句话向邻居问好。"}],"max_tokens":100,"stream":false}'
```

向量接口：

```bash
curl -fsS http://127.0.0.1:11434/api/embed \
  -H 'Content-Type: application/json' \
  -d '{"model":"mxbai-embed-large","input":"咖啡店早上八点开门。"}' \
  | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(JSON.parse(s).embeddings?.[0]?.length))'

ollama ps
```

应分别看到有效对话文本、维度 `1024`、模型加载信息。若接口报错或维度不同，先排查，不继续初始化数据库。这里未实现自动 smoke test；需要记录实际结果。

## 4. 下载上游

从研究项目根目录执行：

```bash
git clone https://github.com/a16z-infra/ai-town.git ai-town
cd ai-town
git rev-parse HEAD
npm install
open -a Docker
```

如果 `ai-town/` 已存在，先检查来源和工作区，不覆盖或重新初始化。等待 Docker 就绪后运行 `docker info`。克隆默认分支仅用于首轮搭建；正式实验必须固定 commit、依赖锁文件和镜像 digest。

## 5. 处理端口并启动 Convex

在上游 `docker-compose.yml` 的 backend ports 中，删除如下映射（若当前版本仍存在）：

```yaml
- '${OLLAMA_PORT:-11434}:11434'
```

宿主机 Ollama 已使用 11434；backend 通过 `host.docker.internal` 访问它，不需要发布此端口。其余改动按实际版本核对，不复制旧配置覆盖新配置。

在 `ai-town/` 执行：

```bash
docker compose up -d backend dashboard
docker compose ps
curl -fsS http://127.0.0.1:3210/version
docker compose exec backend curl -fsS http://host.docker.internal:11434/api/tags
docker compose exec backend ./generate_admin_key.sh
```

前端稍后使用宿主机 Node 启动，当前不启动 Compose 的 frontend 服务。

## 6. 环境配置

仅在尚无 `.env.local` 时，在 `ai-town/` 执行：

```bash
cp ../configs/ai-town.env.example .env.local
```

将 `CONVEX_SELF_HOSTED_ADMIN_KEY` 替换为刚生成的值。已有配置手工合并，不能覆盖。该密钥只用于本地 Convex，不提交、不写入实验日志。

设置后端环境，再发布函数和初始化角色：

```bash
npx convex env set OLLAMA_HOST http://host.docker.internal:11434
npx convex env set OLLAMA_MODEL town-qwen
npx convex env set OLLAMA_EMBEDDING_MODEL mxbai-embed-large
npx convex dev --once
npx convex run init '{"numAgents":5}'
```

第一次先不用 `npm run dev`，因为上游 predev 会调用默认初始化。`numAgents` 只用于首次创建，不会自动缩减已有世界人数。检查 `convex/util/llm.ts` 使用 Ollama 对应的 1024 维默认值；不要混入云端 provider 的环境变量。

## 7. 运行界面与验收

在 `ai-town/` 开两个终端，分别执行：

```bash
npm run dev:backend
```

```bash
npm run dev:frontend
```

- 小镇：`http://localhost:5173`。
- 数据面板：`http://localhost:6791`，用本地管理密钥登录。
- 验收：5 人能交谈；产生记忆和向量；运行 30 分钟；重启后数据仍在。
- 正式后台实验需要处理空闲暂停并加入明确停止条件，详见 EXPERIMENTS.md。

## 8. 暂停、恢复与排查

以下命令按需要单独运行，均在 `ai-town/`：

```bash
npx convex run testing:stop
npx convex run testing:resume
docker compose stop
```

不要把 `down -v` 或 wipeAllTables 当作日常停止操作，它们会涉及数据清除。

本工作区已接入 P3 网关，小镇的实际 OLLAMA_HOST 是 `http://host.docker.internal:11435`；不要执行前文初次部署的 11434 配置覆盖它。服务关闭后的恢复顺序：

1. 启动 Ollama 应用，确认 `curl -fsS http://127.0.0.1:11434/api/version` 成功。
2. 检查 `curl -fsS http://127.0.0.1:11435/health`。若不可访问，在根目录执行 `npm run gateway`；若 `admissionOpen:false`，先用原终端 Ctrl+C 结束旧实例，再启动。不要在占用端口时重复启动。
3. 在 `ai-town/` 执行 `npx convex run testing:resume`，然后在根目录执行 `npm run town:observe`。固定验收不能把中断前后拼接成连续 30 分钟。
4. 使用输出的 run 目录执行 `npm run stage2:report -- <run目录> --wait`，等待停止和请求排空后的完整结论。观察结束会自动停止世界。

当前前端地址为 `http://127.0.0.1:5174/ai-town/`，初次部署示例的 5173 当时被其他服务占用。

| 现象 | 排查顺序 |
| --- | --- |
| 11434 占用 | 确认只启动一个 Ollama 服务，且删除 backend 发布项 |
| 本机正常但容器无法连接 | 检查 host.docker.internal；必要时仅在可信网络以 `OLLAMA_HOST=0.0.0.0:11434` 重启相同服务参数，并限制外部访问 |
| 要求 Convex 云端登录 | 检查执行目录、`.env.local` 和自托管 URL/密钥 |
| 模型响应慢或超时 | 观察 `ollama ps`、内存压力、排队和重载；先减少负载，不无限提高超时 |
| 维度错误 | 检查模型和索引版本；不要直接删除已有实验数据 |
| 小镇停止互动 | 区分空闲暂停、模型错误、队列积压和引擎状态 |

最终部署以固定版本的 [AI Town README](https://github.com/a16z-infra/ai-town)、[源码](https://github.com/a16z-infra/ai-town/blob/main/convex/util/llm.ts)、[Convex CLI](https://docs.convex.dev/cli) 为准。README、模型文件和镜像可能变化，P1 需记录遇到的兼容修复。
