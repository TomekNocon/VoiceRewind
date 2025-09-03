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
let answerBox: HTMLDivElement | null = null;
let playAnswerBtn: HTMLButtonElement | null = null;
let pendingSpeakText: string | null = null;
let lastAudioDataUrl: string | null = null;
let lastAudioUrl: string | null = null;
let micBtn: HTMLButtonElement | null = null;
let recognition: any = null;
let recognizing = false;

// Add: simple session id per page load for conversational continuity
let sessionId: string | null = null;
function generateSessionId(): string {
  try {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return String(Date.now()) + '-' + Math.random().toString(36).slice(2);
  }
}
if (!sessionId) sessionId = generateSessionId();

function speakText(text: string, onEnd: () => void) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0;
    u.pitch = 1.0;
    u.onend = onEnd;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {
    onEnd();
  }
}

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

function createRecognition() {
  try {
    const w: any = window as any;
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return null;
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    return rec;
  } catch { return null; }
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

  // Ask agent input
  const ask = document.createElement('input');
  ask.type = 'text';
  ask.placeholder = 'ask the web…';
  ask.style.background = '#121212';
  ask.style.color = '#fff';
  ask.style.border = '1px solid #333';
  ask.style.borderRadius = '6px';
  ask.style.padding = '4px 8px';
  ask.style.width = '200px';
  ask.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const q = ask.value.trim();
      if (q) await queryAgent(q);
    }
  });

  answerBox = document.createElement('div');
  answerBox.style.maxWidth = '420px';
  answerBox.style.fontSize = '12px';
  answerBox.style.lineHeight = '1.2';
  answerBox.style.maxHeight = '6em';
  answerBox.style.overflow = 'auto';
  answerBox.style.display = 'none';

  playAnswerBtn = document.createElement('button');
  playAnswerBtn.textContent = 'Play answer';
  playAnswerBtn.style.display = 'none';
  playAnswerBtn.style.background = '#121212';
  playAnswerBtn.style.color = '#fff';
  playAnswerBtn.style.border = '1px solid #333';
  playAnswerBtn.style.borderRadius = '6px';
  playAnswerBtn.style.padding = '4px 8px';
  playAnswerBtn.style.cursor = 'pointer';
  playAnswerBtn.onclick = async () => {
    const video = getVideo();
    if (!video) return;
    const prevWasPlaying = !video.paused;
    const prevVol = video.volume;
    video.pause();
    video.volume = 0;
    playAnswerBtn!.style.display = 'none';
    await playAnswerAudioOrSpeak(video, prevWasPlaying, prevVol);
  };

  // Mic button
  micBtn = document.createElement('button');
  micBtn.textContent = '🎤';
  micBtn.title = 'Hold to speak, release to send';
  micBtn.style.background = '#121212';
  micBtn.style.color = '#fff';
  micBtn.style.border = '1px solid #333';
  micBtn.style.borderRadius = '6px';
  micBtn.style.padding = '4px 8px';
  micBtn.style.cursor = 'pointer';

  recognition = createRecognition();
  if (recognition) {
    let interim = '';
    let finalText = '';
    recognition.onresult = (e: any) => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      // Update ask field live
      const askInput = Array.from(document.querySelectorAll('input')).find((el: any) => el.placeholder === 'ask the web…') as HTMLInputElement | undefined;
      if (askInput) askInput.value = (finalText + ' ' + interim).trim();
    };
    recognition.onend = async () => {
      recognizing = false;
      micBtn!.textContent = '🎤';
      const askInput = Array.from(document.querySelectorAll('input')).find((el: any) => el.placeholder === 'ask the web…') as HTMLInputElement | undefined;
      const q = askInput?.value?.trim();
      if (q) await queryAgent(q);
    };
    micBtn.onmousedown = () => {
      if (recognizing) return;
      recognizing = true;
      finalText = '';
      recognition.start();
      micBtn!.textContent = '●';
    };
    micBtn.onmouseup = () => {
      if (!recognizing) return;
      recognition.stop();
    };
    micBtn.onmouseleave = () => {
      if (recognizing) recognition.stop();
    };
  } else {
    micBtn.disabled = true;
    micBtn.title = 'Voice not supported in this browser';
  }

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

  root.append(status, active, input, rew, fwd, spdDown, spdUp, micBtn, ask, answerBox, playAnswerBtn);
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
          // Semantic fallback
          const vid = getVideoIdFromUrl();
          if (vid) {
            try {
              const resp = await chrome.runtime.sendMessage({ type: 'semanticSearch', videoId: vid, q: msg.value.trim() });
              if (resp?.ok && typeof resp.data?.start === 'number') {
                const before = video.currentTime;
                video.currentTime = Math.max(0, resp.data.start);
                console.log('[VoiceRewind] JumpToPhrase (semantic)', { before, after: resp.data.start, score: resp.data.score });
                break;
              }
            } catch (e) {
              console.warn('[VoiceRewind] Semantic search failed', e);
            }
          }
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

// Helper to play ElevenLabs audio data URL (if present) or fallback to Web Speech / open new tab
async function playAnswerAudioOrSpeak(video: HTMLVideoElement, prevWasPlaying: boolean, prevVol: number) {
  const restore = () => {
    video.volume = prevVol;
    if (prevWasPlaying) video.play().catch(() => {});
  };
  if (lastAudioDataUrl) {
    try {
      const audio = new Audio(lastAudioDataUrl);
      audio.controls = true;
      audio.style.display = 'block';
      const root = document.getElementById('voicerewind-overlay');
      if (root) root.appendChild(audio);
      const onEnd = () => {
        audio.removeEventListener('ended', onEnd);
        audio.removeEventListener('play', onPlay);
        try { audio.pause(); } catch {}
        if (root && audio.parentElement === root) root.removeChild(audio);
        restore();
      };
      const onPlay = () => {
        if (!video.paused) video.pause();
        video.volume = 0;
      };
      audio.addEventListener('ended', onEnd);
      audio.addEventListener('play', onPlay);
      const tried = await audio.play().catch(() => {});
      if (audio.paused || audio.currentTime === 0) {
        // Autoplay blocked: keep inline controls and prompt user to click play
        if (root) {
          const hint = document.createElement('div');
          hint.textContent = 'Click ▶ to hear the answer';
          hint.style.fontSize = '11px';
          hint.style.opacity = '0.85';
          hint.style.marginTop = '4px';
          root.appendChild(hint);
          const cleanup = () => { try { if (root && hint.parentElement === root) root.removeChild(hint); } catch {} };
          audio.addEventListener('play', cleanup, { once: true });
          audio.addEventListener('ended', cleanup, { once: true });
        }
        // Restore video while waiting for user gesture
        restore();
      }
      return;
    } catch {
      // final fallback to Web Speech
      if (pendingSpeakText) speakText(pendingSpeakText, restore);
      return;
    }
  }
  // No MP3 available
  if (pendingSpeakText) speakText(pendingSpeakText, restore);
}

async function queryAgent(q: string) {
  const vid = getVideoIdFromUrl();
  const video = getVideo();
  const currentTime = video ? video.currentTime : 0;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'agentQuery', q, videoId: vid, currentTime, sessionId });
    if (!resp?.ok) throw new Error(resp?.error || 'agent failed');
    const { text, sources, audioUrl } = resp.data || {};
    if (answerBox) {
      answerBox.style.display = 'block';
      const citation = Array.isArray(sources) && sources.length ? '\n\n' + sources.map((s: any) => `[${s.i}] ${s.title} - ${s.url}`).join('\n') : '';
      answerBox.textContent = (text || '') + citation;
    }
    pendingSpeakText = text || '';
    lastAudioDataUrl = null;
    lastAudioUrl = null;
    if (audioUrl) {
      try {
        // Store absolute raw URL for tab fallback
        try { lastAudioUrl = new URL(audioUrl, 'http://127.0.0.1:17321').toString(); } catch { lastAudioUrl = null; }
        const aResp = await chrome.runtime.sendMessage({ type: 'fetchAudioDataUrl', url: lastAudioUrl || audioUrl });
        if (aResp?.ok && aResp.dataUrl) lastAudioDataUrl = aResp.dataUrl as string;
      } catch {}
    }
    if (video) {
      const prevWasPlaying = !video.paused;
      const prevVol = video.volume;
      video.pause();
      video.volume = 0;
      // Try ElevenLabs MP3 first (in-DOM audio with controls)
      if (lastAudioDataUrl) {
        await playAnswerAudioOrSpeak(video, prevWasPlaying, prevVol);
        return;
      }
      // No server audio; show button to speak via Web Speech
      if (playAnswerBtn) playAnswerBtn.style.display = 'inline-block';
    }
  } catch (e) {
    if (answerBox) {
      answerBox.style.display = 'block';
      answerBox.textContent = 'Agent error';
    }
  }
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