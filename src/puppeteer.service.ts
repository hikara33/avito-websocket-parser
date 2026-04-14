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
  private readonly watchdogIntervalMs = 15000;
  private startupTask?: Promise<void>;
  private watchdogTimer?: NodeJS.Timeout;
  private baseUrl = 'https://www.avito.ru/profile/messenger';
  private loginTimeoutMs = 180000;
  private parserDebug = false;

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
    this.baseUrl =
      this.configService.get<string>('PUPPETEER_BASE_URL') ??
      'https://www.avito.ru/profile/messenger';
    const userDataDir = this.configService.get<string>('PUPPETEER_USER_DATA_DIR') ?? '.avito-profile';
    const executablePath = this.configService.get<string>('PUPPETEER_EXECUTABLE_PATH');
    this.loginTimeoutMs = Number(this.configService.get<string>('PUPPETEER_LOGIN_TIMEOUT_MS') ?? 180000);
    this.parserDebug = this.configService.get<string>('PUPPETEER_DEBUG_PARSER') === 'true';
    const userAgent =
      this.configService.get<string>('PUPPETEER_USER_AGENT') ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

    this.publishStatus('starting', 'Launching browser');

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
    this.browser.on('disconnected', () => {
      this.publishStatus('disconnected', 'Browser disconnected');
    });

    await this.createPage(userAgent);
    await this.gotoMessenger();
    this.startWatchdog();
    await this.waitForMessenger(this.loginTimeoutMs);
    await this.attachRealtimeListener();

    this.publishStatus('ready', 'Puppeteer listener started');
    this.logger.log('Puppeteer listener started');
  }

  async onModuleDestroy() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }

    if (this.browser) {
      await this.browser.close();
      this.publishStatus('stopped', 'Browser closed');
      this.logger.log('Puppeteer browser closed');
    }
  }

  private async createPage(userAgent: string): Promise<void> {
    if (!this.browser) {
      return;
    }

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
    this.page.on('framenavigated', () => {
      this.publishStatus('navigated', 'Page navigated, listener will be checked');
    });
    this.page.on('close', () => {
      this.publishStatus('reconnecting', 'Page closed, recreating tab');
    });

    await this.page.exposeFunction('emitIncomingMessage', (from: string, text: string) => {
      this.messagesService.publishMessage(from, text);
    });
    await this.page.exposeFunction('emitParserDebug', (details: string) => {
      if (this.parserDebug) {
        this.messagesService.publishStatus('parser_debug', details);
      }
    });
  }

  private async gotoMessenger(): Promise<void> {
    if (!this.page) {
      return;
    }

    this.publishStatus('loading', 'Opening Avito messenger');
    await this.page.goto(this.baseUrl, {
      waitUntil: 'domcontentloaded',
    });
    const blockedAtStartup = await this.failIfBlocked();
    if (blockedAtStartup) {
      this.publishStatus('blocked', 'IP temporarily restricted, pass checks manually');
      this.logger.warn(
        'Avito shows temporary IP restriction page. Keep browser open, pass checks manually, then open messenger page again.',
      );
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

    this.publishStatus('waiting_auth', 'Waiting for messenger UI, log in manually if needed');
    this.logger.log('Waiting for messenger UI. Log in manually if needed.');

    try {
      await this.page.waitForFunction(
        () => {
          const inMessenger = window.location.pathname.includes('/profile/messenger');
          const hasLikelyMessengerUi = Boolean(
            document.querySelector('[data-marker="chat-list"]') ||
              document.querySelector('[data-marker="messenger-chat-list"]') ||
              document.querySelector('[data-marker*="chat"]') ||
              document.querySelector('[data-marker*="message"]') ||
              document.querySelector('[class*="chat"]') ||
              document.querySelector('[class*="message"]'),
          );
          return inMessenger && hasLikelyMessengerUi;
        },
        { timeout: timeoutMs },
      );
      this.publishStatus('auth_ok', 'Messenger UI loaded');
    } catch {
      const currentUrl = this.page.url();
      if (currentUrl.includes('/profile/messenger')) {
        this.publishStatus('auth_partial', 'Messenger URL opened, continuing with fallback mode');
        this.logger.warn('Messenger selectors not found in time, continuing in fallback mode by URL.');
        return;
      }

      this.publishStatus('waiting_auth', 'Still waiting for messenger UI');
      throw new Error('Messenger page not ready yet');
    }
  }

  private async attachRealtimeListener(): Promise<void> {
    if (!this.page) {
      return;
    }

    const normalizedSenders = this.targetSenders;
    const debugMode = this.parserDebug;

    await this.page.evaluate((targetSenders, debug) => {
      const state = window as unknown as {
        __avitoListenerAttached?: boolean;
        __avitoProcessed?: Set<string>;
        emitParserDebug?: (details: string) => Promise<void>;
      };
      state.emitParserDebug =
        (window as unknown as { emitParserDebug?: (details: string) => Promise<void> }).emitParserDebug;
      if (state.__avitoListenerAttached) {
        if (debug && state.emitParserDebug) {
          void state.emitParserDebug('listener already attached');
        }
        return;
      }
      state.__avitoListenerAttached = true;
      state.__avitoProcessed = state.__avitoProcessed ?? new Set<string>();

      const readText = (node: Element | null): string =>
        (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

      const pickMessageNodes = (): Element[] =>
        [
          ...document.querySelectorAll(
            '[data-marker="chat-message"], [data-marker*="chat-message"], [data-marker*="message-item"], [class*="chat-message"]',
          ),
        ].filter((node) => node instanceof Element);

      const isIncoming = (container: Element): boolean => {
        const marker = (container.getAttribute('data-marker') ?? '').toLowerCase();
        const className = container.className.toString().toLowerCase();
        return (
          marker.includes('incoming') ||
          marker.includes('inbound') ||
          marker.includes('/in') ||
          className.includes('incoming') ||
          className.includes('inbound')
        );
      };

      const extractAndEmit = (container: Element) => {
        if (!isIncoming(container)) {
          return;
        }

        const from =
          readText(
            container.querySelector(
              '[data-marker="chat-message-author"], [data-marker*="author"], [data-marker*="sender"], [class*="author"], [class*="sender"], [class*="name"]',
            ),
          ) ||
          readText(container.closest('[data-marker*="chat"]')?.querySelector('[class*="name"]') ?? null);
        const text = readText(
          container.querySelector(
            '[data-marker="chat-message-text"], [data-marker*="message-text"], [data-marker*="text"], [class*="message-text"], [class*="text"]',
          ),
        );

        if (!from || !text) {
          if (debug && state.emitParserDebug) {
            void state.emitParserDebug('skip message: missing sender or text');
          }
          return;
        }

        const fromNormalized = from.toLowerCase();
        const isTarget = targetSenders.some((sender) => fromNormalized.includes(sender));
        if (!isTarget) {
          if (debug && state.emitParserDebug) {
            void state.emitParserDebug(`skip sender: ${from}`);
          }
          return;
        }

        const messageId =
          container.getAttribute('data-id') ??
          container.getAttribute('data-message-id') ??
          container.getAttribute('id') ??
          '';
        const key = `${messageId}::${from}::${text}`;
        if (state.__avitoProcessed?.has(key)) {
          return;
        }
        state.__avitoProcessed?.add(key);
        if (debug && state.emitParserDebug) {
          void state.emitParserDebug(`emit message from ${from}`);
        }

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
            for (const child of addedNode.querySelectorAll('[data-marker*="chat-message"], [class*="chat-message"]')) {
              extractAndEmit(child);
            }
          }
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }, normalizedSenders, debugMode);
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
    }
    this.watchdogTimer = setInterval(() => {
      void this.runWatchdog();
    }, this.watchdogIntervalMs);
  }

  private async runWatchdog(): Promise<void> {
    if (!this.browser || !this.page) {
      return;
    }

    if (this.page.isClosed()) {
      this.publishStatus('reconnecting', 'Page closed, creating new page');
      const userAgent =
        this.configService.get<string>('PUPPETEER_USER_AGENT') ??
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
      await this.createPage(userAgent);
      await this.gotoMessenger();
      await this.waitForMessenger(this.loginTimeoutMs);
      await this.attachRealtimeListener();
      this.publishStatus('ready', 'Recovered after closed page');
      return;
    }

    const currentUrl = this.page.url();
    if (!currentUrl.includes('/profile/messenger')) {
      this.publishStatus('recovering', 'Unexpected page, returning to messenger');
      await this.gotoMessenger();
      await this.waitForMessenger(this.loginTimeoutMs);
    }

    const blocked = await this.failIfBlocked();
    if (blocked) {
      this.publishStatus('blocked', 'IP restriction page detected');
      return;
    }

    await this.attachRealtimeListener();
    this.publishStatus('ready', 'Listener active');
  }

  private publishStatus(state: string, details?: string): void {
    this.messagesService.publishStatus(state, details);
  }
}
