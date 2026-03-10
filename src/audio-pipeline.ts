/**
 * Audio Pipeline
 * 
 * Handles audio format conversion between Discord and OpenAI.
 * 
 * Discord: 48kHz stereo Opus → decoded to PCM16
 * OpenAI: 24kHz mono PCM16
 */

import { Transform, Readable } from 'stream';
import OpusScript from 'opusscript';
import type { Logger } from './types.js';

interface AudioPipelineConfig {
  logger: Logger;
  onProcessedAudio: (audio: Buffer) => void;
}

export class AudioPipeline {
  private config: AudioPipelineConfig;
  private logger: Logger;
  private opusDecoder: any;
  private audioBuffer: Buffer[] = [];

  constructor(config: AudioPipelineConfig) {
    this.config = config;
    this.logger = config.logger;

    // Use opusscript (WASM) instead of @discordjs/opus (native C) to avoid segfaults
    // Native opus crashes in silk_NLSF2A on certain DAVE-decrypted packets
    this.opusDecoder = new OpusScript(48000, 2, (OpusScript as any).Application.AUDIO);
  }

  /**
   * Process incoming Discord audio (Opus frames)
   * Convert to 24kHz mono PCM16 for OpenAI
   */
  processDiscordAudio(opusFrame: Buffer): void {
    try {
      // Decode Opus to PCM16 (48kHz stereo)
      const pcm48kStereo = this.opusDecoder.decode(opusFrame);
      
      // Convert to 24kHz mono
      const pcm24kMono = this.resample48kStereoTo24kMono(pcm48kStereo);
      
      // Send to OpenAI
      this.config.onProcessedAudio(pcm24kMono);
    } catch (err) {
      this.logger.error('Audio decode error:', err);
    }
  }

  /**
   * Convert 48kHz stereo PCM16 to 24kHz mono PCM16
   */
  private resample48kStereoTo24kMono(input: Buffer): Buffer {
    // Input: 48kHz stereo = 4 bytes per sample (2 channels × 2 bytes)
    // Output: 24kHz mono = 2 bytes per sample
    // Ratio: 48k/24k = 2, so we take every 2nd sample
    // And we mix stereo to mono
    
    const inputSamples = input.length / 4; // stereo samples
    const outputSamples = Math.floor(inputSamples / 2); // downsample by 2
    const output = Buffer.alloc(outputSamples * 2);
    
    for (let i = 0; i < outputSamples; i++) {
      const srcIdx = i * 2 * 4; // 2x for downsampling, 4 bytes per stereo sample
      
      // Read left and right channels
      const left = input.readInt16LE(srcIdx);
      const right = input.readInt16LE(srcIdx + 2);
      
      // Mix to mono (average)
      const mono = Math.round((left + right) / 2);
      
      output.writeInt16LE(mono, i * 2);
    }
    
    return output;
  }

  /**
   * Convert 24kHz mono PCM16 to Discord format (48kHz stereo PCM16 stream)
   * Returns a Readable stream for createAudioResource
   * @deprecated Use convertToDiscordBuffer instead
   */
  convertToDiscordFormat(input: Buffer): Readable {
    const output = this.convertToDiscordBuffer(input);
    const stream = new Readable({
      read() {
        this.push(output);
        this.push(null);
      }
    });
    return stream;
  }

  /**
   * Convert 24kHz mono PCM16 to Discord format (48kHz stereo PCM16)
   * Returns a raw Buffer for writing into a PassThrough stream.
   */
  convertToDiscordBuffer(input: Buffer): Buffer {
    // Input: 24kHz mono = 2 bytes per sample
    // Output: 48kHz stereo = 4 bytes per sample
    // Ratio: 48k/24k = 2, so we duplicate each sample

    const inputSamples = input.length / 2;
    const outputSamples = inputSamples * 2; // upsample by 2
    const output = Buffer.alloc(outputSamples * 4); // stereo

    for (let i = 0; i < inputSamples; i++) {
      const sample = input.readInt16LE(i * 2);

      // Write twice (upsample) and duplicate to both channels
      const outIdx1 = i * 2 * 4;
      const outIdx2 = outIdx1 + 4;

      // First sample (left, right)
      output.writeInt16LE(sample, outIdx1);
      output.writeInt16LE(sample, outIdx1 + 2);

      // Second sample (interpolated - same for simplicity)
      output.writeInt16LE(sample, outIdx2);
      output.writeInt16LE(sample, outIdx2 + 2);
    }

    return output;
  }

  /**
   * Flush any buffered audio
   */
  flush(): void {
    // Currently no buffering, but here for future use
    this.audioBuffer = [];
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.audioBuffer = [];
  }
}
