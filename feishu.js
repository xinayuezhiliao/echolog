require('dotenv').config({ path: require('./lib/paths').ENV_FILE });

// ============================================================================
// ⚠️ 关键：unset 全局 proxy env，让飞书 SDK 的 axios 走直连
// ----------------------------------------------------------------------------
// 飞书 SDK (@larksuiteoapi/node-sdk) 内部用 axios。axios 会自动读 HTTPS_PROXY /
// HTTP_PROXY / ALL_PROXY env 变量。如果用户系统装了 ClashX / Mihomo / Surge 等
// 代理软件，env 通常会有 HTTPS_PROXY=http://127.0.0.1:7897。这会导致：
//   - 飞书 API 请求（国内可直连）被强制走代理 → 代理不健康时报 502 Bad Gateway
//   - 即使代理健康也多一跳，增加延迟 + 失败率
//
// 解决：飞书通道启动时主动清掉这些 env。安全性论证：
//   - TG 通道走自己的 HttpsProxyAgent（telegram.js 显式构造），不读 env ✓
//   - Ollama / 云端 LLM 走 lib/llm.js 的 undici 直接 dispatcher，不读 env ✓
//   - whisper-cli / ffmpeg 是本地子进程，跟 proxy 无关 ✓
//   - 飞书 API 域名国内可直连，根本不需要代理 ✓
// ============================================================================
for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) {
  if (process.env[key]) {
    console.log(`[🚫 proxy] 已清掉 ${key}=${process.env[key]}（飞书 SDK 走直连）`);
    delete process.env[key];
  }
}

const lark = require('@larksuiteoapi/node-sdk');
const ollama = require('./lib/llm');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const isoWeek = require('dayjs/plugin/isoWeek');
const fetch = require('node-fetch');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const ticktick = require('./lib/ticktick');
const embeddings = require('./lib/embeddings');
const drafts = require('./lib/drafts');
const { startIngestServer } = require('./lib/ingest-server');
const urlEnrich = require('./lib/url-enrich');
const ratings = require('./lib/ratings');
const flags = require('./lib/feature-flags');
const feishuDoc = require('./lib/feishu-doc');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isoWeek);
dayjs.tz.setDefault('Asia/Shanghai');

// ==========================================================================
// 配置
// ==========================================================================
const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
if (!APP_ID || !APP_SECRET) {
  console.error('❌ 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET (.env)');
  process.exit(1);
}

// LLM_TEXT_MODEL / LLM_VISION_MODEL 是 provider-agnostic 名字；OLLAMA_* 是历史变量名（向后兼容）
const OLLAMA_TEXT_MODEL = process.env.LLM_TEXT_MODEL || process.env.OLLAMA_TEXT_MODEL || 'qwen3.5:9b';
const OLLAMA_VISION_MODEL = process.env.LLM_VISION_MODEL || process.env.OLLAMA_VISION_MODEL || 'openbmb/minicpm-o2.6:latest';
const WHISPER_BIN = '/opt/homebrew/bin/whisper-cli';
const WHISPER_MODEL = path.join(process.env.HOME, '.whisper-models/ggml-large-v3-turbo-q5_0.bin');
const FFMPEG_BIN = '/opt/homebrew/bin/ffmpeg';

const { VAULT_DIR, FEISHU_STATE_FILE: STATE_FILE } = require('./lib/paths');
const FEISHU_BASE = 'https://open.feishu.cn';

const client = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
  loggerLevel: lark.LoggerLevel.warn,
});

// ==========================================================================
// 状态：配对的发送者 + 每个 chat 的 high-water mark + 已处理 message_id
// ==========================================================================
function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { paired_open_id: null, chats: {}, processed_message_ids: [] };
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
let state = loadState();

function isProcessed(messageId) {
  return state.processed_message_ids.includes(messageId);
}
function markProcessed(messageId, chatId, createTimeMs) {
  if (!state.processed_message_ids.includes(messageId)) {
    state.processed_message_ids.push(messageId);
    if (state.processed_message_ids.length > 2000) {
      state.processed_message_ids.splice(0, state.processed_message_ids.length - 2000);
    }
  }
  if (!state.chats[chatId]) state.chats[chatId] = { last_processed_ts: 0 };
  if (createTimeMs > state.chats[chatId].last_processed_ts) {
    state.chats[chatId].last_processed_ts = createTimeMs;
  }
  saveState(state);
}

// ==========================================================================
// 日期上下文（按发送时间归档，不是接收时间）
// ==========================================================================
function getDateContext(dateStr) {
  const dirPath = path.join(VAULT_DIR, dateStr);
  const assetsPath = path.join(dirPath, 'assets');
  const logFile = path.join(dirPath, '01_raw_logs.md');
  const cacheFile = path.join(dirPath, '00_image_cache.json');
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  if (!fs.existsSync(assetsPath)) fs.mkdirSync(assetsPath, { recursive: true });
  if (!fs.existsSync(logFile)) {
    // 轻量 frontmatter，不写大标题（手机卡片渲染时 h1 占屏太多）
    const fm = `---\ndate: ${dateStr}\ntype: raw-log\ntags: [daily, raw, ${dateStr.slice(0, 7)}]\n---\n\n`;
    fs.writeFileSync(logFile, fm);
  }
  if (!fs.existsSync(cacheFile)) fs.writeFileSync(cacheFile, JSON.stringify({}));
  return { dirPath, assetsPath, logFile, cacheFile };
}

function appendLogAt(sendDt, content) {
  const dateStr = sendDt.format('YYYY-MM-DD');
  const timeStr = sendDt.format('HH:mm:ss');
  const { logFile } = getDateContext(dateStr);
  // 轻量格式：粗体时间 + 内容同行（短）或下一行（长）
  // 手机卡片上 h3 占屏太多，所以用 **bold** 替代 ### 标题
  // 内容以空行结尾，让多条 entry 之间有视觉间隔但不堆叠 hr
  const isShort = !content.includes('\n') && content.length < 80;
  const entry = isShort
    ? `**${timeStr}**  ${content}\n\n`
    : `**${timeStr}**\n${content}\n\n`;
  fs.appendFileSync(logFile, entry);
  return dateStr;
}

// ==========================================================================
// 鉴权 token 缓存（用于二进制下载）
// ==========================================================================
let cachedToken = { value: null, expiresAt: 0 };
async function getTenantToken() {
  if (cachedToken.value && Date.now() < cachedToken.expiresAt - 60000) {
    return cachedToken.value;
  }
  const r = await fetch(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`tenant_access_token 失败: ${j.msg}`);
  cachedToken = {
    value: j.tenant_access_token,
    expiresAt: Date.now() + j.expire * 1000,
  };
  return j.tenant_access_token;
}

async function downloadBinary(apiPath, savePath) {
  const token = await getTenantToken();
  const r = await fetch(`${FEISHU_BASE}${apiPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status} ${apiPath}`);
  const buf = await r.arrayBuffer();
  fs.writeFileSync(savePath, Buffer.from(buf));
  return fs.statSync(savePath).size;
}

// ==========================================================================
// 媒体落地：所有文件用「发送时间」命名 + 归档
// ==========================================================================
function safeName(name) {
  return (name || '').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 120);
}

// 收到的图片必须走 messageResource 接口，type=image。
// /im/v1/images/{key} 只能下 bot 自己上传的图，对用户发来的图返回 HTTP 400。
async function downloadImage(messageId, imageKey, sendDt) {
  const { assetsPath } = getDateContext(sendDt.format('YYYY-MM-DD'));
  const fileName = `${sendDt.format('HHmmss')}_img_${imageKey.slice(-8)}.jpg`;
  const savePath = path.join(assetsPath, fileName);
  await downloadBinary(
    `/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
    savePath
  );
  return fileName;
}

async function downloadResource(messageId, fileKey, sendDt, originalName, fallbackExt) {
  const { assetsPath } = getDateContext(sendDt.format('YYYY-MM-DD'));
  const base = originalName ? safeName(originalName) : `file_${fileKey.slice(-8)}.${fallbackExt}`;
  const fileName = `${sendDt.format('HHmmss')}_${base}`;
  const savePath = path.join(assetsPath, fileName);
  await downloadBinary(
    `/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`,
    savePath
  );
  return fileName;
}

// ==========================================================================
// 视觉缓存（每个日期目录一份缓存，按文件名 key）
// ==========================================================================
async function getOrProcessImageDesc(fileName, assetsPath, cacheFile) {
  const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  if (cacheData[fileName]) {
    console.log(`[⚡ 缓存命中] ${fileName}`);
    return cacheData[fileName];
  }
  console.log(`[👁️ 视觉解析] ${fileName} ...`);
  const imagePath = path.join(assetsPath, fileName);
  const imageBase64 = fs.readFileSync(imagePath).toString('base64');
  try {
    const visionPrompt = require('./lib/prompts').loadPromptPair('vision_describe');
    const r = await ollama.chat({
      model: OLLAMA_VISION_MODEL,
      messages: [{
        role: 'user',
        content: visionPrompt.template,
        images: [imageBase64],
      }],
      think: false,
      stream: false,
    });
    const desc = r.message.content;
    cacheData[fileName] = desc;
    fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
    return desc;
  } catch (err) {
    console.error(`[❌ 视觉解析失败] ${fileName}:`, err.message);
    return '图片解析失败。';
  }
}

// ==========================================================================
// 语音转文字（whisper.cpp + ffmpeg），结果缓存到同名 .txt sidecar
// ==========================================================================
async function transcribeAudio(audioPath) {
  const txtSidecar = audioPath + '.txt';
  if (fs.existsSync(txtSidecar)) {
    return fs.readFileSync(txtSidecar, 'utf8').trim();
  }
  if (!fs.existsSync(WHISPER_MODEL)) {
    throw new Error(`whisper 模型缺失: ${WHISPER_MODEL}`);
  }
  // opus → wav 16kHz 单声道（whisper 必需的格式）
  const wavPath = audioPath + '.16k.wav';
  await execFileAsync(FFMPEG_BIN, [
    '-y', '-i', audioPath,
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    wavPath,
  ], { timeout: 60000 });

  const { stdout } = await execFileAsync(WHISPER_BIN, [
    '-m', WHISPER_MODEL,
    '-f', wavPath,
    '-l', 'auto',   // 自动检测语种（中英混杂 OK）
    '-nt',          // no timestamps
    '-np',          // no progress
    '-otxt', 'false',
  ], { timeout: 180000, maxBuffer: 10 * 1024 * 1024 });

  fs.unlinkSync(wavPath); // 清理中间 wav
  const transcript = stdout.replace(/\s+/g, ' ').trim();
  fs.writeFileSync(txtSidecar, transcript);
  return transcript;
}

// ==========================================================================
// 飞书消息发送
// ==========================================================================
async function sendText(chatId, text) {
  return client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      content: JSON.stringify({ text }),
      msg_type: 'text',
    },
  });
}

// 飞书卡片 markdown 不能直接渲染 ![alt](本地路径) —— 会报 11310 (no imagekey)。
// 把图片 markdown 转成纯文本引用，保留信息但避开渲染失败。
function sanitizeMarkdownForFeishu(md) {
  return md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    const file = src.split('/').pop();
    return alt && alt !== '图片' ? `📷 ${alt} \`${file}\`` : `📷 \`${file}\``;
  });
}

// 富文本渲染：使用 Card 2.0 schema —— 比 v1 的 markdown 元素渲染更完整
// （v1 在部分飞书客户端会把 ## # - 等 markdown 语法当成原始文本显示）
// Card 2.0 全平台支持 headers / lists / quotes / code blocks / tables / bold / strike
async function sendMarkdown(chatId, markdownContent, headerTitle = null, headerColor = 'blue') {
  const card = {
    schema: '2.0',
    config: {
      enable_forward: true,
      update_multi: true,
      width_mode: 'fill',
    },
    body: {
      elements: markdownContent
        ? [{ tag: 'markdown', content: sanitizeMarkdownForFeishu(markdownContent) }]
        : [],
    },
  };
  if (headerTitle) {
    card.header = {
      template: headerColor,
      title: { tag: 'plain_text', content: headerTitle },
    };
  }
  return client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      content: JSON.stringify(card),
      msg_type: 'interactive',
    },
  });
}

// 大段 markdown 自动按 ~5000 字切片，每段一张卡片，仅首段带 header
async function sendMarkdownChunked(chatId, markdown, headerTitle = null, headerColor = 'blue') {
  const chunkSize = 5000;
  if (markdown.length <= chunkSize) {
    return sendMarkdown(chatId, markdown, headerTitle, headerColor);
  }
  for (let i = 0; i < markdown.length; i += chunkSize) {
    await sendMarkdown(
      chatId,
      markdown.slice(i, i + chunkSize),
      i === 0 ? headerTitle : null,
      headerColor
    );
  }
}

async function replyText(messageId, text) {
  return client.im.message.reply({
    path: { message_id: messageId },
    data: {
      content: JSON.stringify({ text }),
      msg_type: 'text',
    },
  });
}

async function reactOk(messageId, emoji = 'OK') {
  try {
    await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } },
    });
  } catch (err) {
    console.warn(`[⚠️ reaction 失败] ${messageId}: ${err.message}`);
  }
}

// ==========================================================================
// /diary：基于指定日期生成深度复盘 + 串联滴答清单上下文 + 自动同步行动项
// ==========================================================================
// DIARY prompt 走 prompts/diary_<version>.md 文件加载（DIARY_PROMPT_VERSION env 切换；默认 v1）
const { loadPromptPair } = require('./lib/prompts');
const __diaryPrompt = loadPromptPair('diary');
const DIARY_SYSTEM_PROMPT = __diaryPrompt.system;
const DIARY_TEMPLATE = __diaryPrompt.template;
console.log(`[📜 prompt] diary version: ${__diaryPrompt.version} (${__diaryPrompt.file})`);

async function generateDiary(dateStr, chatId) {
  const { dirPath, assetsPath, logFile, cacheFile } = getDateContext(dateStr);
  const rawLogs = fs.readFileSync(logFile, 'utf8');
  if (rawLogs.trim().endsWith('碎片记录') || rawLogs.length < 30) {
    await sendText(chatId, `📭 ${dateStr} 没有可用记录。`);
    return;
  }

  await sendText(chatId, `🧠 ${dateStr}：读取记忆 + 视觉解析...`);

  const imageRegex = /!\[.*?\]\((assets\/([^)]+))\)/g;
  let augmentedLogs = rawLogs;
  let m;
  while ((m = imageRegex.exec(rawLogs)) !== null) {
    const fullMd = m[0];
    const fileName = m[2];
    const desc = await getOrProcessImageDesc(fileName, assetsPath, cacheFile);
    const replacement = `${fullMd}\n> 💡 **[视觉辅助提取信息]**：${desc}\n`;
    augmentedLogs = augmentedLogs.replace(fullMd, replacement);
  }

  // 滴答清单上下文（功能开关 + 已授权 双重判断；任一不满足都静默跳过）
  let ticktickBlock = '（滴答清单未启用 / 跳过任务上下文）';
  let ticktickCtx = null;
  if (flags.enableTickTick() && ticktick.isAuthed()) {
    try {
      await sendText(chatId, '📋 拉取滴答清单当日任务上下文...');
      ticktickCtx = await ticktick.getTodayContext(dateStr);
      ticktickBlock = ticktick.formatContextForPrompt(ticktickCtx, dateStr);
    } catch (err) {
      console.error(`[ticktick ctx] ${err.message}`);
      ticktickBlock = `（滴答清单读取失败：${err.message}）`;
    }
  }

  await sendText(chatId, `✍️ 信息整合完成，调用 ${OLLAMA_TEXT_MODEL} 写日记...`);

  // 上下文容量自适应（病因：一天 logs 可达 2~3 万字，固定 num_ctx=16384 会让
  // prompt 从头被截断、system 指令丢失 → 模型吐空 → 空日记卡片）。
  // 先按全量 prompt 估 num_ctx；若极端长超过封顶，截断 augmentedLogs 兜底不溢出。
  const promptFixed = DIARY_SYSTEM_PROMPT + ticktickBlock + DIARY_TEMPLATE;
  let numCtx = ollama.estimateNumCtx(promptFixed + augmentedLogs);
  const maxInputChars = ollama.capCharsForCtx(numCtx) - promptFixed.length;
  if (augmentedLogs.length > maxInputChars) {
    const headLen = 2000;
    const tailLen = Math.max(0, maxInputChars - headLen - 200);
    augmentedLogs =
      augmentedLogs.slice(0, headLen) +
      `\n\n> ⚠️ [当日记录过长，中间部分已省略以适应模型上下文；保留早晨开头 + 当日后段]\n\n` +
      augmentedLogs.slice(-tailLen);
    console.warn(`[⚠️ diary] ${dateStr} logs 过长，已截断至约 ${maxInputChars} 字符（num_ctx=${numCtx}）`);
  }

  const buildUserPrompt = (logs) => `
日期：${dateStr}

【滴答清单上下文（截至当前）】
${ticktickBlock}

【今日 logs（已注入图片视觉描述）】
${logs}

==========
请严格按下面的模板输出 markdown 日记：

${DIARY_TEMPLATE}
  `.trim();

  const callModel = async (ctx) => {
    const r = await ollama.chat({
      model: OLLAMA_TEXT_MODEL,
      messages: [
        { role: 'system', content: DIARY_SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(augmentedLogs) },
      ],
      think: false,
      stream: false,
      options: {
        temperature: 0.3,    // 收紧：不要发散文学化
        num_ctx: ctx,        // 自适应：容纳当日 logs + ticktick 上下文
      },
    });
    return (r.message?.content || '').trim();
  };

  let diaryContent = await callModel(numCtx);

  // 空输出守卫：模型返回空/过短（上下文仍偏紧、或偶发吐空）→ 顶到封顶 ctx 重试一次。
  if (diaryContent.length < 30) {
    console.warn(`[⚠️ diary] ${dateStr} 首次返回空内容（num_ctx=${numCtx}），顶到 98304 重试`);
    numCtx = 98304;
    await sendText(chatId, '↻ 内容偏长，扩大上下文重试一次...');
    diaryContent = await callModel(numCtx);
  }
  // 仍为空：明确报错，不写空文件、不占版本号、不发空卡片（原始记录已安全落档）。
  if (diaryContent.length < 30) {
    console.error(`[❌ diary] ${dateStr} 模型两次均返回空内容，已放弃本次生成`);
    await sendText(chatId, '⚠️ 日记生成失败：模型两次返回空内容（可能当日记录过长或模型异常）。原始记录已完整保存，稍后可重试 /diary，或精简后再试。');
    return;
  }

  // 后置：把 Action Items + 选题分别同步到滴答清单（带去重）
  // 同时把选题镜像到本地 Daily_Vault/Notes/，方便在 Obsidian 里管理
  let syncResult = null;
  if (flags.enableTickTick() && ticktick.isAuthed()) {
    try {
      syncResult = await ticktick.syncActionItems(dateStr, diaryContent, { vaultDir: VAULT_DIR });
      const t = syncResult.tasks;
      const n = syncResult.notes;
      console.log(`[✅ 滴答同步] 任务: 建 ${t.created.length} / 跳 ${t.skipped.length} / 失 ${t.failed.length}  ｜  选题: 建 ${n.created.length} / 跳 ${n.skipped.length} / 失 ${n.failed.length}`);
    } catch (err) {
      console.error(`[ticktick sync] ${err.message}`);
    }
  }

  let version = 1;
  while (fs.existsSync(path.join(dirPath, `02_diary_v${version}.md`))) version++;
  const imageCount = (rawLogs.match(imageRegex) || []).length;
  const generatedAt = dayjs().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
  const parsed = ticktick.extractActionItems(diaryContent);
  const fm = [
    '---',
    `date: ${dateStr}`,
    `type: daily-diary`,
    `version: ${version}`,
    `generated_at: "${generatedAt}"`,
    `text_model: ${OLLAMA_TEXT_MODEL}`,
    `vision_model: ${OLLAMA_VISION_MODEL}`,
    `image_count: ${imageCount}`,
    `action_items: ${parsed.tasks.length}`,
    `content_ideas: ${parsed.notes.length}`,
    `ticktick_tasks_synced: ${syncResult ? syncResult.tasks.created.length : 0}`,
    `ticktick_tasks_skipped: ${syncResult ? syncResult.tasks.skipped.length : 0}`,
    `ticktick_notes_synced: ${syncResult ? syncResult.notes.created.length : 0}`,
    `ticktick_notes_skipped: ${syncResult ? syncResult.notes.skipped.length : 0}`,
    `tags: [diary, ${dateStr.slice(0, 7)}]`,
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(
    path.join(dirPath, `02_diary_v${version}.md`),
    `${fm}# ${dateStr} 深度复盘 (v${version})\n\n${diaryContent}`
  );

  await sendMarkdownChunked(
    chatId,
    diaryContent,
    `✨ ${dateStr} 深度复盘 v${version}`,
    'purple'
  );

  // 同步小结回发
  if (syncResult) {
    const t = syncResult.tasks;
    const n = syncResult.notes;
    const taskList = t.created.length
      ? '\n' + t.created.map(c => `  • ${c.title}`).join('\n')
      : '';
    const noteList = n.created.length
      ? '\n' + n.created.map(c => `  • ${c.title.replace(/^标题：/, '')}`).join('\n')
      : '';
    const lines = [
      `**🎯 任务**：新建 ${t.created.length} / 跳过 ${t.skipped.length}${t.failed.length ? ` / ❌${t.failed.length}` : ''}${taskList}`,
      ``,
      `**📝 选题**（→ Notes 项目）：新建 ${n.created.length} / 跳过 ${n.skipped.length}${n.failed.length ? ` / ❌${n.failed.length}` : ''}${noteList}`,
    ];
    if (n.failed.length) {
      lines.push('');
      lines.push(`*选题失败原因*：${n.failed[0].error}`);
    }
    await sendMarkdown(chatId, lines.join('\n'), '✓ 已同步到滴答清单', 'green');
  }

  // 后置异步：把当天 raw_logs 索引到向量库（功能开关；不阻塞主流程，失败不影响 diary）
  if (flags.enableEmbeddings()) {
    embeddings.indexDate(dateStr).then(r => {
      console.log(`[🔎 embed ${dateStr}] indexed ${r.indexed} chunks`);
    }).catch(err => {
      console.error(`[🔎 embed ${dateStr}] ${err.message}`);
    });
  }

  // 引导打分（喂回反馈环；用户回 /rate <1-5> [评语]，写到 .diary_ratings.jsonl）
  await sendText(chatId, '💬 觉得这版怎么样？回 `/rate <1-5> [一句话评语]` 喂给反馈环。例：`/rate 4 第三段太啰嗦`');
}

// ==========================================================================
// 命令工具：列举 vault 日期、单日摘要
// ==========================================================================
function listVaultDates() {
  if (!fs.existsSync(VAULT_DIR)) return [];
  return fs.readdirSync(VAULT_DIR)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
}

function summarizeDate(dateStr) {
  const dirPath = path.join(VAULT_DIR, dateStr);
  if (!fs.existsSync(dirPath)) return null;
  const logFile = path.join(dirPath, '01_raw_logs.md');
  const logSize = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const assetsPath = path.join(dirPath, 'assets');
  const assetCount = fs.existsSync(assetsPath) ? fs.readdirSync(assetsPath).length : 0;
  const diaryVersions = fs.readdirSync(dirPath)
    .filter(f => /^02_diary_v\d+\.md$/.test(f))
    .length;
  return { dateStr, logSize, assetCount, diaryVersions };
}

// /today、/yesterday、/show YYYY-MM-DD：直接回发当日 raw logs（去掉 frontmatter 后渲染）
async function cmdShowRaw(chatId, dateStr) {
  const logFile = path.join(VAULT_DIR, dateStr, '01_raw_logs.md');
  if (!fs.existsSync(logFile)) return sendText(chatId, `📭 ${dateStr} 没有记录。`);
  let content = fs.readFileSync(logFile, 'utf8');
  // 剥离开头的 YAML frontmatter（消息端不需要看 metadata）
  content = content.replace(/^---\n[\s\S]*?\n---\n+/, '');
  if (content.trim().length < 30) {
    return sendText(chatId, `📭 ${dateStr} 没有记录。`);
  }
  await sendMarkdownChunked(chatId, content, `📅 ${dateStr} 原始记录`);
}

// /list [N]：列出最近 N 天的活跃情况（markdown 表格）
async function cmdList(chatId, n = 14) {
  const dates = listVaultDates().slice(-n);
  if (!dates.length) return sendText(chatId, '📭 还没有任何记录。');
  const rows = dates.reverse().map(d => {
    const s = summarizeDate(d);
    const sizeKb = (s.logSize / 1024).toFixed(1);
    const diary = s.diaryVersions ? `v${s.diaryVersions}` : '—';
    const assets = s.assetCount || '—';
    return `| ${d} | ${sizeKb} | ${diary} | ${assets} |`;
  });
  const md = [
    `共 **${dates.length}** 天有记录`,
    '',
    '| 日期 | 文字(KB) | 日记 | 资源 |',
    '|---|---:|:---:|:---:|',
    ...rows,
  ].join('\n');
  await sendMarkdown(chatId, md, `📚 最近 ${dates.length} 天活跃情况`);
}

// /find <关键词>：跨日全文搜，返回最近 20 条命中（markdown 渲染）
async function cmdFind(chatId, query) {
  if (!query) return sendText(chatId, '用法：/find 关键词');
  const dates = listVaultDates();
  const matches = [];
  const q = query.toLowerCase();
  outer: for (const d of dates.reverse()) {
    const logFile = path.join(VAULT_DIR, d, '01_raw_logs.md');
    if (!fs.existsSync(logFile)) continue;
    const content = fs.readFileSync(logFile, 'utf8');
    const lower = content.toLowerCase();
    let idx = lower.indexOf(q);
    while (idx !== -1) {
      const start = Math.max(0, idx - 80);
      const end = Math.min(content.length, idx + 120);
      const snippet = content.slice(start, end).replace(/\s+/g, ' ').trim();
      matches.push({ date: d, snippet });
      if (matches.length >= 20) break outer;
      idx = lower.indexOf(q, idx + q.length);
    }
  }
  if (!matches.length) return sendText(chatId, `🔍 没找到「${query}」。`);
  // 高亮命中词（用 **加粗** 渲染）
  const hlRe = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const out = matches.map(m => {
    const hl = m.snippet.replace(hlRe, s => `**${s}**`);
    return `**📅 ${m.date}**\n> …${hl}…`;
  }).join('\n\n');
  await sendMarkdown(chatId, out, `🔍 「${query}」命中 ${matches.length} 处`);
}

// /recall：跨日语义搜索（向量索引），返回 top-k 相关 chunks
async function cmdRecall(chatId, args) {
  if (!args || !args.trim()) {
    return sendText(chatId, '用法：/recall 你想回忆的主题  例如：/recall 长期主义');
  }
  // 末尾如果是 1-20 的数字，作为 topK
  const m = args.trim().match(/^(.*?)(?:\s+(\d{1,2}))?$/);
  const query = (m[1] || args).trim();
  const topK = m[2] ? Math.max(1, Math.min(20, parseInt(m[2], 10))) : 6;
  if (!query) return sendText(chatId, '用法：/recall 主题 [N]');

  await sendText(chatId, `🔎 跨日语义检索「${query}」（top ${topK}）...`);
  let hits;
  try {
    hits = await embeddings.query(query, { topK });
  } catch (err) {
    return sendText(chatId, `⚠️ 索引查询失败：${err.message}\n（首次需要 \`echolog reindex\` 全量建库）`);
  }
  if (!hits.length) {
    return sendText(chatId, `🤷 没有相关记忆。可能 vault 还没建索引，跑 \`echolog reindex\` 试试。`);
  }
  const lines = hits.map((h, i) => {
    const score = (h.score * 100).toFixed(0);
    // 截断长 chunk，保留时间锚点
    const text = h.text.length > 280 ? h.text.slice(0, 280) + '…' : h.text;
    return `**📅 ${h.date} ${h.time}**  · 相似度 ${score}%\n> ${text.replace(/\n/g, '\n> ')}`;
  });
  await sendMarkdown(
    chatId,
    lines.join('\n\n'),
    `🧠 「${query}」回忆 ${hits.length} 条`,
    'wathet'
  );
}

// /rate <1-5> [评语]：给最近一份 diary 打分（喂回反馈环）
async function cmdRate(chatId, args) {
  const trimmed = (args || '').trim();
  if (!trimmed) {
    const sum = ratings.summarizeRatings();
    if (!sum.total) {
      return sendText(chatId, '用法：/rate <1-5> [评语]\n  例：`/rate 4 第二段太啰嗦了`');
    }
    const dist = [5, 4, 3, 2, 1].map(s => `  ${s}星：${sum.byScore[s] || 0}`).join('\n');
    const md = [
      `共 **${sum.total}** 条评分，平均 **${sum.avg}** / 5`,
      '',
      dist,
      '',
      '**最近 5 条**：',
      ...sum.recent.slice(0, 5).map(r => `- ${r.date} v${r.version} · ${r.score}/5${r.comment ? ` — ${r.comment}` : ''}`),
    ].join('\n');
    return sendMarkdown(chatId, md, '⭐ /diary 评分概览', 'turquoise');
  }
  const m = trimmed.match(/^(\d+)\s*(.*)$/);
  if (!m) {
    return sendText(chatId, '用法：/rate <1-5> [评语]\n  例：`/rate 4 第二段太啰嗦了`');
  }
  const score = parseInt(m[1], 10);
  const comment = (m[2] || '').trim();
  try {
    const rec = ratings.saveRating({ score, comment });
    const stars = '⭐'.repeat(rec.score) + '☆'.repeat(5 - rec.score);
    await sendMarkdown(
      chatId,
      `${stars}\n\n📅 ${rec.date} v${rec.version}${comment ? `\n💬 ${comment}` : ''}\n\n_累计 ${ratings.loadRatings().length} 条评分_`,
      '✓ 评分已记录',
      'green'
    );
  } catch (err) {
    await sendText(chatId, `⚠️ ${err.message}`);
  }
}

// /draft：选题 → 写作流水线（推特串/长文/短视频/一选三发）
async function cmdDraft(chatId, args) {
  const trimmed = (args || '').trim();
  if (!trimmed || trimmed === 'list' || trimmed === 'ls') {
    const notes = drafts.listNotes();
    if (!notes.length) {
      return sendText(chatId, '📭 选题库为空（让 /diary 先跑几次累积选题）');
    }
    const lines = notes.slice(0, 30).map((n, i) => {
      const num = String(i + 1).padStart(2, '0');
      const m = n.maturity ? n.maturity.charAt(0) : '·';
      const cat = n.category ? `\`${n.category}\` ` : '';
      return `**${num}** ${m} ${cat}${n.title}\n   📅 ${n.created}`;
    });
    const md = [
      `共 ${notes.length} 条选题（按 🌳→🌿→🌱 排序）；用 \`/draft <编号>\` 出推特串；\`--long\` 长文；\`--video\` 短视频；\`--all\` 一选三发`,
      '',
      ...lines,
    ].join('\n\n');
    return sendMarkdown(chatId, md, '📝 选题库', 'turquoise');
  }

  // 解析参数：第一个 token 是 id/标题片段，后面 flag --long/--video/--all
  const tokens = trimmed.split(/\s+/);
  const flags = new Set(tokens.filter(t => t.startsWith('--')));
  const idOrTitle = tokens.filter(t => !t.startsWith('--')).join(' ');

  const notes = drafts.listNotes();
  const note = drafts.findNote(idOrTitle, notes);
  if (!note) {
    return sendText(chatId, `🤷 找不到选题「${idOrTitle}」。\n用 /draft list 看完整列表。`);
  }

  const formats = flags.has('--all')
    ? ['twitter', 'long', 'video']
    : flags.has('--long') ? ['long']
    : flags.has('--video') ? ['video']
    : ['twitter'];

  await sendText(
    chatId,
    `✍️  选题：${note.title}\n格式：${formats.map(f => drafts.FORMAT_LABELS[f]).join(' + ')}\n模型：${OLLAMA_TEXT_MODEL}（30s ~ 2min）`
  );

  if (formats.length === 1) {
    const fmt = formats[0];
    try {
      const content = await drafts.generateOne(note, fmt);
      const file = drafts.saveDraft(note, fmt, content);
      const rel = path.relative(VAULT_DIR, file);
      await sendMarkdownChunked(
        chatId,
        content,
        `${fmt === 'twitter' ? '🐦' : fmt === 'long' ? '📝' : '🎬'} ${drafts.FORMAT_LABELS[fmt]} 草稿`,
        fmt === 'twitter' ? 'wathet' : fmt === 'long' ? 'green' : 'orange'
      );
      await sendText(chatId, `💾 已落档：\`${rel}\``);
    } catch (err) {
      const reason = err.friendlyMessage || err.message;
      await sendText(chatId, `⚠️ 生成失败：${reason}`);
    }
    return;
  }

  // --all 一选三发：并发
  try {
    const results = await drafts.generateAll(note);
    const summary = results.map(r => {
      if (r.ok) {
        const rel = path.relative(VAULT_DIR, r.file);
        return `✓ **${drafts.FORMAT_LABELS[r.format]}**（${r.charCount} 字）\n   \`${rel}\``;
      }
      return `✗ **${drafts.FORMAT_LABELS[r.format]}** 失败：${r.error}`;
    }).join('\n\n');
    await sendMarkdown(chatId, summary, '📦 一选三发完成', 'green');
    // 把每份草稿正文都发回（让用户立即能看）
    for (const r of results) {
      if (!r.ok) continue;
      const content = fs.readFileSync(r.file, 'utf8').replace(/^---[\s\S]*?---\n+/, '').replace(/^# .*\n+/, '');
      await sendMarkdownChunked(
        chatId,
        content,
        `${r.format === 'twitter' ? '🐦' : r.format === 'long' ? '📝' : '🎬'} ${drafts.FORMAT_LABELS[r.format]}`,
        r.format === 'twitter' ? 'wathet' : r.format === 'long' ? 'green' : 'orange'
      );
    }
  } catch (err) {
    const reason = err.friendlyMessage || err.message;
    await sendText(chatId, `⚠️ 一选三发失败：${reason}`);
  }
}

// /week：过去 N 天周报（N + endOffset 可配置；默认 7 天截至今天）
async function generateWeekly(chatId, sendDt) {
  const rangeDays = flags.weeklyRangeDays();
  const endOffset = flags.weeklyEndOffset();
  const endDay = sendDt.startOf('day').add(endOffset, 'day');
  const days = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    const d = endDay.subtract(i, 'day').format('YYYY-MM-DD');
    const dirPath = path.join(VAULT_DIR, d);
    if (!fs.existsSync(dirPath)) continue;
    const versions = fs.readdirSync(dirPath)
      .filter(f => /^02_diary_v\d+\.md$/.test(f))
      .sort();
    if (versions.length) {
      days.push({ date: d, source: 'diary', text: fs.readFileSync(path.join(dirPath, versions[versions.length - 1]), 'utf8') });
    } else {
      const logFile = path.join(dirPath, '01_raw_logs.md');
      if (fs.existsSync(logFile)) {
        days.push({ date: d, source: 'raw', text: fs.readFileSync(logFile, 'utf8') });
      }
    }
  }
  if (!days.length) return sendText(chatId, '📭 过去 7 天没有任何内容。');

  const range = `${days[0].date} ~ ${days[days.length - 1].date}`;
  await sendText(chatId, `🗓 正在合成周报（${range}, ${days.length} 天数据）...`);

  const corpus = days.map(d => `## ${d.date}（${d.source === 'diary' ? '已成文日记' : '原始碎片'}）\n\n${d.text}`).join('\n\n---\n\n');
  const weeklyPrompt = require('./lib/prompts').loadPromptPair('weekly', undefined, { CORPUS: corpus });
  console.log(`[📜 prompt] weekly version: ${weeklyPrompt.version} (${weeklyPrompt.file})`);

  try {
    const r = await ollama.chat({
      model: OLLAMA_TEXT_MODEL,
      messages: [
        ...(weeklyPrompt.system ? [{ role: 'system', content: weeklyPrompt.system }] : []),
        { role: 'user', content: weeklyPrompt.template },
      ],
      think: false,
      stream: false,
    });
    const weekly = r.message.content;
    const weekDir = path.join(VAULT_DIR, '_weekly');
    if (!fs.existsSync(weekDir)) fs.mkdirSync(weekDir, { recursive: true });
    const weekId = `${sendDt.format('YYYY')}-W${String(sendDt.isoWeek()).padStart(2, '0')}`;
    const fm = `---\ntype: weekly-digest\nweek: ${weekId}\nrange: "${range}"\ndays_with_data: ${days.length}\ngenerated_at: "${dayjs().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss')}"\ntags: [weekly, ${sendDt.format('YYYY-MM')}]\n---\n\n# ${weekId} 周报（${range}）\n\n`;
    fs.writeFileSync(path.join(weekDir, `${weekId}.md`), fm + weekly);
    await sendMarkdownChunked(
      chatId,
      weekly,
      `🗓 ${weekId} 周报（${range}）`,
      'orange'
    );
  } catch (err) {
    const reason = err.friendlyMessage || err.message;
    await sendText(chatId, `⚠️ 周报生成失败：${reason}`);
  }
}

// /help
// /tasks：拉滴答清单今日任务概览（不调 LLM，秒回）
async function cmdTasks(chatId, sendDt) {
  if (!ticktick.isAuthed()) {
    return sendMarkdown(chatId,
      '滴答清单还没授权。\n\n在终端执行：\n```\necholog ticktick-auth\n```',
      '🔴 TickTick 未授权', 'red');
  }
  const todayStr = sendDt.format('YYYY-MM-DD');
  try {
    const ctx = await ticktick.getTodayContext(todayStr);
    const md = ticktick.formatContextForPrompt(ctx, todayStr);
    await sendMarkdown(chatId, md, `📋 ${todayStr} 滴答清单`, 'blue');
  } catch (err) {
    await sendText(chatId, `⚠️ 拉取任务失败：${err.message}`);
  }
}

async function cmdHelp(chatId) {
  const md = [
    '## 输入',
    '- **文字 / 图片 / 文件 / 视频** —— 立即落档（按发送时间归档）',
    '- **语音** —— 落档 + 自动转文字（whisper large-v3-turbo，本地）',
    '',
    '## 回查（秒回，不调模型）',
    '- `/today` —— 今天的原始记录',
    '- `/yesterday` —— 昨天的原始记录',
    '- `/show YYYY-MM-DD` —— 指定日期的原始记录',
    '- `/list [N]` —— 最近 N 天活跃表（默认 14）',
    '- `/find <关键词>` —— 跨日全文搜（最多 20 条，命中词加粗）',
    '- `/recall <主题> [N]` —— 跨日**语义**回忆（向量检索，例：`/recall 长期主义 8`）',
    '',
    '## 生成（调本地模型，30s ~ 2min）',
    '- `/diary [YYYY-MM-DD]` —— 深度日记（事实清单 / 状态自审 / 模式 / Action Items 自动同步到滴答）',
    '- `/draft list` —— 列出选题库；`/draft <编号>` 默认推特串；`--long` 长文；`--video` 短视频；`--all` 一选三发',
    '- `/week` —— 过去 7 天周报',
    '- `/rate <1-5> [评语]` —— 给最近一份 diary 打分（喂回反馈环）',
    '',
    '## 滴答清单',
    '- `/tasks` —— 今日任务概览（逾期 / 今天 due / 今天已完成）',
    '- 终端执行 `echolog ticktick-auth` —— 一次性授权',
    '',
    '## 飞书云文档导入',
    '- `/doc-import <URL 或 doc_id>` —— 拉云文档纯文本，按内部时间戳拆块落到对应日期的 raw_logs（需权限 `docx:document:readonly`）',
    '',
    '## 其他',
    '- `/help` —— 这个帮助',
  ].join('\n');
  await sendMarkdown(chatId, md, '📒 私密日记 bot 指令', 'green');
}

// /doc-import <url|doc_id>: 拉飞书云文档按时间戳拆块落 raw_logs + 重建索引
async function cmdDocImport(chatId, arg) {
  if (!arg) {
    return sendMarkdown(chatId,
      '**用法**：`/doc-import <飞书云文档 URL 或 doc_id>`\n\n' +
      '支持格式：\n' +
      '- `https://<tenant>.feishu.cn/docx/<doc_id>`\n' +
      '- `https://<tenant>.feishu.cn/wiki/<token>` (会自动 resolve 到 doc_id)\n' +
      '- 裸 doc_id（27 字符，`dox` 开头）\n\n' +
      '需要飞书应用开通 `docx:document:readonly` 权限，且云文档需要把 bot 加为可读应用。',
      '📥 doc-import 用法', 'blue');
  }

  const tenantToken = await getTenantToken();
  const defaultDate = dayjs().tz('Asia/Shanghai').format('YYYY-MM-DD');

  await sendText(chatId, `📥 拉取云文档…\n${arg}`).catch(() => {});

  try {
    const result = await feishuDoc.importDocFromInput({
      input: arg,
      tenantToken,
      defaultDate,
      onProgress: msg => console.log(`[doc-import] ${msg}`),
    });
    if (result.reason === 'empty') {
      return sendText(chatId, '⚠️ 云文档为空,没东西可导入');
    }
    const dates = result.affectedDates.map(d => `\`${d}\``).join(', ');
    const summary =
      `✅ 导入完成\n` +
      `- 文档 ID: \`${result.docId}\`\n` +
      `- 拆出时间块: **${result.totalAppended}**\n` +
      `- 涉及日期: ${dates || '(无)'}`;
    await sendMarkdown(chatId, summary, '📥 导入完成', 'green');
  } catch (err) {
    const msg = err.friendlyMessage || err.message;
    console.error('[doc-import] error:', err);
    await sendText(chatId, `⚠️ 导入失败: ${msg}\n\n如果是 403,大概率是云文档没把 bot 加为可读应用。\n打开文档 → 右上「…」→ 「…更多」→ 「添加文档应用」 → 搜索本 bot 添加。`);
  }
}

// 命令分发：返回 true 表示已被命令吞掉，不再走文本归档
async function tryDispatchCommand(text, chatId, sendDt) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;
  const [cmdRaw, ...rest] = trimmed.split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const arg = rest.join(' ').trim();

  if (cmd === '/help' || cmd === '/?') {
    await cmdHelp(chatId);
  } else if (cmd === '/today') {
    await cmdShowRaw(chatId, sendDt.format('YYYY-MM-DD'));
  } else if (cmd === '/yesterday') {
    await cmdShowRaw(chatId, sendDt.subtract(1, 'day').format('YYYY-MM-DD'));
  } else if (cmd === '/show') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) await cmdShowRaw(chatId, arg);
    else await sendText(chatId, '用法：/show YYYY-MM-DD');
  } else if (cmd === '/list') {
    const n = parseInt(arg, 10);
    await cmdList(chatId, Number.isFinite(n) && n > 0 ? n : 14);
  } else if (cmd === '/find') {
    await cmdFind(chatId, arg);
  } else if (cmd === '/recall' || cmd === '/ask') {
    if (!flags.enableEmbeddings()) {
      sendText(chatId, '🚫 跨日记忆功能已在 .env 关闭（ENABLE_EMBEDDINGS=false）').catch(() => {});
      return true;
    }
    cmdRecall(chatId, arg).catch(err => {
      console.error('[❌ recall]', err);
      sendText(chatId, `⚠️ ${err.message}`).catch(() => {});
    });
  } else if (cmd === '/tasks' || cmd === '/todo' || cmd === '/dida') {
    if (!flags.enableTickTick()) {
      sendText(chatId, '🚫 滴答清单功能已在 .env 关闭（ENABLE_TICKTICK=false）').catch(() => {});
      return true;
    }
    cmdTasks(chatId, sendDt).catch(err => {
      console.error('[❌ tasks]', err);
      sendText(chatId, `⚠️ ${err.message}`).catch(() => {});
    });
  } else if (cmd === '/diary') {
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : sendDt.format('YYYY-MM-DD');
    generateDiary(targetDate, chatId).catch(err => {
      console.error('[❌ diary]', err);
      const reason = err.friendlyMessage || err.message || String(err);
      sendText(chatId, `⚠️ 日记生成失败：${reason}`).catch(() => {});
    });
  } else if (cmd === '/draft') {
    if (!flags.enableDrafts()) {
      sendText(chatId, '🚫 选题→写作流水线功能已在 .env 关闭（ENABLE_DRAFTS=false）').catch(() => {});
      return true;
    }
    cmdDraft(chatId, arg).catch(err => {
      console.error('[❌ draft]', err);
      sendText(chatId, `⚠️ ${err.message}`).catch(() => {});
    });
  } else if (cmd === '/rate') {
    cmdRate(chatId, arg).catch(err => {
      console.error('[❌ rate]', err);
      sendText(chatId, `⚠️ ${err.message}`).catch(() => {});
    });
  } else if (cmd === '/doc-import' || cmd === '/import-doc') {
    cmdDocImport(chatId, arg).catch(err => {
      console.error('[❌ doc-import]', err);
      sendText(chatId, `⚠️ ${err.message}`).catch(() => {});
    });
  } else if (cmd === '/week') {
    generateWeekly(chatId, sendDt).catch(err => {
      console.error('[❌ weekly]', err);
      const reason = err.friendlyMessage || err.message || String(err);
      sendText(chatId, `⚠️ 周报生成失败：${reason}`).catch(() => {});
    });
  } else {
    await sendText(chatId, `未知命令 ${cmd}。发 /help 看可用指令。`);
  }
  return true;
}

// ==========================================================================
// 单条消息处理（事件 + catchup 共用）
// ==========================================================================
const inflight = new Set();

async function handleMessage({ message, sender }) {
  const messageId = message.message_id;
  if (inflight.has(messageId)) return;
  if (isProcessed(messageId)) {
    return;
  }
  inflight.add(messageId);

  try {
    const chatId = message.chat_id;
    const senderOpenId = sender?.sender_id?.open_id;
    const createTimeMs = parseInt(message.create_time, 10);
    const sendDt = dayjs(createTimeMs).tz('Asia/Shanghai');
    const isNewChat = !state.chats[chatId];

    // 只接受 p2p 私聊
    if (message.chat_type && message.chat_type !== 'p2p') {
      console.log(`[⚠️ 非 p2p 丢弃] chat_type=${message.chat_type}`);
      markProcessed(messageId, chatId, createTimeMs);
      return;
    }

    // 首次配对
    if (!state.paired_open_id) {
      state.paired_open_id = senderOpenId;
      saveState(state);
      console.log(`[🤝 首次配对] ${senderOpenId}`);
      try {
        await replyText(messageId, '🛡️ 私密日记 bot 已配对，仅接收来自你的消息。发 /help 查看全部命令。');
      } catch {}
    } else if (senderOpenId && state.paired_open_id !== senderOpenId) {
      console.log(`[🚫 非授权] ${senderOpenId}`);
      markProcessed(messageId, chatId, createTimeMs);
      return;
    }

    // 记住 p2p 主聊天 chat_id —— bot 菜单点击事件(menu_v6)不带 chat_id，回信时用它
    if (chatId && state.paired_chat_id !== chatId && (!message.chat_type || message.chat_type === 'p2p')) {
      state.paired_chat_id = chatId;
      saveState(state);
    }

    const msgType = message.message_type;
    let content;
    try {
      content = JSON.parse(message.content || '{}');
    } catch {
      content = {};
    }

    if (msgType === 'text') {
      const text = (content.text || '').trim();
      if (text.startsWith('/')) {
        const handled = await tryDispatchCommand(text, chatId, sendDt);
        if (handled) reactOk(messageId);
      } else {
        appendLogAt(sendDt, text);
        console.log(`[📝 文本 ${sendDt.format('YYYY-MM-DD HH:mm:ss')}] ${text.slice(0, 40)}`);
        reactOk(messageId);
        // URL 异步丰富：抓 title/description 后追加 quote 到 raw_logs（功能开关；不阻塞主流程）
        const urls = flags.enableUrlEnrich() ? urlEnrich.extractUrls(text) : [];
        if (urls.length) {
          (async () => {
            for (const u of urls.slice(0, 3)) {
              const meta = await urlEnrich.fetchMeta(u);
              const block = urlEnrich.renderMeta(meta);
              if (block) {
                appendLogAt(sendDt, block);
                console.log(`[🔗 url-meta] ${u} → ${meta.title?.slice(0, 60) || '(no title)'}`);
              }
            }
          })().catch(err => console.error('[url-enrich]', err.message));
        }
      }
    } else if (msgType === 'image') {
      const fileName = await downloadImage(messageId, content.image_key, sendDt);
      appendLogAt(sendDt, `![图片](assets/${fileName})`);
      console.log(`[🖼 图片 ${sendDt.format('YYYY-MM-DD HH:mm:ss')}] ${fileName}`);
      reactOk(messageId);
    } else if (msgType === 'file') {
      const fileName = await downloadResource(messageId, content.file_key, sendDt, content.file_name, 'bin');
      const note = content.file_name ? content.file_name : fileName;
      appendLogAt(sendDt, `📎 [文件: ${note}](assets/${encodeURIComponent(fileName)})`);
      console.log(`[📎 文件 ${sendDt.format('YYYY-MM-DD HH:mm:ss')}] ${fileName}`);
      reactOk(messageId);
    } else if (msgType === 'audio') {
      const fileName = await downloadResource(messageId, content.file_key, sendDt, null, 'opus');
      const dur = content.duration ? `（${Math.round(parseInt(content.duration, 10) / 1000)}s）` : '';
      console.log(`[🎙 语音 ${sendDt.format('YYYY-MM-DD HH:mm:ss')}] ${fileName}，开始转写...`);
      reactOk(messageId);
      // 先把语音文件落档，再尝试转写（功能开关 + 转写失败都保留音频）
      appendLogAt(sendDt, `🎙 [语音${dur}](assets/${encodeURIComponent(fileName)})`);
      if (!flags.enableAsr()) {
        console.log(`[🎙 ASR 已关闭] 仅落档 ${fileName}`);
      } else {
      try {
        const audioPath = path.join(VAULT_DIR, sendDt.format('YYYY-MM-DD'), 'assets', fileName);
        const transcript = await transcribeAudio(audioPath);
        if (transcript) {
          // 转录作为 quote 紧跟在语音 entry 后；进 /diary 上下文时 LLM 会识别这是 ASR 结果
          const { logFile } = getDateContext(sendDt.format('YYYY-MM-DD'));
          fs.appendFileSync(logFile, `> 🗣️ ${transcript}\n\n`);
          console.log(`[✅ 转录] ${fileName}: ${transcript.slice(0, 60)}...`);
          // 转录结果回发给用户，比单纯的 OK 表情更直观
          await sendText(chatId, `🗣️ ${transcript}`);
        }
      } catch (err) {
        console.error(`[⚠️ 转录失败] ${fileName}: ${err.message}`);
      }
      } // end else (enableAsr)
    } else if (msgType === 'media') {
      const fileName = await downloadResource(messageId, content.file_key, sendDt, content.file_name, 'mp4');
      const dur = content.duration ? `（${Math.round(parseInt(content.duration, 10) / 1000)}s）` : '';
      const note = content.file_name || fileName;
      appendLogAt(sendDt, `🎬 [视频${dur}: ${note}](assets/${encodeURIComponent(fileName)})`);
      console.log(`[🎬 视频 ${sendDt.format('YYYY-MM-DD HH:mm:ss')}] ${fileName}`);
      reactOk(messageId);
    } else if (msgType === 'sticker') {
      console.log(`[😀 sticker 忽略]`);
    } else if (msgType === 'post') {
      // 富文本：把所有段落里的 text 段拍平
      const lines = (content.content || []).map(line =>
        line.map(seg => seg.text || '').join('')
      ).filter(Boolean);
      const flat = (content.title ? `**${content.title}**\n` : '') + lines.join('\n');
      if (flat.trim()) {
        appendLogAt(sendDt, flat);
        console.log(`[📜 post ${sendDt.format('YYYY-MM-DD HH:mm:ss')}]`);
        reactOk(messageId);
      }
    } else {
      console.log(`[❓ 未支持 msg_type=${msgType}]`);
    }

    markProcessed(messageId, chatId, createTimeMs);

    // 新 chat 第一次出现 → 异步回拉这个 chat 的全部历史消息
    if (isNewChat) {
      backfillNewChat(chatId, createTimeMs).catch(() => {});
    }
  } catch (err) {
    // 失败只 log，不回吐给用户。markProcessed 没被调用，下次启动 catchup 会
    // 自动重拉这条消息重试 —— 安静的故障恢复，避免在聊天里堆积过期错误信息。
    console.error(`[❌ 处理失败] ${messageId}:`, err.message);
  } finally {
    inflight.delete(messageId);
  }
}

// ==========================================================================
// 历史拉取：飞书 bot 的 im.chat.list 不返回 p2p 聊天，所以无法从平台主动
// 列出所有跟 bot 私聊的 user。我们的策略是：
//   - 已知的 chat_id（state.chats）走启动 catchup，按 last_processed_ts 拉增量
//   - 全新的 chat_id 在 WS 收到第一条实时消息时就地触发 backfill，把这个
//     chat 在 [bot 创建以来 ~ 这条消息] 的全部历史拉回来
// 这样即便事件订阅生效之前发的 7-8 条消息也能从 message.list 里补全。
// ==========================================================================
async function pullChatMessages(chatId, startSec, endSec) {
  let token;
  let count = 0;
  do {
    const r = await client.im.message.list({
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        start_time: String(startSec),
        end_time: String(endSec),
        sort_type: 'ByCreateTimeAsc',
        page_size: 50,
        page_token: token,
      },
    });
    const items = r.data?.items || [];
    for (const m of items) {
      if (m.sender?.sender_type === 'app') continue; // 跳过 bot 自己
      await handleMessage({
        message: {
          message_id: m.message_id,
          chat_id: m.chat_id,
          chat_type: 'p2p',
          create_time: m.create_time,
          message_type: m.msg_type,
          content: m.body?.content,
        },
        sender: { sender_id: { open_id: m.sender?.id } },
      });
      count++;
    }
    token = r.data?.has_more ? r.data.page_token : null;
  } while (token);
  return count;
}

// 滚动缓冲：catchup 起点永远是 last_processed_ts - CATCHUP_BUFFER_MS。
// 这样：
//   1. 不会漏掉 last_processed_ts 那一秒内更晚到达的消息
//   2. 失败 / 异常 / WS 偶尔丢的消息都能在 buffer 内被重新拉到
//   3. dedup 表（processed_message_ids）保证不会重复处理已成功的消息
// 代价：每次 catchup 多扫 buffer 时长的消息（dedup 跳过几乎瞬间）
const CATCHUP_BUFFER_MS = 60 * 60 * 1000; // 1 小时
const CATCHUP_MAX_LOOKBACK_MS = 30 * 86400 * 1000; // 30 天上限（首次启动）

async function catchupKnownChats(opts = {}) {
  const chatIds = Object.keys(state.chats);
  const tag = opts.label || 'catchup';
  console.log(`[🔁 ${tag}] 已知 chat_id: ${chatIds.length} 个`);
  if (chatIds.length === 0) {
    if (!opts.silentEmpty) {
      console.log(`[🔁 ${tag}] 首次启动，无历史水位线。等收到第一条实时消息后会自动回拉该 chat 历史。`);
    }
    return;
  }
  for (const chatId of chatIds) {
    const lastTs = state.chats[chatId]?.last_processed_ts || 0;
    // 永远比 last_processed_ts 早 BUFFER 重新扫一遍，dedup 兜底
    const effectiveStartMs = lastTs
      ? Math.max(0, lastTs - CATCHUP_BUFFER_MS)
      : Date.now() - CATCHUP_MAX_LOOKBACK_MS;
    const startSec = Math.floor(effectiveStartMs / 1000);
    const endSec = Math.floor(Date.now() / 1000);
    try {
      const n = await pullChatMessages(chatId, startSec, endSec);
      console.log(`[✅ ${tag}] ${chatId} 扫描完，新处理 ${n} 条`);
    } catch (err) {
      console.error(`[❌ ${tag} ${chatId}]`, err.message);
    }
  }
}

// ==========================================================================
// HTTP /ingest 入口处理：把 Tasker / HTTP Shortcuts 灌入的内容写进 raw_logs
// ==========================================================================
async function handleIngest({ text, imagePath, audioPath, sendDt, source, tags }) {
  const dateStr = sendDt.format('YYYY-MM-DD');
  const { assetsPath } = getDateContext(dateStr);
  const archived = [];
  const sourceTag = source ? `[ingest:${source}]` : '[ingest]';

  // 文件搬运：复制到当天 assets/ 下（带时间戳前缀，保证命名一致性）
  const stamp = sendDt.format('HHmmss');
  function adoptFile(srcPath, kind) {
    const base = path.basename(srcPath);
    const safe = base.replace(/[^\w.\-]/g, '_');
    const dest = path.join(assetsPath, `${stamp}_${kind}_${safe}`);
    fs.copyFileSync(srcPath, dest);
    return path.basename(dest);
  }

  let line = '';
  if (text) line += `${sourceTag} ${text}`;
  if (imagePath) {
    const fn = adoptFile(imagePath, 'img');
    line += `${line ? '\n' : ''}${sourceTag} ![图片](assets/${fn})`;
    archived.push('image');
  }
  if (audioPath) {
    const fn = adoptFile(audioPath, 'aud');
    line += `${line ? '\n' : ''}${sourceTag} 🎙 [语音](assets/${encodeURIComponent(fn)})`;
    archived.push('audio');
  }
  if (tags) line += `\n${tags}`;
  if (text) archived.unshift('text');

  appendLogAt(sendDt, line);

  console.log(`[📥 ingest] ${dateStr} ${sendDt.format('HH:mm:ss')} ${archived.join('+')} from ${source || '?'}`);
  return { date: dateStr, archived };
}

const backfillingChats = new Set();
async function backfillNewChat(chatId, beforeMs) {
  if (backfillingChats.has(chatId)) return;
  backfillingChats.add(chatId);
  try {
    const startSec = Math.floor((Date.now() - 30 * 86400000) / 1000);
    const endSec = Math.floor(beforeMs / 1000); // 不重复处理触发它的那条消息
    console.log(`[🆕 新 chat 历史回拉] ${chatId} 拉最近 30 天 ...`);
    const n = await pullChatMessages(chatId, startSec, endSec);
    console.log(`[✅ 历史回拉] ${chatId} 处理 ${n} 条`);
  } catch (err) {
    console.error(`[❌ 历史回拉 ${chatId}]`, err.message);
  } finally {
    backfillingChats.delete(chatId);
  }
}

// ==========================================================================
// 启动
// ==========================================================================
// 飞书 bot 自定义菜单点击 —— event_key 即命令名（如 "diary"），映射成 /命令 复用 tryDispatchCommand。
// menu_v6 事件不带 chat_id，回信用上面记下的 state.paired_chat_id。
async function handleBotMenu(data) {
  const openId = data?.operator?.operator_id?.open_id;
  const key = (data?.event_key || '').trim();
  console.log(`[🔘 bot.menu] key=${key} by=${openId}`);
  if (!key) return;
  if (state.paired_open_id && openId && openId !== state.paired_open_id) {
    console.log('[🚫 非授权菜单点击]');
    return;
  }
  const chatId = state.paired_chat_id;
  if (!chatId) {
    console.log('[⚠️ 菜单点击但无 paired_chat_id —— 先给 bot 发任意一条消息激活]');
    return;
  }
  const cmd = key.startsWith('/') ? key : '/' + key;
  try {
    await tryDispatchCommand(cmd, chatId, dayjs().tz('Asia/Shanghai'));
  } catch (err) {
    console.error('[❌ 菜单命令]', err.message);
  }
}

async function main() {
  try {
    await catchupKnownChats();
  } catch (err) {
    console.error('[❌ catchup 异常]', err.message);
  }

  const noop = async () => {}; // 静默事件，仅消除 SDK warn 日志
  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async data => {
      console.log(`[📨 im.message.receive_v1] msg_id=${data.message?.message_id} type=${data.message?.message_type}`);
      try {
        await handleMessage({ message: data.message, sender: data.sender });
      } catch (err) {
        console.error('[❌ event 处理]', err);
      }
    },
    // bot 自定义菜单点击 → 映射成命令执行
    'application.bot.menu_v6': async data => {
      try {
        await handleBotMenu(data);
      } catch (err) {
        console.error('[❌ menu 事件处理]', err);
      }
    },
    // bot 自己加的 reaction 也会回声成事件，这里统一吞掉
    'im.message.reaction.created_v1': noop,
    'im.message.reaction.deleted_v1': noop,
    'im.message.message_read_v1': noop,
    'im.message.recalled_v1': noop,
    'im.message.bot_muted_v1': noop,
    'user_status_change': noop,
  });

  // 诊断包装：任何到达 dispatcher 的事件都打日志，定位「WS 通了但事件不路由」
  const origInvoke = dispatcher.invoke.bind(dispatcher);
  dispatcher.invoke = async function (...args) {
    const ev = args[0] || {};
    const evType =
      ev?.header?.event_type ||
      ev?.event_type ||
      'UNKNOWN';
    console.log(`[📡 事件入口] event_type=${evType}`);
    try {
      return await origInvoke(...args);
    } catch (err) {
      console.error('[❌ dispatcher.invoke]', err);
      throw err;
    }
  };

  const ws = new lark.WSClient({
    appId: APP_ID,
    appSecret: APP_SECRET,
    domain: lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.info,
  });
  ws.onReady = () => console.log('[🟢 WS] 长连接已就绪');
  ws.onError = err => console.error('[🔴 WS] 错误:', err?.message || err);
  ws.onReconnecting = () => console.log('[🟡 WS] 重连中...');
  ws.onReconnected = () => console.log('[🟢 WS] 重连成功');

  ws.start({ eventDispatcher: dispatcher });
  console.log('🛡️ 飞书私密日记 bot 已启动 (WS 长连接)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('提示：发 /help 查看全部命令。每条处理完会打 OK 表情作为已读标记。');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 🔥 异步 warmup：把 text + vision 模型先加载到内存，避免第一次 /diary 撞 cold start
  // ollama-client 默认 keep_alive=30m，加载后常驻不卸载
  // 失败不阻塞主流程（ollama 可能没起、瞬时网络问题）
  ollama.warmup([OLLAMA_TEXT_MODEL, OLLAMA_VISION_MODEL]).catch(() => {});

  // 定期 catchup 兜底：每 30 分钟扫一次最近 1h 窗口。
  // WS 偶尔丢事件、Feishu 网关瞬时不通、本地代码 panic 全部能被这层补救。
  // 起点永远是 last_processed_ts - CATCHUP_BUFFER_MS（1h），dedup 表过滤已处理。
  const PERIODIC_CATCHUP_MS = 30 * 60 * 1000; // 30 分钟
  setInterval(() => {
    catchupKnownChats({ label: 'periodic-catchup', silentEmpty: true })
      .catch(err => console.error('[❌ periodic-catchup]', err.message));
  }, PERIODIC_CATCHUP_MS);
  console.log(`⏱  定期 catchup 已启动，每 ${PERIODIC_CATCHUP_MS / 60000} 分钟回扫一次（buffer ${CATCHUP_BUFFER_MS / 60000} 分钟）`);

  // HTTP /ingest 端点：让 Android (Tasker / HTTP Shortcuts) 直接灌入文本/图片/音频
  // 必须配 INGEST_TOKEN（≥16 char），跨设备走 Tailscale / SSH tunnel 不暴露公网
  // 同时给 desktop GUI 提供 /command 端点（仅 127.0.0.1，无需 token）
  const ingestToken = process.env.INGEST_TOKEN;
  const onCommand = async ({ command, date, chatId }) => {
    // 仅支持触发不需要 chat 上下文也能跑的命令（diary / week）
    // 没传 chatId 就用配对的 paired_open_id 对应的 p2p chat（state.chats 第一个）
    let targetChatId = chatId;
    if (!targetChatId) {
      const knownChats = Object.keys(state.chats || {});
      if (knownChats.length) targetChatId = knownChats[0];
    }
    if (!targetChatId) {
      throw new Error('找不到可用的 chat_id（bot 还没收到过私聊消息）');
    }
    const sendDt = dayjs().tz('Asia/Shanghai');
    const dateStr = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : sendDt.format('YYYY-MM-DD');
    if (command === 'diary') {
      generateDiary(dateStr, targetChatId).catch(err => console.error('[/command diary]', err));
      return { triggered: 'diary', date: dateStr, chatId: targetChatId };
    }
    if (command === 'week' || command === 'weekly') {
      generateWeekly(targetChatId, sendDt).catch(err => console.error('[/command week]', err));
      return { triggered: 'week', chatId: targetChatId };
    }
    throw new Error(`不支持的命令: ${command}（目前只支持 diary / week）`);
  };
  if (ingestToken) {
    startIngestServer({ token: ingestToken, onIngest: handleIngest, onCommand });
  } else {
    // 无 INGEST_TOKEN 也启动 server，但只开 /command + /health（不开 /ingest）
    // 给 token 一个随机值绕过启动检查，但路由层 /ingest 仍要验证（不知 token 就 401）
    const crypto = require('crypto');
    const fakeToken = crypto.randomBytes(24).toString('hex'); // 用户不知道这个 token → /ingest 失败但 /command 可用
    startIngestServer({ token: fakeToken, onIngest: handleIngest, onCommand });
    console.log('💡 未设 INGEST_TOKEN —— /ingest 不可用，但 /command 端点为 desktop GUI 开放');
  }
}

main().catch(err => {
  console.error('[💥 启动失败]', err);
  process.exit(1);
});
