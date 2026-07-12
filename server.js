const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recordings (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      transcript TEXT DEFAULT '',
      lang TEXT DEFAULT 'uk-UA',
      duration_sec REAL DEFAULT 0,
      audio BYTEA,
      audio_mime TEXT DEFAULT 'audio/webm',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// Generate title + short description with Claude
async function generateMeta(transcript, lang) {
  const fallback = () => {
    const words = (transcript || '').trim().split(/\s+/).slice(0, 6).join(' ');
    return {
      title: words || 'Голосовий запис',
      description: (transcript || '').trim().slice(0, 150),
    };
  };
  if (!process.env.ANTHROPIC_API_KEY || !transcript || !transcript.trim()) return fallback();
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Ось транскрипт голосового повідомлення (мова: ${lang}). Придумай коротку назву (до 8 слів) і короткий опис (1-2 речення) тією ж мовою, що й транскрипт. Відповідай СУВОРО у форматі JSON: {"title": "...", "description": "..."}\n\nТранскрипт:\n${transcript.slice(0, 4000)}`,
        }],
      }),
    });
    if (!resp.ok) return fallback();
    const data = await resp.json();
    const text = data.content && data.content[0] && data.content[0].text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return fallback();
    const parsed = JSON.parse(m[0]);
    if (!parsed.title) return fallback();
    return { title: String(parsed.title).slice(0, 200), description: String(parsed.description || '').slice(0, 500) };
  } catch (e) {
    console.error('Claude API error:', e.message);
    return fallback();
  }
}

// Transcribe audio via OpenAI Whisper
app.post('/api/transcribe', async (req, res) => {
  const { audioBase64, audioMime = 'audio/webm', lang = 'uk-UA' } = req.body;
  if (!audioBase64) return res.status(400).json({ error: 'audioBase64 required' });
  if (!process.env.OPENAI_API_KEY)
    return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });
  try {
    const buf = Buffer.from(audioBase64, 'base64');
    const ext = /mp4|m4a/.test(audioMime) ? 'mp4' : /ogg/.test(audioMime) ? 'ogg' : 'webm';
    const language = lang.split('-')[0]; // 'uk-UA' → 'uk'
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: audioMime }), `audio.${ext}`);
    fd.append('model', 'whisper-1');
    fd.append('language', language);
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd,
    });
    if (!r.ok) {
      const t = await r.text();
      console.error('[whisper] API error:', t);
      return res.status(502).json({ error: t.slice(0, 300) });
    }
    const data = await r.json();
    res.json({ transcript: (data.text || '').trim() });
  } catch (e) {
    console.error('[whisper]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Create recording
app.post('/api/recordings', async (req, res) => {
  try {
    const { transcript = '', lang = 'uk-UA', audioBase64 = null, audioMime = 'audio/webm', durationSec = 0 } = req.body;
    const meta = await generateMeta(transcript, lang);
    const audioBuf = audioBase64 ? Buffer.from(audioBase64, 'base64') : null;
    const r = await pool.query(
      `INSERT INTO recordings (title, description, transcript, lang, duration_sec, audio, audio_mime)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, title, description, transcript, lang, duration_sec, audio_mime, created_at, (audio IS NOT NULL) AS has_audio`,
      [meta.title, meta.description, transcript, lang, durationSec, audioBuf, audioMime]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// List / search recordings
app.get('/api/recordings', async (req, res) => {
  try {
    const { q, from, to } = req.query;
    const conds = [];
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      conds.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length} OR transcript ILIKE $${params.length})`);
    }
    if (from) {
      params.push(from);
      conds.push(`created_at >= $${params.length}::date`);
    }
    if (to) {
      params.push(to);
      conds.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const r = await pool.query(
      `SELECT id, title, description, transcript, lang, duration_sec, audio_mime, created_at, (audio IS NOT NULL) AS has_audio
       FROM recordings ${where} ORDER BY created_at DESC LIMIT 500`, params);
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Calendar counts per day for a month
app.get('/api/calendar', async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10); // 1-12
    if (!year || !month) return res.status(400).json({ error: 'year and month required' });
    const r = await pool.query(
      `SELECT to_char(created_at, 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
       FROM recordings
       WHERE created_at >= make_date($1,$2,1) AND created_at < make_date($1,$2,1) + INTERVAL '1 month'
       GROUP BY 1`, [year, month]);
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Audio stream
app.get('/api/recordings/:id/audio', async (req, res) => {
  try {
    const r = await pool.query('SELECT audio, audio_mime FROM recordings WHERE id=$1', [req.params.id]);
    if (!r.rows.length || !r.rows[0].audio) return res.status(404).end();
    res.set('Content-Type', r.rows[0].audio_mime || 'audio/webm');
    res.send(r.rows[0].audio);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update title/description
app.patch('/api/recordings/:id', async (req, res) => {
  try {
    const { title, description } = req.body;
    const r = await pool.query(
      `UPDATE recordings SET title=COALESCE($1,title), description=COALESCE($2,description)
       WHERE id=$3 RETURNING id, title, description, transcript, lang, duration_sec, audio_mime, created_at, (audio IS NOT NULL) AS has_audio`,
      [title || null, description || null, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete
app.delete('/api/recordings/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM recordings WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

initDb()
  .then(() => app.listen(PORT, () => console.log(`Voice Notes running on port ${PORT}`)))
  .catch((e) => {
    console.error('DB init failed:', e);
    process.exit(1);
  });
