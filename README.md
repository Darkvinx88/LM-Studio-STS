# LM Studio STS Chat

A modern web-based frontend for LM Studio that integrates speech-to-text and text-to-speech capabilities, creating a complete voice chat interface.

## Features

- 🎤 **Voice Input**: Vosk-based speech recognition with multiple language support
- 🗣️ **Voice Output**: Kokoro TTS integration for natural speech synthesis
- 🤖 **LLM Integration**: Connects to LM Studio for AI responses
- 💬 **Chat Interface**: Modern, responsive chat UI with message history
- 🎨 **Multiple Themes**: Customizable themes (Material, Grey, Blue, Violet, Original)
- ⚙️ **Advanced Settings**: Configurable voice parameters, system prompts, and API endpoints
- 🔄 **Real-time Status**: Health monitoring for all connected services

## Architecture

```
Frontend (Web) → LM Studio (LLM) → Kokoro TTS (Speech) ← Vosk (Speech Recognition)
```

## Prerequisites

1. **LM Studio**: Installed and running locally
2. **Kokoro TTS**: Local installation with Gradio interface
3. **Python 3.x**: For running the frontend server
4. **Modern Browser**: Chrome, Firefox, Safari, or Edge

## Quick Start

### Option 1: Using the Launcher (Recommended)

1. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/lm-studio-sts-chat.git
   cd lm-studio-sts-chat
   ```

2. Update the paths in `RunLMStudioTTSV2.bat` to match your system:
   - `LM_STUDIO_PATH`: Path to LM Studio executable
   - `LMS_CLI_PATH`: Path to LM Studio CLI
   - `KOKORO_PATH`: Path to Kokoro TTS installation
   - `MODEL_PATH`: Your preferred model path

3. Run the launcher:
   ```bash
   RunLMStudioTTSV2.bat
   ```

### Option 2: Manual Setup

1. Start LM Studio and load your preferred model
2. Start Kokoro TTS with Gradio interface
3. Start the frontend server:
   ```bash
   python -m http.server 8000
   ```
4. Open `http://localhost:8000` in your browser

## Configuration

### API Endpoints

Configure the following in the settings panel:

- **LLM Endpoint**: `http://127.0.0.1:1234/v1/chat/completions` (default LM Studio)
- **TTS Endpoint**: `http://127.0.0.1:7860/` (default Kokoro TTS)
- **Vosk Model**: Select from available language models

### Voice Settings

- **Voice Selection**: Choose from 50+ available voices
- **Audio Format**: WAV or MP3 output
- **Speed**: 0.1x to 2.0x playback speed
- **Volume**: 0% to 100% volume control

### Speech Recognition

- **Languages**: English (US), Italian
- **Continuous Listening**: Toggle for always-on recognition
- **Interim Results**: Show partial recognition results

## File Structure

```
lm-studio-sts-chat/
├── index.html              # Main application page
├── script.js               # Core application logic
├── style.css               # Main stylesheet
├── themes/                 # Theme variations
│   ├── style Material.css
│   ├── style Grey.css
│   ├── style blue.css
│   ├── style violet.css
│   └── style original.css
├── models/                 # Vosk speech models
│   ├── vosk-model-small-en-us-0.15.tar.gz
│   └── vosk-model-small-it-0.22.tar.gz
├── RunLMStudioTTS.bat     # Basic launcher
├── RunLMStudioTTSV2.bat    # Enhanced launcher
├── favicon.ico             # Application icon
└── README.md               # This file
```

## Usage

1. **Text Chat**: Type messages and press Enter or click Send
2. **Voice Chat**: Hold the microphone button to record voice input
3. **Settings**: Configure endpoints, voice parameters, and system prompts
4. **Themes**: Switch between different visual themes
5. **Clear Chat**: Remove conversation history and start fresh

## API Integration

### LM Studio API

The frontend connects to LM Studio's OpenAI-compatible API:

```javascript
// Example API call
const response = await fetch('http://127.0.0.1:1234/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'local-model',
    messages: conversationHistory,
    stream: false
  })
});
```

### Kokoro TTS API

Text-to-speech synthesis via Gradio client:

```javascript
// Example TTS call
const client = await Client.connect('http://127.0.0.1:7860');
const result = await client.predict('/generate_tts_with_logs', {
  voice_name: 'af_alloy',
  text: 'Hello, world!',
  format: 'wav',
  speed: 1.0
});
```

## Troubleshooting

### Common Issues

1. **LM Studio Connection**: Ensure LM Studio is running and the model is loaded
2. **TTS Service**: Verify Kokoro TTS is running on port 7860
3. **Voice Recognition**: Check that Vosk models are properly loaded
4. **Browser Permissions**: Grant microphone access for voice input

### Status Indicators

- **Green Dot**: Service is healthy and responding
- **Red Dot**: Service is unreachable or error occurred
- **Yellow Dot**: Service is checking or starting up

## Development

### Local Development

1. Clone the repository
2. Start a local HTTP server:
   ```bash
   python -m http.server 8000
   ```
3. Open `http://localhost:8000` in your browser

### Customization

- **Themes**: Modify CSS files in the `themes/` directory
- **Voices**: Update the voice list in `script.js`
- **Settings**: Add new configuration options to the settings panel

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- **LM Studio**: For the local LLM inference platform
- **Kokoro TTS**: For high-quality text-to-speech synthesis
- **Vosk**: For accurate speech recognition
- **Gradio**: For the machine learning interface framework

## Support

If you encounter issues or have questions:

1. Check the troubleshooting section above
2. Verify all prerequisites are installed
3. Ensure all services are running on correct ports
4. Open an issue on GitHub with detailed error information

---

**Version**: 0.4.7  
**Last Updated**: 2025-01-25
