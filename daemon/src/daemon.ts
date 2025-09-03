import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import type { Express } from 'express';
import OpenAI from 'openai';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { WebSocket } from 'ws';

const PORT = Number(process.env.PORT ?? 17321);
const ENABLE_AUDIO = String(process.env.ENABLE_AUDIO ?? 'false').toLowerCase() === 'true';
const WAKE_KEYWORD = process.env.WAKE_KEYWORD ?? 'Jarvis'; // builtin by default; set to a .ppn path for custom
const SENSITIVITY = Math.max(0, Math.min(1, Number(process.env.SENSITIVITY ?? '0.6')));
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';
const CHAT_MODEL = process.env.CHAT_MODEL ?? 'gpt-4o-mini';
const TAVILY_API_KEY = process.env.TAVILY_API_KEY ?? '';
const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY ?? '';
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM'; // Rachel
const TOOL_SECRET = process.env.TOOL_SECRET ?? '';
// Add: ElevenLabs Conversational Agent ID
const ELEVEN_AGENT_ID = process.env.ELEVENLABS_AGENT_ID ?? '';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// JSON cache on disk
const CACHE_DIR = path.join(process.cwd(), 'cache', 'transcripts');
const MEDIA_DIR = path.join(process.cwd(), 'cache', 'agent_media');
function ensureCacheDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
  try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch {}
}
function cachePath(videoId: string) { return path.join(CACHE_DIR, `${videoId}.json`); }
function embedPath(videoId: string) { return path.join(CACHE_DIR, `${videoId}.embeddings.json`); }
function mediaPath(basename: string) { return path.join(MEDIA_DIR, basename); }
function readDiskCache(videoId: string): any[] | null {
  try {
    const fp = cachePath(videoId);
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.segments)) return parsed.segments;
    }
  } catch {}
  return null;
}
function writeDiskCache(videoId: string, segments: any[]) {
  try {
    ensureCacheDir();
    fs.writeFileSync(cachePath(videoId), JSON.stringify(segments, null, 2), 'utf8');
  } catch {}
}
function readEmbedCache(videoId: string): null | { model: string; dims: number; items: { idx: number; start: number; duration: number; text: string; embedding: number[] }[] } {
  try {
    const fp = embedPath(videoId);
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    return null;
  }
}
function writeEmbedCache(videoId: string, payload: { model: string; dims: number; items: { idx: number; start: number; duration: number; text: string; embedding: number[] }[] }) {
  try {
    ensureCacheDir();
    fs.writeFileSync(embedPath(videoId), JSON.stringify(payload, null, 2), 'utf8');
  } catch {}
}

// Simple intent schema
export type IntentMessage = {
  intent:
    | 'begin_listen'
    | 'end_listen'
    | 'rewind'
    | 'forward'
    | 'set_speed'
    | 'set_volume'
    | 'pause'
    | 'play'
    | 'jump_to_phrase';
  value?: number | string;
};

// Minimal HTTP API for simulation and health
const app: Express = express();
app.use(express.json());
app.use('/media', express.static(MEDIA_DIR));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/simulate', (req, res) => {
  const msg = req.body as IntentMessage;
  if (!msg || !msg.intent) return res.status(400).json({ error: 'invalid message' });
  broadcast(msg);
  res.json({ ok: true });
});

// Transcript endpoint (YouTube official captions if available; Whisper fallback if not)
const transcriptCache = new Map<string, any[]>();
app.get('/transcript', async (req, res) => {
  const videoId = String(req.query.videoId ?? '').trim();
  const force = String(req.query.force ?? '').trim() === '1';
  if (!videoId) return res.status(400).json({ error: 'missing videoId' });
  try {
    // Disk cache
    if (!force) {
      const disk = readDiskCache(videoId);
      if (disk && disk.length) {
        console.log(`[daemon] /transcript disk cache hit ${videoId} segments=${disk.length}`);
        transcriptCache.set(videoId, disk);
        return res.json({ segments: disk });
      }
    }

    if (transcriptCache.has(videoId) && !force) {
      console.log(`[daemon] /transcript cache hit ${videoId}`);
      return res.json({ segments: transcriptCache.get(videoId) });
    }
    let segments: any[] = [];
    if (!force) {
      console.log(`[daemon] /transcript fetching timedtext for ${videoId}`);
      const { YoutubeTranscript } = await import('youtube-transcript');
      const languages = ['en', 'en-US', 'en-GB', 'auto', 'pl', 'es', 'de', 'fr'];
      for (const lang of languages) {
        try {
          // @ts-ignore optional lang param supported by lib
          // eslint-disable-next-line no-await-in-loop
          segments = await YoutubeTranscript.fetchTranscript(videoId, { lang });
          console.log(`[daemon] timedtext lang=${lang} segments=${Array.isArray(segments) ? segments.length : 0}`);
          if (Array.isArray(segments) && segments.length) break;
        } catch (e) {
          console.warn(`[daemon] timedtext failed lang=${lang}`, e);
        }
      }
    }

    if (!Array.isArray(segments) || segments.length === 0) {
      // Try raw timedtext XML for 'en'
      try {
        const timedUrl = `https://www.youtube.com/api/timedtext?lang=en&v=${encodeURIComponent(videoId)}`;
        console.log('[daemon] trying raw timedtext XML', timedUrl);
        const resp = await fetch(timedUrl);
        if (resp.ok) {
          const xml = await resp.text();
          const { XMLParser } = await import('fast-xml-parser');
          const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
          const data: any = parser.parse(xml);
          const texts = data?.transcript?.text ?? [];
          const arr = Array.isArray(texts) ? texts : [texts];
          const parsed = arr
            .filter(Boolean)
            .map((t: any) => ({ text: String(t['#text'] ?? ''), start: Number(t.start ?? 0), duration: Number(t.dur ?? 0) }));
          if (parsed.length) {
            console.log(`[daemon] raw timedtext segments=${parsed.length}`);
            transcriptCache.set(videoId, parsed);
            writeDiskCache(videoId, parsed);
            return res.json({ segments: parsed });
          }
        }
      } catch (e) {
        console.warn('[daemon] raw timedtext fetch failed', e);
      }

      console.log(`[daemon] falling back to Whisper for ${videoId}`);
      const whisper = await transcriptWithWhisper(videoId);
      console.log(`[daemon] whisper segments=${whisper.length}`);
      transcriptCache.set(videoId, whisper);
      writeDiskCache(videoId, whisper);
      return res.json({ segments: whisper });
    }

    transcriptCache.set(videoId, segments);
    writeDiskCache(videoId, segments);
    res.json({ segments });
  } catch (e: any) {
    console.error('[daemon] /transcript error', e);
    res.status(200).json({ segments: [] });
  }
});

async function transcriptWithWhisper(videoId: string): Promise<Array<{ text: string; start: number; duration: number }>> {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[daemon] whisper skipped: OPENAI_API_KEY missing');
    return [];
  }
  try {
    console.log(`[daemon] whisper: downloading audio for ${videoId}`);
    const { default: ytdl } = await import('@distube/ytdl-core');
    const ffmpegPath = (await import('ffmpeg-static')).default as string;
    const ffmpeg = (await import('fluent-ffmpeg')).default;
    ffmpeg.setFfmpegPath(ffmpegPath);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrw-'));
    const tmpMp4 = path.join(tmpDir, `${videoId}.mp4`);
    const tmpWav = path.join(tmpDir, `${videoId}.wav`);

    try {
      await new Promise<void>((resolve, reject) => {
        const stream = ytdl(`https://www.youtube.com/watch?v=${videoId}`, { quality: 'highestaudio', filter: 'audioonly' });
        const file = fs.createWriteStream(tmpMp4);
        stream.pipe(file);
        file.on('finish', () => resolve());
        file.on('error', reject);
        stream.on('error', reject);
      });
      console.log('[daemon] whisper: audio downloaded');

      await new Promise<void>((resolve, reject) => {
        ffmpeg(tmpMp4)
          .noVideo()
          .audioChannels(1)
          .audioFrequency(16000)
          .format('wav')
          .duration(10)
          .save(tmpWav)
          .on('end', () => resolve())
          .on('error', (err: any) => reject(err));
      });
      console.log('[daemon] whisper: audio converted');

      const file = await OpenAI.toFile(fs.createReadStream(tmpWav) as any, 'audio.wav');
      const tr: any = await openai.audio.transcriptions.create({
        file,
        model: 'whisper-1',
        response_format: 'verbose_json',
        temperature: 0
      } as any);
      const out: Array<{ text: string; start: number; duration: number }> = [];
      const segs: any[] = tr?.segments ?? [];
      for (const s of segs) {
        const start = Number(s.start ?? 0);
        const end = Number(s.end ?? start);
        const text = String(s.text ?? '').trim();
        if (!text) continue;
        out.push({ text, start, duration: Math.max(0, end - start) });
      }
      return out;
    } finally {
      try { fs.unlinkSync(tmpMp4); } catch {}
      try { fs.unlinkSync(tmpWav); } catch {}
      try { fs.rmdirSync(tmpDir); } catch {}
    }
  } catch (e) {
    console.error('[daemon] whisper error', e);
    return [];
  }
}

// Helper to get transcript segments (shared between endpoints)
async function getTranscriptSegments(videoId: string, force: boolean): Promise<any[]> {
  // Disk cache
  if (!force) {
    const disk = readDiskCache(videoId);
    if (disk && disk.length) {
      console.log(`[daemon] getTranscriptSegments disk cache ${videoId} segments=${disk.length}`);
      transcriptCache.set(videoId, disk);
      return disk;
    }
  }
  if (transcriptCache.has(videoId) && !force) {
    const s = transcriptCache.get(videoId)!;
    if (s.length) return s;
  }
  let segments: any[] = [];
  // Try library with multiple langs
  if (!force) {
    try {
      const { YoutubeTranscript } = await import('youtube-transcript');
      const languages = ['en', 'en-US', 'en-GB', 'auto', 'pl', 'es', 'de', 'fr'];
      for (const lang of languages) {
        try {
          // @ts-ignore
          // eslint-disable-next-line no-await-in-loop
          segments = await YoutubeTranscript.fetchTranscript(videoId, { lang });
          console.log(`[daemon] lib timedtext lang=${lang} segments=${Array.isArray(segments) ? segments.length : 0}`);
          if (Array.isArray(segments) && segments.length) break;
        } catch (e) {
          console.warn(`[daemon] lib timedtext failed lang=${lang}`);
        }
      }
    } catch {}
  }
  // Raw timedtext XML
  if (!Array.isArray(segments) || segments.length === 0) {
    try {
      const timedUrl = `https://www.youtube.com/api/timedtext?lang=en&v=${encodeURIComponent(videoId)}`;
      const resp = await fetch(timedUrl);
      if (resp.ok) {
        const xml = await resp.text();
        const { XMLParser } = await import('fast-xml-parser');
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
        const data: any = parser.parse(xml);
        const texts = data?.transcript?.text ?? [];
        const arr = Array.isArray(texts) ? texts : [texts];
        const parsed = arr
          .filter(Boolean)
          .map((t: any) => ({ text: String(t['#text'] ?? ''), start: Number(t.start ?? 0), duration: Number(t.dur ?? 0) }));
        if (parsed.length) {
          segments = parsed;
        }
      }
    } catch {}
  }
  // Whisper fallback (first 10s currently)
  if (!Array.isArray(segments) || segments.length === 0) {
    const whisper = await transcriptWithWhisper(videoId);
    segments = whisper;
  }
  transcriptCache.set(videoId, segments);
  writeDiskCache(videoId, segments);
  return segments;
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { const x = a[i]; const y = b[i]; dot += x * y; na += x * x; nb += y * y; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function ensureEmbeddings(videoId: string, segments: { text: string; start?: number; offset?: number; duration?: number }[], force: boolean) {
  const existing = !force ? readEmbedCache(videoId) : null;
  if (existing && existing.model === EMBEDDING_MODEL && Array.isArray(existing.items) && existing.items.length) {
    return existing;
  }
  const inputs: string[] = segments.map(s => (s.text || '').toString());
  const resp = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: inputs });
  const dims = resp.data[0].embedding.length;
  const items = resp.data.map((row, idx) => {
    const seg = segments[idx];
    const start = typeof seg.start === 'number' ? seg.start : (typeof seg.offset === 'number' ? seg.offset / 1000 : 0);
    const duration = typeof seg.duration === 'number' ? seg.duration : 0;
    return { idx, start, duration, text: inputs[idx], embedding: row.embedding as unknown as number[] };
  });
  const payload = { model: EMBEDDING_MODEL, dims, items };
  writeEmbedCache(videoId, payload);
  return payload;
}

// Semantic search endpoint
app.get('/semantic_search', async (req, res) => {
  try {
    const videoId = String(req.query.videoId ?? '').trim();
    const q = String(req.query.q ?? '').trim();
    const force = String(req.query.force ?? '').trim() === '1';
    if (!videoId || !q) return res.status(400).json({ error: 'missing videoId or q' });
    const segments = await getTranscriptSegments(videoId, force);
    if (!segments.length) return res.json({ start: 0, score: 0, text: '', candidates: [] });
    const embedIndex = await ensureEmbeddings(videoId, segments, force);
    const qEmb = (await openai.embeddings.create({ model: EMBEDDING_MODEL, input: q })).data[0].embedding as unknown as number[];
    let best = { score: -1, start: 0, text: '', idx: -1 };
    const candidates: { start: number; score: number; text: string }[] = [];
    for (const item of embedIndex.items) {
      const s = cosineSim(qEmb, item.embedding);
      candidates.push({ start: item.start, score: s, text: item.text });
      if (s > best.score) best = { score: s, start: item.start, text: item.text, idx: item.idx };
    }
    candidates.sort((a, b) => b.score - a.score);
    res.json({ start: best.start, score: best.score, text: best.text, index: best.idx, candidates: candidates.slice(0, 5) });
  } catch (e) {
    console.error('[daemon] /semantic_search error', e);
    res.status(500).json({ error: 'semantic search failed' });
  }
});

async function tavilySearch(query: string): Promise<Array<{ title: string; url: string; content: string }>> {
  if (!TAVILY_API_KEY) return [];
  try {
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: TAVILY_API_KEY, query, search_depth: 'basic', max_results: 5, include_answer: false })
    });
    if (!resp.ok) return [];
    const data: any = await resp.json();
    const results: any[] = data?.results ?? [];
    return results.map(r => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), content: String(r.content ?? '') }));
  } catch { return []; }
}

async function synthesizeAnswer(question: string, sources: Array<{ title: string; url: string; content: string }>, context?: string): Promise<string> {
  const sys = `You are a helpful research assistant. Answer concisely (3-6 sentences). Use the provided web results and optional video context. Include inline citations like [1], [2] mapping to the provided sources by index. If unsure, say so.`;
  const sourceList = sources.map((s, i) => `[${i + 1}] ${s.title} - ${s.url}\n${s.content}`).join('\n\n');
  const user = `Question: ${question}\n\nVideo context (optional):\n${context ?? '(none)'}\n\nWeb results:\n${sourceList}`;
  const chat = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [ { role: 'system', content: sys }, { role: 'user', content: user } ],
    temperature: 0.2
  });
  return chat.choices[0]?.message?.content ?? '';
}

async function elevenTTS(text: string): Promise<string | null> {
	if (!ELEVEN_API_KEY) return null;
	const fileBase = `ans-${Date.now()}.mp3`;
	const outPath = mediaPath(fileBase);
	try {
		const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVEN_API_KEY, 'Accept': 'audio/mpeg' },
			body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
		});
		if (!resp.ok) return null;
		const buf = Buffer.from(await resp.arrayBuffer());
		ensureCacheDir();
		fs.writeFileSync(outPath, buf);
		return `/media/${fileBase}`;
	} catch {
		return null;
	}
}

// Add: ElevenLabs Conversational AI (WebSocket) integration

async function getElevenSignedUrl(agentId: string): Promise<string | null> {
	try {
		if (!ELEVEN_API_KEY || !agentId) return null;
		const primary = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`;
		console.log('[convai] fetching signed url', primary);
		let resp = await fetch(primary, { headers: { 'xi-api-key': ELEVEN_API_KEY } });
		if (!resp.ok) {
			console.warn('[convai] primary signed url failed status', resp.status);
			// try alternate path (underscore) sometimes shown in examples
			const alt = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(agentId)}`;
			console.log('[convai] trying alt signed url', alt);
			resp = await fetch(alt, { headers: { 'xi-api-key': ELEVEN_API_KEY } });
			if (!resp.ok) {
				console.warn('[convai] alt signed url failed status', resp.status);
				return null;
			}
		}
		const data: any = await resp.json();
		const signed = String(data?.signed_url ?? '').trim();
		console.log('[convai] signed url ok?', Boolean(signed));
		return signed || null;
	} catch (e) {
		console.warn('[convai] signed url error', e);
		return null;
	}
}

function joinBuffers(chunks: Buffer[]): Buffer {
	if (!chunks.length) return Buffer.alloc(0);
	return Buffer.concat(chunks);
}

function pcmToWavFromChunks(pcmChunks: Buffer[], sampleRate = 16000, numChannels = 1): Buffer {
	const pcm = joinBuffers(pcmChunks);
	return pcmToWav(pcm, sampleRate, numChannels);
}

// Persistent ConvAI sessions keyed by sessionId
const convaiSessions = new Map<string, {
	ws: WebSocket;
	isOpen: boolean;
	sentInit: boolean;
	lastAudioAt: number;
	turnChunks: Buffer[];
	agentText: string;
	pending: Array<(r: { text: string; audioUrl: string | null }) => void>;
	interval: NodeJS.Timeout | null;
}>();

async function ensureConvaiSession(sessionId: string): Promise<{
	ws: WebSocket;
	isOpen: boolean;
	sentInit: boolean;
	lastAudioAt: number;
	turnChunks: Buffer[];
	agentText: string;
	pending: Array<(r: { text: string; audioUrl: string | null }) => void>;
	interval: NodeJS.Timeout | null;
}> {
	let s = convaiSessions.get(sessionId);
	if (s && s.ws.readyState === 1) return s;
	let wsUrl = await getElevenSignedUrl(ELEVEN_AGENT_ID);
	if (!wsUrl) wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(ELEVEN_AGENT_ID)}`;
	console.log('[convai] opening websocket (session)', sessionId);
	const ws = new WebSocket(wsUrl);
	s = { ws, isOpen: false, sentInit: false, lastAudioAt: 0, turnChunks: [], agentText: '', pending: [], interval: null };
	convaiSessions.set(sessionId, s);

	const maybeFinalizeTurn = () => {
		if (!s) return;
		if (!s.pending.length) return;
		const idle = Date.now() - s.lastAudioAt;
		// consider a turn done if we have text or audio and idled for 800ms
		if ((s.agentText || s.turnChunks.length) && idle > 800) {
			const textOut = s.agentText;
			let audioUrl: string | null = null;
			try {
				if (s.turnChunks.length) {
					const wav = pcmToWavFromChunks(s.turnChunks, 16000, 1);
					const fileBase = `ans-${Date.now()}.wav`;
					const outPath = mediaPath(fileBase);
					ensureCacheDir();
					fs.writeFileSync(outPath, wav);
					audioUrl = `/media/${fileBase}`;
				}
			} catch {}
			// reset buffers for next turn
			s.agentText = '';
			s.turnChunks = [];
			const resolve = s.pending.shift();
			if (resolve) resolve({ text: textOut, audioUrl });
		}
	};

	ws.on('open', () => {
		if (!s) return;
		s.isOpen = true;
		console.log('[convai] ws open (session)', sessionId);
		try { ws.send(JSON.stringify({ type: 'conversation_initiation_client_data' })); } catch {}
		s.interval = setInterval(maybeFinalizeTurn, 250);
	});
	ws.on('message', (raw: any) => {
		try {
			const msg = JSON.parse(raw.toString());
			const t = String(msg?.type ?? '');
			if (t === 'agent_response') {
				if (s) s.agentText = String(msg?.agent_response_event?.agent_response ?? s.agentText);
			} else if (t === 'audio') {
				const b64: string = String(msg?.audio_event?.audio_base_64 ?? msg?.audio?.chunk ?? '');
				if (b64 && s) {
					const buf = Buffer.from(b64, 'base64');
					s.turnChunks.push(buf);
					s.lastAudioAt = Date.now();
				}
			} else if (t === 'ping') {
				const eventId = msg?.ping_event?.event_id;
				if (eventId != null) { try { ws.send(JSON.stringify({ type: 'pong', event_id: eventId })); } catch {} }
			}
		} catch {}
	});
	ws.on('close', () => {
		console.log('[convai] ws close (session)', sessionId);
		if (!s) return;
		if (s.interval) clearInterval(s.interval);
		convaiSessions.delete(sessionId);
	});
	ws.on('error', () => {
		if (!s) return;
		if (s.interval) clearInterval(s.interval);
		convaiSessions.delete(sessionId);
	});
	return s;
}

async function elevenConversationalAnswer(question: string, contextText: string | undefined, sessionId: string): Promise<{ text: string; audioUrl: string | null }> {
	if (!ELEVEN_API_KEY || !ELEVEN_AGENT_ID) {
		console.warn('[convai] missing ELEVEN credentials or agent id');
		return { text: '', audioUrl: null };
	}
	const id = sessionId || 'default';
	const s = await ensureConvaiSession(id);
	// send optional context
	if (contextText && contextText.trim()) {
		try { s.ws.send(JSON.stringify({ type: 'contextual_update', text: contextText.trim() })); } catch {}
	}
	// send user question and await this turn's resolution
	return await new Promise<{ text: string; audioUrl: string | null }>((resolve) => {
		s.pending.push(resolve);
		try { s.ws.send(JSON.stringify({ type: 'user_message', text: question })); } catch {}
	});
}

// Session memory (simple in-memory per sessionId)
const sessionMemory = new Map<string, Array<{ role: 'user' | 'assistant'; text: string }>>();
function pushMemory(sessionId: string, role: 'user' | 'assistant', text: string) {
	if (!sessionId) return;
	const arr = sessionMemory.get(sessionId) ?? [];
	arr.push({ role, text: (text || '').slice(0, 800) });
	// keep last 6 messages (3 turns)
	while (arr.length > 6) arr.shift();
	sessionMemory.set(sessionId, arr);
}
function summarizeMemory(sessionId: string): string {
	const arr = sessionMemory.get(sessionId) ?? [];
	if (!arr.length) return '';
	return arr.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join(' \n ');
}

app.post('/agent/query', async (req, res) => {
	try {
		const q = String(req.body?.q ?? '').trim();
		const videoId = String(req.body?.videoId ?? '').trim();
		const currentTime = Number(req.body?.currentTime ?? 0);
		const sessionId = String(req.body?.sessionId ?? '').trim();
		if (!q) return res.status(400).json({ error: 'missing q' });
		// Build brief context from transcript near current time (no prompt override, no extra memory)
		let context = '';
		if (videoId) {
			const segs = await getTranscriptSegments(videoId, false);
			if (segs.length) {
				const around = segs.filter((s: any) => {
					const start = typeof s.start === 'number' ? s.start : (typeof s.offset === 'number' ? s.offset / 1000 : 0);
					return Math.abs(start - currentTime) <= 90; // +/- 90s
				}).slice(0, 20).map((s: any) => s.text).join(' ');
				context = `Transcript excerpt near t=${Math.max(0, Math.floor(currentTime))}s: ${around}`;
			}
		}

		// Prefer ElevenLabs Conversational AI with persistent sessions
		if (ELEVEN_API_KEY && ELEVEN_AGENT_ID) {
			const { text, audioUrl } = await elevenConversationalAnswer(q, context || undefined, sessionId);
			return res.json({ text, sources: [], audioUrl });
		}

		// Fallback: web search + OpenAI + ElevenLabs TTS (unchanged)
		const web = await tavilySearch(q);
		const answer = await synthesizeAnswer(q, web, context || undefined);
		const audioUrl = await elevenTTS(answer);
		res.json({ text: answer, sources: web.map((s, i) => ({ i: i + 1, title: s.title, url: s.url })), audioUrl });
	} catch (e) {
		console.error('[daemon] /agent/query error', e);
		res.status(500).json({ error: 'agent failed' });
	}
});

// CORS for tool webhook (restrict as needed)
app.options('/tools/web_search', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.status(204).end();
});

app.post('/tools/web_search', async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!TOOL_SECRET || req.header('x-tool-secret') !== TOOL_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const query = String(req.body?.query ?? req.body?.q ?? '').trim();
    const context = String(req.body?.context ?? '').trim();
    if (!query) return res.status(400).json({ error: 'missing query' });
    const web = await tavilySearch(query);
    const answer = await synthesizeAnswer(query, web, context || undefined);
    return res.json({ answer, sources: web.map((s, i) => ({ i: i + 1, title: s.title, url: s.url })) });
  } catch (e) {
    console.error('[daemon] /tools/web_search error', e);
    return res.status(500).json({ error: 'tool failed' });
  }
});

// Create a single server for both HTTP and WS
const server = createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(msg: IntentMessage) {
  const payload = JSON.stringify(msg);
  let count = 0;
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
      count++;
    }
  }
  console.log(`[daemon] Broadcast ${msg.intent} -> ${count} client(s)`);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[daemon] HTTP+WS listening on http://127.0.0.1:${PORT}`);
});

// Optional: Wake-word + ASR pipeline (off by default)
async function startAudioPipeline() {
  if (!ENABLE_AUDIO) {
    console.log('[daemon] Audio pipeline disabled. Set ENABLE_AUDIO=true to enable.');
    return;
  }
  // Lazy import optional deps to avoid install errors in MVP
  let PorcupineMod: any;
  let Porcupine: any;
  let BuiltinKeyword: any;
  let mic: any;
  try {
    PorcupineMod = await import('@picovoice/porcupine-node');
    Porcupine = PorcupineMod.Porcupine;
    BuiltinKeyword = PorcupineMod.BuiltinKeyword;
    mic = (await import('mic')).default ?? (await import('mic'));
  } catch (err) {
    console.warn('[daemon] Optional audio deps missing. Install @picovoice/porcupine-node and mic to enable.');
    return;
  }

  const pvKey = process.env.PV_ACCESS_KEY;
  if (!pvKey) {
    console.warn('[daemon] PV_ACCESS_KEY not set; cannot enable wake-word.');
    return;
  }

  console.log(`[daemon] Initializing wake-word (${WAKE_KEYWORD}) with sensitivity ${SENSITIVITY}…`);
  let detector: any;
  if (WAKE_KEYWORD.toLowerCase().endsWith('.ppn')) {
    detector = new Porcupine(pvKey, [WAKE_KEYWORD], [SENSITIVITY]);
  } else {
    const name = WAKE_KEYWORD.toUpperCase().replace(/\s+/g, '_');
    const builtin = BuiltinKeyword[name] ?? BuiltinKeyword.PORCUPINE;
    detector = new Porcupine(pvKey, [builtin], [SENSITIVITY]);
  }

  const micInstance = mic({ rate: '16000', channels: '1', bitwidth: '16', encoding: 'signed-integer', device: 'default' });
  const micStream: NodeJS.ReadableStream = micInstance.getAudioStream();

  let frameBuf: Buffer = Buffer.alloc(0);
  const frameBytes = detector.frameLength * 2; // 16-bit PCM → bytes

  micStream.on('data', (data: Buffer) => {
    frameBuf = Buffer.concat([frameBuf, data]);
    while (frameBuf.length >= frameBytes) {
      const chunk = frameBuf.subarray(0, frameBytes);
      frameBuf = frameBuf.subarray(frameBytes);
      const pcm = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
      const keywordIndex = detector.process(pcm);
      if (keywordIndex >= 0) {
        console.log('[daemon] Wake word detected');
        // Duck the tab audio while capturing speech to avoid feedback
        broadcast({ intent: 'begin_listen' });
        captureUtterance(micStream, 3500)
          .then(async (rawPcm) => {
            const wav = pcmToWav(rawPcm, 16000, 1);
            const message = await transcribeAndParse(wav);
            if (message) broadcast(message);
          })
          .catch((e) => console.error('[daemon] capture error', e))
          .finally(() => {
            broadcast({ intent: 'end_listen' });
          });
      }
    }
  });

  micInstance.start();
  console.log('[daemon] Mic started. Say the wake word.');
}

async function captureUtterance(stream: NodeJS.ReadableStream, ms: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const onData = (d: Buffer) => chunks.push(d);
    stream.on('data', onData);
    setTimeout(() => {
      stream.off('data', onData);
      resolve(Buffer.concat(chunks));
    }, ms);
  });
}

function pcmToWav(pcmSignedLE16: Buffer, sampleRate = 16000, numChannels = 1): Buffer {
  const byteRate = sampleRate * numChannels * 2;
  const blockAlign = numChannels * 2;
  const dataSize = pcmSignedLE16.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // audio format PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmSignedLE16.copy(buffer, 44);
  return buffer;
}

async function transcribeAndParse(wav: Buffer): Promise<IntentMessage | null> {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[daemon] OPENAI_API_KEY not set; cannot transcribe');
    return null;
  }
  try {
    const file = await OpenAI.toFile(wav, 'speech.wav');
    const tr = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'json',
      temperature: 0
    } as any);
    const text: string = (tr as any).text ?? '';
    console.log('[daemon] Transcript:', text);
    const intent = parseIntentFromText(text);
    if (!intent) console.log('[daemon] No intent parsed');
    return intent;
  } catch (e) {
    console.error('[daemon] transcription error', e);
    return null;
  }
}

function parseIntentFromText(textIn: string): IntentMessage | null {
  const text = textIn.toLowerCase().trim();
  // rewind / go back N seconds/minutes
  let m = text.match(/\b(rewind|go back|back)\b\s*(?:by|for)?\s*(\d+)?\s*(seconds?|secs?|s|minutes?|mins?|m)?/i);
  if (m) {
    const n = Number(m[2] ?? '10');
    const unit = (m[3] ?? 's').toLowerCase();
    const secs = unit.startsWith('m') ? n * 60 : n;
    return { intent: 'rewind', value: secs };
  }
  // forward N seconds/minutes
  m = text.match(/\b(forward|go forward|skip ahead|ahead)\b\s*(?:by|for)?\s*(\d+)?\s*(seconds?|secs?|s|minutes?|mins?|m)?/i);
  if (m) {
    const n = Number(m[2] ?? '10');
    const unit = (m[3] ?? 's').toLowerCase();
    const secs = unit.startsWith('m') ? n * 60 : n;
    return { intent: 'forward', value: secs };
  }
  // pause / play
  if (/\b(pause|stop)\b/.test(text)) return { intent: 'pause' };
  if (/\b(play|resume)\b/.test(text)) return { intent: 'play' };
  // speed
  m = text.match(/\b(speed|playback speed)\b.*?(?:to|at)?\s*([0-9]+(?:\.[0-9]+)?)/);
  if (m) return { intent: 'set_speed', value: Number(m[2]) };
  if (/\bfaster\b/.test(text)) return { intent: 'set_speed', value: 1.25 };
  if (/\bslower\b/.test(text)) return { intent: 'set_speed', value: 0.75 };
  // volume
  m = text.match(/\bvolume\b.*?(?:to|at)?\s*(\d{1,3})\s*%?/);
  if (m) return { intent: 'set_volume', value: Math.min(100, Number(m[1])) };
  // jump to phrase
  m = text.match(/\b(jump|go) to\b\s*(?:where\s*)?(.+)/);
  if (m) return { intent: 'jump_to_phrase', value: m[2].trim() };
  return null;
}

startAudioPipeline().catch((e) => console.error('[daemon] audio init failed', e)); 