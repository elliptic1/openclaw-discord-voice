/**
 * OpenAI Realtime API Bridge
 * 
 * Handles WebSocket connection to OpenAI's Realtime API for voice conversations.
 */

import WebSocket from 'ws';
import type { Logger, OpenAISessionConfig, OpenAIMessage } from './types.js';

interface RealtimeBridgeConfig {
  apiKey: string;
  model: string;
  voice: string;
  vadThreshold: number;
  systemPrompt?: string;
  logger: Logger;
  onAudioResponse: (audio: Buffer) => void;
}

export class RealtimeBridge {
  private ws: WebSocket | null = null;
  private config: RealtimeBridgeConfig;
  private logger: Logger;
  private isConnected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;

  constructor(config: RealtimeBridgeConfig) {
    this.config = config;
    this.logger = config.logger;
  }

  /**
   * Connect to OpenAI Realtime API
   */
  async connect(): Promise<void> {
    const url = `wss://api.openai.com/v1/realtime?model=${this.config.model}`;
    
    this.logger.info('Connecting to OpenAI Realtime API...');
    
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });
      
      this.ws.on('open', () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.logger.info('Connected to OpenAI Realtime API');
        
        // Configure session
        this.configureSession();
        resolve();
      });
      
      this.ws.on('message', (data) => {
        this.handleMessage(data);
      });
      
      this.ws.on('error', (err) => {
        this.logger.error('WebSocket error:', err);
        if (!this.isConnected) {
          reject(err);
        }
      });
      
      this.ws.on('close', (code, reason) => {
        this.isConnected = false;
        this.logger.info(`WebSocket closed: ${code} ${reason}`);
        
        // Attempt reconnect
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          this.logger.info(`Reconnecting (attempt ${this.reconnectAttempts})...`);
          setTimeout(() => this.connect().catch(() => {}), 1000 * this.reconnectAttempts);
        }
      });
    });
  }

  /**
   * Configure the OpenAI session
   */
  private configureSession(): void {
    const sessionConfig: OpenAISessionConfig = {
      modalities: ['text', 'audio'],
      voice: this.config.voice,
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      turn_detection: {
        type: 'server_vad',
        threshold: this.config.vadThreshold,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
    };
    
    if (this.config.systemPrompt) {
      sessionConfig.instructions = this.config.systemPrompt;
    }
    
    this.send({
      type: 'session.update',
      session: sessionConfig,
    });
    
    this.logger.debug('Session configured');
  }

  /**
   * Handle incoming messages from OpenAI
   */
  private handleMessage(data: WebSocket.RawData): void {
    try {
      const message = JSON.parse(data.toString()) as OpenAIMessage;
      
      switch (message.type) {
        case 'session.created':
          this.logger.debug('Session created');
          break;
          
        case 'session.updated':
          this.logger.debug('Session updated');
          break;
          
        case 'input_audio_buffer.speech_started':
          this.logger.debug('Speech started');
          break;
          
        case 'input_audio_buffer.speech_stopped':
          this.logger.debug('Speech stopped');
          break;
          
        case 'response.audio.delta':
          // Audio chunk from AI response
          const audioData = message.delta as string;
          if (audioData) {
            const buffer = Buffer.from(audioData, 'base64');
            this.config.onAudioResponse(buffer);
          }
          break;
          
        case 'response.audio.done':
          this.logger.debug('Audio response complete');
          break;
          
        case 'response.done':
          this.logger.debug('Response complete');
          break;
          
        case 'error':
          this.logger.error('OpenAI error:', message.error);
          break;
          
        default:
          // Ignore other message types
          break;
      }
    } catch (err) {
      this.logger.error('Failed to parse message:', err);
    }
  }

  /**
   * Send audio data to OpenAI
   */
  sendAudio(audio: Buffer): void {
    if (!this.isConnected) return;
    
    this.send({
      type: 'input_audio_buffer.append',
      audio: audio.toString('base64'),
    });
  }

  /**
   * Commit the audio buffer (signal end of speech)
   */
  commitAudio(): void {
    if (!this.isConnected) return;
    
    this.send({
      type: 'input_audio_buffer.commit',
    });
  }

  /**
   * Clear the audio buffer
   */
  clearAudio(): void {
    if (!this.isConnected) return;
    
    this.send({
      type: 'input_audio_buffer.clear',
    });
  }

  /**
   * Send a message to OpenAI
   */
  private send(message: OpenAIMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Disconnect from OpenAI
   */
  disconnect(): void {
    this.maxReconnectAttempts = 0; // Prevent reconnection
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.isConnected = false;
  }
}
