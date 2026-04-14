import { Injectable } from '@nestjs/common';
import { MessagesGateway } from './messages.gateway';

@Injectable()
export class MessagesService {
  constructor(private gateway: MessagesGateway) {}

  publishMessage(from: string, text: string): void {
    this.gateway.sendMessage({
      from,
      text,
      ts: new Date().toISOString(),
    });
  }
}
