import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import type { Express } from 'express';
import OpenAI from 'openai';

const PORT = Number(process.env.PORT ?? 17321);
const ENABLE_AUDIO = String(process.env.ENABLE_AUDIO ?? 'false').toLowerCase() === 'true';
const WAKE_KEYWORD = process.env.WAKE_KEYWORD ?? 'Jarvis'; // builtin by default; set to a .ppn path for custom
const SENSITIVITY = Math.max(0, Math.min(1, Number(process.env.SENSITIVITY ?? '0.6')));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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