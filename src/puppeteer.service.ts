import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import puppeteer, { Browser, Page } from 'puppeteer';
import { MessagesService } from './messages/messages.service';

@Injectable()
export class PuppeteerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PuppeteerService.name);
  private browser?: Browser;
  private page?: Page;
  private readonly targetSenders = ['рушан натфуллин', 'рушан'];
  private startupTask?: Promise<void>;

  constructor(
    private readonly configService: ConfigService,
    private readonly messagesService: MessagesService,
  ) {}

  async onModuleInit() {
    this.startupTask = this.startInBackground();
  }

  private async startInBackground(): Promise<void> {
    try {
      await this.startup();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Puppeteer startup failed: ${message}`);
    }
  }

  private async startup(): Promise<void> {
    const headless = this.configService.get('PUPPETEER_HEADLESS') === 'true';
    const baseUrl =
      this.configService.get<string>('PUPPETEER_BASE_URL') ??
      'https://www.avito.ru/profile/messenger';
    const userDataDir = this.configService.get<string>('PUPPETEER_USER_DATA_DIR') ?? '.avito-profile';
    const executablePath = this.configService.get<string>('PUPPETEER_EXECUTABLE_PATH');
    const loginTimeoutMs = Number(this.configService.get<string>('PUPPETEER_LOGIN_TIMEOUT_MS') ?? 180000);
    const userAgent =
      this.configService.get<string>('PUPPETEER_USER_AGENT') ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

    this.browser = await puppeteer.launch({
      headless,
      executablePath: executablePath || undefined,
      userDataDir,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    this.page = await this.browser.newPage();
    await this.page.setUserAgent(userAgent);
    await this.page.setExtraHTTPHeaders({
      'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    });
    await this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });
    this.page.setDefaultNavigationTimeout(90000);

    await this.page.exposeFunction('emitIncomingMessage', (from: string, text: string) => {
      this.messagesService.publishMessage(from, text);
    });

    await this.page.goto(baseUrl, {
      waitUntil: 'domcontentloaded',
    });

    const blockedAtStartup = await this.failIfBlocked();
    if (blockedAtStartup) {
      this.logger.warn(
        'Avito shows temporary IP restriction page. Keep browser open, pass checks manually, then open messenger page again.',
      );
    }

    await this.waitForMessenger(loginTimeoutMs);
    await this.attachRealtimeListener();

    this.logger.log('Puppeteer listener started');
  }

  async onModuleDestroy() {
    if (this.browser) {
      await this.browser.close();
      this.logger.log('Puppeteer browser closed');
    }
  }

  private async failIfBlocked(): Promise<boolean> {
    if (!this.page) {
      return false;
    }

    const blocked = await this.page.evaluate(() => {
      const text = (document.body?.innerText ?? '').toLowerCase();
      return (
        text.includes('доступ ограничен') ||
        text.includes('соединение с вашего ip') ||
        text.includes('подозрительная активность')
      );
    });

    return blocked;
  }

  private async waitForMessenger(timeoutMs: number): Promise<void> {
    if (!this.page) {
      return;
    }

    this.logger.log('Waiting for messenger UI. Log in manually if needed.');

    await this.page.waitForFunction(
      () =>
        Boolean(
          document.querySelector('[data-marker="chat-list"]') ||
            document.querySelector('[data-marker="messenger-chat-list"]'),
        ),
      { timeout: timeoutMs },
    );
  }

  private async attachRealtimeListener(): Promise<void> {
    if (!this.page) {
      return;
    }

    const normalized = this.targetSenders;

    await this.page.evaluate((targetSenders) => {
      const processed = new Set<string>();

      const readText = (node: Element | null): string =>
        (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

      const pickMessageNodes = (): Element[] => [
        ...document.querySelectorAll('[data-marker*="message"], [class*="message"]'),
      ];

      const extractAndEmit = (container: Element) => {
        const from =
          readText(container.querySelector('[data-marker*="author"], [class*="author"], [class*="name"]')) ||
          readText(container.closest('[data-marker*="chat"]')?.querySelector('[class*="name"]') ?? null);
        const text = readText(
          container.querySelector(
            '[data-marker*="text"], [data-marker*="message-text"], [class*="text"], [class*="message"]',
          ),
        );

        if (!from || !text) {
          return;
        }

        const fromNormalized = from.toLowerCase();
        const isTarget = targetSenders.some((sender) => fromNormalized.includes(sender));
        if (!isTarget) {
          return;
        }

        const key = `${from}::${text}`;
        if (processed.has(key)) {
          return;
        }
        processed.add(key);

        void (window as unknown as { emitIncomingMessage: (from: string, text: string) => Promise<void> }).emitIncomingMessage(
          from,
          text,
        );
      };

      for (const node of pickMessageNodes()) {
        extractAndEmit(node);
      }

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const addedNode of mutation.addedNodes) {
            if (!(addedNode instanceof Element)) {
              continue;
            }

            extractAndEmit(addedNode);
            for (const child of addedNode.querySelectorAll('[data-marker*="message"], [class*="message"]')) {
              extractAndEmit(child);
            }
          }
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }, normalized);
  }
}
