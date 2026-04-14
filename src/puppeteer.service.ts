import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import puppeteer, { Browser, Page } from 'puppeteer';

@Injectable()
export class PuppeteerService implements OnModuleInit, OnModuleDestroy {
  private browser!: Browser;
  private page!: Page;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const headless = this.configService.get('PUPPETEER_HEADLESS') === 'true';
    const baseUrl = this.configService.get<string>('PUPPETEER_BASE_URL');

    this.browser = await puppeteer.launch({
      headless,
    });

    this.page = await this.browser.newPage();
    await this.page.goto(baseUrl!, { waitUntil: 'domcontentloaded' });

    console.log('Браузер открыт');
  }

  async onModuleDestroy() {
    if (this.browser) {
      await this.browser.close();
    }
  }
}
