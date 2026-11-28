import type { WebSocket } from 'ws';
import type { SessionBoardDto } from './board.service.js';
import { publicBoard } from '../projection/projection.board.js';

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

  /// Les ecrans de projection, a part des joueurs : ils recoivent un plateau
  /// nettoye, et le MJ doit pouvoir les couper sans toucher a sa table.
  private readonly projectors = new Map<string, Set<WebSocket>>();

  join(sessionId: string, socket: WebSocket): void {
    add(this.rooms, sessionId, socket);
  }

  leave(sessionId: string, socket: WebSocket): void {
    remove(this.rooms, sessionId, socket);
  }

  joinProjection(sessionId: string, socket: WebSocket): void {
    add(this.projectors, sessionId, socket);
  }

  leaveProjection(sessionId: string, socket: WebSocket): void {
    remove(this.projectors, sessionId, socket);
  }

  listeners(sessionId: string): number {
    return this.rooms.get(sessionId)?.size ?? 0;
  }

  projections(sessionId: string): number {
    return this.projectors.get(sessionId)?.size ?? 0;
  }

  /// Tells everyone watching that the board moved.
  ///
  /// A socket that refuses the message is dropped rather than retried: the
  /// board is a state, not a stream of events, so the next push carries
  /// everything the missed one did. Whoever reconnects asks for it whole.
  publish(sessionId: string, board: SessionBoardDto): void {
    const room = this.rooms.get(sessionId);
    if (room) {
      const payload = JSON.stringify({ type: 'board', board });
      for (const socket of [...room]) {
        try {
          socket.send(payload);
        } catch {
          this.leave(sessionId, socket);
        }
      }
    }

    const screens = this.projectors.get(sessionId);
    if (screens) {
      const payload = JSON.stringify({ type: 'board', board: publicBoard(board) });
      for (const socket of [...screens]) {
        try {
          socket.send(payload);
        } catch {
          this.leaveProjection(sessionId, socket);
        }
      }
    }
  }

  /// Coupe tous les ecrans d'une seance : lien revoque ou remplace, seance
  /// annulee. Un ecran deja ouvert garderait sinon le plateau sous les yeux
  /// de la salle, alors que le lien qui l'a ouvert ne vaut plus rien.
  closeProjections(sessionId: string, message: string): void {
    const screens = this.projectors.get(sessionId);
    if (!screens) return;

    const payload = JSON.stringify({ type: 'closed', message });
    for (const socket of [...screens]) {
      try {
        socket.send(payload);
        socket.close();
      } catch {
        // Deja coupee : il n'y a plus rien a lui dire.
      }
    }
    this.projectors.delete(sessionId);
  }
}

function add(rooms: Map<string, Set<WebSocket>>, sessionId: string, socket: WebSocket): void {
  const room = rooms.get(sessionId) ?? new Set<WebSocket>();
  room.add(socket);
  rooms.set(sessionId, room);
}

function remove(rooms: Map<string, Set<WebSocket>>, sessionId: string, socket: WebSocket): void {
  const room = rooms.get(sessionId);
  if (!room) return;

  room.delete(socket);
  // An empty room would keep the session id alive forever, and a long-lived
  // API would end up holding one per evening ever played.
  if (room.size === 0) {
    rooms.delete(sessionId);
  }
}
