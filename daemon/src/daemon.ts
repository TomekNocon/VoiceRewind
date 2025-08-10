import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import type { Express } from 'express';
import OpenAI from 'openai';
import os from 'os';
import fs from 'fs';
import path from 'path';

const PORT = Number(process.env.PORT ?? 17321);
const ENABLE_AUDIO = String(process.env.ENABLE_AUDIO ?? 'false').toLowerCase() === 'true';
const WAKE_KEYWORD = process.env.WAKE_KEYWORD ?? 'Jarvis'; // builtin by default; set to a .ppn path for custom
const SENSITIVITY = Math.max(0, Math.min(1, Number(process.env.SENSITIVITY ?? '0.6')));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// JSON cache on disk
const CACHE_DIR = path.join(process.cwd(), 'cache', 'transcripts');
function ensureCacheDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
}
function cachePath(videoId: string) { return path.join(CACHE_DIR, `${videoId}.json`); }
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
          .duration(600)
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