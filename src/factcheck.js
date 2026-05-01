/**
 * Fact-check requests via Grok (xAI).
 *
 * Active subscribers send "تحقق: <text>" or an image with a "تحقق" caption.
 * We download the image (if present), forward to Grok with an Arabic
 * fact-check system prompt, parse the verdict + reasoning, and reply.
 *
 * Cost guard: per-user rate limit (5/day + 5-min cooldown). Failed/blocked
 * attempts don't count toward quota.
 *
 * Routing is in handlers.js — handleInboundMessage detects the trigger and
 * dispatches here regardless of state-based routing (subject to eligibility).
 */

import { sendTextMessage, GRAPH_API_VERSION } from './whatsapp.js';

const DAILY_QUOTA       = 5;
const COOLDOWN_MS       = 5 * 60 * 1000;
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

const MAX_PROMPT_TEXT   = 2000;   // truncate user input we forward to Grok
const MAX_RESPONSE_TEXT = 4000;   // truncate what we store in DB
const MAX_OUTPUT_TOKENS = 600;
const GROK_TIMEOUT_MS   = 30_000;

// JavaScript's \b word boundary only recognizes ASCII word characters, so
// /^\s*تحقق\b/ never matches Arabic input. Use a Unicode-aware negative
// lookahead instead — keyword must be followed by end-of-string or any
// non-letter character (whitespace, : ، . etc.). This correctly rejects
// Arabic words that happen to start with "تحقق" (e.g. "تحققان").
const TRIGGER_KEYWORD = 'تحقق';
const SEPARATOR_RE    = /^[\s:،,.\-]+/u;

const SYSTEM_PROMPT = `أنت مساعد ذكي للتحقق من الأخبار. سيُعرض عليك خبر نصي أو صورة، وعليك تقييم مدى دقّته/صحته بناءً على معرفتك العامة.

أعد إجابتك بالشكل التالي بالضبط:

[الحكم]: 🟢 صحيح
أو
[الحكم]: 🟡 يحتاج مراجعة
أو
[الحكم]: 🔴 غير صحيح
أو
[الحكم]: ⚪ لا يمكن التحقق

[الشرح]: فقرة قصيرة من 2-4 جمل توضح سبب الحكم.

[المصادر]: (اختياري) إذا كان لديك معرفة بمصادر موثوقة، اذكرها بإيجاز.

ملاحظات مهمة:
- إذا لم تكن متأكداً، اختر "🟡 يحتاج مراجعة" أو "⚪ لا يمكن التحقق" بدلاً من التخمين.
- اكتب الإجابة بالعربية الفصحى المبسّطة.
- لا تتجاوز 200 كلمة في الشرح.
- لا تحاول التحقق من معلومات شخصية أو خاصة.`;

const DISCLAIMER = '\n\n⚠️ النتيجة استرشادية وقد تكون غير دقيقة. يبقى التحقق النهائي على عاتق القارئ.';

// ----------------------------------------------------------------------------
// Public: trigger detection (called from handlers.js)
// ----------------------------------------------------------------------------

/**
 * Inspect an inbound WhatsApp message; if it's a fact-check trigger, return
 * a normalized payload, else null.
 *
 * Returns:
 *   { type: 'text',  text: '<user content without trigger>' }
 *   { type: 'image', mediaId, caption }
 *   null
 */
export function parseFactCheckTrigger(message) {
  if (!message) return null;

  let raw = '';
  let isImage = false;
  let mediaId = null;

  if (message.type === 'text') {
    raw = message.text?.body || '';
  } else if (message.type === 'image') {
    raw = message.image?.caption || '';
    mediaId = message.image?.id;
    isImage = true;
  } else {
    return null;
  }

  // Trim any leading whitespace (incl. RTL marks Meta sometimes injects)
  const body = raw.replace(/^[\s‎‏‪-‮]+/, '');

  if (!body.startsWith(TRIGGER_KEYWORD)) return null;

  // What's right after the keyword — end-of-string or non-letter is required
  // to avoid matching longer Arabic words that begin with "تحقق".
  const after = body.slice(TRIGGER_KEYWORD.length);
  if (after.length > 0 && /^\p{L}/u.test(after)) return null;

  // Strip leading separators (colon, comma, dash, whitespace, Arabic comma)
  const content = after.replace(SEPARATOR_RE, '').trim();

  if (isImage) {
    return {
      type: 'image',
      mediaId,
      caption: content.slice(0, MAX_PROMPT_TEXT) || 'تحقق من هذه الصورة',
    };
  }

  if (!content) return null;  // text mode requires actual content after the keyword
  return { type: 'text', text: content.slice(0, MAX_PROMPT_TEXT) };
}

// ----------------------------------------------------------------------------
// Public: handler
// ----------------------------------------------------------------------------

export async function handleFactCheckRequest(env, phone, subscriber, trigger) {
  const t0 = Date.now();

  if (subscriber?.state !== 'active') {
    await persist(env, phone, trigger, null, null, 'not_eligible', null, null, t0);
    await sendTextMessage(env, phone, 'هذه الخدمة متاحة للمشتركين النشطين فقط.');
    return;
  }

  const limit = await checkRateLimit(env, phone);
  if (limit) {
    await persist(env, phone, trigger, null, null, 'rate_limited', null, null, t0);
    const msg = limit === 'daily_limit'
      ? `تجاوزت الحد اليومي للتحقق (${DAILY_QUOTA} طلبات). أعد المحاولة بعد 24 ساعة.`
      : 'يُرجى الانتظار 5 دقائق بين كل طلبين.';
    await sendTextMessage(env, phone, msg);
    return;
  }

  if (!env.XAI_API_KEY) {
    console.error('[factcheck] XAI_API_KEY not configured');
    await persist(env, phone, trigger, null, null, 'model_error', null, 'XAI_API_KEY missing', t0);
    await sendTextMessage(env, phone, 'الخدمة غير متاحة حالياً.');
    return;
  }

  let userContent;
  if (trigger.type === 'image') {
    let dataUrl;
    try {
      dataUrl = await downloadMetaMediaAsDataUrl(env, trigger.mediaId);
    } catch (err) {
      const m = err.message || String(err);
      console.error('[factcheck] media download failed:', m);
      await persist(env, phone, trigger, null, null, 'media_error', null, m, t0);
      await sendTextMessage(env, phone, 'تعذّر قراءة الصورة. حاول إرسالها مرة أخرى.');
      return;
    }
    userContent = [
      { type: 'text', text: trigger.caption || 'تحقق من هذه الصورة' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ];
  } else {
    userContent = trigger.text;
  }

  let grokText;
  try {
    grokText = await callGrok(env, userContent);
  } catch (err) {
    const m = err.message || String(err);
    console.error('[factcheck] Grok call failed:', m);
    await persist(env, phone, trigger, null, null, 'model_error', null, m, t0);
    await sendTextMessage(env, phone, 'تعذّر الوصول إلى خدمة التحقق حالياً. حاول لاحقاً.');
    return;
  }

  const verdict = extractVerdict(grokText);
  const trimmedResponse = grokText.length > MAX_RESPONSE_TEXT ? grokText.slice(0, MAX_RESPONSE_TEXT) : grokText;
  const reply = `${grokText.trim()}${DISCLAIMER}`;

  let wamid = null;
  try {
    const sent = await sendTextMessage(env, phone, reply);
    wamid = sent?.messages?.[0]?.id || null;
  } catch (err) {
    const m = err.message || String(err);
    console.error('[factcheck] reply send failed:', m);
    await persist(env, phone, trigger, verdict, trimmedResponse, 'send_failed', null, m, t0);
    return;
  }

  await persist(env, phone, trigger, verdict, trimmedResponse, 'replied', wamid, null, t0);
}

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------

async function checkRateLimit(env, phone) {
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN requested_at > ? THEN 1 ELSE 0 END) AS day_count,
       MAX(requested_at) AS last_at
     FROM factcheck_requests
     WHERE phone = ? AND status = 'replied'`
  ).bind(now - ROLLING_WINDOW_MS, phone).first();

  const dayCount = row?.day_count || 0;
  const lastAt   = row?.last_at;
  if (dayCount >= DAILY_QUOTA) return 'daily_limit';
  if (lastAt && (now - lastAt) < COOLDOWN_MS) return 'cooldown';
  return null;
}

async function downloadMetaMediaAsDataUrl(env, mediaId) {
  if (!mediaId) throw new Error('missing mediaId');
  const headers = { 'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` };

  const metaResp = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, { headers });
  if (!metaResp.ok) {
    const t = await metaResp.text();
    throw new Error(`media metadata ${metaResp.status}: ${t.slice(0, 200)}`);
  }
  const meta = await metaResp.json();
  if (!meta.url) throw new Error('media metadata missing url');

  const binResp = await fetch(meta.url, { headers });
  if (!binResp.ok) throw new Error(`media bytes ${binResp.status}`);
  const buf = await binResp.arrayBuffer();
  const mime = meta.mime_type || binResp.headers.get('content-type') || 'image/jpeg';
  return `data:${mime};base64,${arrayBufferToBase64(buf)}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function callGrok(env, userContent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROK_TIMEOUT_MS);
  try {
    const resp = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.XAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.GROK_MODEL || 'grok-2-vision-1212',
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userContent },
        ],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`xAI ${resp.status}: ${text.slice(0, 300)}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('xAI response missing message.content');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function extractVerdict(text) {
  if (!text) return null;
  if (text.includes('🟢')) return 'ok';
  if (text.includes('🟡')) return 'review';
  if (text.includes('🔴')) return 'wrong';
  if (text.includes('⚪')) return 'unknown';
  return null;
}

async function persist(env, phone, trigger, verdict, response, status, wamid, error, t0) {
  try {
    const promptText = trigger?.type === 'text' ? trigger.text : (trigger?.caption || null);
    const mediaId    = trigger?.type === 'image' ? trigger.mediaId : null;
    await env.DB.prepare(
      `INSERT INTO factcheck_requests
        (phone, type, prompt_text, media_id, verdict, response_text, status,
         requested_at, latency_ms, error, wa_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      phone,
      trigger?.type || 'text',
      promptText,
      mediaId,
      verdict,
      response,
      status,
      t0,
      Date.now() - t0,
      error,
      wamid,
    ).run();
  } catch (err) {
    console.error('[factcheck] persist failed:', err);
  }
}
