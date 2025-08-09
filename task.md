# VoiceRewind Tasks

## Goals
- Wake-word daemon (Node + TypeScript) that listens for a wake word and sends control intents over WebSocket to the browser.
- Chrome/Brave extension (MV3 + TypeScript) that controls YouTube playback and can jump to transcript phrases.

## Structure
- `daemon/`: Node TS background service (wake word → ASR → intent → WS broadcast)
- `extension/`: MV3 extension (content script connects to local WS and controls the `video` element)

## Prerequisites
- Node.js 18+
- Chrome or Brave
- Optional (for full wake-word + mic):
  - Picovoice Porcupine access key (for wake word)
  - macOS: `brew install sox` (if you use the `mic` package) or `brew install portaudio` (if you switch to `naudiodon`)
  - OpenAI API key for ASR (set `OPENAI_API_KEY`)

## Setup
1. Create daemon env file:
   - Create `daemon/.env` with:
     - `OPENAI_API_KEY=...` (optional for later ASR)
     - `PV_ACCESS_KEY=...` (optional for wake word)
     - `PORT=17321`
     - `ENABLE_AUDIO=false`
2. Install dependencies:
   - `cd daemon && npm install`
   - `cd ../extension && npm install`
3. Build extension:
   - `npm run build` inside `extension/`

## Running
- Daemon (dev, simulated without mic):
  - `cd daemon && npm run dev`
  - This starts WS+HTTP on `http://127.0.0.1:17321`.
  - Trigger intents:
    - `curl -X POST http://127.0.0.1:17321/simulate -H 'Content-Type: application/json' -d '{"intent":"rewind","value":15}'`
- Daemon (with wake word and ASR when configured):
  - `ENABLE_AUDIO=true npm run dev`
- Extension:
  - Load `extension/dist` as an unpacked extension in Chrome: Extensions → Developer mode → Load unpacked → select `extension/dist`.
  - Open a YouTube video tab; the content script will connect to the daemon and respond to intents.

## Supported intents (MVP)
```json
{"intent":"rewind","value":10}
{"intent":"forward","value":10}
{"intent":"set_speed","value":1.5}
{"intent":"set_volume","value":65}
{"intent":"pause"}
{"intent":"play"}
{"intent":"jump_to_phrase","value":"transformer architecture"}
```

## Next steps
- Replace simulated mode with real wake-word detection (Porcupine) and VAD.
- Add transcript embeddings for semantic jump across all captions (fallback to ASR when no captions).
- Add UI overlay for quick actions and connection status.
- Add Native Messaging bridge as an alternative to WS for better reliability.
- Auto-launch daemon at login via LaunchAgent. 