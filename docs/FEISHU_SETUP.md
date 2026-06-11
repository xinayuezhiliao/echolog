# Feishu / Lark setup — paste-ready

飞书机器人配置指南（**照抄即可，不用猜**）。控制台在 https://open.feishu.cn ，按钮名用「中文引号」标出。
Set up the echolog Feishu bot in ~5 minutes. Console: https://open.feishu.cn

---

## 1. 创建应用 + 拿凭证 / Create app & credentials

「开发者后台」→「创建企业自建应用」→ 填名称（如 *日记助手*）和头像。
进「凭证与基础信息」，复制 **App ID** 和 **App Secret** 填进 `.env`：

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## 2. 权限 / Permissions（最省事：批量导入）

「权限管理」→ 右上「批量开通权限」→ 把下面整段粘进去 → 开通：

```
im:message
im:message:send_as_bot
im:resource
im:chat
im:message.reaction:write
docx:document:readonly
```

| 权限 | 干嘛用的 |
|---|---|
| `im:message` / `im:message:send_as_bot` | 收消息 / 以机器人身份回消息 |
| `im:resource` | 下载你发的图片 / 语音 / 文件 / 视频 |
| `im:chat` | 读会话信息（catchup 补历史用） |
| `im:message.reaction:write` | 处理完给你的消息打 ✅ 表情当已读标记（失败不影响主流程） |
| `docx:document:readonly` | `/doc-import` 拉飞书云文档用（基础收发消息不需要） |

> **云文档授权**：开通了 `docx:document:readonly` 后，第一次 import 某份云文档时，还要去该文档 **「…」→「…更多」→「添加文档应用」** 把本 bot 加进去（不然 API 会返 403）。

## 3. 事件订阅 / Event subscription

「事件与回调」→「订阅方式」选 **使用长连接接收**（不用配公网 URL，本地直接跑）。
然后「添加事件」，订阅这两个：

```
im.message.receive_v1      # 收到消息（核心）
application.bot.menu_v6     # 机器人菜单被点击（让下面那排菜单按钮能用）
```

## 4. 机器人菜单 / Bot menu（那排 /today /diary 按钮）

「应用功能」→「机器人」→ 打开「机器人自定义菜单」。每个菜单项：**类型选「推送事件」**，
`event_key` 按下表填（**就是命令名，不带斜杠**）。echolog 收到点击会自动映射成 `/命令` 执行：

| 菜单名称（随你写） | event_key（照填） | 点击后 |
|---|---|---|
| 今日 | `today` | 回看今天的原始记录 |
| 列表 | `list` | 最近 14 天概览 |
| 写日记 | `diary` | 生成今天的结构化日记 |
| 周报 | `week` | 过去 7 天周报 |
| 任务 | `tasks` | 滴答清单今日上下文（启用了才有） |
| 帮助 | `help` | 全部命令说明 |

> 带参数的命令（`/show 日期`、`/find 关键词`、`/recall 主题`、`/draft <id>`）直接在对话里**打字**发，不放菜单。

## 5. 发布 / Publish

「版本管理与发布」→「创建版本」→ 填版本号 → **申请发布** → 企业管理员审批后即上线。
（自己是管理员的话秒批。）改了权限/事件/菜单后**都要重新发版**才生效。

## 6. 配对 + 开跑 / Pair & run

```bash
echolog start        # 启动（长连接）
echolog logs -f      # 看日志，等 “🟢 WS 长连接已就绪”
```

在飞书里**私聊机器人发任意一条消息** → 它把你锁为唯一主人（之后别人发的一律忽略），
并记下你的 p2p 会话（菜单点击回信要用）。然后点菜单「写日记」或打字 `/diary` 试试。

## 故障排查 / Troubleshooting

| 现象 | 排查 |
|---|---|
| 发消息没反应 | ① 事件订阅是否选了**长连接** + `im.message.receive_v1`；② 应用**发版**了吗；③ 改完配置 `echolog restart` 重连握手 |
| **菜单点了没反应** | ① 订阅了 `application.bot.menu_v6` 吗；② 菜单项类型是「推送事件」、`event_key` 是 `diary` 这种**纯命令名**吗；③ 先给 bot **发过至少一条消息**（才会记下回信用的 chat_id）；④ 重新发版 |
| 下图片/语音失败 | 缺 `im:resource` 权限，加上重新发版 |
| 表情已读没打上 | 缺 `im:message.reaction:write`；这个失败不影响主流程，可忽略 |
