import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';

@Injectable()
export class SseService implements OnModuleDestroy {
  private readonly subject = new Subject<MessageEvent>();
  private clients = 0;

  emit(data: Record<string, unknown>): void {
    const event: MessageEvent = {
      data: JSON.stringify(data),
    } as MessageEvent;
    this.subject.next(event);
  }

  subscribe(): Observable<MessageEvent> {
    this.clients++;
    return new Observable<MessageEvent>((observer) => {
      const subscription = this.subject.subscribe({
        next: (event) => observer.next(event),
        error: (err) => observer.error(err),
        complete: () => observer.complete(),
      });
      return () => {
        subscription.unsubscribe();
        this.clients--;
      };
    });
  }

  /** 当前活跃 SSE 连接数（瞬时值，监控 overview 的 sse gauge 用；1.54.0 埋点批） */
  getActiveConnections(): number {
    return this.clients;
  }

  onModuleDestroy() {
    this.subject.complete();
  }
}
