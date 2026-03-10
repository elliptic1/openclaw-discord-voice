/**
 * OpenAI Realtime API Bridge
 *
 * Handles WebSocket connection to OpenAI's Realtime API for voice conversations.
 * Supports function calling to bridge into OpenClaw's gateway API for project
 * awareness, agent launching, and admin operations.
 */

import WebSocket from 'ws';
import type { Logger, OpenAISessionConfig, OpenAIMessage, RealtimeTool } from './types.js';
import type { GatewayClient } from './gateway-client.js';

interface RealtimeBridgeConfig {
  apiKey: string;
  model: string;
  voice: string;
  vadThreshold: number;
  systemPrompt?: string;
  logger: Logger;
  onAudioResponse: (audio: Buffer) => void;
  onAudioDone: () => void;
  onResponseText?: (text: string) => void;
  gateway?: GatewayClient;
}

/**
 * Tool definitions exposed to OpenAI Realtime for function calling
 */
function getToolDefinitions(): RealtimeTool[] {
  return [
    {
      type: 'function',
      name: 'list_projects',
      description: 'List all projects in the workspace with their paths and descriptions. Use this to understand what projects exist.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      type: 'function',
      name: 'get_project_status',
      description: 'Get the current status, recent activity, and open issues for a specific project.',
      parameters: {
        type: 'object',
        properties: {
          project: {
            type: 'string',
            description: 'Project name (directory name in workspace)',
          },
        },
        required: ['project'],
      },
    },
    {
      type: 'function',
      name: 'read_channel_messages',
      description: 'Read recent messages from a Discord channel. Use this to catch up on what\'s been discussed in a project channel. The channel_id is the Discord channel snowflake ID.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: 'Discord channel ID (snowflake). Use list_channels to find channel IDs.',
          },
          limit: {
            type: 'number',
            description: 'Number of recent messages to retrieve (default: 5)',
          },
        },
        required: ['channel_id'],
      },
    },
    {
      type: 'function',
      name: 'send_message',
      description: 'Send a message to a Discord channel. Use this to post updates or communicate.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: 'Discord channel ID (snowflake)',
          },
          message: {
            type: 'string',
            description: 'Message content to send',
          },
        },
        required: ['channel_id', 'message'],
      },
    },
    {
      type: 'function',
      name: 'launch_agent',
      description: 'Launch an AI agent to work on a task. The agent runs in the background and can fix bugs, implement features, write code, etc. Use this when the user asks you to do something that requires coding or file modifications.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Detailed description of what the agent should do',
          },
          project: {
            type: 'string',
            description: 'Project name to work in (determines workspace directory)',
          },
          model: {
            type: 'string',
            description: 'AI model to use (optional, uses default if not specified)',
          },
        },
        required: ['task', 'project'],
      },
    },
    {
      type: 'function',
      name: 'check_agent_status',
      description: 'Check the status of running agents/sessions. Shows what agents are active and what they\'re working on.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'Specific session ID to check (optional, lists all if not specified)',
          },
        },
        required: [],
      },
    },
    {
      type: 'function',
      name: 'run_command',
      description: 'Execute a shell command in a project workspace. Use for checking build status, running tests, git operations, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to execute',
          },
          project: {
            type: 'string',
            description: 'Project to run the command in (determines working directory)',
          },
        },
        required: ['command'],
      },
    },
  ];
}

export class RealtimeBridge {
  private ws: WebSocket | null = null;
  private config: RealtimeBridgeConfig;
  private logger: Logger;
  private isConnected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private gateway: GatewayClient | null;

  // Timing metrics
  private speechStartTime: number | null = null;
  private responseStartTime: number | null = null;
  private audioChunkCount = 0;
  private totalAudioBytes = 0;

  constructor(config: RealtimeBridgeConfig) {
    this.config = config;
    this.logger = config.logger;
    this.gateway = config.gateway || null;
  }

  /**
   * Connect to OpenAI Realtime API
   */
  async connect(): Promise<void> {
    const url = `wss://api.openai.com/v1/realtime?model=${this.config.model}`;

    this.logger.info(`[realtime] Connecting to OpenAI Realtime API (model: ${this.config.model})...`);
    const connectStart = Date.now();

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
        const connectTime = Date.now() - connectStart;
        this.logger.info(`[realtime] ✓ Connected to OpenAI Realtime API (${connectTime}ms)`);

        // Configure session
        this.configureSession();
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (err) => {
        this.logger.error('[realtime] WebSocket error:', err);
        if (!this.isConnected) {
          reject(err);
        }
      });

      this.ws.on('close', (code, reason) => {
        this.isConnected = false;
        this.logger.info(`[realtime] WebSocket closed: ${code} ${reason}`);

        // Attempt reconnect
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          this.logger.info(`[realtime] Reconnecting (attempt ${this.reconnectAttempts})...`);
          setTimeout(() => this.connect().catch(() => {}), 1000 * this.reconnectAttempts);
        }
      });
    });
  }

  /**
   * Configure the OpenAI session with tools
   */
  private configureSession(): void {
    const sessionConfig: any = {
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

    // Add function calling tools if gateway is available
    if (this.gateway) {
      sessionConfig.tools = getToolDefinitions();
      sessionConfig.tool_choice = 'auto';
      this.logger.info(`[realtime] Registering ${sessionConfig.tools.length} tools for function calling`);
    }

    this.send({
      type: 'session.update',
      session: sessionConfig,
    });

    this.logger.info(`[realtime] Session configured (voice: ${this.config.voice}, VAD: ${this.config.vadThreshold}, tools: ${sessionConfig.tools?.length || 0})`);
  }

  /**
   * Handle incoming messages from OpenAI
   */
  private handleMessage(data: WebSocket.RawData): void {
    try {
      const message = JSON.parse(data.toString()) as OpenAIMessage;
      const now = Date.now();

      switch (message.type) {
        case 'session.created':
          this.logger.info('[realtime] ✓ Session created');
          break;

        case 'session.updated':
          this.logger.info('[realtime] ✓ Session updated');
          break;

        case 'input_audio_buffer.speech_started':
          this.speechStartTime = now;
          this.logger.info('[realtime] 🎤 Speech started (user talking)');
          break;

        case 'input_audio_buffer.speech_stopped':
          if (this.speechStartTime) {
            const speechDuration = now - this.speechStartTime;
            this.logger.info(`[realtime] 🎤 Speech stopped (duration: ${speechDuration}ms)`);
          }
          break;

        case 'input_audio_buffer.committed':
          this.logger.info('[realtime] Audio buffer committed');
          break;

        case 'response.created':
          this.responseStartTime = now;
          this.audioChunkCount = 0;
          this.totalAudioBytes = 0;
          if (this.speechStartTime) {
            const latency = now - this.speechStartTime;
            this.logger.info(`[realtime] 🤖 Response started (latency: ${latency}ms)`);
          } else {
            this.logger.info('[realtime] 🤖 Response started');
          }
          break;

        case 'response.output_item.added':
          this.logger.info(`[realtime] Output item added (type: ${(message as any).item?.type || 'unknown'})`);
          break;

        case 'response.content_part.added':
          this.logger.info(`[realtime] Content part added (type: ${(message as any).part?.type || 'unknown'})`);
          break;

        case 'response.audio_transcript.delta': {
          const transcript = (message as any).delta as string;
          if (transcript) {
            this.logger.info(`[realtime] 📝 Transcript: "${transcript}"`);
          }
          break;
        }

        case 'response.audio.delta': {
          const audioData = message.delta as string;
          if (audioData) {
            const buffer = Buffer.from(audioData, 'base64');
            this.audioChunkCount++;
            this.totalAudioBytes += buffer.length;

            if (this.audioChunkCount === 1) {
              const firstChunkLatency = this.responseStartTime ? now - this.responseStartTime : 0;
              this.logger.info(`[realtime] 🔊 First audio chunk (${buffer.length}B, ${firstChunkLatency}ms)`);
            } else if (this.audioChunkCount % 10 === 0) {
              this.logger.debug(`[realtime] 🔊 Chunk #${this.audioChunkCount} (total: ${this.totalAudioBytes}B)`);
            }

            this.config.onAudioResponse(buffer);
          }
          break;
        }

        case 'response.audio.done':
          this.logger.info(`[realtime] 🔊 Audio done (${this.audioChunkCount} chunks, ${this.totalAudioBytes}B)`);
          this.config.onAudioDone();
          break;

        case 'response.audio_transcript.done': {
          const fullTranscript = (message as any).transcript as string;
          if (fullTranscript) {
            this.logger.info(`[realtime] 📝 Full: "${fullTranscript}"`);
            this.config.onResponseText?.(fullTranscript);
          }
          break;
        }

        // Function calling events
        case 'response.function_call_arguments.delta':
          // Accumulating arguments — no action needed
          break;

        case 'response.function_call_arguments.done':
          this.handleFunctionCall(message);
          break;

        case 'response.done': {
          if (this.responseStartTime) {
            const totalResponseTime = now - this.responseStartTime;
            const totalTurnTime = this.speechStartTime ? now - this.speechStartTime : 0;
            this.logger.info(`[realtime] ✓ Response done (${totalResponseTime}ms, turn: ${totalTurnTime}ms)`);
          } else {
            this.logger.info('[realtime] ✓ Response done');
          }

          // Check if response contains function calls that need processing
          const response = (message as any).response;
          if (response?.output) {
            for (const item of response.output) {
              if (item.type === 'function_call') {
                this.handleFunctionCallFromResponse(item);
              }
            }
          }

          this.speechStartTime = null;
          this.responseStartTime = null;
          break;
        }

        case 'rate_limits.updated': {
          const limits = (message as any).rate_limits;
          if (limits) {
            this.logger.debug(`[realtime] Rate limits: ${JSON.stringify(limits)}`);
          }
          break;
        }

        case 'error':
          this.logger.error('[realtime] ❌ OpenAI error:', message.error);
          break;

        default:
          this.logger.debug(`[realtime] Unhandled: ${message.type}`);
          break;
      }
    } catch (err) {
      this.logger.error('[realtime] Parse error:', err);
    }
  }

  /**
   * Handle a completed function call from response.done output
   */
  private async handleFunctionCallFromResponse(item: any): Promise<void> {
    const { name, arguments: argsStr, call_id } = item;
    if (!name || !call_id) return;

    this.logger.info(`[realtime] 🔧 Function call: ${name}(${argsStr?.substring(0, 100) || ''})`);

    let args: Record<string, unknown> = {};
    try {
      if (argsStr) args = JSON.parse(argsStr);
    } catch {
      this.logger.error(`[realtime] Failed to parse function args: ${argsStr}`);
      this.sendFunctionResult(call_id, { error: 'Invalid arguments' });
      return;
    }

    try {
      const result = await this.executeTool(name, args);
      this.sendFunctionResult(call_id, result);
    } catch (err: any) {
      this.logger.error(`[realtime] Tool execution error (${name}): ${err.message}`);
      this.sendFunctionResult(call_id, { error: err.message });
    }
  }

  /**
   * Handle function call arguments done event (legacy path)
   */
  private async handleFunctionCall(message: any): Promise<void> {
    // This event fires during streaming — actual execution happens in response.done
    const name = message.name;
    const callId = message.call_id;
    if (name && callId) {
      this.logger.info(`[realtime] 🔧 Function call ready: ${name} (${callId})`);
    }
  }

  /**
   * Execute a tool and return the result
   */
  private async executeTool(name: string, args: Record<string, unknown>): Promise<any> {
    if (!this.gateway) {
      return { error: 'Gateway not connected — cannot execute tools' };
    }

    const startTime = Date.now();

    switch (name) {
      case 'list_projects': {
        const output = await this.gateway.exec('ls -1 /Users/todd/workspace/');
        const elapsed = Date.now() - startTime;
        this.logger.info(`[realtime] ✓ list_projects (${elapsed}ms)`);
        return { projects: output.trim().split('\n') };
      }

      case 'get_project_status': {
        const project = args.project as string;
        const workspace = `/Users/todd/workspace/${project}`;
        const output = await this.gateway.exec(
          `echo "=== Git Status ===" && git status -s 2>/dev/null && echo "=== Recent Commits ===" && git log --oneline -10 2>/dev/null && echo "=== Branch ===" && git branch --show-current 2>/dev/null`,
          workspace
        );
        const elapsed = Date.now() - startTime;
        this.logger.info(`[realtime] ✓ get_project_status[${project}] (${elapsed}ms)`);
        return { project, status: output };
      }

      case 'read_channel_messages': {
        const channelId = args.channel_id as string;
        const limit = (args.limit as number) || 5;
        // Read session file directly for speed (avoid spawning CLI)
        try {
          const output = await this.gateway.exec(
            `python3 -c "
import json, sys
sessions = json.load(open('/Users/todd/.openclaw/agents/main/sessions/sessions.json'))
key = 'agent:main:discord:channel:${channelId}'
if key not in sessions:
    print(json.dumps({'error': 'no session for this channel'}))
    sys.exit(0)
sf = sessions[key].get('sessionFile','')
if not sf:
    print(json.dumps({'error': 'no session file'}))
    sys.exit(0)
msgs = []
for line in open(sf):
    try:
        e = json.loads(line)
        if e.get('type') == 'message':
            d = e.get('data',{})
            role = d.get('role','')
            text = ''.join(c.get('text','') for c in d.get('content',[]) if c.get('type')=='text')
            sender = d.get('senderLabel', role)
            if text.strip():
                msgs.append({'role':role,'sender':sender,'text':text[:500]})
    except: pass
print(json.dumps({'messages': msgs[-${limit}:]}))" 2>&1`
          );
          const elapsed = Date.now() - startTime;
          this.logger.info(`[realtime] ✓ read_channel_messages[${channelId}] (${elapsed}ms)`);
          return JSON.parse(output);
        } catch (err: any) {
          return { error: `Could not read channel ${channelId}: ${err.message}` };
        }
      }

      case 'send_message': {
        const channelId = args.channel_id as string;
        const message = args.message as string;
        // Use openclaw gateway call for sending (needs WS)
        try {
          const escaped = message.replace(/'/g, "'\\''");
          const output = await this.gateway.exec(
            `openclaw gateway call chat.send --json --token "${this.gateway!['authToken']}" --params '{"sessionKey":"agent:main:discord:channel:${channelId}","message":"${escaped}"}' --timeout 10000 2>&1`
          );
          const elapsed = Date.now() - startTime;
          this.logger.info(`[realtime] ✓ send_message[${channelId}] (${elapsed}ms)`);
          return { sent: true };
        } catch (err: any) {
          return { error: `Could not send to channel ${channelId}: ${err.message}` };
        }
      }

      case 'launch_agent': {
        const task = args.task as string;
        const project = args.project as string;
        // Launch via claude CLI in background
        try {
          const workspace = `/Users/todd/workspace/${project}`;
          const escaped = task.replace(/'/g, "'\\''");
          const output = await this.gateway.exec(
            `cd "${workspace}" && nohup claude --dangerously-skip-permissions -p '${escaped}' > /tmp/agent-${project}.log 2>&1 &
echo "Agent launched for ${project} (PID $!)"`
          );
          const elapsed = Date.now() - startTime;
          this.logger.info(`[realtime] ✓ launch_agent[${project}] (${elapsed}ms)`);
          return { launched: true, project, output: output.trim() };
        } catch (err: any) {
          return { error: `Could not launch agent for ${project}: ${err.message}` };
        }
      }

      case 'check_agent_status': {
        try {
          // Check for running claude processes
          const output = await this.gateway.exec(
            `ps aux | grep '[c]laude.*-p' | awk '{print $2, $11, $12, $13}' 2>/dev/null || echo "No agents running"`
          );
          const elapsed = Date.now() - startTime;
          this.logger.info(`[realtime] ✓ check_agent_status (${elapsed}ms)`);
          return { agents: output.trim() };
        } catch {
          return { error: 'Could not check agent status' };
        }
      }

      case 'run_command': {
        const command = args.command as string;
        const project = args.project as string | undefined;
        const cwd = project ? `/Users/todd/workspace/${project}` : '/Users/todd/workspace';
        const output = await this.gateway.exec(command, cwd);
        const elapsed = Date.now() - startTime;
        this.logger.info(`[realtime] ✓ run_command (${elapsed}ms)`);
        return { output };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  /**
   * Send function call result back to OpenAI
   */
  private sendFunctionResult(callId: string, result: any): void {
    const output = typeof result === 'string' ? result : JSON.stringify(result);
    this.logger.info(`[realtime] → Sending function result for ${callId} (${output.length} chars)`);

    // Send the function output
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output,
      },
    });

    // Trigger a new response so the AI can speak the result
    this.send({
      type: 'response.create',
    });
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
   * Commit the audio buffer
   */
  commitAudio(): void {
    if (!this.isConnected) return;
    this.send({ type: 'input_audio_buffer.commit' });
  }

  /**
   * Clear the audio buffer
   */
  clearAudio(): void {
    if (!this.isConnected) return;
    this.send({ type: 'input_audio_buffer.clear' });
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
    this.maxReconnectAttempts = 0;
    this.logger.info('[realtime] Disconnecting from OpenAI Realtime API');

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
  }
}
