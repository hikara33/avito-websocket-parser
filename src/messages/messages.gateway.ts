import {
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class MessagesGateway implements OnGatewayInit {
  @WebSocketServer()
  server!: Server;

  afterInit() {
    console.log('WebSocket initialized');
  }

  sendMessage(data: any): void {
    this.server.emit('message', data);
  }

  sendStatus(data: { state: string; details?: string; ts: string }): void {
    this.server.emit('status', data);
  }
}
