/**
 * OpenClaw Discord Voice Plugin
 * 
 * Enables voice conversations in Discord voice channels using OpenAI Realtime API.
 * Integrates with existing OpenClaw Discord bot - no separate bot token needed.
 */

import type { Client, VoiceState, Interaction, GuildMember } from 'discord.js';
import { SlashCommandBuilder } from 'discord.js';
import { VoiceConnectionManager } from './voice-manager.js';
import { PluginConfig } from './types.js';

// Plugin state
let voiceManager: VoiceConnectionManager | null = null;
let discordClient: Client | null = null;

// Config schema for validation
const discordVoiceConfigSchema = {
  parse(value: unknown): PluginConfig {
    const raw = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
    
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
      openaiApiKey: typeof raw.openaiApiKey === 'string' ? raw.openaiApiKey : undefined,
      model: typeof raw.model === 'string' ? raw.model : 'gpt-4o-realtime-preview-2024-12-17',
      voice: (raw.voice as PluginConfig['voice']) || 'alloy',
      vadThreshold: typeof raw.vadThreshold === 'number' ? raw.vadThreshold : 0.5,
      systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : undefined,
      autoJoin: typeof raw.autoJoin === 'boolean' ? raw.autoJoin : false,
      maxConcurrentConnections: typeof raw.maxConcurrentConnections === 'number' 
        ? raw.maxConcurrentConnections : 5,
    };
  },
  uiHints: {
    openaiApiKey: {
      label: 'OpenAI API Key',
      sensitive: true,
      help: 'Required for Realtime API. Falls back to providers.openai.apiKey if not set.',
    },
    model: {
      label: 'Realtime Model',
      help: 'OpenAI Realtime model to use',
    },
    voice: {
      label: 'AI Voice',
      help: 'Voice for AI responses (alloy, echo, fable, onyx, nova, shimmer)',
    },
    vadThreshold: {
      label: 'VAD Threshold',
      help: 'Voice activity detection sensitivity (0-1)',
    },
    systemPrompt: {
      label: 'System Prompt',
      help: 'Custom personality/instructions for voice AI',
    },
    autoJoin: {
      label: 'Auto-Join',
      help: 'Automatically join voice channel when user joins',
    },
  },
};

/**
 * Handle slash command interactions
 */
async function handleInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  if (!voiceManager) return;

  const { commandName, guildId, member } = interaction;

  if (commandName === 'voice-join') {
    const guildMember = member as GuildMember;
    const voiceChannel = guildMember?.voice?.channel;
    
    if (!voiceChannel) {
      await interaction.reply({ content: '❌ Join a voice channel first!', ephemeral: true });
      return;
    }

    try {
      await voiceManager.join(voiceChannel);
      await interaction.reply({ 
        content: `🎙️ Joined **${voiceChannel.name}** - start talking!`, 
        ephemeral: true 
      });
    } catch (err) {
      await interaction.reply({ 
        content: `❌ Failed to join: ${err instanceof Error ? err.message : err}`, 
        ephemeral: true 
      });
    }
  }

  else if (commandName === 'voice-leave') {
    if (!guildId) {
      await interaction.reply({ content: '❌ Must be in a server', ephemeral: true });
      return;
    }

    const left = voiceManager.leave(guildId);
    if (left) {
      await interaction.reply({ content: '👋 Left voice channel', ephemeral: true });
    } else {
      await interaction.reply({ content: '❌ Not in a voice channel', ephemeral: true });
    }
  }

  else if (commandName === 'voice-status') {
    const status = voiceManager.getStatus(guildId);
    await interaction.reply({ content: status, ephemeral: true });
  }
}

/**
 * Handle voice state changes for auto-join
 */
function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
  if (!voiceManager) return;

  // User joined a channel
  if (!oldState.channel && newState.channel) {
    // Don't join if it's the bot itself
    if (newState.member?.user.bot) return;

    // Auto-join the channel
    voiceManager.join(newState.channel).catch(() => {
      // Silently fail auto-join
    });
  }
}

// OpenClaw Plugin Export
const discordVoicePlugin = {
  id: 'discord-voice',
  name: 'Discord Voice',
  description: 'Voice conversations in Discord voice channels using OpenAI Realtime API',
  configSchema: discordVoiceConfigSchema,

  register(api: any) {
    const config = discordVoiceConfigSchema.parse(api.pluginConfig);
    const logger = api.logger;

    if (!config.enabled) {
      logger.info('[discord-voice] Plugin disabled');
      return;
    }

    // Get OpenAI API key
    const openaiApiKey = config.openaiApiKey || api.config?.providers?.openai?.apiKey;
    if (!openaiApiKey) {
      logger.warn('[discord-voice] No OpenAI API key configured. Set plugins.entries.discord-voice.config.openaiApiKey or providers.openai.apiKey');
      return;
    }

    // Store config for later use when Discord client is available
    const pluginState = {
      config,
      openaiApiKey,
      logger,
    };

    // Register slash commands via gateway method
    api.registerGatewayMethod?.(
      'discord-voice.join',
      async ({ params, respond }: any) => {
        try {
          if (!voiceManager) {
            respond(false, { error: 'Voice manager not initialized' });
            return;
          }
          // This would need the channel object - for now just acknowledge
          respond(true, { message: 'Use /voice-join slash command in Discord' });
        } catch (err) {
          respond(false, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    );

    api.registerGatewayMethod?.(
      'discord-voice.leave',
      async ({ params, respond }: any) => {
        try {
          if (!voiceManager) {
            respond(false, { error: 'Voice manager not initialized' });
            return;
          }
          const guildId = params?.guildId;
          if (!guildId) {
            respond(false, { error: 'guildId required' });
            return;
          }
          const left = voiceManager.leave(guildId);
          respond(true, { left });
        } catch (err) {
          respond(false, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    );

    api.registerGatewayMethod?.(
      'discord-voice.status',
      async ({ params, respond }: any) => {
        try {
          if (!voiceManager) {
            respond(false, { error: 'Voice manager not initialized' });
            return;
          }
          const status = voiceManager.getStatus(params?.guildId);
          respond(true, { status });
        } catch (err) {
          respond(false, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    );

    // Hook into Discord channel plugin to get client
    // The discord channel plugin exposes the client via runtime
    const discordRuntime = api.runtime?.channels?.discord;
    if (discordRuntime?.client) {
      initializeWithClient(discordRuntime.client, pluginState);
    } else {
      // Listen for discord client to become available
      api.on?.('discord:ready', (client: Client) => {
        initializeWithClient(client, pluginState);
      });
      
      logger.info('[discord-voice] Waiting for Discord client...');
    }

    logger.info('[discord-voice] Plugin registered');
  },

  async shutdown() {
    if (voiceManager) {
      voiceManager.disconnectAll();
      voiceManager = null;
    }
    if (discordClient) {
      discordClient.off('interactionCreate', handleInteraction);
      discordClient.off('voiceStateUpdate', handleVoiceStateUpdate);
      discordClient = null;
    }
  },
};

/**
 * Initialize voice manager with Discord client
 */
function initializeWithClient(client: Client, state: any): void {
  const { config, openaiApiKey, logger } = state;

  discordClient = client;

  // Initialize voice manager
  voiceManager = new VoiceConnectionManager({
    client,
    openaiApiKey,
    model: config.model,
    voice: config.voice,
    vadThreshold: config.vadThreshold,
    systemPrompt: config.systemPrompt,
    maxConnections: config.maxConcurrentConnections,
    logger,
  });

  // Register interaction handler
  client.on('interactionCreate', handleInteraction);

  // Auto-join handling
  if (config.autoJoin) {
    client.on('voiceStateUpdate', handleVoiceStateUpdate);
  }

  // Register slash commands
  registerSlashCommands(client, logger);

  logger.info('[discord-voice] Initialized with Discord client');
}

/**
 * Register slash commands with Discord
 */
async function registerSlashCommands(client: Client, logger: any): Promise<void> {
  const commands = [
    new SlashCommandBuilder()
      .setName('voice-join')
      .setDescription('Join your voice channel for AI conversation'),
    new SlashCommandBuilder()
      .setName('voice-leave')
      .setDescription('Leave the voice channel'),
    new SlashCommandBuilder()
      .setName('voice-status')
      .setDescription('Show voice connection status'),
  ];

  try {
    // Register commands globally (or per-guild for faster updates during dev)
    if (client.application) {
      await client.application.commands.set(commands.map(c => c.toJSON()));
      logger.info('[discord-voice] Slash commands registered');
    }
  } catch (err) {
    logger.error('[discord-voice] Failed to register slash commands:', err);
  }
}

export default discordVoicePlugin;
export { VoiceConnectionManager } from './voice-manager.js';
export { RealtimeBridge } from './realtime-bridge.js';
export type { PluginConfig } from './types.js';
