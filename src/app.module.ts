import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PuppeteerService } from './puppeteer.service';
import { ConfigModule } from '@nestjs/config';
import { MessagesModule } from './messages/messages.module';
import { CloudflaredService } from './cloudflared.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MessagesModule,
  ],
  controllers: [AppController],
  providers: [AppService, PuppeteerService, CloudflaredService],
})
export class AppModule {}
