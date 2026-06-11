// 飞书云文档导入 —— 把云文档内容按时间戳拆开,落进 raw_logs,再异步重建索引
//
// 用法:
//   const fd = require('./feishu-doc');
//   const r = await fd.importDocFromInput({ input: '<url or doc_id>', tenantToken, defaultDate: 'YYYY-MM-DD' });
//
// 设计要点:
//   - 支持三种 URL 形态: 完整 https://<tenant>.feishu.cn/docx/<id>  /  /wiki/<token>  / 裸 doc_id
//   - wiki 链接要先用 wiki v2 接口 resolve 出 obj_token(就是 doc_id)
//   - 内容按时间戳拆分: 优先 **HH:MM:SS**, 其次 HH:MM:SS / HH:MM, 再容错 YYYY-MM-DD HH:MM[:SS]
//   - 日期优先从内容里抽(Y标题/MM月DD日/YYYY-MM-DD), 都没有才用 defaultDate
//   - 每个时间戳块落 raw_logs 时加 (从飞书云文档导入: <id>) 标记,方便后续溯源/批量删除
//   - ENABLE_EMBEDDINGS=true 时调 embeddings.indexDate(dateStr) 重建该日索引
//
// 需要权限: docx:document:readonly (View upgraded Docs)

const path = require('path');
const fs = require('fs');
const https = require('https');
const { URL } = require('url');
const dayjs = require('dayjs');
const { VAULT_DIR } = require('./paths');

// ============================================================================
// URL 解析
// ============================================================================

// docx API 文档说 document_id 是 27 字符,前缀 dox
const DOC_ID_RE = /^dox[a-zA-Z0-9]{23,30}$/;
const WIKI_TOKEN_RE = /^[A-Za-z0-9]{6,40}$/;   // wiki token 长度不固定,放宽

function parseDocUrl(input) {
  const s = String(input || '').trim();
  if (!s) return { kind: 'empty' };

  // 裸 doc_id
  if (DOC_ID_RE.test(s)) {
    return { kind: 'doc', docId: s };
  }

  let url;
  try { url = new URL(s); } catch { return { kind: 'invalid', input: s }; }
  if (!/(^|\.)feishu\.cn$|(^|\.)larksuite\.com$/.test(url.hostname)) {
    return { kind: 'invalid_host', host: url.hostname };
  }

  // /docx/<id>  (新版云文档)
  let m = url.pathname.match(/^\/docx\/([A-Za-z0-9_-]+)/);
  if (m) return { kind: 'doc', docId: m[1] };

  // /docs/<id>  (旧版)
  m = url.pathname.match(/^\/docs\/([A-Za-z0-9_-]+)/);
  if (m) return { kind: 'doc', docId: m[1] };

  // /wiki/<token>
  m = url.pathname.match(/^\/wiki\/([A-Za-z0-9_-]+)/);
  if (m) return { kind: 'wiki', wikiToken: m[1] };

  return { kind: 'unknown_path', path: url.pathname };
}

// ============================================================================
// 飞书 API 调用
// ============================================================================

function apiGet(hostname, path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'GET', headers: { Authorization: 'Bearer ' + token } },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          let j;
          try { j = JSON.parse(d); } catch { return reject(new Error(`API 返回非 JSON (HTTP ${res.statusCode}): ${d.slice(0, 200)}`)); }
          if (j.code !== 0) {
            const err = new Error(`飞书 API 错误 code=${j.code} msg=${j.msg}`);
            err.feishuCode = j.code; err.feishuMsg = j.msg;
            return reject(err);
          }
          resolve(j.data);
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function resolveWikiToken(wikiToken, tenantToken) {
  const data = await apiGet('open.feishu.cn', `/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(wikiToken)}`, tenantToken);
  const node = data?.node;
  if (!node) throw new Error(`wiki token ${wikiToken} resolve 失败: 空 node`);
  if (node.obj_type !== 'docx') {
    throw new Error(`wiki 节点 obj_type=${node.obj_type}, 仅支持 docx 类型云文档`);
  }
  return node.obj_token;
}

async function fetchDocRaw(docId, tenantToken) {
  const data = await apiGet('open.feishu.cn', `/open-apis/docx/v1/documents/${encodeURIComponent(docId)}/raw_content?lang=0`, tenantToken);
  return { docId, content: data?.content || '' };
}

// ============================================================================
// 时间戳 / 日期拆分
// ============================================================================

// 优先级 1: **HH:MM:SS** 或 **HH:MM** (bold, 跟现有 raw_logs 格式一致)
// 优先级 2: HH:MM:SS 或 HH:MM 行首
// 优先级 3: YYYY-MM-DD HH:MM[:SS]
// 优先级 4: 中文 M月D日 / MM月DD日
const RE_BOLD_TIME = /\*\*(\d{1,2}):(\d{2})(?::(\d{2}))?\*\*/g;
const RE_PLAIN_TIME = /(?:^|\n)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?=\n|$)/gm;
const RE_ISO_DATETIME = /(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d)/g;
const RE_CN_DATE = /(20\d{2})年(\d{1,2})月(\d{1,2})日(?!\d)/g;

// 整段 doc 顶部/底部的"显式日期"行(可作为后续时间块的默认日期)
const RE_DATE_HEADING = /^\s*#{1,6}\s*(?:日期[:：]?\s*)?(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/m;
const RE_DATE_HEADING_CN = /^\s*#{1,6}\s*(?:日期[:：]?\s*)?(20\d{2})年(\d{1,2})月(\d{1,2})日(?!\d)/m;
const RE_DATE_INLINE_HEAD = /^\s*(?:日期|Date|Day)[:：]\s*(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/im;

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtDate(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function fmtTime(h, m, s) {
  return `${pad2(h)}:${pad2(m)}:${s != null ? pad2(s) : '00'}`;
}

// 抽出 doc 里"显式日期"作为 fallback,扫开头 + 末尾 + 标题
function detectDocDefaultDate(content) {
  const head = content.slice(0, 1500);
  const tail = content.length > 1500 ? content.slice(-1000) : '';
  let m;
  if ((m = head.match(RE_DATE_HEADING))) return fmtDate(+m[1], +m[2], +m[3]);
  if ((m = head.match(RE_DATE_HEADING_CN))) return fmtDate(+m[1], +m[2], +m[3]);
  if ((m = head.match(RE_DATE_INLINE_HEAD))) return fmtDate(+m[1], +m[2], +m[3]);
  // 兜底: head 里任意位置的 ISO / 中文日期,取第一个
  const reAnyIso = /(20\d{2})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/g;
  let mm;
  if ((mm = reAnyIso.exec(head))) return fmtDate(+mm[1], +mm[2], +mm[3]);
  const reAnyCn = /(20\d{2})年(\d{1,2})月(\d{1,2})日(?!\d)/g;
  if ((mm = reAnyCn.exec(head))) return fmtDate(+mm[1], +mm[2], +mm[3]);
  // 末段也扫一下
  if (tail) {
    if ((mm = reAnyIso.exec(tail))) return fmtDate(+mm[1], +mm[2], +mm[3]);
    if ((mm = reAnyCn.exec(tail))) return fmtDate(+mm[1], +mm[2], +mm[3]);
  }
  return null;
}

// 拆分主入口
// 返回 [{date: 'YYYY-MM-DD', time: 'HH:MM:SS', text: '...'}, ...]
function splitByTimestamps(content, defaultDate) {
  if (!content || !content.trim()) return [];
  const lines = content.split(/\r?\n/);

  // 1. 找所有时间戳点(line index)
  const markers = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    let m;
    const reB = new RegExp(RE_BOLD_TIME.source, 'g');
    let found = null;
    while ((m = reB.exec(ln)) !== null) {
      found = { line: i, time: fmtTime(+m[1], +m[2], m[3] != null ? +m[3] : null), fullDate: null, col: m.index };
      break;
    }
    if (!found) {
      const reIso = new RegExp(RE_ISO_DATETIME.source, 'g');
      let used = false;
      while ((m = reIso.exec(ln)) !== null) {
        used = true;
        markers.push({
          line: i,
          time: fmtTime(+m[4], +m[5], m[6] != null ? +m[6] : null),
          fullDate: fmtDate(+m[1], +m[2], +m[3]),
          col: m.index,
        });
      }
      if (!used) {
        const reP = new RegExp(RE_PLAIN_TIME.source, 'gm');
        while ((m = reP.exec(ln)) !== null) {
          if (+m[1] < 24 && +m[2] < 60) {
            markers.push({
              line: i,
              time: fmtTime(+m[1], +m[2], m[3] != null ? +m[3] : null),
              fullDate: null,
              col: m.index,
            });
            break;
          }
        }
      }
    } else {
      markers.push(found);
    }
  }

  // 2. 找所有日期标记点(line index → date) —— 标题/独立行的 ISO / 中文日期
  //    用于在 mid-doc 切日期
  const dateMarkers = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    let m;
    if ((m = ln.match(RE_DATE_HEADING))) {
      dateMarkers.push({ line: i, date: fmtDate(+m[1], +m[2], +m[3]) });
    } else if ((m = ln.match(RE_DATE_HEADING_CN))) {
      dateMarkers.push({ line: i, date: fmtDate(+m[1], +m[2], +m[3]) });
    } else if ((m = ln.match(RE_DATE_INLINE_HEAD))) {
      dateMarkers.push({ line: i, date: fmtDate(+m[1], +m[2], +m[3]) });
    }
  }

  // 3. 拼起来按 line 排序,用于二分查找
  const allMarkers = [...markers, ...dateMarkers].sort((a, b) => a.line - b.line);

  if (!markers.length) {
    // 一个时间戳都没有 → 整篇当成一个块,时间用 00:00:00
    const detected = detectDocDefaultDate(content);
    let text = content.trim();
    if (detected) {
      const [y, m, d] = detected.split('-');
      const iso = detected.replace(/-/g, '[-/.]');
      const cn = `${y}年${parseInt(m, 10)}月${parseInt(d, 10)}日`;
      const stripped = text
        .replace(new RegExp(`^\\s*#+\\s*(?:日期[:：]?\\s*)?(${iso}|${cn})\\s*\\n`), '')
        .replace(new RegExp(`^\\s*(?:日期|Date|Day)[:：]\\s*(${iso}|${cn})\\s*\\n`), '')
        .replace(new RegExp(`^\\s*(${iso}|${cn})\\s*\\n`), '');
      if (stripped !== text) text = stripped.trim();
    }
    return [{
      date: detected || defaultDate,
      time: '00:00:00',
      text,
    }];
  }

  // 4. 给每个 time marker 找最近一次出现的日期
  //    (a) 时间戳自身带 ISO 日期 → 用它
  //    (b) 否则找在它之前最近的一个 dateMarker.date
  //    (c) 都没有 → 用 detectDocDefaultDate → defaultDate
  const detected = detectDocDefaultDate(content);
  const defaultFromContext = detected || defaultDate;
  const blocks = [];
  for (let i = 0; i < markers.length; i++) {
    const mk = markers[i];
    let blockDate = mk.fullDate;
    if (!blockDate) {
      // 二分找 last dateMarker.line < mk.line
      let lo = 0, hi = dateMarkers.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (dateMarkers[mid].line < mk.line) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      blockDate = ans >= 0 ? dateMarkers[ans].date : defaultFromContext;
    }
    const next = markers[i + 1];
    const startLine = mk.line;
    const endLine = next ? next.line : lines.length;
    const textLines = [];
    const startLineText = lines[startLine];
    // 把标记行的时间戳挖掉,保留其余内容
    const stripped = startLineText.replace(/\*\*\d{1,2}:\d{2}(?::\d{2})?\*\*/, '').replace(/^\s*\d{1,2}:\d{2}(?::\d{2})?/, '').trim();
    if (stripped) textLines.push(stripped);
    for (let j = startLine + 1; j < endLine; j++) {
      textLines.push(lines[j]);
    }
    const text = textLines.join('\n').trim();
    if (!text) continue;
    blocks.push({ date: blockDate, time: mk.time, text });
  }
  return blocks;
}

// ============================================================================
// 落档
// ============================================================================

function appendImportBlock(block, sourceDocId) {
  const dateStr = block.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`无法识别日期: ${dateStr}`);
  }
  const dirPath = path.join(VAULT_DIR, dateStr);
  const logFile = path.join(dirPath, '01_raw_logs.md');
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  if (!fs.existsSync(logFile)) {
    const fm = `---\ndate: ${dateStr}\ntype: raw-log\ntags: [daily, raw, ${dateStr.slice(0, 7)}]\n---\n\n`;
    fs.writeFileSync(logFile, fm);
  }

  const isShort = !block.text.includes('\n') && block.text.length < 80;
  const sourceTag = `> 📄 [从飞书云文档导入: ${sourceDocId}](${sourceDocId})`;
  const entry = isShort
    ? `**${block.time}**  ${block.text}\n${sourceTag}\n\n`
    : `**${block.time}**\n${block.text}\n\n${sourceTag}\n\n`;
  fs.appendFileSync(logFile, entry);
  return dateStr;
}

// ============================================================================
// 总入口
// ============================================================================

async function importDocFromInput({ input, tenantToken, defaultDate, onProgress }) {
  if (!tenantToken) throw new Error('缺少 tenant_token');

  // 1. 解析输入
  const parsed = parseDocUrl(input);
  console.log(`[doc-import] parseDocUrl: ${JSON.stringify(parsed)}`);
  if (parsed.kind === 'empty') throw new Error('用法: /doc-import <飞书云文档 URL 或 doc_id>');
  if (parsed.kind === 'invalid') throw new Error(`无法识别的输入: ${parsed.input}`);
  if (parsed.kind === 'invalid_host') throw new Error(`域名不是 feishu.cn: ${parsed.host}`);
  if (parsed.kind === 'unknown_path') throw new Error(`URL 路径不认识 (期望 /docx/<id> /docs/<id> /wiki/<token>): ${parsed.path}`);

  let docId = parsed.docId;
  if (parsed.kind === 'wiki') {
    if (onProgress) onProgress(`🔗 解析 wiki token → doc_id...`);
    docId = await resolveWikiToken(parsed.wikiToken, tenantToken);
    console.log(`[doc-import] wiki resolved: ${docId}`);
  }

  // 2. 拉内容
  if (onProgress) onProgress(`📥 拉取云文档 ${docId} 纯文本...`);
  console.log(`[doc-import] fetchDocRaw start: ${docId}`);
  const { content } = await fetchDocRaw(docId, tenantToken);
  console.log(`[doc-import] fetchDocRaw done, content length: ${content.length}`);
  if (!content.trim()) {
    return { docId, blocks: [], totalAppended: 0, affectedDates: [], reason: 'empty' };
  }

  // 3. 拆分
  const fallbackDate = defaultDate || dayjs().tz('Asia/Shanghai').format('YYYY-MM-DD');
  const blocks = splitByTimestamps(content, fallbackDate);
  console.log(`[doc-import] split done: ${blocks.length} blocks, dates: ${[...new Set(blocks.map(b=>b.date))].join(',')}`);

  // 4. 落档
  const affectedDates = new Set();
  for (const b of blocks) {
    appendImportBlock(b, docId);
    affectedDates.add(b.date);
  }
  console.log(`[doc-import] appended ${blocks.length} blocks to ${affectedDates.size} dates`);

  // 5. 重建索引
  if (process.env.ENABLE_EMBEDDINGS !== 'false') {
    try {
      const embeddings = require('./embeddings');
      for (const d of affectedDates) {
        if (onProgress) onProgress(`🔎 重建索引 ${d}...`);
        await embeddings.indexDate(d).catch(err => {
          console.error(`[doc-import] index ${d} 失败:`, err.message);
        });
      }
    } catch (e) {
      console.error('[doc-import] embeddings 模块加载失败:', e.message);
    }
  }

  return {
    docId,
    blocks,
    totalAppended: blocks.length,
    affectedDates: [...affectedDates],
  };
}

module.exports = {
  parseDocUrl,
  fetchDocRaw,
  resolveWikiToken,
  splitByTimestamps,
  detectDocDefaultDate,
  appendImportBlock,
  importDocFromInput,
};
