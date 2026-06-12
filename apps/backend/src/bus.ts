/**
 * In-process event bus for realtime fan-out. Events are persisted in the DB
 * (the durable replay source); the bus only handles live delivery to open
 * SSE connections — per stream and per user (the global activity feed).
 */

export interface BusEvent {
  streamKind: string;
  streamId: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  userId: string;
  createdAt: string;
}

type Listener = (event: BusEvent) => void;

export class EventBus {
  private streamListeners = new Map<string, Set<Listener>>();
  private userListeners = new Map<string, Set<Listener>>();

  private streamKey(kind: string, id: string): string {
    return `${kind}:${id}`;
  }

  publish(event: BusEvent): void {
    for (const l of this.streamListeners.get(this.streamKey(event.streamKind, event.streamId)) ??
      []) {
      try {
        l(event);
      } catch {
        // a broken subscriber must never break the publisher
      }
    }
    for (const l of this.userListeners.get(event.userId) ?? []) {
      try {
        l(event);
      } catch {
        // ignore
      }
    }
  }

  subscribeStream(kind: string, id: string, listener: Listener): () => void {
    const key = this.streamKey(kind, id);
    let set = this.streamListeners.get(key);
    if (!set) {
      set = new Set();
      this.streamListeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.streamListeners.delete(key);
    };
  }

  subscribeUser(userId: string, listener: Listener): () => void {
    let set = this.userListeners.get(userId);
    if (!set) {
      set = new Set();
      this.userListeners.set(userId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.userListeners.delete(userId);
    };
  }
}
