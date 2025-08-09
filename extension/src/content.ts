type IntentMessage = {
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

const DAEMON_WS = 'ws://127.0.0.1:17321';
let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;

function connect() {
  try {
    ws = new WebSocket(DAEMON_WS);
    ws.addEventListener('open', () => {
      console.log('[VoiceRewind] Connected to daemon');
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as IntentMessage;
        console.log('[VoiceRewind] Received', msg);
        handleIntent(msg);
      } catch (e) {
        console.warn('[VoiceRewind] Bad message', e);
      }
    });
    ws.addEventListener('close', () => {
      console.log('[VoiceRewind] Disconnected, retrying…');
      scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      console.log('[VoiceRewind] WS error, retrying…');
      scheduleReconnect();
    });
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer != null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
}

function getVideo(): HTMLVideoElement | null {
  // Prefer the main YouTube player element
  const candidates: HTMLVideoElement[] = [];
  const bySelector = document.querySelector('video.html5-main-video') as HTMLVideoElement | null;
  if (bySelector) candidates.push(bySelector);
  const inMoviePlayer = (document.getElementById('movie_player')?.querySelector('video') as HTMLVideoElement | null);
  if (inMoviePlayer) candidates.push(inMoviePlayer);
  candidates.push(...Array.from(document.querySelectorAll('video')));

  // Deduplicate and pick the most visible/largest
  const unique = Array.from(new Set(candidates));
  if (unique.length === 0) return null;
  unique.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const areaA = ra.width * ra.height;
    const areaB = rb.width * rb.height;
    const visA = isVisible(a) ? 1 : 0;
    const visB = isVisible(b) ? 1 : 0;
    return visB - visA || areaB - areaA;
  });
  return unique[0] ?? null;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

async function handleIntent(msg: IntentMessage) {
  const video = getVideo();
  if (!video) {
    console.warn('[VoiceRewind] No video element found');
    return;
  }

  switch (msg.intent) {
    case 'rewind': {
      const before = video.currentTime;
      const after = clamp(before - (Number(msg.value) || 10), 0, video.duration || 1e9);
      video.currentTime = after;
      console.log('[VoiceRewind] Rewind', { before, after });
      break;
    }
    case 'forward': {
      const before = video.currentTime;
      const after = clamp(before + (Number(msg.value) || 10), 0, video.duration || 1e9);
      video.currentTime = after;
      console.log('[VoiceRewind] Forward', { before, after });
      break;
    }
    case 'set_speed': {
      const rate = clamp(Number(msg.value) || 1, 0.25, 3);
      video.playbackRate = rate;
      console.log('[VoiceRewind] Speed', rate);
      break;
    }
    case 'set_volume': {
      const vol = clamp((Number(msg.value) || 100) / 100, 0, 1);
      video.volume = vol;
      console.log('[VoiceRewind] Volume', vol);
      break;
    }
    case 'pause':
      video.pause();
      console.log('[VoiceRewind] Pause');
      break;
    case 'play':
      await video.play().catch(() => {});
      console.log('[VoiceRewind] Play');
      break;
    case 'jump_to_phrase':
      if (typeof msg.value === 'string' && msg.value.trim()) {
        const t = await findTimestampForPhrase(msg.value.trim());
        if (t != null) {
          const before = video.currentTime;
          video.currentTime = t;
          console.log('[VoiceRewind] JumpToPhrase', { before, after: t });
        } else {
          console.warn('[VoiceRewind] Phrase not found');
        }
      }
      break;
  }
}

async function findTimestampForPhrase(phrase: string): Promise<number | null> {
  // Use available text tracks (captions) if present
  const video = getVideo();
  if (!video) return null;
  const tracks = Array.from(video.textTracks || []);
  // Prefer the active or showing track
  const track = tracks.find((tr) => tr.mode === 'showing') || tracks[0];
  if (!track || !track.cues) return null;
  const cues = Array.from(track.cues) as TextTrackCue[];
  const lower = phrase.toLowerCase();
  let best: { startTime: number; idx: number } | null = null;
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i] as any;
    const text: string = (cue.text || '').toString();
    if (!text) continue;
    if (text.toLowerCase().includes(lower)) {
      const s = (cue.startTime as number) ?? 0;
      if (!best || s < best.startTime) best = { startTime: s, idx: i };
    }
  }
  return best?.startTime ?? null;
}

connect(); 