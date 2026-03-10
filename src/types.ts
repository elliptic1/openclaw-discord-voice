/**
 * Type definitions for the Discord Voice plugin
 */

import type { Client } from 'discord.js';

export interface PluginConfig {
  enabled?: boolean;
  openaiApiKey?: string;
  model?: string;
  voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
  vadThreshold?: number;
  systemPrompt?: string;
  autoJoin?: boolean;
  maxConcurrentConnections?: number;
}

export interface PluginContext {
  config: PluginConfig;
  logger: Logger;
  getProviderApiKey?: (provider: string) => string | undefined;
  getDiscordClient?: () => Client | undefined;
  registerSlashCommands?: (commands: unknown[]) => void;
}

export interface Logger {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

export interface VoiceManagerConfig {
  client: Client;
  openaiApiKey: string;
  model: string;
  voice: string;
  vadThreshold: number;
  systemPrompt?: string;
  maxConnections: number;
  logger: Logger;
  gatewayPort?: number;
  gatewayAuthToken?: string;
  guildId?: string;
}

export interface OpenAISessionConfig {
  modalities: string[];
  voice: string;
  input_audio_format: string;
  output_audio_format: string;
  turn_detection: {
    type: string;
    threshold: number;
    prefix_padding_ms?: number;
    silence_duration_ms?: number;
  };
  instructions?: string;
}

export interface OpenAIMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * OpenAI Realtime tool definition (function calling)
 */
export interface RealtimeTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * OpenClaw Gateway API client config
 */
export interface GatewayConfig {
  host: string;
  port: number;
  authToken: string;
  logger: Logger;
}

/**
 * OpenClaw API reference passed from plugin registration
 */
export interface OpenClawAPI {
  pluginConfig: unknown;
  logger: Logger;
  config: {
    channels?: {
      discord?: {
        token?: string;
        guilds?: Record<string, unknown>;
      };
    };
    providers?: {
      openai?: {
        apiKey?: string;
      };
    };
  };
  registerGatewayMethod?: (name: string, handler: (ctx: any) => Promise<void>) => void;
  registerChannel?: (name: string, channel: unknown) => void;
  on?: (event: string, handler: (...args: any[]) => void) => void;
}
