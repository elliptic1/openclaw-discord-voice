/**
 * OpenClaw Discord Voice Plugin
 * 
 * Enables voice conversations in Discord voice channels using OpenAI Realtime API.
 * Integrates with existing OpenClaw Discord bot - no separate bot token needed.
 */

import type { Client, VoiceState } from 'discord.js';
import { VoiceConnectionManager } from './voice-manager.js';
import { PluginConfig, PluginContext } from './types.js';

let voiceManager: VoiceConnectionManager | null = null;

/**
 * Plugin initialization - called when OpenClaw loads the plugin
 */
export async function init(context: PluginContext): Promise<void> {
  const config = context.config as PluginConfig;
  const logger = context.logger;
  
  logger.info('Discord Voice plugin initializing...');
  
  // Get OpenAI API key - from plugin config or fall back to providers.openai
  const openaiApiKey = config.openaiApiKey || context.getProviderApiKey?.('openai');
  if (!openaiApiKey) {
    throw new Error('OpenAI API key required. Set plugins.entries.discord-voice.config.openaiApiKey or providers.openai.apiKey');
  }
  
  // Get Discord client from the discord channel extension
  const discordClient = context.getDiscordClient?.() as Client | undefined;
  if (!discordClient) {
    throw new Error('Discord client not available. Ensure discord channel is configured and enabled.');
  }
  
  // Initialize voice manager
  voiceManager = new VoiceConnectionManager({
    client: discordClient,
    openaiApiKey,
    model: config.model || 'gpt-4o-realtime-preview-2024-12-17',
    voice: config.voice || 'alloy',
    vadThreshold: config.vadThreshold ?? 0.5,
    systemPrompt: config.systemPrompt,
    maxConnections: config.maxConcurrentConnections || 5,
    logger,
  });
  
  // Register slash commands
  await registerCommands(context, discordClient);
  
  // Auto-join handling
  if (config.autoJoin) {
    discordClient.on('voiceStateUpdate', handleVoiceStateUpdate);
  }
  
  logger.info('Discord Voice plugin ready');
}

/**
 * Register slash commands with Discord
 */
async function registerCommands(context: PluginContext, client: Client): Promise<void> {
  const { SlashCommandBuilder } = await import('discord.js');
  
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
  
  // Register commands via Discord REST API
  // In a real OpenClaw plugin, this would use the plugin SDK's command registration
  context.registerSlashCommands?.(commands.map(c => c.toJSON()));
  
  // Handle command interactions
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!voiceManager) return;
    
    const { commandName, guildId, member } = interaction;
    
    if (commandName === 'voice-join') {
      // @ts-ignore - member.voice exists on GuildMember
      const voiceChannel = member?.voice?.channel;
      if (!voiceChannel) {
        await interaction.reply({ content: '❌ Join a voice channel first!', ephemeral: true });
        return;
      }
      
      try {
        await voiceManager.join(voiceChannel);
        await interaction.reply({ content: `🎙️ Joined **${voiceChannel.name}** - start talking!`, ephemeral: true });
      } catch (err) {
        await interaction.reply({ content: `❌ Failed to join: ${err}`, ephemeral: true });
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
  });
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

/**
 * Plugin shutdown - cleanup connections
 */
export async function shutdown(): Promise<void> {
  if (voiceManager) {
    voiceManager.disconnectAll();
    voiceManager = null;
  }
}

export { VoiceConnectionManager } from './voice-manager.js';
export { RealtimeBridge } from './realtime-bridge.js';
export type { PluginConfig, PluginContext } from './types.js';
