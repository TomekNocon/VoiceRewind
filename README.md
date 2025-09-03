# VoiceRewind 🎙️

> AI-powered voice control for YouTube videos with intelligent search capabilities

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)

VoiceRewind is a sophisticated voice-controlled assistant that enhances your YouTube viewing experience. Use natural language to control video playback, ask questions about content, and navigate to specific moments using semantic search.

## ✨ Features

### 🎬 **Voice Control**
- **Wake Word Detection**: Say "Jarvis" to activate voice commands
- **Media Controls**: Rewind, forward, pause, play, speed control
- **Semantic Navigation**: "Jump to where they discuss machine learning"
- **Natural Language**: Use conversational commands like "go back 30 seconds"

### 🤖 **AI-Powered Search**
- **Conversational AI**: Ask questions and get intelligent responses
- **Web Search Integration**: Real-time information from the internet
- **Video Context**: AI understands current video content
- **Multi-Modal**: Text-to-speech responses with ElevenLabs

### 🚀 **Smart Transcription**
- **YouTube Captions**: Automatic extraction of official captions
- **Multi-Language Support**: English, Spanish, French, German, Polish
- **Whisper Fallback**: AI transcription when captions unavailable
- **Semantic Search**: Find moments by meaning, not just keywords

### 🌐 **Browser Extension**
- **Modern UI**: Clean, glassmorphism design with animations
- **Real-time Feedback**: Visual indicators for listening/speaking states
- **Cross-Platform**: Works on Chrome, Firefox, Edge
- **Minimal Footprint**: Lightweight and performant

## 🏗️ Architecture

```
VoiceRewind/
├── daemon/                 # Node.js backend service
│   ├── src/
│   │   ├── services/       # Core business logic
│   │   ├── routes/         # HTTP API endpoints
│   │   ├── websocket/      # Real-time communication
│   │   ├── config/         # Configuration management
│   │   ├── middleware/     # Validation & error handling
│   │   └── types/          # TypeScript definitions
│   └── tests/              # Test suite
└── extension/              # Browser extension
    ├── src/
    │   ├── content.ts      # YouTube page integration
    │   ├── background.ts   # Extension background script
    │   └── popup.html      # Extension popup UI
    └── manifest.json       # Extension configuration
```

### 🔧 **Technology Stack**

**Backend (Daemon)**
- **Runtime**: Node.js + TypeScript
- **Web Framework**: Express.js with WebSocket support
- **AI Services**: OpenAI (Whisper, GPT), ElevenLabs (TTS/Conversational AI)
- **Voice Processing**: Picovoice Porcupine (wake word detection)
- **Search**: Tavily API for web search
- **Caching**: File system cache for transcripts and embeddings

**Frontend (Extension)**
- **Languages**: TypeScript, modern CSS
- **Architecture**: Content script injection
- **Styling**: Glassmorphism UI with CSS animations
- **Communication**: WebSocket for real-time updates

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ 
- npm or yarn
- Chrome/Firefox/Edge browser
- Required API keys (see [Configuration](#configuration))

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-username/VoiceRewind.git
   cd VoiceRewind
   ```

2. **Install dependencies**
   ```bash
   # Install daemon dependencies
   cd daemon
   npm install

   # Install extension dependencies  
   cd ../extension
   npm install
   ```

3. **Configure environment variables**
   ```bash
   # Copy example environment file
   cd ../daemon
   cp .env.example .env
   
   # Edit .env with your API keys (see Configuration section)
   nano .env
   ```

4. **Build the extension**
   ```bash
   cd ../extension
   npm run build
   ```

5. **Install browser extension**
   - Open Chrome/Firefox extension management
   - Enable "Developer mode"
   - Click "Load unpacked" and select `extension/dist/`

6. **Start the daemon**
   ```bash
   cd ../daemon
   npm run dev
   ```

### First Run

1. Open YouTube in your browser
2. Look for the VoiceRewind widget in the top-right corner
3. Try typing a question in the "Ask the web..." input
4. For voice control, say "Jarvis" followed by commands like:
   - "Rewind 10 seconds"
   - "Jump to where they explain the concept"
   - "What is machine learning?"

## ⚙️ Configuration

Create a `.env` file in the `daemon` directory:

```bash
# Required: OpenAI API key for transcription and embeddings
OPENAI_API_KEY=your_openai_api_key_here

# Required: ElevenLabs for text-to-speech and conversational AI
ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM  # Rachel voice
ELEVENLABS_AGENT_ID=your_agent_id_here     # For conversational AI

# Optional: Tavily for web search (fallback mode available)
TAVILY_API_KEY=your_tavily_api_key_here

# Optional: Voice control (requires Picovoice account)
ENABLE_AUDIO=true
PV_ACCESS_KEY=your_picovoice_access_key_here
WAKE_KEYWORD=Jarvis
SENSITIVITY=0.6

# Optional: Server configuration
PORT=17321
TOOL_SECRET=your_webhook_secret_here

# Optional: AI model configuration  
EMBEDDING_MODEL=text-embedding-3-small
CHAT_MODEL=gpt-4o-mini
```

### API Key Setup

1. **OpenAI** (Required)
   - Visit [OpenAI Platform](https://platform.openai.com/)
   - Create account and generate API key
   - Used for: Whisper transcription, text embeddings, chat completions

2. **ElevenLabs** (Required for voice features)
   - Visit [ElevenLabs](https://elevenlabs.io/)
   - Create account and get API key
   - Set up conversational agent for best experience

3. **Tavily** (Optional - for web search)
   - Visit [Tavily](https://tavily.com/)
   - Create account and get API key
   - Fallback: Uses basic web scraping if not provided

4. **Picovoice** (Optional - for wake word detection)
   - Visit [Picovoice Console](https://console.picovoice.ai/)
   - Create account and get access key
   - Without this, voice control is disabled

## 🎯 Usage

### Voice Commands

**Media Control:**
- "Rewind 10 seconds" / "Go back 30 seconds"
- "Forward 15 seconds" / "Skip ahead 1 minute" 
- "Pause" / "Play" / "Resume"
- "Speed up" / "Slow down" / "Set speed to 1.5"
- "Volume 50%" / "Set volume to 80"

**Navigation:**
- "Jump to where they discuss [topic]"
- "Go to the part about [concept]"
- "Find the section on [subject]"

**Questions:**
- "What is [topic]?" 
- "Who won the Tour de France?"
- "Explain quantum computing"

### Text Interface

Use the "Ask the web..." input box to:
- Ask questions and get AI-generated answers
- Search for current information
- Get explanations with sources cited
- Receive audio responses automatically

### Advanced Features

**Semantic Search:**
- `/semantic_search?videoId=VIDEO_ID&q=your_query`
- Find video moments by meaning, not just keywords
- Returns timestamp and confidence score

**Transcript API:**
- `/transcript?videoId=VIDEO_ID`
- Get full video transcript with timestamps
- Supports caching for performance

**Web Search Tool:**
- `/tools/web_search` with proper authentication
- Integrates with external AI agents and tools

## 🧪 Development

### Project Structure

```
daemon/src/
├── services/           # Business logic services
│   ├── AudioService.ts       # Voice processing & wake word
│   ├── CacheService.ts       # File system caching
│   ├── ElevenLabsService.ts  # TTS & conversational AI
│   ├── EmbeddingService.ts   # Vector embeddings & search
│   ├── SearchService.ts      # Web search & answer synthesis
│   └── TranscriptService.ts  # YouTube transcript fetching
├── routes/             # HTTP API endpoints
├── websocket/          # WebSocket communication
├── middleware/         # Validation & error handling
├── config/             # Configuration management
├── types/              # TypeScript definitions
└── tests/              # Test suites
```

### Testing

```bash
# Run all tests
cd daemon
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test SearchService
```

### API Documentation

**Health Check**
```bash
GET /health
# Returns system status and configuration
```

**Transcript Fetching**
```bash
GET /transcript?videoId=VIDEO_ID&force=0
# Returns transcript segments with timestamps
```

**Semantic Search**
```bash
GET /semantic_search?videoId=VIDEO_ID&q=search_query
# Returns best matching segment with confidence score
```

**Agent Query**  
```bash
POST /agent/query
Content-Type: application/json

{
  "q": "Your question here",
  "videoId": "optional_video_id", 
  "currentTime": 123.45,
  "sessionId": "optional_session_id"
}
```

### WebSocket Events

The daemon broadcasts these events to connected clients:

```javascript
// Listening state changes
{ "intent": "begin_listen" }
{ "intent": "end_listen" }

// Media control commands
{ "intent": "rewind", "value": 10 }
{ "intent": "pause" }
{ "intent": "set_speed", "value": 1.5 }

// Agent responses
{ 
  "intent": "agent_response", 
  "value": { 
    "text": "Response text", 
    "audioUrl": "/media/response.wav" 
  } 
}
```

## 🚦 Running the Refactored Version

We've created an improved, modular version of the daemon:

```bash
# Run the new refactored daemon
cd daemon
npm run start:new

# Or run in development mode with auto-restart
npm run dev:new
```

The refactored version includes:
- ✅ **Modular Architecture**: Separated into focused services
- ✅ **Better Error Handling**: Comprehensive validation and error recovery
- ✅ **Type Safety**: Strict TypeScript with proper type definitions
- ✅ **Testing Ready**: Jest/Vitest test suite with examples
- ✅ **Performance**: Rate limiting, caching, and optimization
- ✅ **Developer Experience**: Better logging, health checks, graceful shutdown

## 🐛 Troubleshooting

### Common Issues

**"Wake word not detected"**
- Ensure `PV_ACCESS_KEY` is set correctly
- Check microphone permissions in browser/system
- Verify `ENABLE_AUDIO=true` in `.env`
- Install audio dependencies: `npm install @picovoice/porcupine-node mic`

**"No transcript available"**  
- YouTube video may not have captions
- Try `?force=1` parameter to use Whisper
- Check `OPENAI_API_KEY` is valid
- Some videos may have geo-restrictions

**"Agent not responding"**
- Verify `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID`
- Check network connectivity  
- Look for rate limiting (429 errors)
- Ensure sufficient API credits

**Extension not loading**
- Reload extension in browser dev tools
- Check console for JavaScript errors
- Verify daemon is running on correct port
- Try incognito mode to test without other extensions

### Debug Mode

```bash
# Enable verbose logging
DEBUG=voicerewind:* npm run dev

# Check WebSocket connections
curl http://localhost:17321/health

# Test API endpoints
curl "http://localhost:17321/transcript?videoId=dQw4w9WgXcQ"
```

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Workflow

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes and add tests
4. Run the test suite: `npm test`
5. Commit your changes: `git commit -m 'Add amazing feature'`
6. Push to the branch: `git push origin feature/amazing-feature`
7. Open a Pull Request

### Code Style

We use ESLint and Prettier for code formatting:

```bash
# Format code
npm run format

# Lint code
npm run lint

# Type check
npm run type-check
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [OpenAI](https://openai.com/) for Whisper and GPT models
- [ElevenLabs](https://elevenlabs.io/) for voice synthesis and conversational AI
- [Picovoice](https://picovoice.ai/) for wake word detection
- [Tavily](https://tavily.com/) for web search capabilities
- The open source community for various dependencies

## 📊 Project Stats

- **Language**: TypeScript (90%), JavaScript (10%)
- **Lines of Code**: ~3,000 (refactored from 1,000+ line monolith)
- **Test Coverage**: 80%+ (target)
- **Browser Support**: Chrome 90+, Firefox 88+, Edge 90+
- **Node.js**: 18+ required

---

<div align="center">

**[⭐ Star this project](https://github.com/your-username/VoiceRewind)** if you find it useful!

[🐛 Report Bug](https://github.com/your-username/VoiceRewind/issues) • [💡 Request Feature](https://github.com/your-username/VoiceRewind/issues) • [💬 Discord Community](https://discord.gg/your-server)

</div>