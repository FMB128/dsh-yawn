/**
 * Pull-based message source for a connect bidirectional request stream: connect
 * pulls the next message when it is ready to send, while the producer pushes
 * messages whenever its own events arrive.
 *
 * `throw` is part of the contract connect's abort handling requires of a
 * request iterable: it injects the abort reason into the source.
 *
 * @module @zhming0/dsh-yawn/message-queue
 */

export class MessageQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private waiting:
    | {
        resolve: (result: IteratorResult<T>) => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  private ended = false;
  private failure: Error | undefined;

  push(message: T): void {
    if (this.ended || this.failure !== undefined) {
      throw new Error("the request stream is closed");
    }
    const waiting = this.waiting;
    this.waiting = undefined;
    if (waiting === undefined) {
      this.buffered.push(message);
      return;
    }
    waiting.resolve({ done: false, value: message });
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.resolve({ done: true, value: undefined as never });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.failure !== undefined) {
          return Promise.reject(this.failure);
        }
        const message = this.buffered.shift();
        if (message !== undefined) {
          return Promise.resolve({ done: false, value: message });
        }
        if (this.ended) {
          return Promise.resolve({ done: true, value: undefined as never });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiting = { resolve, reject };
        });
      },
      throw: (error: unknown) => {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        this.ended = true;
        this.failure = failure;
        const waiting = this.waiting;
        this.waiting = undefined;
        waiting?.reject(failure);
        return Promise.reject(failure);
      },
      return: () => {
        this.end();
        return Promise.resolve({ done: true, value: undefined as never });
      },
    };
  }
}

export default MessageQueue;
