type IntentMessage = {
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

const DAEMON_WS = 'ws://127.0.0.1:17321';
const DAEMON_HTTP = 'http://127.0.0.1:17321';
let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let isActiveTab = false;
let prevVolume: number | null = null;
let wasPlayingBeforeListen: boolean | null = null;

let cachedTranscript: { text: string; offset?: number; start?: number; duration?: number }[] | null = null;
let cachedVideoId: string | null = null;

function getVideoIdFromUrl(): string | null {
  try {
    const href = location.href;
    const u = new URL(href);
    // Standard watch
    const vParam = u.searchParams.get('v');
    if (vParam) return vParam;
    // Shorts
    const shortsMatch = href.match(/\/shorts\/([a-zA-Z0-9_-]{5,})/);
    if (shortsMatch) return shortsMatch[1];
    // youtu.be short links
    const youtu = href.match(/https?:\/\/youtu\.be\/([a-zA-Z0-9_-]{5,})/);
    if (youtu) return youtu[1];
  } catch {}
  return null;
}

async function ensureTranscript(): Promise<void> {
  const vid = getVideoIdFromUrl();
  if (!vid) return;
  if (cachedTranscript && cachedVideoId === vid) return;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'fetchTranscript', videoId: vid });
    if (resp?.ok && Array.isArray(resp?.data?.segments)) {
      cachedTranscript = resp.data.segments;
      cachedVideoId = vid;
      console.log('[VoiceRewind] Transcript loaded', (cachedTranscript ? cachedTranscript.length : 0));
    } else {
      console.warn('[VoiceRewind] Transcript fetch failed', resp?.error);
    }
  } catch (e) {
    console.warn('[VoiceRewind] Transcript error', e);
  }
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureOverlay() {
  if (document.getElementById('voicerewind-overlay')) return;
  const root = document.createElement('div');
  root.id = 'voicerewind-overlay';
  root.style.position = 'fixed';
  root.style.right = '12px';
  root.style.bottom = '12px';
  root.style.zIndex = '2147483647';
  root.style.fontFamily = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
  root.style.background = 'rgba(0,0,0,0.6)';
  root.style.color = '#fff';
  root.style.padding = '8px 10px';
  root.style.borderRadius = '8px';
  root.style.display = 'flex';
  root.style.gap = '8px';
  root.style.alignItems = 'center';

  const status = document.createElement('span');
  status.id = 'vr-status';
  status.textContent = '●';
  status.style.color = '#f44336';

  const active = document.createElement('span');
  active.id = 'vr-active';
  active.textContent = '(inactive)';
  active.style.opacity = '0.8';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'jump to…';
  input.style.background = '#121212';
  input.style.color = '#fff';
  input.style.border = '1px solid #333';
  input.style.borderRadius = '6px';
  input.style.padding = '4px 8px';
  input.style.width = '160px';
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const q = input.value.trim();
      if (q) {
        await ensureTranscript();
        await handleIntent({ intent: 'jump_to_phrase', value: q });
      }
    }
  });

  const btn = (label: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.background = '#121212';
    b.style.color = '#fff';
    b.style.border = '1px solid #333';
    b.style.borderRadius = '6px';
    b.style.padding = '4px 8px';
    b.style.cursor = 'pointer';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  };

  const rew = btn('⏪ 10s', () => handleIntent({ intent: 'rewind', value: 10 }));
  const fwd = btn('⏩ 10s', () => handleIntent({ intent: 'forward', value: 10 }));
  const spdDown = btn('− speed', () => {
    const v = Math.max(0.25, (getVideo()?.playbackRate ?? 1) - 0.25);
    handleIntent({ intent: 'set_speed', value: v });
  });
  const spdUp = btn('+ speed', () => {
    const v = Math.min(3, (getVideo()?.playbackRate ?? 1) + 0.25);
    handleIntent({ intent: 'set_speed', value: v });
  });

  root.append(status, active, input, rew, fwd, spdDown, spdUp);
  document.body.appendChild(root);
}

function setStatus(connected: boolean) {
  const el = document.getElementById('vr-status');
  if (!el) return;
  el.textContent = connected ? '●' : '○';
  (el as HTMLElement).style.color = connected ? '#4caf50' : '#f44336';
}

function setActive(active: boolean) {
  const el = document.getElementById('vr-active');
  if (!el) return;
  el.textContent = active ? '(active)' : '(inactive)';
  (el as HTMLElement).style.opacity = active ? '1' : '0.8';
}

function connect() {
  ensureOverlay();
  try {
    ws = new WebSocket(DAEMON_WS);
    ws.addEventListener('open', () => {
      console.log('[VoiceRewind] Connected to daemon');
      setStatus(true);
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as IntentMessage;
        console.log('[VoiceRewind] Received', msg);
        if (!isActiveTab && msg.intent !== 'begin_listen' && msg.intent !== 'end_listen') return;
        handleIntent(msg);
      } catch (e) {
        console.warn('[VoiceRewind] Bad message', e);
      }
    });
    ws.addEventListener('close', () => {
      console.log('[VoiceRewind] Disconnected, retrying…');
      setStatus(false);
      scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      console.log('[VoiceRewind] WS error, retrying…');
      setStatus(false);
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
  const candidates: HTMLVideoElement[] = [];
  const bySelector = document.querySelector('video.html5-main-video') as HTMLVideoElement | null;
  if (bySelector) candidates.push(bySelector);
  const inMoviePlayer = (document.getElementById('movie_player')?.querySelector('video') as HTMLVideoElement | null);
  if (inMoviePlayer) candidates.push(inMoviePlayer);
  candidates.push(...Array.from(document.querySelectorAll('video')));

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
  if (msg.intent === 'begin_listen') {
    if (video) {
      if (prevVolume === null) prevVolume = video.volume;
      if (wasPlayingBeforeListen === null) wasPlayingBeforeListen = !video.paused;
      video.volume = 0;
      if (!video.paused) video.pause();
    }
    return;
  }
  if (msg.intent === 'end_listen') {
    if (video) {
      if (prevVolume !== null) video.volume = prevVolume;
      prevVolume = null;
      if (wasPlayingBeforeListen) {
        await video.play().catch(() => {});
      }
      wasPlayingBeforeListen = null;
    }
    return;
  }

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
  const video = getVideo();
  if (!video) return null;

  const qNorm = normalize(phrase);

  // 1) Try text tracks
  const tracks = Array.from(video.textTracks || []);
  const track = tracks.find((tr) => tr.mode === 'showing') || tracks[0];
  if (track && track.cues) {
    const cues = Array.from(track.cues) as TextTrackCue[];
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i] as any;
      const text: string = (cue.text || '').toString();
      if (!text) continue;
      if (normalize(text).includes(qNorm)) {
        return (cue.startTime as number) ?? 0;
      }
    }
  }

  // 2) Fallback to daemon transcript (merge windows of segments for fuzzy match)
  await ensureTranscript();
  if (cachedTranscript && cachedTranscript.length) {
    const windowSize = 3; // merge up to 3 segments for better context
    for (let i = 0; i < cachedTranscript.length; i++) {
      let merged = '';
      for (let w = 0; w < windowSize && i + w < cachedTranscript.length; w++) {
        merged += ' ' + (cachedTranscript[i + w]?.text ?? '');
        if (normalize(merged).includes(qNorm)) {
          const seg = cachedTranscript[i];
          const startSec = typeof seg.start === 'number' ? seg.start : (typeof seg.offset === 'number' ? seg.offset / 1000 : 0);
          return Math.max(0, startSec);
        }
      }
    }
  }
  return null;
}

// Background messages
window.addEventListener('message', () => {});
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'active-tab') {
    isActiveTab = true;
    setActive(true);
  }
  if (msg?.type === 'heartbeat') {
    ensureOverlay();
  }
});

// Initialize
ensureOverlay();
setStatus(false);
setActive(false);
connect(); 