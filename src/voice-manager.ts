/**
 * Voice Connection Manager
 * 
 * Manages Discord voice connections and bridges them to OpenAI Realtime API.
 */

import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  AudioPlayer,
} from '@discordjs/voice';
import type { VoiceBasedChannel, Client } from 'discord.js';
import { RealtimeBridge } from './realtime-bridge.js';
import { AudioPipeline } from './audio-pipeline.js';
import type { VoiceManagerConfig, Logger } from './types.js';

interface GuildConnection {
  connection: VoiceConnection;
  bridge: RealtimeBridge;
  pipeline: AudioPipeline;
  player: AudioPlayer;
  channelId: string;
  channelName: string;
}

export class VoiceConnectionManager {
  private connections = new Map<string, GuildConnection>();
  private config: VoiceManagerConfig;
  private logger: Logger;

  constructor(config: VoiceManagerConfig) {
    this.config = config;
    this.logger = config.logger;
  }

  /**
   * Join a voice channel and start the AI bridge
   */
  async join(channel: VoiceBasedChannel): Promise<void> {
    const guildId = channel.guild.id;
    
    // Check connection limit
    if (this.connections.size >= this.config.maxConnections) {
      throw new Error(`Max concurrent connections (${this.config.maxConnections}) reached`);
    }
    
    // Leave existing connection in this guild
    if (this.connections.has(guildId)) {
      this.leave(guildId);
    }
    
    this.logger.info(`Joining voice channel: ${channel.name} (${channel.id})`);
    
    // Create Discord voice connection
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    
    // Wait for connection to be ready
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    } catch (err) {
      connection.destroy();
      throw new Error(`Failed to connect: ${err}`);
    }
    
    // Create audio player for responses
    const player = createAudioPlayer();
    connection.subscribe(player);
    
    // Create OpenAI Realtime bridge
    const bridge = new RealtimeBridge({
      apiKey: this.config.openaiApiKey,
      model: this.config.model,
      voice: this.config.voice,
      vadThreshold: this.config.vadThreshold,
      systemPrompt: this.config.systemPrompt,
      logger: this.logger,
      onAudioResponse: (audio: Buffer) => {
        this.playAudio(guildId, audio);
      },
    });
    
    // Create audio pipeline for format conversion
    const pipeline = new AudioPipeline({
      logger: this.logger,
      onProcessedAudio: (audio: Buffer) => {
        bridge.sendAudio(audio);
      },
    });
    
    // Store connection
    this.connections.set(guildId, {
      connection,
      bridge,
      pipeline,
      player,
      channelId: channel.id,
      channelName: channel.name,
    });
    
    // Start listening to users
    this.startListening(guildId, connection);
    
    // Connect to OpenAI
    await bridge.connect();
    
    // Handle disconnection
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Reconnecting...
      } catch {
        this.leave(guildId);
      }
    });
    
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.cleanup(guildId);
    });
  }

  /**
   * Start listening to audio from users in the voice channel
   */
  private startListening(guildId: string, connection: VoiceConnection): void {
    const gc = this.connections.get(guildId);
    if (!gc) return;
    
    const receiver = connection.receiver;
    
    // Listen for users speaking
    receiver.speaking.on('start', (userId) => {
      this.logger.debug(`User ${userId} started speaking`);
      
      // Subscribe to their audio
      const audioStream = receiver.subscribe(userId, {
        end: { behavior: 'afterSilence' as any, duration: 100 },
      });
      
      // Process audio through pipeline
      audioStream.on('data', (chunk: Buffer) => {
        gc.pipeline.processDiscordAudio(chunk);
      });
      
      audioStream.on('end', () => {
        this.logger.debug(`User ${userId} stopped speaking`);
        gc.pipeline.flush();
      });
    });
  }

  /**
   * Play audio response from OpenAI
   */
  private playAudio(guildId: string, audio: Buffer): void {
    const gc = this.connections.get(guildId);
    if (!gc) return;
    
    // Convert 24kHz mono PCM16 to Discord format and play
    const discordAudio = gc.pipeline.convertToDiscordFormat(audio);
    
    const resource = createAudioResource(discordAudio, {
      inputType: StreamType.Raw,
    });
    
    gc.player.play(resource);
  }

  /**
   * Leave a voice channel
   */
  leave(guildId: string): boolean {
    const gc = this.connections.get(guildId);
    if (!gc) return false;
    
    this.logger.info(`Leaving voice channel: ${gc.channelName}`);
    
    gc.connection.destroy();
    this.cleanup(guildId);
    
    return true;
  }

  /**
   * Cleanup resources for a guild
   */
  private cleanup(guildId: string): void {
    const gc = this.connections.get(guildId);
    if (!gc) return;
    
    gc.bridge.disconnect();
    gc.pipeline.destroy();
    gc.player.stop();
    
    this.connections.delete(guildId);
  }

  /**
   * Disconnect from all voice channels
   */
  disconnectAll(): void {
    for (const guildId of this.connections.keys()) {
      this.leave(guildId);
    }
  }

  /**
   * Get status for a guild or all connections
   */
  getStatus(guildId?: string | null): string {
    if (guildId) {
      const gc = this.connections.get(guildId);
      if (!gc) return '❌ Not connected to any voice channel';
      
      return `🎙️ Connected to **${gc.channelName}**\n` +
             `Model: \`${this.config.model}\`\n` +
             `Voice: \`${this.config.voice}\``;
    }
    
    if (this.connections.size === 0) {
      return '❌ No active voice connections';
    }
    
    const lines = [`📊 **${this.connections.size} active connection(s)**\n`];
    for (const [guildId, gc] of this.connections) {
      lines.push(`• ${gc.channelName} (${guildId})`);
    }
    return lines.join('\n');
  }
}
