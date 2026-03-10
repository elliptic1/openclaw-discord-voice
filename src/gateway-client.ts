/**
 * OpenClaw Gateway Client
 *
 * Executes commands and calls gateway methods.
 * Since the plugin runs inside the gateway process, we use child_process
 * for shell commands and the CLI for gateway RPC calls.
 */

import { exec } from 'child_process';
import type { Logger } from './types.js';

interface GatewayClientConfig {
  port: number;
  authToken: string;
  logger: Logger;
}

export class GatewayClient {
  private authToken: string;
  private port: number;
  private logger: Logger;

  constructor(config: GatewayClientConfig) {
    this.authToken = config.authToken;
    this.port = config.port;
    this.logger = config.logger;
  }

  /**
   * Execute a shell command and return stdout
   */
  async exec(command: string, cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const options: any = {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      };
      if (cwd) options.cwd = cwd;

      exec(command, options, (error, stdout, stderr) => {
        if (error) {
          // Still return stdout if available (command may have partial output)
          if (stdout) {
            resolve(stdout.toString());
          } else {
            reject(new Error(stderr?.toString() || error.message));
          }
          return;
        }
        resolve(stdout.toString());
      });
    });
  }

  /**
   * Call an OpenClaw gateway RPC method via CLI
   */
  async call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const paramsJson = JSON.stringify(params);
    const cmd = `openclaw gateway call "${method}" --json --token "${this.authToken}" --params '${paramsJson}' --timeout 15000`;

    this.logger.info(`[gateway] RPC: ${method}`);

    try {
      const output = await this.exec(cmd);
      return JSON.parse(output);
    } catch (err: any) {
      this.logger.error(`[gateway] RPC error (${method}): ${err.message}`);
      throw err;
    }
  }
}
