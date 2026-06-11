# Changelog

按时间倒序，最新在最上面。

## Unreleased — 飞书云文档导入

把飞书云文档作为外部日记载体，直接灌进 echolog。

### 新增
- **`lib/feishu-doc.js`** —— 云文档导入核心库
  - `parseDocUrl(input)` —— 识别 `https://<tenant>.feishu.cn/docx/<id>` / `/docs/<id>` / `/wiki/<token>` / 裸 `doc_id` 四种输入
  - `wiki → docx` 自动 resolve：先用 `wiki/v2/spaces/get_node?token=...` 拿 `obj_token`
  - `fetchDocRaw(docId, tenantToken)` —— 调 `docx/v1/documents/{id}/raw_content` 拉纯文本
  - `splitByTimestamps(content, defaultDate)` —— 4 级时间戳识别：
    1. `**HH:MM:SS**` / `**HH:MM**` (粗体，跟现有 raw_logs 同款)
    2. 行首 `HH:MM:SS` / `HH:MM`
    3. `YYYY-MM-DD HH:MM[:SS]` (完整 ISO 自身带日期)
    4. 日期边界识别：`# YYYY-MM-DD` 标题 / `日期: YYYY-MM-DD` 行 / 文首 1500 字符内扫 ISO / 中文日期
    - 跨日切分：每段找「最近一次出现的日期标记」作 fallback，支持 `# 2026-05-30 ... **HH:MM**` `# 2026-05-31 ... **HH:MM**` 多日合并
    - 无时间戳的整篇 → 当成 `00:00:00` 一块，自动剥掉开头的日期行
  - `appendImportBlock(block, sourceDocId)` —— 落 raw_logs 格式：
    ```
    **HH:MM:SS**  正文
    > 📄 [从飞书云文档导入: <doc_id>](<doc_id>)
    ```
    每个落档块带来源标记，方便后续溯源 / 批量删
  - `importDocFromInput({input, tenantToken, defaultDate, onProgress})` —— 总入口

### feishu.js 改造
- 加 `require('./lib/feishu-doc')`
- 加 `cmdDocImport(chatId, arg)` 函数：进度回报 + 异常兜底(403 提示去云文档把 bot 加为可读应用)
- `tryDispatchCommand` 加 `/doc-import` 和 `/import-doc` 两个分支
- `/help` 帮助页加「飞书云文档导入」段落

### docs/FEISHU_SETUP.md 补充
- 权限批量导入列表加 `docx:document:readonly` 一行
- 表格加一行说明该权限的用途
- 末尾注释「云文档授权」流程：开通权限后还要去云文档里「添加文档应用」加 bot

### 已知前置
- 飞书 app 需要开通 `docx:document:readonly` 权限并重发版
- 第一次 import 某份云文档时，文档右上「…」→「…更多」→「添加文档应用」→ 加上 bot
- 文档作者必须是同租户、有分享权限的账号

### 单元测试覆盖
- `parseDocUrl` 7 例：docx / wiki / docs / 裸 ID / 错域名 / 空
- `splitByTimestamps` 5 例：跨日切分 / 无时间戳 / 完整 ISO / 中文日期 / 错格式

## v0.4.0 (2026-05-28) — Prompt 全配置化

朋友实测反馈后的迭代：把所有写死的 prompt 都抽出来走文件 + GUI 编辑。
方便给不同用户分别定制 voice / 工作场景模板，又保留默认开箱即用。

### 新增 7 个 prompt 文件（共 8 个已模板化的 prompt）
- `prompts/weekly_v1.md` —— /week 周报（含 {{CORPUS}} 占位符注入数据源）
- `prompts/drafts_twitter_v1.md` —— /draft 推特串
- `prompts/drafts_long_v1.md` —— /draft 长文
- `prompts/drafts_video_v1.md` —— /draft 短视频
- `prompts/self_review_single_v1.md` —— self-review 单日审稿
- `prompts/self_review_advice_v1.md` —— self-review 改 prompt 建议（含 {{PER_DAY_RESULTS}} 等占位符）
- `prompts/vision_describe_v1.md` —— 视觉模型解析图片（SYSTEM 段允许为空）

### lib/prompts.js 升级
- PROMPT_REGISTRY：注册所有 prompt name + 中文标签 + 描述
- ENV_KEY / DEFAULT_VERSION：每个 prompt 都对应一个 env 变量 + 默认 v1
- listAllPromptNames()：给 GUI / doctor 用
- loadPromptPair 放宽：`## SYSTEM` 段可选（vision_describe 不需要 system）
- 「（视觉模型直接走...）」这种纯说明文本视为空 SYSTEM，自动跳过 system message

### bot 主进程 callers 改造
- `feishu.js` 视觉解析 prompt → 走 loadPromptPair('vision_describe')
- `feishu.js` 周报 prompt → 走 loadPromptPair('weekly', undefined, { CORPUS })
- `lib/drafts.js` SHARED_VOICE/TWITTER/LONGFORM/VIDEO 全删 → loadDraftPrompt(format)
- `lib/self-review.js` SINGLE_DAY_PROMPT/ADVICE_PROMPT 全删 → loadPromptPair

### GUI 升级
- **PromptsView**：顶部 dropdown 切 prompt 类型（8 选 1）+ 下方版本列表 + 新建版本
  - 切换时未保存改动会弹 confirm
  - footer 提示「必须含 ## TEMPLATE；支持 {{USER_NAME}} / {{CORPUS}} 等」
- **ConfigView**：「Prompt 版本」段动态构建，8 个版本下拉自动列出
  - IPC 新增 `config:listPromptRegistry` 返回 registry + 每个 name 的可用版本

### .env.example
- 「Prompt 版本管理」段重写：列出全部 8 个 *_PROMPT_VERSION + 默认值

### 测试（85 个；新加 3 个 prompts.js 测试）
- 所有 8 个注册 prompt 能加载 ✓
- vision_describe SYSTEM 段为空 ✓
- ENV_KEY + DEFAULT_VERSION 完整覆盖 ✓
- App.test PromptsView 测试匹配新 UI

## v0.3.0 (2026-05-28) — 可发布给真实用户

为了真正分发给朋友试用，加打包 / 签名 / 在线更新 / 引导 / 错误边界。

### 默认配置 + 体验
- `echolog init` 默认推荐**本地 Ollama**（数据不出本机），按硬件自动推模型组合：
  - Apple Silicon 24GB+ → qwen3.5:9b + minicpm-o2.6 + qwen3-embedding:4b
  - Apple Silicon 12-24GB → qwen2.5:7b + minicpm-o2.6 + bge-large
  - Apple Silicon <12GB / Intel → qwen2.5:3b + 跳过视觉 + bge-small（适合 M2 8GB）
- 接受推荐后**自动 ollama pull** 三个模型（带超时 + 失败 graceful）
- 字体大小 3 档调节（小/中/大），Sidebar 底部切换 + localStorage 持久化

### 编辑体验
- **Monaco 编辑器** 替换 PromptsView 的 textarea：
  - markdown 语法高亮 + 行号 + 多光标 + 自动 word wrap
  - ⌘S 保存（劫持 Monaco 默认的格式化）
  - 跟字体大小调节联动

### 在线更新 (electron-updater)
- 启动 30s 后静默检查 GitHub Releases
- 发现新版本 → 后台下载 → 顶部 UpdaterBanner 提示
- 「立即重启安装」按钮 + 主菜单「检查更新...」入口
- CI `release.yml` workflow：`git tag v0.x.x` → 自动 build + 上传 dmg + latest-mac.yml 到 Releases

### 免费分发签名
- `electron-builder.yml` 配 Hardened Runtime + entitlements（无需 $99/年 Apple Developer ID）
- `build/entitlements.mac.plist` 含 JIT / library validation / network 等必需权限
- DMG 双架构（arm64 + x64）

### 错误处理 + 引导
- **ErrorBoundary**：单视图崩塌不影响整 app，显示错误堆栈 + 「重置 UI」/「整窗口重载」/「提 issue」按钮
- **WelcomeBanner**：检测 FEISHU_APP_ID 缺失或仍是 placeholder → 顶部蓝色横幅引导去配置
- **UpdaterBanner**：在线更新各阶段（发现/下载中/已下载）顶部通知

### GUI 触发命令
- DiaryView 加「生成 / 重生成日记」按钮 → 调本地 HTTP `/command` 端点触发 bot 端 generateDiary
- 30/60/120s 三次自动刷新等结果
- bot 端 `lib/ingest-server.js` 新增 `/command` 路由（127.0.0.1 only，不暴露公网）
- bot 端在没 INGEST_TOKEN 时也启 server（用随机 fake token 屏蔽 /ingest，但开放 /command 给 GUI）

### 实时日志流
- StatusView 日志面板加「跟随」复选框 → 每 3s 自动 tail 最新 120 行

### 测试（85 个，比 v0.2 多 10 个）
- AppSettings (4)
- ErrorBoundary (3)
- WelcomeBanner (3)
- Monaco 在测试环境 mock 成普通 textarea
- 完整回归 bot 19 + desktop 85 全过

## v0.2.0 (2026-05-27) — 商业级可用

桌面 GUI 从 MVP 推到 production-ready；bot 端补功能开关 + 周报配置可调。

### 桌面 GUI
- **新增 6 个视图**（原 4 个 + 搜索 + Prompt 编辑），快捷键 ⌘1..6 切换 + native menu
- **跨日搜索**：关键词全文 grep（带 ±100 字上下文高亮）+ 语义检索（调 lib/embeddings）
- **Prompt 编辑器**：可视化编辑 prompts/diary_*.md，保存自动备份；支持从当前版本复制新建
- **LLM 连通性测试**：配置页一键调小请求，秒级反馈 provider/模型/延迟
- **Bot 进程控制**：start/stop/restart 按钮，集成今日日志查看面板
- **功能开关 UI**：滴答清单 / 选题 / 链接抓取 / ASR / Embeddings 五个模块都能独立关
- **周报周期配置 UI**：rangeDays + endOffset，默认 7+0 = 过去一周
- **全局 Toast 系统**：操作反馈统一走 success/error/info/warning
- **窗口状态持久化**：位置 / 尺寸 / maximize 状态记下次启动恢复
- **跨视图导航**：搜索命中 → 点日期 → 跳到日记浏览对应日
- **localStorage 记忆上次视图**
- **electron-builder 打包**：可生成 .dmg；含 .icns app icon
- **macOS native menu**：⌘, 打开偏好；⌘⇧O Finder 打开 vault
- **75 个测试**：env-utils 单测、IPC handler 集成测试、Toast 系统测试、App 路由 + 视图 smoke

### Bot 主进程
- **功能开关 `lib/feature-flags.js`**：5 个模块 + 周报周期都能配。`/diary` `/draft` `/recall` `/tasks` 都尊重 flag
- **`/week` 周报支持配置范围**：从 (今天 + WEEKLY_RANGE_END_OFFSET) 往前数 WEEKLY_RANGE_DAYS 天
- **19 个 bot 端单测**：feature-flags / llm 路由 / prompts interpolate

### CI
- **GitHub Actions** 双 job：bot 端 syntax+单测；desktop 端 vitest+build

### 文档
- 新增 `CHANGELOG.md`
- README 不变（v0.2 内容靠 CHANGELOG 引导）

## v0.1.0 (2026-05-27)

- 桌面 GUI MVP：Electron + React + Vite + TS，4 个视图（日记 / 选题 / 配置 / 状态）
- 16 个测试

## v0.0.x — bot 主体（早于 v0.1）

详见 git log。要点：
- LLM 多 provider 抽象（ollama + OpenAI 兼容协议）
- Prompt 个人身份模板化（USER_NAME / USER_IDENTITY 等）
- `echolog init` 首跑向导 + `doctor` 硬件评估
- LICENSE + docs/SETUP.md 完整零基础部署指南
- fix: unset proxy env 修飞书 SDK 502
