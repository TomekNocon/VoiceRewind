import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import type { Express } from 'express';

const PORT = Number(process.env.PORT ?? 17321);
const ENABLE_AUDIO = String(process.env.ENABLE_AUDIO ?? 'false').toLowerCase() === 'true';

// Simple intent schema
export type IntentMessage = {
  intent:
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
  let Porcupine: any;
  let mic: any;
  try {
    Porcupine = (await import('@picovoice/porcupine-node')).Porcupine;
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

  console.log('[daemon] Initializing wake-word…');
  const porcupine = await Porcupine.create(pvKey, [{ builtin: 'Jarvis' }]);

  const micInstance = mic({ rate: '16000', channels: '1', bitwidth: '16', encoding: 'signed-integer', device: 'default' });
  const micStream: NodeJS.ReadableStream = micInstance.getAudioStream();

  let frame: Buffer[] = [];
  const frameLen = porcupine.frameLength * 2; // 16-bit PCM → bytes

  micStream.on('data', (data: Buffer) => {
    frame.push(data);
    const buf = Buffer.concat(frame);
    while (buf.length >= frameLen) {
      const chunk = buf.subarray(0, frameLen);
      frame = [buf.subarray(frameLen)];
      const pcm = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
      const keywordIndex = porcupine.process(pcm);
      if (keywordIndex >= 0) {
        console.log('[daemon] Wake word detected');
        captureUtterance(micStream, 3000)
          .then(async (wav) => {
            const message = await transcribeAndParse(wav);
            if (message) broadcast(message);
          })
          .catch((e) => console.error('[daemon] capture error', e));
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

async function transcribeAndParse(_wav: Buffer): Promise<IntentMessage | null> {
  return null;
}

startAudioPipeline().catch((e) => console.error('[daemon] audio init failed', e)); 