"use strict";

import { Client } from "https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js";

// Constants
const CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAYS: [1000, 2000, 4000],
  HEALTH_CHECK_INTERVAL: 30000,
  API_TIMEOUT: 60000,
  SERVICE_TIMEOUT: 10000
};

// Application State Management
class AppState {
  constructor() {
    this.state = this.getDefaultState();
    this.listeners = new Set();
    this.init();
  }

  getDefaultState() {
    return {
      settings: JSON.parse(localStorage.getItem("ttsSettings") || "{}"),
      currentApiUrl: null,
      currentTtsUrl: null,
      voskModelUrl: null,
      isSpeakingOrLoading: false,
      client: null,
      currentAudio: null,
      availableVoices: [],
      retryAttempts: { api: 0, tts: 0 },
      healthStatus: { api: 'unknown', tts: 'unknown', vosk: 'unknown' },
      audioIsStopped: false,
      currentModel: null,
      availableModels: [],
      conversationHistory: [],
      maxContextMessages: 20,
      voiceRecognition: {
        isListening: false,
        isProcessing: false,
        recognition: null,
        isSupported: typeof Vosk !== 'undefined',
        vosk: null,
        voskModelLoaded: false,
        audioContext: null,
        mediaStream: null
      }
    };
  }

  init() {
    this.state.currentApiUrl = this.state.settings.apiUrl || null;
    this.state.currentTtsUrl = this.state.settings.ttsUrl || null;
    this.state.voskModelUrl = this.state.settings.voskModelUrl || null;
    this.state.voiceRecognition.isSupported = typeof Vosk !== 'undefined';
  }

  setState(newState) {
    const oldState = { ...this.state };
    this.state = { ...this.state, ...newState };
    this.notify(oldState);
  }

  getState() {
    return { ...this.state };
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notify(oldState) {
    this.listeners.forEach(callback => {
      try {
        callback(this.state, oldState);
      } catch (error) {
        console.error('State listener error:', error);
      }
    });
  }
}

// Error Handling and Retry Logic
class ErrorHandler {
  static async withRetry(operation, maxRetries = CONFIG.MAX_RETRIES) {
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation(attempt);
      } catch (error) {
        lastError = error;
        
        if (attempt < maxRetries) {
          const delay = CONFIG.RETRY_DELAYS[attempt] || 4000;
          statusManager.setStatus(`Retry ${attempt + 1}/${maxRetries} in ${delay/1000}s...`, 'warning');
          await this.sleep(delay);
        }
      }
    }
    
    throw lastError;
  }

  static sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  static getErrorMessage(error) {
    if (error.name === 'AbortError') {
      return 'Request timeout - please check your connection';
    }
    if (error.message.includes('fetch')) {
      return 'Network error - please check if the service is running';
    }
    return error.message || 'Unknown error occurred';
  }
}

// Status Management
class StatusManager {
  constructor(statusEl) {
    this.statusEl = statusEl;
    this.currentTimeout = null;
  }

  setStatus(message, type = 'info', duration = null) {
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
    }

    this.statusEl.textContent = message;
    this.statusEl.className = `status-${type}`;

    if (duration) {
      this.currentTimeout = setTimeout(() => {
        this.setStatus('Ready', 'info');
      }, duration);
    }
  }

  setLoadingStatus(message) {
    this.statusEl.innerHTML = `<div class="spinner"></div>${message}`;
    this.statusEl.className = '';
  }

  clearStatus() {
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
    }
    this.statusEl.textContent = '';
    this.statusEl.className = '';
  }
}

// Voice Recognition Manager
class VoiceRecognitionManager {
  constructor(appState) {
    this.appState = appState;
    this.modelInstance = null;
    this.recognition = null;
    this.isInitialized = false;
  }

  async initVosk() {
    const state = this.appState.getState();
    const voskModelUrl = state.voskModelUrl;
    
    if (!state.voiceRecognition.isSupported) {
      statusManager.setStatus('Vosk speech recognition library not loaded.', 'error', 5000);
      this.appState.setState({ 
        voiceRecognition: { ...state.voiceRecognition, voskModelLoaded: false } 
      });
      return false;
    }

    if (!voskModelUrl) {
      statusManager.setStatus('Vosk Model URL not configured.', 'warning', 3000);
      this.appState.setState({ 
        voiceRecognition: { ...state.voiceRecognition, voskModelLoaded: false } 
      });
      return false;
    }

    if (this.modelInstance) {
      console.log('Vosk model already loaded, skipping initVosk call.');
      this.appState.setState({ 
        voiceRecognition: { ...state.voiceRecognition, voskModelLoaded: true } 
      });
      return true;
    }

    statusManager.setLoadingStatus("Loading Vosk model...");
    console.log('Attempting to load Vosk model from:', voskModelUrl);

    try {
      this.modelInstance = await Vosk.createModel(voskModelUrl);
      console.log('Vosk model loaded successfully.', this.modelInstance);
      this.appState.setState({ 
        voiceRecognition: { ...state.voiceRecognition, voskModelLoaded: true } 
      });
      statusManager.setStatus('Vosk model loaded and ready', 'success', 2000);
      healthChecker.checkServices();
      return true;
    } catch (error) {
      console.error('Failed to load Vosk model:', error);
      this.appState.setState({ 
        voiceRecognition: { ...state.voiceRecognition, voskModelLoaded: false } 
      });
      statusManager.setStatus(`Failed to load Vosk model: ${error.message}`, 'error', 5000);
      this.isInitialized = false;
      healthChecker.checkServices();
      return false;
    }
  }

  startNewRecognition() {
    const state = this.appState.getState();
    if (!this.modelInstance) {
      console.error('Cannot start recognition: Vosk model not loaded.');
      statusManager.setStatus('Vosk model not ready for recognition.', 'error', 3000);
      return false;
    }

    if (this.recognition) {
      this.recognition.remove();
      this.recognition = null;
      console.log('Previous KaldiRecognizer instance removed.');
    }

    try {
      this.recognition = new this.modelInstance.KaldiRecognizer(16000);
      console.log('New KaldiRecognizer instance created.', this.recognition);
      this.appState.setState({ 
        voiceRecognition: { ...state.voiceRecognition, vosk: this.recognition } 
      });

      this.setupRecognitionHandlers();
      return true;
    } catch (error) {
      console.error('Failed to create KaldiRecognizer:', error);
      statusManager.setStatus(`Failed to initialize speech recognition: ${error.message}`, 'error', 5000);
      return false;
    }
  }

  setupRecognitionHandlers() {
    this.recognition.on("partialresult", (message) => {
      console.log('Vosk partial result:', message);
      const promptInput = document.getElementById('promptInput');
      const interimEnabled = document.getElementById('interimResults').checked;
      if (interimEnabled && message.result.partial) {
        const currentText = promptInput.value;
        const baseText = currentText.replace(/\s*\[.*?\]\s*$/, '');
        promptInput.value = baseText + (baseText ? ' ' : '') + `[${message.result.partial}]`;
      }
    });

    this.recognition.on("result", (message) => {
      console.log('Vosk final result:', message);
      const promptInput = document.getElementById('promptInput');
      if (message.result.text) {
        const finalResult = message.result.text;
        promptInput.value = finalResult;
        statusManager.setStatus('Speech recognized', 'success', 2000);
        
        if (!document.getElementById('continuousListening').checked) {
          sendPrompt(finalResult);
        }
      } else if (!document.getElementById('continuousListening').checked) {
        promptInput.value = '';
        statusManager.setStatus('No speech detected or empty transcription.', 'info', 2000);
      }

      this.cleanup();
    });

    this.recognition.on("ready", () => {
      console.log('Vosk recognizer ready for audio stream.');
    });

    this.recognition.on("error", (event) => {
      console.error('Vosk recognition error:', event);
      const state = this.appState.getState();
      this.appState.setState({ 
        voiceRecognition: { ...state.voiceRecognition, isListening: false, isProcessing: false } 
      });
      statusManager.setStatus(`Vosk error: ${event.message || 'Unknown error'}`, 'error', 4000);
      healthChecker.checkServices();
      this.cleanup();
    });
  }

  cleanup() {
    const state = this.appState.getState();
    this.appState.setState({ 
      voiceRecognition: { 
        ...state.voiceRecognition, 
        isListening: false, 
        isProcessing: false,
        vosk: null 
      } 
    });

    if (this.recognition) {
      this.recognition = null;
      console.log('KaldiRecognizer instance cleaned up.');
    }
  }

  stopCurrentRecognition() {
    if (this.recognition) {
      console.log('stopCurrentRecognition: KaldiRecognizer will finalize naturally.');
    }
  }
}

// Audio Input Processor
class AudioInputProcessor {
  constructor(appState, voiceRecognitionManager) {
    this.appState = appState;
    this.voiceRecognitionManager = voiceRecognitionManager;
    this.audioContext = null;
    this.mediaStream = null;
    this.audioSource = null;
    this.scriptProcessor = null;
  }

  async start() {
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ 
        sampleRate: 16000 
      });
      
      const state = this.appState.getState();
      this.appState.setState({ 
        voiceRecognition: { ...state.voiceRecognition, audioContext: this.audioContext } 
      });

      console.log('AudioInputProcessor: Attempting to get microphone input...');
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('AudioInputProcessor: Microphone input obtained successfully.');
      
      memoryManager.trackMediaStream(this.mediaStream);
      this.appState.setState({ 
        voiceRecognition: { ...state.voiceRecognition, mediaStream: this.mediaStream } 
      });

      this.audioSource = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
      
      this.scriptProcessor.onaudioprocess = (event) => {
        const audioBuffer = event.inputBuffer;
        const currentState = this.appState.getState();
        
        if (currentState.voiceRecognition.vosk && currentState.voiceRecognition.isListening) {
          this.voiceRecognitionManager.recognition.acceptWaveform(audioBuffer);
          
          if (audioBuffer.length > 0) {
            console.log('AudioInputProcessor: Sending waveform to Vosk, buffer size:', audioBuffer.length);
          }
        }
      };

      this.audioSource.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.audioContext.destination);

      console.log('Microphone input started.');
      return true;
    } catch (error) {
      console.error('Failed to get microphone input:', error);
      statusManager.setStatus('Microphone access denied or error.', 'error', 5000);
      this.stop();
      throw error;
    }
  }

  stop() {
    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
      this.scriptProcessor.onaudioprocess = null;
      this.scriptProcessor = null;
    }
    
    if (this.audioSource) {
      this.audioSource.disconnect();
      this.audioSource = null;
    }
    
    if (this.mediaStream) {
      memoryManager.releaseMediaStream(this.mediaStream);
      this.mediaStream = null;
    }
    
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().then(() => {
        console.log('AudioContext closed.');
        const state = this.appState.getState();
        this.appState.setState({ 
          voiceRecognition: { ...state.voiceRecognition, audioContext: null } 
        });
      });
    }
    
    console.log('Microphone input stopped.');
  }
}

// Health Checker
class HealthChecker {
  constructor(appState) {
    this.appState = appState;
    this.checkInterval = null;
  }

  start() {
    this.checkServices();
    this.checkInterval = setInterval(() => {
      this.checkServices();
    }, CONFIG.HEALTH_CHECK_INTERVAL);
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  async checkServices() {
    const state = this.appState.getState();
    const results = await Promise.allSettled([
      this.checkAPI(state.currentApiUrl),
      this.checkTTS(state.currentTtsUrl)
    ]);

    const healthStatus = {
      api: results[0].status === 'fulfilled' ? 'healthy' : 'unhealthy',
      tts: results[1].status === 'fulfilled' ? 'healthy' : 'unhealthy',
      vosk: state.voiceRecognition.voskModelLoaded ? 'healthy' : 'unhealthy'
    };

    this.appState.setState({ healthStatus });
    this.updateHealthIndicators(healthStatus);
  }

  async checkAPI(url) {
    if (!url) throw new Error('No API URL configured');
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.SERVICE_TIMEOUT);
    
    try {
      const baseUrl = new URL(url);
      baseUrl.pathname = '/v1/models';
      
      const response = await fetch(baseUrl.toString(), {
        signal: controller.signal,
        method: 'GET'
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async checkTTS(url) {
    if (!url) throw new Error('No TTS URL configured');
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.SERVICE_TIMEOUT);
    
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        method: 'GET'
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  updateHealthIndicators(healthStatus) {
    const apiDot = document.getElementById('apiStatus');
    const ttsDot = document.getElementById('ttsStatus');
    const voskDot = document.getElementById('voskStatus');

    if (apiDot) apiDot.className = `status-dot ${healthStatus.api}`;
    if (ttsDot) ttsDot.className = `status-dot ${healthStatus.tts}`;
    if (voskDot) voskDot.className = `status-dot ${healthStatus.vosk}`;
  }
}

// Memory Manager
class MemoryManager {
  constructor() {
    this.audioObjects = new Set();
    this.blobUrls = new Set();
    this.eventListeners = new Map();
    this.mediaStreams = new Set();
    
    window.addEventListener('beforeunload', () => this.cleanup());
  }

  trackAudio(audio) {
    this.audioObjects.add(audio);
  }

  trackBlobUrl(url) {
    this.blobUrls.add(url);
  }

  trackMediaStream(stream) {
    this.mediaStreams.add(stream);
  }

  releaseMediaStream(stream) {
    if (this.mediaStreams.has(stream)) {
      stream.getTracks().forEach(track => track.stop());
      this.mediaStreams.delete(stream);
    }
  }

  trackEventListener(element, event, handler) {
    const key = `${element}_${event}`;
    if (this.eventListeners.has(key)) {
      const oldHandler = this.eventListeners.get(key);
      element.removeEventListener(event, oldHandler);
    }
    element.addEventListener(event, handler);
    this.eventListeners.set(key, handler);
  }

  cleanupAudio(audio) {
    if (this.audioObjects.has(audio)) {
      try {
        audio.pause();
        audio.currentTime = 0;
        audio.src = '';
        audio.load();
      } catch (e) {
        console.warn('Error cleaning up audio:', e);
      }
      this.audioObjects.delete(audio);
    }
  }

  cleanupBlobUrl(url) {
    if (this.blobUrls.has(url)) {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        console.warn('Error revoking blob URL:', e);
      }
      this.blobUrls.delete(url);
    }
  }

  cleanup() {
    this.audioObjects.forEach(audio => {
      try {
        audio.pause();
        audio.currentTime = 0;
        audio.src = '';
        audio.load();
      } catch (e) {
        console.warn('Error cleaning up audio:', e);
      }
    });
    this.audioObjects.clear();

    this.blobUrls.forEach(url => {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        console.warn('Error revoking blob URL:', e);
      }
    });
    this.blobUrls.clear();

    this.mediaStreams.forEach(stream => {
      try {
        stream.getTracks().forEach(track => track.stop());
      } catch (e) {
        console.warn('Error stopping media stream:', e);
      }
    });
    this.mediaStreams.clear();

    this.eventListeners.forEach((handler, key) => {
      try {
        const [element, event] = key.split('_');
        if (element && event && handler) {
          element.removeEventListener(event, handler);
        }
      } catch (e) {
        console.warn('Error removing event listener:', e);
      }
    });
    this.eventListeners.clear();
  }
}

// Token Counter
class TokenCounter {
  static sessionTotal = { prompt: 0, completion: 0, total: 0 };

  static update(usage) {
    if (!usage) return;
    this.sessionTotal.prompt     += usage.prompt_tokens     || 0;
    this.sessionTotal.completion += usage.completion_tokens || 0;
    this.sessionTotal.total      += usage.total_tokens      || 0;

    const el = document.getElementById('tokenCounter');
    if (!el) return;

    const estMark = usage.estimated
      ? `<span class="tok-sep" title="Estimated">~</span>`
      : '';
    el.innerHTML =
      `<span class="tok-label">Last</span>` +
      `<span class="tok-val">${(usage.prompt_tokens||0).toLocaleString()}</span>` +
      `<span class="tok-sep">&#8593;</span>` +
      `<span class="tok-val">${(usage.completion_tokens||0).toLocaleString()}</span>` +
      `<span class="tok-sep">&#8595;</span>${estMark}` +
      `<span class="tok-sep" style="margin:0 6px">&middot;</span>` +
      `<span class="tok-label">Session</span>` +
      `<span class="tok-val">${this.sessionTotal.total.toLocaleString()}</span>`;
    el.removeAttribute('data-empty');
  }

  static reset() {
    this.sessionTotal = { prompt: 0, completion: 0, total: 0 };
    const el = document.getElementById('tokenCounter');
    if (el) {
      el.innerHTML = '';
      el.setAttribute('data-empty', 'true');
    }
  }
}

// Initialize managers
const appState = new AppState();
const statusManager = new StatusManager(document.getElementById("status"));
const healthChecker = new HealthChecker(appState);
const memoryManager = new MemoryManager();
const voiceRecognitionManager = new VoiceRecognitionManager(appState);
const audioInputProcessor = new AudioInputProcessor(appState, voiceRecognitionManager);

// DOM Elements
const elements = {
  apiUrlInput: document.getElementById("apiUrl"),
  saveApiBtn: document.getElementById("saveApiBtn"),
  ttsUrlInput: document.getElementById("ttsUrl"),
  saveTtsBtn: document.getElementById("saveTtsBtn"),
  voiceSelect: document.getElementById("voiceSelect"),
  formatSelect: document.getElementById("formatSelect"),
  speedRange: document.getElementById("speedRange"),
  volumeRange: document.getElementById("volumeRange"),
  chatEl: document.getElementById("chat"),
  promptInput: document.getElementById("promptInput"),
  sendBtn: document.getElementById("sendBtn"),
  stopBtn: document.getElementById("stopBtn"),
  clearBtn: document.getElementById("clearBtn"),
  themeBtn: document.getElementById("themeBtn"),
  currentModelBox: document.getElementById("currentModelBox"),
  modelText: document.getElementById("modelText"),
  systemPromptTextarea: document.getElementById("systemPromptTextarea"),
  saveSystemPromptBtn: document.getElementById("saveSystemPromptBtn"),
  voskModelUrlInput: document.getElementById("voskModelUrl"),
  saveVoskModelBtn: document.getElementById("saveVoskModelBtn"),
  voiceBtn: document.getElementById("voiceBtn"),
  presetTitle: document.getElementById("presetTitle") // Aggiunto riferimento al titolo del preset
};

// Input Validation
class InputValidator {
  static validateUrl(url) {
    if (!url?.trim()) return false;
    try {
      const parsed = new URL(url.trim());
      return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  }

  static sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    return input.trim().replace(/[<>"']/g, '');
  }
}

// Settings Management
class SettingsManager {
  static save(appState) {
    const settings = {
      speed: elements.speedRange.value,
      volume: elements.volumeRange.value,
      voiceIndex: elements.voiceSelect.selectedIndex || 0,
      format: elements.formatSelect.value,
      theme: document.body.classList.contains("light") ? "light" : "dark",
      apiUrl: elements.apiUrlInput.value.trim() || null,
      ttsUrl: elements.ttsUrlInput.value.trim() || null,
      voskModelUrl: elements.voskModelUrlInput.value.trim() || null,
      systemPrompt: elements.systemPromptTextarea.value.trim() || "",
      presetTitle: elements.presetTitle?.textContent || "", // Salvataggio del titolo preset
      sttLanguage: document.getElementById('sttLanguage').value,
      continuousListening: document.getElementById('continuousListening').checked,
      interimResults: document.getElementById('interimResults').checked
    };
    
    try {
      localStorage.setItem("ttsSettings", JSON.stringify(settings));
      appState.setState({ 
        settings: settings,
        currentApiUrl: settings.apiUrl,
        currentTtsUrl: settings.ttsUrl,
        voskModelUrl: settings.voskModelUrl
      });
    } catch (error) {
      console.error('Failed to save settings:', error);
      statusManager.setStatus('Failed to save settings', 'error', 3000);
    }
  }

  static load(appState) {
    try {
      const storedSettings = localStorage.getItem("ttsSettings");
      const loadedSettings = storedSettings ? JSON.parse(storedSettings) : {};
      
      // Load conversation history
      const storedHistory = localStorage.getItem("conversationHistory");
      const conversationHistory = storedHistory ? JSON.parse(storedHistory) : [];
      
      appState.setState({
        settings: loadedSettings,
        currentApiUrl: loadedSettings.apiUrl || null,
        currentTtsUrl: loadedSettings.ttsUrl || null,
        voskModelUrl: loadedSettings.voskModelUrl || null,
        conversationHistory: conversationHistory
      });

      this.populateUI(loadedSettings);
    } catch (error) {
      console.error('Failed to load settings:', error);
      statusManager.setStatus('Failed to load settings', 'error', 3000);
    }
  }

  static populateUI(settings) {
    if (settings.speed) {
      elements.speedRange.value = settings.speed;
      document.getElementById("speedVal").textContent = settings.speed;
    }
    if (settings.volume) {
      elements.volumeRange.value = settings.volume;
      document.getElementById("volumeVal").textContent = settings.volume;
    }
    if (settings.format) {
      elements.formatSelect.value = settings.format;
    }
    if (settings.theme === "light") {
      document.body.classList.add("light");
    }
    if (settings.apiUrl) {
      elements.apiUrlInput.value = settings.apiUrl;
    }
    if (settings.ttsUrl) {
      elements.ttsUrlInput.value = settings.ttsUrl;
    }
    if (settings.voskModelUrl) {
      elements.voskModelUrlInput.value = settings.voskModelUrl;
    }
    if (settings.systemPrompt) {
      elements.systemPromptTextarea.value = settings.systemPrompt;
    }
    if (settings.presetTitle && elements.presetTitle) {
      elements.presetTitle.textContent = settings.presetTitle; // Ripopolamento del titolo preset
    }
    if (settings.sttLanguage) {
      document.getElementById('sttLanguage').value = settings.sttLanguage;
    }
    if (typeof settings.continuousListening === 'boolean') {
      document.getElementById('continuousListening').checked = settings.continuousListening;
    }
    if (typeof settings.interimResults === 'boolean') {
      document.getElementById('interimResults').checked = settings.interimResults;
    }
  }
}

// Chat Management
class ChatManager {
  static save() {
    try {
      localStorage.setItem("chatHistory", elements.chatEl.innerHTML);
    } catch (error) {
      console.error('Failed to save chat:', error);
    }
  }

  static load() {
    try {
      const savedChat = localStorage.getItem("chatHistory");
      if (savedChat) {
        elements.chatEl.innerHTML = savedChat;
        this.scrollToBottom();
      }
    } catch (error) {
      console.error('Failed to load chat:', error);
    }
  }

  static clear() {
    try {
      localStorage.removeItem("chatHistory");
      localStorage.removeItem("conversationHistory");
      elements.chatEl.innerHTML = "";
      appState.setState({ conversationHistory: [] });
      TokenCounter.reset();
      statusManager.setStatus("Chat cleared", 'success', 2000);
    } catch (error) {
      console.error('Failed to clear chat:', error);
      statusManager.setStatus("Failed to clear chat", 'error', 3000);
    }
  }

  static scrollToBottom() {
    const chatWrap = elements.chatEl.closest(".chat-wrap") || elements.chatEl.parentElement;
    if (chatWrap) { chatWrap.scrollTop = chatWrap.scrollHeight; }
  }

  static createMessageElement(role, text, typing = false) {
    const msgDiv = document.createElement("div");
    msgDiv.className = `message ${role}`;
    msgDiv.setAttribute('role', role === 'user' ? 'log' : 'status');
    msgDiv.setAttribute('aria-label', `${role} message`);
    
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = role === "user" ? "🙂" : "🤖";
    avatar.setAttribute('aria-hidden', 'true');
    
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    
    if (typing) {
      bubble.classList.add("typing-indicator");
      bubble.innerHTML = "<span></span><span></span><span></span>";
      bubble.setAttribute('aria-label', 'AI is typing');
    } else {
      bubble.textContent = text;
    }
    
    msgDiv.appendChild(avatar);
    msgDiv.appendChild(bubble);
    elements.chatEl.appendChild(msgDiv);
    
    this.scrollToBottom();
    return bubble;
  }
}

// Voice Management
class VoiceManager {
  static availableVoices = [
    'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 
    'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky', 'am_adam', 
    'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 
    'am_puck', 'am_santa', 'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 
    'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis', 'ef_dora', 'em_alex', 
    'em_santa', 'ff_siwis', 'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi', 
    'if_sara', 'im_nicola', 'jf_alpha', 'jf_gongitsune', 'jf_nezumi', 
    'jf_tebukuro', 'jm_kumo', 'pf_dora', 'pm_alex', 'pm_santa', 'zf_xiaobei', 
    'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi', 'zm_yunjian', 'zm_yunxi', 
    'zm_yunxia', 'zm_yunyang'
  ];

  static populate(appState) {
    try {
      elements.voiceSelect.innerHTML = "";
      
      this.availableVoices.forEach(voice => {
        const opt = document.createElement("option");
        opt.value = voice;
        opt.textContent = this.getDisplayName(voice);
        elements.voiceSelect.appendChild(opt);
      });
      
      const settings = appState.getState().settings;
      if (settings.voiceIndex && elements.voiceSelect.options[settings.voiceIndex]) {
        elements.voiceSelect.selectedIndex = settings.voiceIndex;
      }
      
      appState.setState({ availableVoices: this.availableVoices });
      statusManager.setStatus("Voices loaded", 'success', 2000);
    } catch (error) {
      console.error('Failed to populate voices:', error);
      elements.voiceSelect.innerHTML = `<option value="">Failed to load voices</option>`;
      statusManager.setStatus("Failed to load voices", 'error', 3000);
    }
  }

  static getDisplayName(voice) {
    const prefixMap = {
      'af_': 'Female',
      'am_': 'Male', 
      'bf_': 'British Female',
      'bm_': 'British Male',
      'ef_': 'European Female',
      'em_': 'European Male',
      'ff_': 'French Female',
      'hf_': 'Hindi Female',
      'hm_': 'Hindi Male',
      'if_': 'Italian Female',
      'im_': 'Italian Male',
      'jf_': 'Japanese Female',
      'jm_': 'Japanese Male',
      'pf_': 'Portuguese Female',
      'pm_': 'Portuguese Male',
      'zf_': 'Chinese Female',
      'zm_': 'Chinese Male'
    };

    for (const [prefix, suffix] of Object.entries(prefixMap)) {
      if (voice.startsWith(prefix)) {
        return `${voice.replace(prefix, '').toUpperCase()} (${suffix})`;
      }
    }
    
    return voice.toUpperCase();
  }
}

// API Management
class ApiManager {
  static async fetchCurrentModel(appState) {
    const state = appState.getState();
    const currentApiUrl = state.currentApiUrl;
    
    if (!currentApiUrl) {
      elements.modelText.textContent = 'API endpoint non configurato';
      return;
    }

    elements.modelText.innerHTML = '<div class="spinner"></div>Caricamento...';
    
    try {
      const result = await ErrorHandler.withRetry(async () => {
        const urlObj = new URL(currentApiUrl);
        urlObj.pathname = "/v1/models";
        urlObj.search = "";
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONFIG.SERVICE_TIMEOUT);
        
        try {
          const response = await fetch(urlObj.toString(), {
            signal: controller.signal,
            method: 'GET'
          });
          
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
          
          return await response.json();
        } finally {
          clearTimeout(timeout);
        }
      }, 2);

      if (result.data?.length > 0) {
        const models = result.data.map(m => m.id);
        const savedModel = appState.getState().currentModel;
        const activeModel = (savedModel && models.includes(savedModel)) ? savedModel : models[0];
        appState.setState({ availableModels: models, currentModel: activeModel });
        elements.modelText.textContent = activeModel;
        ModelDropdown.populate(models, activeModel);
      } else {
        elements.modelText.textContent = "non disponibile";
      }
    } catch (error) {
      const errorMsg = ErrorHandler.getErrorMessage(error);
      elements.modelText.textContent = `Errore: ${errorMsg}`;
      console.error('Model fetch error:', error);
    }
  }

  static async sendMessage(userMessage, appState, onChunk) {
    const state = appState.getState();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT);

    // Store controller so Stop button can abort the stream
    ApiManager._currentController = controller;

    try {
      const messages = [];

      const systemPrompt = elements.systemPromptTextarea.value.trim();
      if (systemPrompt) {
        messages.push({
          role: "system",
          content: InputValidator.sanitizeInput(systemPrompt)
        });
      }

      const recentHistory = state.conversationHistory.slice(-state.maxContextMessages);
      messages.push(...recentHistory);

      messages.push({
        role: "user",
        content: InputValidator.sanitizeInput(userMessage)
      });

      const response = await fetch(state.currentApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream"
        },
        body: JSON.stringify({
          model: state.currentModel || "local-model",
          messages: messages,
          stream: true,
          max_tokens: 2048,
          temperature: 0.7
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`API Error ${response.status}: ${errorText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let usage = null;
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep the last (possibly incomplete) line in the buffer
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') break;

          try {
            const parsed = JSON.parse(data);

            // Capture usage if the server sends it (some send it on the last chunk)
            if (parsed.usage) usage = parsed.usage;

            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              if (typeof onChunk === 'function') onChunk(delta, fullText);
            }
          } catch {
            // Malformed chunk — skip
          }
        }

        // Check if the caller requested cancellation
        const currentState = appState.getState();
        if (currentState.audioIsStopped) break;
      }

      // Save history
      const newHistory = [...state.conversationHistory];
      newHistory.push({ role: "user", content: InputValidator.sanitizeInput(userMessage) });
      newHistory.push({ role: "assistant", content: fullText });
      const trimmedHistory = newHistory.slice(-state.maxContextMessages);
      appState.setState({ conversationHistory: trimmedHistory });

      try {
        localStorage.setItem("conversationHistory", JSON.stringify(trimmedHistory));
      } catch (error) {
        console.warn('Failed to save conversation history:', error);
      }

      // Estimate token count if the API didn't return usage
      if (!usage) {
        const estimatedPromptTokens = messages.reduce((acc, m) =>
          acc + Math.ceil((m.content || '').length / 4), 0);
        const estimatedCompletionTokens = Math.ceil(fullText.length / 4);
        usage = {
          prompt_tokens: estimatedPromptTokens,
          completion_tokens: estimatedCompletionTokens,
          total_tokens: estimatedPromptTokens + estimatedCompletionTokens,
          estimated: true
        };
      }

      return { text: fullText, usage };

    } finally {
      clearTimeout(timeout);
      ApiManager._currentController = null;
    }
  }

  static abortCurrent() {
    if (ApiManager._currentController) {
      ApiManager._currentController.abort();
      ApiManager._currentController = null;
    }
  }
}

// TTS Management
class TTSManager {
  static async connect(appState) {
    const state = appState.getState();
    
    if (!state.currentTtsUrl) {
      throw new Error('No TTS URL configured');
    }
    
    statusManager.setLoadingStatus("Connecting to TTS API...");
    
    try {
      const client = await ErrorHandler.withRetry(async () => {
        return await Client.connect(state.currentTtsUrl);
      }, 2);
      
      appState.setState({ client });
      statusManager.setStatus("Connected to TTS API", 'success', 2000);
      VoiceManager.populate(appState);
      
      return client;
    } catch (error) {
      appState.setState({ client: null });
      const errorMsg = ErrorHandler.getErrorMessage(error);
      statusManager.setStatus(`TTS connection failed: ${errorMsg}`, 'error', 5000);
      VoiceManager.populate(appState);
      throw error;
    }
  }

  static async generateSpeech(text, appState) {
    const state = appState.getState();
    
    if (!state.client) {
      throw new Error("TTS client is not connected");
    }
    
    const chosenVoice = elements.voiceSelect.value || "af_alloy";
    const format = elements.formatSelect.value || "wav";
    const speed = parseFloat(elements.speedRange.value);

    statusManager.setLoadingStatus("Generating TTS audio...");
    
    try {
      const result = await ErrorHandler.withRetry(async () => {
        return await state.client.predict("/generate_tts_with_logs", {
          voice_name: chosenVoice,
          text: InputValidator.sanitizeInput(text),
          format: format,
          speed: speed
        });
      }, 2);

      const audioData = result.data[0];
      let audioUrl;
      
      if (typeof audioData === 'string') {
        audioUrl = audioData;
      } else if (audioData?.url) {
        audioUrl = audioData.url;
      } else if (audioData?.path) {
        audioUrl = audioData.path;
      } else {
        throw new Error("No audio URL found in TTS response");
      }

      return audioUrl;
      
    } catch (error) {
      const errorMsg = ErrorHandler.getErrorMessage(error);
      statusManager.setStatus(`TTS generation failed: ${errorMsg}`, 'error', 5000);
      throw error;
    }
  }
}

// Audio Management
class AudioManager {
  static async playAudio(audioUrl, appState) {
    const state = appState.getState();
    
    this.stopCurrentAudio(appState);

    const audioEl = new Audio();
    audioEl.volume = parseFloat(elements.volumeRange.value);
    audioEl.preload = 'auto';
    
    memoryManager.trackAudio(audioEl);
    appState.setState({ 
      currentAudio: audioEl,
      audioIsStopped: false
    });

    return new Promise((resolve, reject) => {
      let hasStarted = false;
      let isResolved = false;
      let cancellationChecker = null;
      
      const resolveOnce = (reason = 'completed') => {
        if (!isResolved) {
          isResolved = true;
          if (cancellationChecker) {
            clearInterval(cancellationChecker);
          }
          console.log(`AudioManager: Audio promise resolved - ${reason}`);
          resolve();
        }
      };
      
      const rejectOnce = (error) => {
        if (!isResolved) {
          isResolved = true;
          if (cancellationChecker) {
            clearInterval(cancellationChecker);
          }
          console.log('AudioManager: Audio promise rejected -', error.message);
          reject(error);
        }
      };
      
      const cleanup = () => {
        audioEl.onloadstart = null;
        audioEl.oncanplay = null;
        audioEl.onended = null;
        audioEl.onerror = null;
        audioEl.onabort = null;
        audioEl.onpause = null;
      };

      const checkCancellation = () => {
        const currentState = appState.getState();
        if (currentState.audioIsStopped && !isResolved) {
          console.log('AudioManager: Audio cancelled during playback');
          cleanup();
          resolveOnce('cancelled');
          return true;
        }
        return false;
      };

      audioEl.onloadstart = () => {
        if (checkCancellation()) return;
        statusManager.setLoadingStatus("Loading audio...");
      };

      audioEl.oncanplay = () => {
        if (checkCancellation()) return;
        
        if (!hasStarted) {
          hasStarted = true;
          statusManager.setStatus("Playing audio...", 'info');
          appState.setState({ isSpeakingOrLoading: true });
          
          audioEl.play().then(() => {
            if (checkCancellation()) return;
          }).catch((playError) => {
            console.error('Audio play error:', playError);
            rejectOnce(playError);
          });
        }
      };

      audioEl.onended = () => {
        cleanup();
        const currentState = appState.getState();
        if (!currentState.audioIsStopped && !isResolved) {
          appState.setState({ 
            isSpeakingOrLoading: false,
            currentAudio: null 
          });
          statusManager.setStatus("Audio playback completed", 'success', 2000);
        }
        memoryManager.cleanupAudio(audioEl);
        
        if (audioUrl.startsWith("blob:")) {
          memoryManager.cleanupBlobUrl(audioUrl);
        }
        
        resolveOnce('ended');
      };

      audioEl.onerror = (e) => {
        cleanup();
        appState.setState({ 
          isSpeakingOrLoading: false,
          currentAudio: null 
        });
        statusManager.setStatus("Audio playback error", 'error', 3000);
        memoryManager.cleanupAudio(audioEl);
        
        if (audioUrl.startsWith("blob:")) {
          memoryManager.cleanupBlobUrl(audioUrl);
        }
        
        rejectOnce(new Error('Audio playback failed'));
      };

      audioEl.onabort = () => {
        cleanup();
        resolveOnce('aborted');
      };

      audioEl.onpause = () => {
        const currentState = appState.getState();
        if (currentState.audioIsStopped) {
          cleanup();
          resolveOnce('paused-stopped');
        }
      };

      cancellationChecker = setInterval(() => {
        if (checkCancellation()) {
          // resolved via checkCancellation
        }
      }, 100);

      audioEl.src = audioUrl;
      audioEl.load();
    });
  }

  static stopCurrentAudio(appState) {
    const state = appState.getState();
    
    appState.setState({ 
      audioIsStopped: true,
      isSpeakingOrLoading: false
    });
    
    if (state.currentAudio) {
      try {
        state.currentAudio.pause();
        state.currentAudio.currentTime = 0;
        
        const oldSrc = state.currentAudio.src;
        state.currentAudio.src = '';
        state.currentAudio.load();
        
        if (oldSrc?.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(oldSrc);
          } catch (e) {
            console.warn('Error revoking blob URL:', e);
          }
        }
        
      } catch (e) {
        console.warn('Error stopping audio:', e);
      }
      
      memoryManager.cleanupAudio(state.currentAudio);
    }
    
    appState.setState({ 
      currentAudio: null,
      isSpeakingOrLoading: false
    });
    
    statusManager.setStatus("Audio stopped", 'info', 2000);
  }
}

// UI State Management
class UIManager {
  static updateSendButtonState(appState) {
    const state = appState.getState();
    const hasText = elements.promptInput.value.trim().length > 0;
    const hasApiUrl = !!state.currentApiUrl;
    const hasTtsUrl = !!state.currentTtsUrl;
    const isVoskListening = state.voiceRecognition.isListening || state.voiceRecognition.isProcessing;
    
    const audioEnabled = window.audioEnabled !== false;
    const shouldDisableSend = state.isSpeakingOrLoading || 
                             isSendingPrompt || 
                             !hasApiUrl || 
                             (audioEnabled && !hasTtsUrl) || 
                             (!hasText && !isVoskListening);
    
    const shouldDisableStop = !state.isSpeakingOrLoading && 
                             !isVoskListening && 
                             !isSendingPrompt;

    elements.sendBtn.disabled = shouldDisableSend;
    elements.stopBtn.disabled = shouldDisableStop;
    
    elements.voiceBtn.disabled = !state.voiceRecognition.isSupported || 
                                !state.voiceRecognition.voskModelLoaded ||
                                isSendingPrompt;
    elements.voiceBtn.title = elements.voiceBtn.disabled ? (
      !state.voiceRecognition.isSupported ? 'Vosk not supported' :
      !state.voiceRecognition.voskModelLoaded ? 'Vosk model not loaded' :
      'Processing in progress'
    ) : 'Hold to record voice';

    if (isSendingPrompt) {
      elements.sendBtn.setAttribute('aria-label', 'Sending message...');
    } else if (state.isSpeakingOrLoading) {
      elements.sendBtn.setAttribute('aria-label', 'Processing... Use stop button to cancel');
    } else if (!hasApiUrl || (audioEnabled && !hasTtsUrl)) {
      elements.sendBtn.setAttribute('aria-label', audioEnabled && !hasTtsUrl ? 'Configure TTS endpoint or disable audio' : 'Configure API endpoint first');
    } else if (!hasText && !isVoskListening) {
      elements.sendBtn.setAttribute('aria-label', 'Enter a message or start voice input to send');
    } else {
      elements.sendBtn.setAttribute('aria-label', 'Send message');
    }
    
    if (!elements.stopBtn.disabled) {
      elements.stopBtn.setAttribute('aria-label', 'Stop current audio playback or voice input');
    } else {
      elements.stopBtn.setAttribute('aria-label', 'No audio or voice input active');
    }

    elements.promptInput.disabled = isVoskListening;
    if (isVoskListening) {
      elements.promptInput.placeholder = "Listening...";
    } else if (isSendingPrompt) {
      elements.promptInput.placeholder = "Processing...";
    } else if (elements.promptInput.value === "") {
      elements.promptInput.placeholder = "Type your prompt or use voice input...";
    }
  }

  static showButtonLoading(button, originalContent) {
    button.innerHTML = `<div class="spinner"></div>${originalContent}`;
    button.disabled = true;
  }

  static hideButtonLoading(button, originalContent) {
    button.innerHTML = originalContent;
    button.disabled = false;
  }
}

// Global flag to prevent double-execution
let isSendingPrompt = false;

// Main Application Logic
async function sendPrompt(transcribedText = null) {
  if (isSendingPrompt) {
    console.warn('sendPrompt: Already sending a prompt, ignoring new request.');
    return;
  }

  isSendingPrompt = true;
  console.log('sendPrompt: Starting, isSendingPrompt set to true');

  const state = appState.getState();
  const prompt = transcribedText?.trim() || elements.promptInput.value.trim();

  if (!prompt || !state.currentApiUrl) {
    console.log('sendPrompt: No prompt or API URL, resetting state');
    isSendingPrompt = false;
    
    if (state.voiceRecognition.isListening || state.voiceRecognition.isProcessing) {
      appState.setState({ 
        voiceRecognition: { 
          ...state.voiceRecognition, 
          isListening: false, 
          isProcessing: false 
        } 
      });
      UIManager.updateSendButtonState(appState);
      statusManager.setStatus('No speech detected or empty transcription.', 'warning', 3000);
    }
    return;
  }

  appState.setState({
    isSpeakingOrLoading: true,
    audioIsStopped: false
  });
  UIManager.updateSendButtonState(appState);

  ChatManager.createMessageElement("user", prompt);
  const typingBubble = ChatManager.createMessageElement("assistant", "", true);
  ChatManager.save();

  try {
    statusManager.setLoadingStatus("Getting AI response...");

    // Keep typing indicator until response is complete
    let assistantResponse = '';

    const { text, usage } = await ApiManager.sendMessage(prompt, appState, (delta, fullText) => {
      assistantResponse = fullText;
    });

    // Remove typing indicator and show full response at once
    typingBubble.classList.remove("typing-indicator");
    typingBubble.removeAttribute('aria-label');
    typingBubble.textContent = assistantResponse;
    ChatManager.scrollToBottom();

    // Update token counter
    TokenCounter.update(usage);

    const currentState = appState.getState();
    if (currentState.audioIsStopped) {
      console.log('sendPrompt: Operation cancelled, cleaning up');
      if (!assistantResponse) typingBubble.closest('.message')?.remove();
      return;
    }

    typingBubble.textContent = assistantResponse;
    ChatManager.scrollToBottom();

    elements.promptInput.value = '';
    elements.promptInput.focus();
    try {
      sessionStorage.removeItem('promptDraft');
    } catch (e) {
      console.warn('Error clearing prompt draft:', e);
    }

    if (window.audioEnabled === false) {
      // Audio is disabled — skip TTS/playback entirely
      statusManager.setStatus("Response received", 'success', 2000);
    } else {
      statusManager.setStatus("Response received, generating speech...", 'info');

      try {
        const currentState2 = appState.getState();
        if (currentState2.audioIsStopped) {
          console.log('sendPrompt: TTS cancelled before generation');
          return;
        }

        const audioUrl = await TTSManager.generateSpeech(assistantResponse, appState);

        const currentState3 = appState.getState();
        if (currentState3.audioIsStopped) {
          console.log('sendPrompt: Audio cancelled before playback');
          return;
        }

        await AudioManager.playAudio(audioUrl, appState);
        
      } catch (ttsError) {
        console.error('TTS Error:', ttsError);
        const errorMsg = ErrorHandler.getErrorMessage(ttsError);
        statusManager.setStatus(`TTS failed: ${errorMsg}`, 'error', 5000);
      }
    }

    ChatManager.save();

  } catch (error) {
    console.error('Send prompt error:', error);
    const errorMsg = ErrorHandler.getErrorMessage(error);

    const typingBubbles = document.querySelectorAll('.bubble.typing-indicator');
    typingBubbles.forEach(bubble => bubble.remove());
    
    ChatManager.createMessageElement("assistant", `Error: ${errorMsg}`);
    statusManager.setStatus(`Error: ${errorMsg}`, 'error', 5000);

  } finally {
    console.log('sendPrompt: Cleaning up, resetting isSendingPrompt to false');
    appState.setState({ isSpeakingOrLoading: false });
    isSendingPrompt = false;
    UIManager.updateSendButtonState(appState);
    elements.promptInput.focus();
  }
}

// Event Handlers Setup
function setupEventHandlers() {
  elements.sendBtn.addEventListener('click', (e) => {
    e.preventDefault();
    console.log('Send button clicked, isSendingPrompt:', isSendingPrompt);
    
    const state = appState.getState();
    if (!isSendingPrompt && !state.isSpeakingOrLoading && !state.voiceRecognition.isListening) {
      sendPrompt();
    }
  });

  elements.stopBtn.addEventListener('click', () => {
    console.log('Stop button clicked');
    ApiManager.abortCurrent();
    AudioManager.stopCurrentAudio(appState);
    
    const state = appState.getState();
    if (state.voiceRecognition.isListening || state.voiceRecognition.isProcessing) {
      audioInputProcessor.stop();
      elements.voiceBtn.classList.remove('active');
      elements.voiceBtn.textContent = '🎤';
      appState.setState({ 
        voiceRecognition: { 
          ...state.voiceRecognition, 
          isListening: false, 
          isProcessing: false 
        } 
      });
      statusManager.setStatus('Voice input stopped', 'info', 2000);
    }
    
    if (isSendingPrompt) {
      console.log('Stop: Cancelling ongoing send operation');
      appState.setState({ 
        audioIsStopped: true,
        isSpeakingOrLoading: false 
      });
    }
    
    UIManager.updateSendButtonState(appState);
  });

  elements.clearBtn.addEventListener('click', () => {
    ChatManager.clear();
  });

  elements.saveApiBtn.addEventListener('click', async () => {
    const url = elements.apiUrlInput.value.trim();
    
    if (!InputValidator.validateUrl(url)) {
      statusManager.setStatus('Invalid API URL format', 'error', 3000);
      return;
    }
    
    const originalContent = elements.saveApiBtn.innerHTML;
    UIManager.showButtonLoading(elements.saveApiBtn, 'Saving...');
    
    try {
      appState.setState({ currentApiUrl: url });
      SettingsManager.save(appState);
      statusManager.setStatus('API endpoint saved', 'success', 2000);
      await ApiManager.fetchCurrentModel(appState);
    } catch (error) {
      console.error('Save API error:', error);
      statusManager.setStatus('Failed to save API endpoint', 'error', 3000);
    } finally {
      UIManager.hideButtonLoading(elements.saveApiBtn, originalContent);
      UIManager.updateSendButtonState(appState);
    }
  });

  elements.saveTtsBtn.addEventListener('click', async () => {
    const url = elements.ttsUrlInput.value.trim();
    
    if (!InputValidator.validateUrl(url)) {
      statusManager.setStatus('Invalid TTS URL format', 'error', 3000);
      return;
    }
    
    const originalContent = elements.saveTtsBtn.innerHTML;
    UIManager.showButtonLoading(elements.saveTtsBtn, 'Connecting...');
    
    try {
      appState.setState({ currentTtsUrl: url });
      SettingsManager.save(appState);
      await TTSManager.connect(appState);
      statusManager.setStatus('TTS endpoint saved and connected', 'success', 2000);
    } catch (error) {
      console.error('Save TTS error:', error);
      const errorMsg = ErrorHandler.getErrorMessage(error);
      statusManager.setStatus(`Failed to connect to TTS: ${errorMsg}`, 'error', 5000);
    } finally {
      UIManager.hideButtonLoading(elements.saveTtsBtn, originalContent);
      UIManager.updateSendButtonState(appState);
    }
  });

  elements.saveSystemPromptBtn.addEventListener('click', () => {
    SettingsManager.save(appState);
    statusManager.setStatus('System prompt saved', 'success', 2000);
  });

  elements.saveVoskModelBtn.addEventListener('click', async () => {
    const url = elements.voskModelUrlInput.value.trim();

    if (!InputValidator.validateUrl(url)) {
      statusManager.setStatus('Invalid Vosk Model URL format', 'error', 3000);
      return;
    }

    const originalContent = elements.saveVoskModelBtn.innerHTML;
    UIManager.showButtonLoading(elements.saveVoskModelBtn, 'Loading...');

    try {
      appState.setState({ voskModelUrl: url });
      SettingsManager.save(appState);
      await voiceRecognitionManager.initVosk();
      statusManager.setStatus('Vosk Model URL saved', 'success', 2000);
    } catch (error) {
      console.error('Save Vosk Model URL error:', error);
      const errorMsg = ErrorHandler.getErrorMessage(error);
      statusManager.setStatus(`Failed to save Vosk Model URL: ${errorMsg}`, 'error', 5000);
    } finally {
      UIManager.hideButtonLoading(elements.saveVoskModelBtn, originalContent);
      UIManager.updateSendButtonState(appState);
    }
  });

  let inputTimeout;
  elements.promptInput.addEventListener('input', () => {
    clearTimeout(inputTimeout);
    inputTimeout = setTimeout(() => {
      UIManager.updateSendButtonState(appState);
      try {
        sessionStorage.setItem('promptDraft', elements.promptInput.value);
      } catch (e) {
        // Ignore sessionStorage errors
      }
    }, 100);
  });

  elements.speedRange.addEventListener('input', () => {
    document.getElementById("speedVal").textContent = elements.speedRange.value;
    SettingsManager.save(appState);
  });

  elements.volumeRange.addEventListener('input', () => {
    document.getElementById("volumeVal").textContent = elements.volumeRange.value;
    const state = appState.getState();
    if (state.currentAudio) {
      state.currentAudio.volume = parseFloat(elements.volumeRange.value);
    }
    SettingsManager.save(appState);
  });

  elements.voiceSelect.addEventListener('change', () => {
    SettingsManager.save(appState);
  });

  elements.formatSelect.addEventListener('change', () => {
    SettingsManager.save(appState);
  });

  ['sttLanguage', 'continuousListening', 'interimResults'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      SettingsManager.save(appState);
    });
  });

  elements.themeBtn.addEventListener('click', () => {
    document.body.classList.toggle("light");
    SettingsManager.save(appState);
    statusManager.setStatus('Theme updated', 'success', 1000);
  });

  // Model dropdown toggle
  elements.currentModelBox.addEventListener('click', (e) => {
    e.stopPropagation();
    if (ModelDropdown._switching) return;
    ModelDropdown.toggle();
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('modelDropdownWrap');
    if (wrap && !wrap.contains(e.target)) {
      ModelDropdown.close();
    }
  });

  elements.promptInput.addEventListener('keydown', (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      
      const state = appState.getState();
      if (!isSendingPrompt && 
          !state.isSpeakingOrLoading && 
          !state.voiceRecognition.isListening && 
          !state.voiceRecognition.isProcessing) {
        sendPrompt();
      }
    }
  });

  setupVoiceInput();

  appState.subscribe(() => {
    UIManager.updateSendButtonState(appState);
    updateVoskStatusDot();
  });
}

function setupVoiceInput() {
  let holdTimeout;
  let isRecording = false;

  const startRecording = async () => {
    const state = appState.getState();
    if (isRecording || !state.voiceRecognition.voskModelLoaded || isSendingPrompt) {
      if (!state.voiceRecognition.voskModelLoaded) {
        statusManager.setStatus('Vosk model not loaded yet. Please wait.', 'warning', 3000);
      } else if (isSendingPrompt) {
        statusManager.setStatus('Please wait for current operation to complete.', 'warning', 3000);
      }
      return;
    }

    isRecording = true;
    elements.voiceBtn.classList.add('active');
    elements.voiceBtn.textContent = '🛑';
    statusManager.setLoadingStatus('Listening...');
    
    appState.setState({ 
      voiceRecognition: { 
        ...state.voiceRecognition, 
        isListening: true, 
        isProcessing: true 
      } 
    });
    
    elements.promptInput.value = '';
    elements.promptInput.focus();
    try {
      sessionStorage.removeItem('promptDraft');
    } catch (e) {
      console.warn('Error clearing prompt draft:', e);
    }
    
    UIManager.updateSendButtonState(appState);

    try {
      const recognizerStarted = voiceRecognitionManager.startNewRecognition();
      if (!recognizerStarted) {
        throw new Error("Failed to start Vosk recognizer.");
      }
      await audioInputProcessor.start();
    } catch (error) {
      console.error('Error starting audio input or Vosk recognizer:', error);
      appState.setState({ 
        voiceRecognition: { 
          ...appState.getState().voiceRecognition, 
          isListening: false, 
          isProcessing: false 
        } 
      });
      statusManager.setStatus('Microphone or Vosk error: ' + ErrorHandler.getErrorMessage(error), 'error', 5000);
      isRecording = false;
      elements.voiceBtn.classList.remove('active');
      elements.voiceBtn.textContent = '🎤';
    }
  };

  const stopRecording = () => {
    if (!isRecording) return;
    
    isRecording = false;
    elements.voiceBtn.classList.remove('active');
    elements.voiceBtn.textContent = '🎤';
    audioInputProcessor.stop();
    voiceRecognitionManager.stopCurrentRecognition();

    const state = appState.getState();
    appState.setState({ 
      voiceRecognition: { 
        ...state.voiceRecognition, 
        isListening: false, 
        isProcessing: false 
      } 
    });
    
    UIManager.updateSendButtonState(appState);
    statusManager.clearStatus();
  };

  elements.voiceBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const state = appState.getState();
    if (state.voiceRecognition.voskModelLoaded && !state.voiceRecognition.isListening && !state.voiceRecognition.isProcessing && !isSendingPrompt) {
      holdTimeout = setTimeout(startRecording, 200);
    }
  });

  elements.voiceBtn.addEventListener('mouseup', () => {
    clearTimeout(holdTimeout);
    if (isRecording) {
      stopRecording();
    }
  });

  elements.voiceBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const state = appState.getState();
    if (state.voiceRecognition.voskModelLoaded && !state.voiceRecognition.isListening && !state.voiceRecognition.isProcessing && !isSendingPrompt) {
      holdTimeout = setTimeout(startRecording, 200);
    }
  }, { passive: false });

  elements.voiceBtn.addEventListener('touchend', () => {
    clearTimeout(holdTimeout);
    if (isRecording) {
      stopRecording();
    }
  });

  document.addEventListener('keydown', (e) => {
    const state = appState.getState();
    if (e.key === 'Control' && !isRecording && !elements.voiceBtn.disabled && !isSendingPrompt) {
      e.preventDefault();
      startRecording();
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Control' && isRecording) {
      e.preventDefault();
      stopRecording();
    }
  });
}

function updateVoskStatusDot() {
  const voskStatusDot = document.getElementById('voskStatus');
  if (voskStatusDot) {
    const state = appState.getState();
    if (state.voiceRecognition.voskModelLoaded) {
      voskStatusDot.className = 'status-dot healthy';
    } else if (state.voiceRecognition.isSupported) {
      voskStatusDot.className = 'status-dot unhealthy';
    } else {
      voskStatusDot.className = 'status-dot';
    }
  }
}

// Model Dropdown Manager
class ModelDropdown {
  static _open = false;
  static _switching = false;

  static populate(models, activeModel) {
    const dropdown = document.getElementById('modelDropdown');
    if (!dropdown) return;
    dropdown.innerHTML = '';
    models.forEach(id => {
      const item = document.createElement('button');
      item.className = 'model-dropdown-item' + (id === activeModel ? ' active' : '');
      item.title = id;
      item.innerHTML = `<span class="mdi-label">${id}</span>`;
      if (id === activeModel) {
        item.innerHTML += `<span class="mdi-check">✓</span>`;
      }
      item.addEventListener('click', () => {
        if (this._switching) return;
        if (id === appState.getState().currentModel) {
          this.close();
          return;
        }
        this.close();
        this.switchModel(id);
      });
      dropdown.appendChild(item);
    });
  }

  static async switchModel(newModelId) {
    if (this._switching) return;
    this._switching = true;

    const state = appState.getState();
    const oldModelId = state.currentModel;

    // Derive base URL from the configured API endpoint
    let baseUrl;
    try {
      const u = new URL(state.currentApiUrl);
      baseUrl = `${u.protocol}//${u.host}`;
    } catch {
      statusManager.setStatus('URL API non valido', 'error', 3000);
      this._switching = false;
      return;
    }

    // Show loading overlay
    ModelProgress.show(oldModelId, newModelId);
    elements.currentModelBox.classList.add('switching');

    try {
      // 1. Unload current model (get instance_id first from v0 models list)
      if (oldModelId) {
        ModelProgress.setPhase('unload', oldModelId);
        let instanceId = oldModelId;
        try {
          const modelsRes = await fetch(`${baseUrl}/api/v0/models`, { method: 'GET' });
          if (modelsRes.ok) {
            const modelsData = await modelsRes.json();
            const loaded = modelsData.data?.find(m => m.id === oldModelId && m.state === 'loaded');
            if (loaded?.instance_id) instanceId = loaded.instance_id;
          }
        } catch { /* use model id as fallback */ }

        try {
          await fetch(`${baseUrl}/api/v1/models/unload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instance_id: instanceId })
          });
        } catch (e) {
          console.warn('Unload failed (continuing anyway):', e);
        }
        ModelProgress.setPhase('unloaded', oldModelId);
        await new Promise(r => setTimeout(r, 300));
      }

      // 2. Load new model — this call is synchronous (blocks until loaded)
      // Poll /api/v0/models in parallel to show state changes
      ModelProgress.setPhase('load', newModelId);
      const loadStart = Date.now();

      // Start polling for visual feedback
      const pollStop = ModelProgress.startPolling(baseUrl, newModelId, loadStart);

      // Fire the actual load request
      const loadRes = await fetch(`${baseUrl}/api/v1/models/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: newModelId })
      });

      pollStop();

      if (!loadRes.ok) {
        const errText = await loadRes.text().catch(() => '');
        throw new Error(`Load HTTP ${loadRes.status}: ${errText}`);
      }

      const loadData = await loadRes.json();
      const loadSec = loadData.load_time_seconds
        ? `${loadData.load_time_seconds.toFixed(1)}s`
        : `${((Date.now() - loadStart) / 1000).toFixed(1)}s`;

      // 3. Update state & UI
      appState.setState({ currentModel: newModelId });
      elements.modelText.textContent = newModelId;
      const topbarModel = document.getElementById('topbarModel');
      if (topbarModel) topbarModel.textContent = newModelId;

      // Refresh model list to get updated states
      await ApiManager.fetchCurrentModel(appState);

      ModelProgress.setPhase('done', newModelId, loadSec);
      await new Promise(r => setTimeout(r, 1200));
      ModelProgress.hide();
      statusManager.setStatus(`Model loaded in ${loadSec}`, 'success', 3000);

    } catch (err) {
      console.error('Model switch error:', err);
      ModelProgress.setPhase('error', newModelId, err.message);
      await new Promise(r => setTimeout(r, 2500));
      ModelProgress.hide();
      statusManager.setStatus(`Loading Error: ${err.message}`, 'error', 5000);
      // Restore old model in UI
      elements.modelText.textContent = oldModelId || 'Errore';
    } finally {
      this._switching = false;
      elements.currentModelBox.classList.remove('switching');
    }
  }

  static toggle() {
    if (this._switching) return;
    const wrap = document.getElementById('modelDropdownWrap');
    if (!wrap) return;
    this._open ? this.close() : this.open();
  }

  static open() {
    const wrap = document.getElementById('modelDropdownWrap');
    if (!wrap) return;
    wrap.classList.add('open');
    this._open = true;
    const state = appState.getState();
    if (state.availableModels.length > 0) {
      this.populate(state.availableModels, state.currentModel);
    }
  }

  static close() {
    const wrap = document.getElementById('modelDropdownWrap');
    if (!wrap) return;
    wrap.classList.remove('open');
    this._open = false;
  }
}

// Model Load Progress Overlay
class ModelProgress {
  static _pollInterval = null;

  static show(oldModel, newModel) {
    let overlay = document.getElementById('modelProgressOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'modelProgressOverlay';
      overlay.className = 'model-progress-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="model-progress-card">
        <div class="mp-header">
          <div class="mp-spinner"></div>
          <span class="mp-title">Changing Model</span>
        </div>
        <div class="mp-steps">
          <div class="mp-step unload-step" id="mpStepUnload">
            <div class="mp-step-dot"></div>
            <div class="mp-step-body">
              <div class="mp-step-label">Unload</div>
              <div class="mp-step-detail" id="mpDetailUnload">${oldModel || '—'}</div>
            </div>
          </div>
          <div class="mp-step" id="mpStepLoad">
            <div class="mp-step-dot"></div>
            <div class="mp-step-body">
              <div class="mp-step-label">Load</div>
              <div class="mp-step-detail" id="mpDetailLoad">${newModel}</div>
            </div>
          </div>
        </div>
        <div class="mp-status" id="mpStatus">Preparing...</div>
        <div class="mp-bar-wrap"><div class="mp-bar" id="mpBar"></div></div>
        <div class="mp-elapsed" id="mpElapsed"></div>
      </div>`;
    overlay.classList.add('visible');
  }

  static hide() {
    const overlay = document.getElementById('modelProgressOverlay');
    if (overlay) {
      overlay.classList.remove('visible');
      setTimeout(() => overlay.remove(), 300);
    }
  }

  static setPhase(phase, modelId, extra = '') {
    const statusEl = document.getElementById('mpStatus');
    const barEl = document.getElementById('mpBar');
    const stepUnload = document.getElementById('mpStepUnload');
    const stepLoad = document.getElementById('mpStepLoad');

    const setStep = (el, state) => {
      if (!el) return;
      el.className = 'mp-step ' + state;
    };

    switch (phase) {
      case 'unload':
        if (statusEl) statusEl.textContent = `Unloading ${modelId}...`;
        if (barEl) barEl.style.width = '15%';
        setStep(stepUnload, 'active');
        setStep(stepLoad, '');
        break;
      case 'unloaded':
        if (statusEl) statusEl.textContent = 'Model Unloaded';
        if (barEl) barEl.style.width = '30%';
        setStep(stepUnload, 'done');
        break;
      case 'load':
        if (statusEl) statusEl.textContent = `Loading ${modelId}...`;
        if (barEl) barEl.style.width = '35%';
        setStep(stepUnload, 'done');
        setStep(stepLoad, 'active');
        break;
      case 'done':
        if (statusEl) statusEl.textContent = `Ready in ${extra}`;
        if (barEl) barEl.style.width = '100%';
        setStep(stepUnload, 'done');
        setStep(stepLoad, 'done');
        const header = document.querySelector('.mp-header .mp-spinner');
        if (header) {
          header.outerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
        }
        break;
      case 'error':
        if (statusEl) { statusEl.textContent = `Errore: ${extra}`; statusEl.style.color = 'var(--error)'; }
        if (barEl) { barEl.style.width = '100%'; barEl.style.background = 'var(--error)'; }
        break;
    }
  }

  static startPolling(baseUrl, modelId, startTime) {
    let lastState = '';
    const elapsedEl = document.getElementById('mpElapsed');
    const barEl = document.getElementById('mpBar');

    // Elapsed timer
    const timerInterval = setInterval(() => {
      const sec = ((Date.now() - startTime) / 1000).toFixed(1);
      if (elapsedEl) elapsedEl.textContent = `${sec}s`;
    }, 200);

    // Pulse bar animation while loading (35% → 90%, never reaching 100 until done)
    let barPct = 35;
    const barInterval = setInterval(() => {
      barPct = Math.min(barPct + (90 - barPct) * 0.04, 89);
      if (barEl && barEl.style.width !== '100%') {
        barEl.style.width = barPct + '%';
      }
    }, 400);

    // Poll model state
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${baseUrl}/api/v0/models`, { method: 'GET' });
        if (!res.ok) return;
        const data = await res.json();
        const model = data.data?.find(m => m.id === modelId);
        if (model && model.state !== lastState) {
          lastState = model.state;
          const statusEl = document.getElementById('mpStatus');
          if (statusEl && model.state === 'loading') {
            statusEl.textContent = `Loading in progress (${model.state})...`;
          }
        }
      } catch { /* ignore */ }
    }, 1500);

    return () => {
      clearInterval(timerInterval);
      clearInterval(barInterval);
      clearInterval(pollInterval);
    };
  }
}

// Application Initialization
async function initializeApp() {
  try {
    statusManager.setLoadingStatus("Initializing application...");
    
    SettingsManager.load(appState);
    ChatManager.load();
    
    try {
      const draft = sessionStorage.getItem('promptDraft');
      if (draft) {
        elements.promptInput.value = draft;
      }
    } catch (e) {
      console.warn('Error accessing sessionStorage for promptDraft:', e);
    }
    
    setupEventHandlers();
    VoiceManager.populate(appState);
    UIManager.updateSendButtonState(appState);
    
    const state = appState.getState();
    if (state.currentApiUrl) {
      ApiManager.fetchCurrentModel(appState);
    }
    
    if (state.currentTtsUrl) {
      try {
        await TTSManager.connect(appState);
      } catch (error) {
        // Connection error handled in TTSManager.connect
      }
    }
    
    if (state.voiceRecognition.isSupported && state.voskModelUrl) {
      try {
        await voiceRecognitionManager.initVosk();
      } catch (error) {
        console.error('Error initializing Vosk model:', error);
      }
    }
    
    healthChecker.start();
    statusManager.setStatus('Application ready', 'success', 2000);
    
  } catch (error) {
    console.error('Initialization error:', error);
    statusManager.setStatus('Failed to initialize application', 'error', 5000);
  }
}

// Riferimenti agli elementi DOM per i Preset
const loadPresetBtn = document.getElementById('loadPresetBtn');
const presetFileInput = document.getElementById('presetFileInput');
const systemPromptTextarea = document.getElementById('systemPromptTextarea');

// Trigger della finestra di dialogo alla pressione del tasto visibile
loadPresetBtn.addEventListener('click', () => {
    presetFileInput.click();
});

// Gestione della lettura del file JSON inserito
presetFileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            
            // Estrazione del campo 'name' dal JSON
            const presetName = data?.name || "";
            
            // Navigazione all'interno della struttura del JSON fornito
            const fields = data?.operation?.fields || [];
            const systemPromptObj = fields.find(field => field.key === "llm.prediction.systemPrompt");

            if (systemPromptObj && systemPromptObj.value) {
                // Imposta il valore nella textarea
                systemPromptTextarea.value = systemPromptObj.value;
                
                // Aggiorna l'elemento del titolo nell'interfaccia
                if (elements.presetTitle) {
                    elements.presetTitle.textContent = presetName ? `(${presetName})` : "";
                }
                
                // Salva le impostazioni aggiornate in localStorage
                SettingsManager.save(appState);
                
                console.log("System Prompt caricato con successo:", systemPromptObj.value);
            } else {
                alert("Attenzione: Chiave 'llm.prediction.systemPrompt' non trovata nel preset.");
            }
        } catch (error) {
            console.error("Errore nel parsing del JSON:", error);
            alert("Errore nel caricamento del file. Assicurati che sia un JSON valido.");
        }
        
        // Reset del file input per permettere di ricaricare lo stesso file in futuro
        presetFileInput.value = '';
    };

    reader.readAsText(file);
});

// Start the application
document.addEventListener('DOMContentLoaded', initializeApp);
