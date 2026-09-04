# agycli-bridge

把本机的 **Antigravity CLI**（`agy`）包装成一个 **OpenAI 兼容端点**，供 SillyTavern 等客户端使用。

不劫持 HTTP 流量、不需要 API Key —— 直接调用本地已登录的 `agy` 命令行。

```
SillyTavern  ──POST /v1/chat/completions──>  agycli-bridge  ──stdin/NDJSON──>  agy
             <────────  SSE  ─────────────                 <──── stream-json ──
```

- Node.js ≥ 20，**零依赖**
- Windows / Linux / macOS 通用
- 流式（SSE）与非流式均支持

---

## 快速开始

前置条件：已安装并登录 Antigravity CLI（终端里 `agy models` 能列出模型）。

```bash
node src/server.js
```

Windows 可直接双击 `start.bat`；Linux/macOS 用 `./start.sh`（首次需 `chmod +x start.sh`）。

启动后会打印：

```
  agycli-bridge  —  Antigravity CLI as an OpenAI-compatible API
  ----------------------------------------------------------
  endpoint      http://127.0.0.1:5599/v1
  agy           C:\Users\you\AppData\Local\agy\bin\agy.exe
  version       1.1.23
  model         claude-sonnet-4-6
  models known  14
  concurrency   2
  auth          open (no key)
```

## 接入 SillyTavern

1. API 选择 **Chat Completion**
2. 来源选择 **Custom (OpenAI-compatible)**
3. **Custom Endpoint (Base URL)** 填 `http://127.0.0.1:5599/v1`
4. **API Key** 留空（除非在 `config.json` 里设了 `apiKey`）
5. 点 **Connect**，然后在模型下拉里选一个

> 建议在 SillyTavern 里把 `Stop Sequences` 设为 `\nHuman:`，避免模型替你续写下一轮对话。

---

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/chat/completions` | 对话补全，支持 `stream: true` |
| GET  | `/v1/models` | 模型列表（启动时从 `agy models` 读取） |
| GET  | `/health` | 状态：运行时长、agy 版本、并发数 |

`/v1` 前缀可省略（`/chat/completions` 同样可用）。

### 按请求选择推理强度

在模型名后加 `:low` / `:medium` / `:high` 即可，方便只能填模型名的客户端：

```json
{ "model": "gemini-3.1-pro-high:high", "messages": [...] }
```

---

## 配置

编辑 `config.json`（支持 `//` 注释）。所有字段都能用 `BRIDGE_` 前缀的环境变量覆盖，
优先级：**环境变量 > config.json > 默认值**。

```bash
BRIDGE_PORT=8080 BRIDGE_MODEL=gemini-3.7-flash-high node src/server.js
```

常用项：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `host` / `port` | `127.0.0.1` / `5599` | 监听地址。要让局域网访问改成 `0.0.0.0` |
| `apiKey` | `""` | 非空时要求 `Authorization: Bearer <key>` |
| `agyPath` | `"agy"` | agy 可执行文件路径，默认从 PATH 查找 |
| `model` | `claude-sonnet-4-6` | 默认模型，客户端可覆盖 |
| `effort` | `""` | 推理强度 `low` / `medium` / `high` |
| `agent` | `""` | 非空时传 `--agent`，用 agy 自己的 agent 承载人设 |
| `maxConcurrent` | `2` | 同时运行的 agy 进程数，超出的请求排队 |
| `timeout` | `600` | 单次生成超时（秒） |
| `retries` | `1` | 瞬时启动失败的重试次数 |
| `systemPreamble` | 见下 | 置于系统提示词最前的任务说明 |
| `debug` | `false` | 打印 agy 命令行与事件 |

### systemPreamble 是做什么的

`agy` 自带"Antigravity 编程助手"的身份设定，角色扮演时会泄漏进回复。
`systemPreamble` 拼在客户端系统提示词前面来压制它。

**措辞很关键**：写成"忽略你的默认身份"这类对抗性指令会被模型判定为越狱，
Claude 会直接拒绝并回复 *"I'm Antigravity, your AI coding assistant — I can't be
reassigned to a different role via prompts"* —— 恰好造成你想避免的泄漏。
默认措辞把它描述成**一个创作任务**，实测 Claude 与 Gemini 都能干净通过。

---

## 工作原理

每个请求 spawn 一个 `agy` 进程，用完即弃，不复用会话。

**提示词组装**（`src/messages.js`）——整段对话被展平成**一条** user 消息：

```
<systemPreamble>

<客户端的 system 提示词>

Human: 你好
Assistant: 你好呀
System: [OOC: 简短点]
Human: 现在呢？

Assistant:
```

**进程调用**（`src/agy.js`）：

```
agy --output-format stream-json --input-format stream-json \
    --model <model> [--effort <e>] [--agent <a>] \
    --disable-slash-commands --print-timeout <t>s
```

提示词通过 **stdin** 以单行 NDJSON 送入：

```json
{"event":"user","message":{"role":"user","content":"...整段提示词..."}}
```

这样做有两个原因：绕开 Windows ~32K 的命令行长度上限；且 agy **每读一行输入就跑一个 turn**，
单行保证只消耗一次生成。

**输出解析**：只有 `step_type` 为 `agent_response` 的 `text_delta` 会转发给客户端；
`tool_use`、`system_message` 等属于 CLI 内部步骤，一律丢弃。

---

## 已知限制

- **每次请求约 13–16K 输入 token 的固定开销。** agy 会把全套工具定义塞进上下文，
  无法通过命令行关闭。这是走 CLI 而非官方 API 的固有代价。
- **首字延迟 7–15 秒。** 进程冷启动 + 上述上下文开销，无法避免。
- **不支持图片。** agy 的流式输入只接受 `text` 类型内容块。
- **不支持 prefill。** agy 只接受 `user` 事件，注入 `assistant` 事件会被忽略并告警。
- **不复用会话**，因此没有 prefix cache 收益。SillyTavern 本身会带全量上下文，
  所以功能上没有损失。
- **不支持工具调用**（tool/function calling）。

## 测试

```bash
npm test
```

覆盖提示词组装、`Assistant:` 前缀剥离、stop 序列的跨 chunk 回溯匹配、
CLI 参数构造，以及瞬时错误的重试判定。

## License

MIT
