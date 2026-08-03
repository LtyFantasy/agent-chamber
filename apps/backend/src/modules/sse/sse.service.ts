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

  onModuleDestroy() {
    this.subject.complete();
  }
}
