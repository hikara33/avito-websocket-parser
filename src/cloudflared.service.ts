import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { MessagesService } from './messages/messages.service';

@Injectable()
export class CloudflaredService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CloudflaredService.name);
  private process?: ChildProcessWithoutNullStreams;
  private restartTimer?: NodeJS.Timeout;
  private isShuttingDown = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly messagesService: MessagesService,
  ) {}

  onModuleInit(): void {
    const enabled = this.configService.get<string>('CLOUDFLARED_ENABLED') === 'true';
    if (!enabled) {
      this.messagesService.publishStatus('cloudflared_disabled', 'Set CLOUDFLARED_ENABLED=true to auto-start tunnel');
      return;
    }

    this.startTunnel();
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }

    if (this.process && !this.process.killed) {
      this.process.kill();
    }
  }

  private startTunnel(): void {
    const bin = this.configService.get<string>('CLOUDFLARED_BIN') ?? 'cloudflared';
    const argsRaw = this.configService.get<string>('CLOUDFLARED_ARGS') ?? 'tunnel --url http://localhost:3000';
    const args = argsRaw.split(' ').filter(Boolean);

    this.messagesService.publishStatus('cloudflared_starting', `${bin} ${args.join(' ')}`);
    this.logger.log(`Starting cloudflared: ${bin} ${args.join(' ')}`);

    this.process = spawn(bin, args, {
      shell: true,
      stdio: 'pipe',
    });

    this.process.stdout.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (!line) {
        return;
      }

      if (line.includes('trycloudflare.com')) {
        this.messagesService.publishStatus('cloudflared_ready', line);
      }
      this.logger.log(`[cloudflared] ${line}`);
    });

    this.process.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (!line) {
        return;
      }

      this.messagesService.publishStatus('cloudflared_error', line);
      this.logger.warn(`[cloudflared] ${line}`);
    });

    this.process.on('exit', (code) => {
      this.messagesService.publishStatus('cloudflared_stopped', `exit code ${code ?? -1}`);
      this.logger.warn(`cloudflared exited with code ${code ?? -1}`);
      this.process = undefined;

      if (this.isShuttingDown) {
        return;
      }

      this.restartTimer = setTimeout(() => {
        this.startTunnel();
      }, 5000);
    });
  }
}
