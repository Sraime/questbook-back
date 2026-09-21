import type { WebSocket } from 'ws';
import type { SessionBoardDto } from './board.service.js';

/// Who is currently watching which board, in memory.
///
/// In memory and not in the database on purpose: this is not a fact about the
/// evening, it is the list of sockets this process happens to hold. Losing it
/// on a restart is correct — the sockets die with the process, and every
/// client reconnects and asks for the board again.
///
/// The consequence to keep in mind: **this only works because the API runs as
/// a single process.** The day it runs twice behind Caddy, a game master
/// served by one instance would push to listeners the other one holds, and
/// nothing would arrive. That is the moment to put a broker between them, and
/// the reason this class is small enough to replace.
export class BoardLiveRegistry {
  private readonly rooms = new Map<string, Set<WebSocket>>();

  join(sessionId: string, socket: WebSocket): void {
    const room = this.rooms.get(sessionId) ?? new Set<WebSocket>();
    room.add(socket);
    this.rooms.set(sessionId, room);
  }

  leave(sessionId: string, socket: WebSocket): void {
    const room = this.rooms.get(sessionId);
    if (!room) return;

    room.delete(socket);
    // An empty room would keep the session id alive forever, and a long-lived
    // API would end up holding one per evening ever played.
    if (room.size === 0) {
      this.rooms.delete(sessionId);
    }
  }

  listeners(sessionId: string): number {
    return this.rooms.get(sessionId)?.size ?? 0;
  }

  /// Tells everyone watching that the board moved.
  ///
  /// A socket that refuses the message is dropped rather than retried: the
  /// board is a state, not a stream of events, so the next push carries
  /// everything the missed one did. Whoever reconnects asks for it whole.
  publish(sessionId: string, board: SessionBoardDto): void {
    const room = this.rooms.get(sessionId);
    if (!room) return;

    const payload = JSON.stringify({ type: 'board', board });

    for (const socket of [...room]) {
      try {
        socket.send(payload);
      } catch {
        this.leave(sessionId, socket);
      }
    }
  }
}
