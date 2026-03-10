/**
 * Voice Connection Manager
 * 
 * Manages Discord voice connections and bridges them to OpenAI Realtime API.
 */

import { PassThrough } from 'stream';
import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayer,
} from '@discordjs/voice';
import type { VoiceBasedChannel, Client } from 'discord.js';
import { RealtimeBridge } from './realtime-bridge.js';
import { AudioPipeline } from './audio-pipeline.js';
import { GatewayClient } from './gateway-client.js';
import type { VoiceManagerConfig, Logger } from './types.js';

interface GuildConnection {
  connection: VoiceConnection;
  bridge: RealtimeBridge;
  pipeline: AudioPipeline;
  player: AudioPlayer;
  channelId: string;
  channelName: string;
  currentStream: PassThrough | null;
  isSpeaking: boolean;
  activeStreams: Map<string, any>;
}

export class VoiceConnectionManager {
  private connections = new Map<string, GuildConnection>();
  private config: VoiceManagerConfig;
  private logger: Logger;
  private gateway: GatewayClient | null = null;

  constructor(config: VoiceManagerConfig) {
    this.config = config;
    this.logger = config.logger;

    if (config.gatewayPort && config.gatewayAuthToken) {
      this.gateway = new GatewayClient({
        port: config.gatewayPort,
        authToken: config.gatewayAuthToken,
        logger: this.logger,
      });
      this.logger.info(`[voice] Gateway client configured (port: ${config.gatewayPort})`);
    }
  }

  async join(channel: VoiceBasedChannel): Promise<void> {
    const guildId = channel.guild.id;
    const joinStart = Date.now();

    if (this.connections.size >= this.config.maxConnections) {
      throw new Error(`Max concurrent connections (${this.config.maxConnections}) reached`);
    }

    if (this.connections.has(guildId)) {
      this.leave(guildId);
    }

    this.logger.info(`[voice] Joining: ${channel.name} (${channel.id})`);

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    connection.on('stateChange', (oldState, newState) => {
      this.logger.info(`[voice] State: ${oldState.status} → ${newState.status}`);
    });

    connection.on('error', (err) => {
      this.logger.error(`[voice] Connection error:`, err);
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      this.logger.info(`[voice] ✓ Connected (${Date.now() - joinStart}ms)`);
    } catch (err) {
      connection.destroy();
      throw new Error(`Failed to connect: ${err}`);
    }

    const player = createAudioPlayer();
    connection.subscribe(player);

    player.on('stateChange', (o, n) => {
      this.logger.info(`[voice] Player: ${o.status} → ${n.status}`);
    });
    player.on('error', (err) => {
      this.logger.error(`[voice] Player error:`, err);
    });

    const bridge = new RealtimeBridge({
      apiKey: this.config.openaiApiKey,
      model: this.config.model,
      voice: this.config.voice,
      vadThreshold: this.config.vadThreshold,
      systemPrompt: this.config.systemPrompt,
      logger: this.logger,
      gateway: this.gateway || undefined,
      onAudioResponse: (audio: Buffer) => {
        this.playAudio(guildId, audio);
      },
      onAudioDone: () => {
        this.finishPlayback(guildId);
      },
    });

    const activeStreams = new Map<string, any>();

    const pipeline = new AudioPipeline({
      logger: this.logger,
      onProcessedAudio: (audio: Buffer) => {
        const gc = this.connections.get(guildId);
        if (gc?.isSpeaking) return;
        bridge.sendAudio(audio);
      },
    });

    const gc: GuildConnection = {
      connection,
      bridge,
      pipeline,
      player,
      channelId: channel.id,
      channelName: channel.name,
      currentStream: null,
      isSpeaking: false,
      activeStreams,
    };

    this.connections.set(guildId, gc);
    this.startListening(guildId, connection);

    await bridge.connect();
    this.logger.info(`[voice] ✓ Fully ready (${Date.now() - joinStart}ms)`);

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.leave(guildId);
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.cleanup(guildId);
    });
  }

  private startListening(guildId: string, connection: VoiceConnection): void {
    const gc = this.connections.get(guildId);
    if (!gc) return;

    const { activeStreams } = gc;
    const receiver = connection.receiver;
    const botUserId = this.config.client.user?.id;

    /**
     * Subscribe to a user's audio stream.
     * Uses `manual` end behavior so the stream persists across speaking intervals.
     * We re-create the stream if it has already ended.
     */
    const subscribeUser = (userId: string) => {
      if (!gc) return;
      if (userId === botUserId) return;

      // Check if existing stream is still open
      const existing = activeStreams.get(userId);
      if (existing && !existing.destroyed && !existing.readableEnded) return;

      this.logger.info(`[voice] Subscribing to user ${userId}`);

      const stream = receiver.subscribe(userId, {
        end: { behavior: 'manual' as any },
      });
      activeStreams.set(userId, stream);

      let chunkCount = 0;
      stream.on('data', (chunk: Buffer) => {
        chunkCount++;
        gc.pipeline.processDiscordAudio(chunk);
      });
      stream.on('end', () => {
        this.logger.info(`[voice] Stream ended for ${userId} (${chunkCount} packets)`);
        activeStreams.delete(userId);
      });
      stream.on('error', (err: Error) => {
        this.logger.error(`[voice] Stream error for ${userId}: ${err.message}`);
        activeStreams.delete(userId);
      });
    };

    // Primary: subscribe whenever SSRC is mapped to a userId
    (receiver as any).ssrcMap?.on('create', (data: any) => {
      if (data.userId) {
        this.logger.info(`[voice] SSRC ${data.audioSSRC} → user ${data.userId}`);
        subscribeUser(data.userId);
      }
    });

    // Fallback: speaking event (fires slightly later but always works)
    receiver.speaking.on('start', (userId) => {
      subscribeUser(userId);
    });

    // Also subscribe to already-present members
    try {
      const voiceChannel = connection.joinConfig.channelId;
      const guild = this.config.client.guilds.cache.get(guildId as string);
      const channel = voiceChannel ? guild?.channels.cache.get(voiceChannel) : undefined;
      if (channel?.isVoiceBased()) {
        for (const [memberId, member] of (channel as any).members) {
          if (memberId !== botUserId && !member.user?.bot) {
            subscribeUser(memberId);
          }
        }
      }
    } catch (e: any) {
      this.logger.debug(`[voice] Pre-subscribe scan: ${e.message}`);
    }
  }

  private playbackChunkCount = 0;
  private playbackStartTime: number | null = null;

  private playAudio(guildId: string, audio: Buffer): void {
    const gc = this.connections.get(guildId);
    if (!gc) return;

    gc.isSpeaking = true;
    this.playbackChunkCount++;

    const discordAudio = gc.pipeline.convertToDiscordBuffer(audio);

    if (!gc.currentStream) {
      this.playbackStartTime = Date.now();
      this.logger.info(`[voice] 🔊 Playback starting`);
      gc.currentStream = new PassThrough();
      const resource = createAudioResource(gc.currentStream, {
        inputType: StreamType.Raw,
      });
      gc.player.play(resource);
    }

    gc.currentStream.write(discordAudio);
  }

  private finishPlayback(guildId: string): void {
    const gc = this.connections.get(guildId);
    if (!gc) return;

    if (gc.currentStream) {
      gc.currentStream.end();
      gc.currentStream = null;
    }

    setTimeout(() => {
      const gc2 = this.connections.get(guildId);
      if (gc2) {
        gc2.isSpeaking = false;
        this.logger.info('[voice] 🎤 Input unmuted');
      }
    }, 300);

    if (this.playbackStartTime) {
      this.logger.info(`[voice] 🔊 Playback done (${this.playbackChunkCount} chunks, ${Date.now() - this.playbackStartTime}ms)`);
    }
    this.playbackChunkCount = 0;
    this.playbackStartTime = null;
  }

  leave(guildId: string): boolean {
    const gc = this.connections.get(guildId);
    if (!gc) return false;
    this.logger.info(`[voice] Leaving: ${gc.channelName}`);
    gc.connection.destroy();
    this.cleanup(guildId);
    return true;
  }

  private cleanup(guildId: string): void {
    const gc = this.connections.get(guildId);
    if (!gc) return;
    if (gc.currentStream) { gc.currentStream.end(); gc.currentStream = null; }
    gc.bridge.disconnect();
    gc.pipeline.destroy();
    gc.player.stop();
    for (const stream of Array.from(gc.activeStreams.values())) {
      try { stream.destroy(); } catch {}
    }
    gc.activeStreams.clear();
    this.connections.delete(guildId);
  }

  disconnectAll(): void {
    for (const guildId of this.connections.keys()) {
      this.leave(guildId);
    }
  }

  getStatus(guildId?: string | null): string {
    if (guildId) {
      const gc = this.connections.get(guildId);
      if (!gc) return '❌ Not connected to any voice channel';
      return `🎙️ Connected to **${gc.channelName}**\nModel: \`${this.config.model}\`\nVoice: \`${this.config.voice}\``;
    }
    if (this.connections.size === 0) return '❌ No active voice connections';
    const lines = [`📊 **${this.connections.size} active connection(s)**`];
    for (const [gid, gc] of this.connections.entries()) {
      lines.push(`• ${gc.channelName} (${gid})`);
    }
    return lines.join('\n');
  }
}
