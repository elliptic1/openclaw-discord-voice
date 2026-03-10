/**
 * OpenClaw Discord Voice Plugin
 *
 * Enables voice conversations in Discord voice channels using OpenAI Realtime API.
 * Creates its own discord.js client for voice (OpenClaw uses Carbon internally,
 * which doesn't support voice). Uses the same bot token from OpenClaw config.
 */

import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import type { VoiceState, Interaction, GuildMember } from 'discord.js';
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
      model: typeof raw.model === 'string' ? raw.model : 'gpt-4o-realtime-preview-2025-06-03',
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

  if (commandName === 'voice-join' || commandName === 'vc') {
    const guildMember = member as GuildMember;
    const voiceChannel = guildMember?.voice?.channel;

    if (!voiceChannel) {
      await interaction.reply({ content: '❌ Join a voice channel first!', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      await voiceManager.join(voiceChannel);
      await interaction.editReply(`🎙️ Joined **${voiceChannel.name}** - start talking!`);
    } catch (err) {
      await interaction.editReply(`❌ Failed to join: ${err instanceof Error ? err.message : err}`);
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

/**
 * Build a rich system prompt for the voice AI
 */
function buildSystemPrompt(): string {
  return `You are Todd's AI assistant, connected via Discord voice. You have admin-level access to all projects and can take action on his behalf.

CAPABILITIES:
- Check project status (git status, recent commits, branch)
- Read Discord channel messages for any project
- Run shell commands in any project workspace
- Launch AI agents to do coding tasks (fix bugs, implement features, refactor)
- Send messages to Discord channels

BEHAVIOR:
- Be concise — this is voice, keep it brief and conversational.
- Use tools to get real info, don't guess.
- When asked to fix/change something, launch an agent and confirm.
- Don't read back long lists — summarize.

PROJECTS & CHANNELS (workspace: /Users/todd/workspace/):
Channel ID → Name → Workspace Dir
1465931495767150625 → general
1466123449213911170 → ai-consulting
1468097580914446507 → agentport → agentport-api, agentport-web
1465937776942776511 → algebro → Algebro
1465937778062921780 → business-shield → BusinessShield
1472496838119526510 → chromawall → ChromaWall
1465937822820077763 → e-tycoon → e-tycoon
1465937774598164578 → elderly-ai → Elderly-AI
1466123450597904676 → external-prompt-protocol → external-prompt-protocol
1465937775999058043 → mininews → MiniNews-functions, MiniNews-KMP, MiniNews-website
1466123453274001600 → my-family-story → My-Family-Story
1465937823637966974 → mycatneedsthat → mycatneedsthat
1465937787441123593 → nerdgame → Nerdgame
1468733304441405450 → neuroplay → neuroplay-platform
1466123451587756274 → number-field-sieve → General-Number-Field-Sieve
1465937786266976367 → oral-exam → Oral-Exam
1474320919387181157 → personal-finance → Finances
1474329096698728510 → personal-finance-app → Finances
1465937859931410661 → solipsistic-physics → Solipsistic-Physics
1465937824372228190 → spectacularbitch → spectacularbitch
1466123449939398811 → swe-report → Engineering-Report
1465937822174416988 → think2link → think2link-react
1477530690693103738 → ticklebees → Ticklebees
1465937860518613189 → toddbsmith-website → toddbsmith-website
1475688418381135944 → voice-ai → voice-ai
1478273352492650578 → voxpost
1466317735402278994 → glytch
1467568728144220180 → relay
1475712479131598869 → single-topic-tutor
1475891101108801729 → yc-prep
1472615283423183107 → openclaw-status
1465952612934357055 → ci-builds
1466435017772372180 → daily-brief`;
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
    const openaiApiKey = config.openaiApiKey || api.config?.providers?.openai?.apiKey || process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      logger.warn('[discord-voice] No OpenAI API key configured');
      return;
    }

    // Get Discord token from OpenClaw config
    // OpenClaw uses Carbon (not discord.js), so we create our own discord.js
    // client specifically for voice channel support.
    const discordToken = api.config?.channels?.discord?.token || process.env.DISCORD_TOKEN;
    if (!discordToken) {
      logger.error('[discord-voice] No Discord token found in config (channels.discord.token)');
      return;
    }

    logger.info('[discord-voice] Creating discord.js client for voice support...');

    // Create a discord.js client for voice support.
    // We need Guilds (to cache guilds) and GuildVoiceStates (for voice).
    // Note: This creates a second gateway connection alongside OpenClaw's Carbon client.
    // Discord will send events to both, but voice state updates for OUR voice requests
    // should come back to our gateway since we initiate them.
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
      ],
    });

    discordClient = client;

    // Extract gateway config from OpenClaw
    const gatewayPort = api.config?.gateway?.port || 18789;
    const gatewayAuthToken = api.config?.gateway?.auth?.token;

    client.once('ready', async () => {
      logger.info(`[discord-voice] Voice client ready as ${client.user?.tag}`);

      // Build system prompt with project awareness
      const systemPrompt = config.systemPrompt || buildSystemPrompt();

      // Get guild ID from config
      const guildsObj = api.config?.channels?.discord?.guilds;
      const guildId = guildsObj ? Object.keys(guildsObj)[0] : undefined;

      // Initialize voice manager
      voiceManager = new VoiceConnectionManager({
        client,
        openaiApiKey,
        model: config.model || 'gpt-4o-realtime-preview-2025-06-03',
        voice: config.voice || 'alloy',
        vadThreshold: config.vadThreshold ?? 0.5,
        systemPrompt,
        maxConnections: config.maxConcurrentConnections || 5,
        logger,
        gatewayPort,
        gatewayAuthToken,
        guildId,
      });

      // Register interaction handler
      client.on('interactionCreate', handleInteraction);

      // Auto-join handling
      if (config.autoJoin) {
        client.on('voiceStateUpdate', handleVoiceStateUpdate);
      }

      // Register slash commands via REST API (guild-specific for instant availability)
      await registerSlashCommands(client, logger, discordToken, guildId);

      logger.info('[discord-voice] Fully initialized');
    });

    client.on('error', (err) => {
      logger.error('[discord-voice] Discord client error:', err);
    });

    // Log in with the same bot token OpenClaw uses
    client.login(discordToken).catch((err) => {
      logger.error('[discord-voice] Failed to login:', err);
    });

    // Register gateway methods for external control
    api.registerGatewayMethod?.(
      'discord-voice.status',
      async ({ params, respond }: any) => {
        const status = voiceManager?.getStatus(params?.guildId) || 'Not initialized';
        respond(true, { status });
      }
    );

    logger.info('[discord-voice] Plugin registered');
  },

  async shutdown() {
    if (voiceManager) {
      voiceManager.disconnectAll();
      voiceManager = null;
    }
    if (discordClient) {
      discordClient.destroy();
      discordClient = null;
    }
  },
};

/**
 * Register slash commands with Discord via REST API
 */
async function registerSlashCommands(client: Client, logger: any, token: string, guildId?: string): Promise<void> {
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
    const rest = new REST().setToken(token);
    const appId = client.user?.id;
    if (!appId) {
      logger.error('[discord-voice] No application ID available');
      return;
    }

    if (guildId) {
      await rest.put(
        Routes.applicationGuildCommands(appId, guildId),
        { body: commands.map(c => c.toJSON()) }
      );
      logger.info(`[discord-voice] Slash commands registered to guild ${guildId}`);
    } else {
      await rest.put(
        Routes.applicationCommands(appId),
        { body: commands.map(c => c.toJSON()) }
      );
      logger.info('[discord-voice] Slash commands registered globally');
    }
  } catch (err) {
    logger.error('[discord-voice] Failed to register slash commands:', err);
  }
}

export default discordVoicePlugin;
export { VoiceConnectionManager } from './voice-manager.js';
export { RealtimeBridge } from './realtime-bridge.js';
export type { PluginConfig } from './types.js';
