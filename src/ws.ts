import { WebSocketServer, WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'http';
import type { WebSocketEvents } from './types.js';

type ClientInfo = {
  ws: WebSocket;
  playerID: string;
  name?: string;
  location?: { latitude: number; longitude: number } | null;
  opponentID?: string;
  // last known game state published by the client
  lastState?: { total?: number; history?: any[] } | null;
};

export class WSManager {
  private wss: WebSocketServer;
  private clients = new Map<string, ClientInfo>(); // playerID -> client
  private usedPlayerIDs = new Set<string>(); // Track used 4-digit IDs
  private wsToClient = new Map<WebSocket, ClientInfo>(); // track socket -> client until assigned
  // Timers for debouncing offline notifications (to avoid flicker on quick reloads)
  private offlineTimers = new Map<string, NodeJS.Timeout>();
  private readonly OFFLINE_DEBOUNCE_MS = 2000;
  private dataFilePath: string;
  // Track last time we broadcast 'player:online' per player to avoid duplicate notifications on quick reconnects
  private lastOnlineBroadcast = new Map<string, number>();
  private readonly ONLINE_BROADCAST_DEBOUNCE_MS = 1500;

  constructor(server: any) {
    this.wss = new WebSocketServer({ server });
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => this.onConnection(ws, req));
    this.dataFilePath = path.join(process.cwd(), 'data', 'used_player_ids.json');

    // Load previously used IDs from disk (if any)
    this.loadUsedIDs().catch(err => console.error('Failed to load used player IDs:', err));
  }

  private async loadUsedIDs() {
    try {
      const dir = path.dirname(this.dataFilePath);
      await fs.promises.mkdir(dir, { recursive: true });
      if (!fs.existsSync(this.dataFilePath)) return;
      const raw = await fs.promises.readFile(this.dataFilePath, 'utf8');
      const arr: string[] = JSON.parse(raw);
      for (const id of arr) this.usedPlayerIDs.add(id);
      console.log(`📦 Loaded ${this.usedPlayerIDs.size} used player IDs from ${this.dataFilePath}`);
    } catch (err) {
      console.error('Error loading used player IDs:', err);
    }
  }

  private async saveUsedIDs() {
    // Serialize saves to avoid concurrent write/rename races
    if ((this as any).savingPromise) {
      // Chain another save after the current one so that the latest state is eventually persisted
      (this as any).savingPromise = (this as any).savingPromise.then(() => this.saveUsedIDs());
      return (this as any).savingPromise;
    }

    (this as any).savingPromise = (async () => {
      try {
        const dir = path.dirname(this.dataFilePath);
        // Ensure directory exists before writing
        await fs.promises.mkdir(dir, { recursive: true });
        const tmp = `${this.dataFilePath}.tmp`;

        // Write temp file first
        try {
          await fs.promises.writeFile(tmp, JSON.stringify(Array.from(this.usedPlayerIDs)), 'utf8');
        } catch (writeErr) {
          console.error('Error writing temp used_player_ids file:', writeErr);
          // As a fallback, attempt to write directly to the final path
          try {
            await fs.promises.writeFile(this.dataFilePath, JSON.stringify(Array.from(this.usedPlayerIDs)), 'utf8');
            return;
          } catch (directErr) {
            console.error('Error writing used_player_ids directly after temp write failure:', directErr);
            throw writeErr;
          }
        }

        // Try to atomically rename the temp file into place
        try {
          await fs.promises.rename(tmp, this.dataFilePath);
        } catch (renameErr) {
          console.error('Error renaming temp used_player_ids file to final path:', renameErr);
          // If rename failed (e.g., tmp disappeared), attempt final write as a robust fallback
          try {
            const data = JSON.stringify(Array.from(this.usedPlayerIDs));
            await fs.promises.writeFile(this.dataFilePath, data, 'utf8');
            // Best-effort: remove tmp if it still exists
            try { await fs.promises.unlink(tmp); } catch (e) { /* ignore */ }
            return;
          } catch (finalErr) {
            console.error('Final fallback write failed for used_player_ids:', finalErr);
            throw renameErr;
          }
        }
      } catch (err) {
        console.error('Error saving used player IDs:', err);
      } finally {
        // clear the saving promise so future saves can proceed
        (this as any).savingPromise = null;
      }
    })();

    return (this as any).savingPromise;
  }

  private generateUniquePlayerID() {
    let playerID: string;
    let attempts = 0;
    do {
      // Generate random 4-digit number (1000-9999)
      const randomNum = Math.floor(Math.random() * 9000) + 1000;
      playerID = randomNum.toString();
      attempts++;
      // Safety check to prevent infinite loop
      if (attempts > 1000) {
        throw new Error('Unable to generate unique player ID');
      }
    } while (this.usedPlayerIDs.has(playerID) || this.clients.has(playerID));
    this.usedPlayerIDs.add(playerID);
    // Persist to disk (don't await to avoid blocking the WS thread)
    this.saveUsedIDs().catch(err => console.error('Failed to save used IDs:', err));
    return playerID;
  }

  private onConnection(ws: WebSocket, req: IncomingMessage) {
    // Initially, we don't know the player ID - client will send it or request a new one
    let tempPlayerID = `temp_${Date.now()}_${Math.random()}`;
    const clientInfo: ClientInfo = {
      ws,
      playerID: tempPlayerID,
      name: 'Unknown Player'
    };

    // Temporarily store mapping by WebSocket until a real playerID is assigned
    this.wsToClient.set(ws, clientInfo);
    console.log(`🔌 New WebSocket connection established (awaiting player ID)`);

    // Send connection established message - client should respond with existing ID or request new one
    ws.send(JSON.stringify({ type: 'connection:established', payload: {} }));

    // Handle incoming messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as WebSocketEvents;
        this.handleMessage(ws, message);
      } catch (error) {
        console.error('Error parsing message:', error);
      }
    });

    ws.on('close', () => {
      // Remove mapping from wsToClient and schedule offline notification (debounced)
      const client = this.wsToClient.get(ws);
      if (client) {
        const pid = client.playerID;
        this.wsToClient.delete(ws);
        // If this ws had an assigned (non-temp) playerID, schedule offline notification
        if (!pid.startsWith('temp_') && this.clients.has(pid)) {
          const existing = this.clients.get(pid);
          // Only schedule if the stored client matches this ws (avoid race where another ws replaced it)
          if (existing && existing.ws === ws) {
            console.log(`🚪 Player connection closed (debounced): ${pid}`);
            const timer = setTimeout(() => {
              console.log(`⏱️ Offline debounce expired, marking player offline: ${pid}`);
              this.clients.delete(pid);
              this.offlineTimers.delete(pid);
              // Clear last online timestamp so a subsequent quick reconnect will be broadcast
              this.lastOnlineBroadcast.delete(pid);
              // Notify only the opponent (if any) instead of broadcasting to everyone
              this.sendPlayerOffline(pid);
            }, this.OFFLINE_DEBOUNCE_MS);
            this.offlineTimers.set(pid, timer);
          }
        }
      } else {
        // As a fallback, scan clients for matching ws and schedule offline
        for (const [playerID, c] of this.clients.entries()) {
          if (c.ws === ws) {
            console.log(`🚪 Player connection closed (debounced): ${playerID}`);
            const timer = setTimeout(() => {
              console.log(`⏱️ Offline debounce expired, marking player offline: ${playerID}`);
              this.clients.delete(playerID);
              this.offlineTimers.delete(playerID);
              this.lastOnlineBroadcast.delete(playerID);
              // Notify only the opponent (if any)
              this.sendPlayerOffline(playerID);
            }, this.OFFLINE_DEBOUNCE_MS);
            this.offlineTimers.set(playerID, timer);
            break;
          }
        }
      }
    });
  }

  private handleMessage(ws: WebSocket, message: any) {
    // Find client by WebSocket mapping
    const client = this.wsToClient.get(ws);
    if (!client) return;
    const currentPlayerID = client.playerID;

    const typeStr = message && typeof message.type === 'string' ? message.type : '';

    switch (typeStr) {
      case 'player:request_id': {
        // Client requesting a new player ID with their chosen name
        const playerName = (message.payload as any)?.name as string | undefined;
        const newPlayerID = this.generateUniquePlayerID();
        // Assign real ID and name to client
        client.playerID = newPlayerID;
        client.name = playerName || `Player ${newPlayerID}`;
        // If another ws was previously associated with this ID, close it
        const prev = this.clients.get(newPlayerID);
        if (prev && prev.ws !== ws) {
          try { prev.ws.close(); } catch (e) { /* ignore */ }
          // Remove previous mapping from wsToClient as well
          this.wsToClient.delete(prev.ws);
        }
        this.clients.set(newPlayerID, client);
        // Ensure wsToClient maps to the updated client
        this.wsToClient.set(ws, client);
        console.log(`🎮 New player ID assigned: ${newPlayerID} (${client.name})`);
        console.log(`👥 Total connected players: ${this.clients.size}`);
        // Send the new ID to client
        ws.send(JSON.stringify({ type: 'player:id_assigned', payload: { playerID: newPlayerID } }));
        // Notify others that player is online (debounced to avoid duplicates on quick reconnects)
        this.sendPlayerOnline(newPlayerID);
        break;
      }

      case 'player:reconnect': {
        // Client reconnecting with existing player ID
        const existingPlayerID = message.payload?.playerID as string | undefined;
        if (existingPlayerID && /^\d{4}$/.test(existingPlayerID)) {
          // If there was a pending offline timer for this player (quick reconnect), cancel it
          const pending = this.offlineTimers.get(existingPlayerID);
          if (pending) {
            clearTimeout(pending);
            this.offlineTimers.delete(existingPlayerID);
          }

          // Assign the existing ID to this ws. If another connection already holds it, replace/close it.
          const prev = this.clients.get(existingPlayerID);
          if (prev && prev.ws !== ws) {
            try { prev.ws.close(); } catch (e) { /* ignore */ }
            this.wsToClient.delete(prev.ws);
          }
          client.playerID = existingPlayerID;
          client.name = (message.payload as any)?.name || `Player ${existingPlayerID}`;
          this.clients.set(existingPlayerID, client);
          this.wsToClient.set(ws, client);
          // Track this ID as used and persist
          this.usedPlayerIDs.add(existingPlayerID);
          this.saveUsedIDs().catch(err => console.error('Failed to save used IDs:', err));
          console.log(`🔄 Player reconnected: ${existingPlayerID} (${client.name})`);
          console.log(`👥 Total connected players: ${this.clients.size}`);
          // Confirm reconnection
          ws.send(JSON.stringify({ type: 'player:reconnected', payload: { playerID: existingPlayerID } }));
          // Notify others that player is online (debounced to avoid duplicates on quick reconnects)
          this.sendPlayerOnline(existingPlayerID);
          // If we have a last-known state for this player, and they have an opponent, inform the opponent so their UI updates
          if (client.lastState && client.opponentID) {
            const opponentIDToNotify = client.opponentID;
            const gameState = client.lastState;
            const payload = { opponentID: existingPlayerID, opponentName: client.name || '', gameState };
            const opponent = this.clients.get(opponentIDToNotify);
            if (opponent && opponent.ws && opponent.ws.readyState === opponent.ws.OPEN) {
              this.send(opponentIDToNotify, { type: 'game:resume', payload } as any);
            }
          }
        } else {
          // Invalid player ID, request new one
          ws.send(JSON.stringify({ type: 'player:invalid_id', payload: { message: 'Invalid player ID format' } }));
        }
        break;
      }

      case 'player:update_name': {
        client.name = (message.payload as any)?.name || client.name || '';
        // Notify only the opponent about name change (don't broadcast to everyone)
        if (client.opponentID) {
          const opponent = this.clients.get(client.opponentID);
          if (opponent && opponent.ws && opponent.ws.readyState === opponent.ws.OPEN) {
            this.send(opponent.playerID, { type: 'player:name_changed', payload: { playerID: client.playerID, name: client.name || '' } } as any);
          } else {
            console.log(`ℹ️ Name changed for ${client.playerID}, but opponent ${client.opponentID} not connected`);
          }
        } else {
          console.log(`ℹ️ Name changed for ${client.playerID} but no opponent to notify`);
        }
        break;
      }

      case 'player:state_update': {
        // Store lightweight player state for resume/discovery
        const payload = (message.payload as any) || {};
        // Update client fields
        if (payload.name) client.name = payload.name;
        if (payload.location) client.location = payload.location;
        if (payload.opponentID) client.opponentID = payload.opponentID;
        client.lastState = { total: payload.total, history: payload.history };

        // Do NOT forward this on every state update — that causes excessive resume messages.
        // Resume notifications are sent on reconnect (handled elsewhere) so opponents get a single sync.
        break;
      }

      case 'player:update_location': {
        client.location = (message.payload as any) || null;
        break;
      }

      case 'game:start': {
        const opponentID = (message.payload as any)?.opponentID as string | undefined;
        // Prevent starting a game with oneself
        if (!opponentID || opponentID === currentPlayerID) {
          ws.send(JSON.stringify({ type: 'game:error', payload: { message: 'Cannot start a game with yourself' } }));
          break;
        }
        const opponent = this.clients.get(opponentID);
        if (opponent) {
          // Set up opponent relationship
          client.opponentID = opponentID;
          opponent.opponentID = currentPlayerID;
          // Notify both players
          this.send(currentPlayerID, {
            type: 'game:auto_joined',
            payload: { opponentID, opponentName: opponent.name || '' }
          });
          this.send(opponentID, {
            type: 'game:auto_joined',
            payload: { opponentID: currentPlayerID, opponentName: client.name || '' }
          });
        }
        break;
      }

      case 'game:score_update': {
        const targetOpponentID = (message.payload as any)?.opponentID as string | undefined;
        if (targetOpponentID) {
          this.send(targetOpponentID, {
            type: 'game:opponent_scored',
            payload: { score: (message.payload as any)?.score || 0, playerID: currentPlayerID }
          });
        }
        break;
      }

      case 'game:apply_brisks': {
        // Sender instructs the opponent to apply brisk points to their own total
        const targetOpponentID = (message.payload as any).opponentID as string | undefined;
        const briskCount = (message.payload as any).briskCount;
        // Basic validation: do not allow applying brisks to self
        if (!targetOpponentID || targetOpponentID === currentPlayerID) break;
        const target = this.clients.get(targetOpponentID);
        if (target && target.ws && target.ws.readyState === target.ws.OPEN) {
          // Forward to the opponent indicating who it's from
          this.send(targetOpponentID, { type: 'game:apply_brisks', payload: { briskCount, from: currentPlayerID } as any });
        }
        break;
      }

  case 'game:opponent_undo': {
        const targetOpponentID = (message.payload as any).opponentID as string | undefined;
        // Basic validation: do not allow undo-for-self
        if (!targetOpponentID || targetOpponentID === currentPlayerID) break;
        const target = this.clients.get(targetOpponentID);
        if (target && target.ws && target.ws.readyState === target.ws.OPEN) {
          this.send(targetOpponentID, {
            type: 'game:opponent_undo',
            payload: { points: (message.payload as any)?.points, briskValue: (message.payload as any)?.briskValue, from: currentPlayerID }
          });
        }
        break;
      }

      case 'game:reset': {
        const targetOpponentID = (message.payload as any)?.opponentID as string | undefined;
        if (!targetOpponentID || targetOpponentID === currentPlayerID) break;
        const target = this.clients.get(targetOpponentID);
        if (target && target.ws && target.ws.readyState === target.ws.OPEN) {
          this.send(targetOpponentID, { type: 'game:reset', payload: { from: currentPlayerID } } as any);
        }
        break;
      }

  case 'players:get_all': {
        // Exclude the requester from the returned list so users don't see themselves
        const allPlayers = this.getAllPlayers(currentPlayerID);
        console.log(`📋 Player ${currentPlayerID} requested all players. Found ${allPlayers.length} players (excluding self).`);
        // Ensure names are strings
        const safePlayers = allPlayers.map(p => ({ ...p, name: p.name || '' }));
        this.send(currentPlayerID, { type: 'players:list', payload: { players: safePlayers } } as any);
        break;
      }

      case 'players:search': {
        const searchTerm = (message.payload as any)?.searchTerm as string | undefined;
        if (!searchTerm || !searchTerm.trim()) {
          this.send(currentPlayerID, { type: 'players:search_results', payload: { players: [] } } as any);
          break;
        }
        
        const searchResults = this.searchPlayers(currentPlayerID, searchTerm.trim());
        console.log(`🔍 Player ${currentPlayerID} searched for "${searchTerm}". Found ${searchResults.length} results.`);
        this.send(currentPlayerID, { type: 'players:search_results', payload: { players: searchResults } } as any);
        break;
      }
    }
  }

  send(playerID: string, message: WebSocketEvents) {
    const client = this.clients.get(playerID);
    if (client && client.ws.readyState === client.ws.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }

  broadcast(message: WebSocketEvents) {
    const data = JSON.stringify(message);
    for (const { ws } of this.clients.values()) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  isOnline(playerID: string) {
    return this.clients.has(playerID);
  }

  /**
   * Get all connected players. If excludePlayerID is provided, omit that player from the results.
   */
  getAllPlayers(excludePlayerID?: string) {
    return Array.from(this.clients.entries())
      .filter(([playerID]) => playerID !== excludePlayerID)
      .map(([playerID, client]) => ({
        playerID,
        name: client.name,
        isOnline: client.ws.readyState === client.ws.OPEN,
        location: client.location ? { x: (client.location as any).longitude, y: (client.location as any).latitude } : undefined
      }));
  }

  /**
   * Search for players by ID or name. Returns up to 5 matches, excluding the requester.
   * If search term is exactly 4 digits, prioritize exact ID matches first.
   */
  searchPlayers(excludePlayerID: string, searchTerm: string) {
    const results: any[] = [];
    const lowerSearchTerm = searchTerm.toLowerCase();
    const isExact4DigitSearch = /^\d{4}$/.test(searchTerm);
    
    // If searching for exact 4-digit ID, check for exact match first
    if (isExact4DigitSearch) {
      const exactMatch = this.clients.get(searchTerm);
      if (exactMatch && searchTerm !== excludePlayerID) {
        results.push({
          playerID: searchTerm,
          name: exactMatch.name || '',
          isOnline: exactMatch.ws.readyState === exactMatch.ws.OPEN,
          location: exactMatch.location ? { x: (exactMatch.location as any).longitude, y: (exactMatch.location as any).latitude } : undefined
        });
      }
    }
    
    // Then search through all players for partial matches
    for (const [playerID, client] of this.clients.entries()) {
      // Exclude the requester from search results
      if (playerID === excludePlayerID) continue;
      
      // Skip if already added as exact match
      if (isExact4DigitSearch && playerID === searchTerm) continue;

      const playerName = (client.name || '').toLowerCase();
      const playerIDLower = playerID.toLowerCase();

      // Match by player ID or name
      if (playerIDLower.includes(lowerSearchTerm) || playerName.includes(lowerSearchTerm)) {
        results.push({
          playerID,
          name: client.name || '',
          isOnline: client.ws.readyState === client.ws.OPEN,
          location: client.location ? { x: (client.location as any).longitude, y: (client.location as any).latitude } : undefined
        });

        // Limit to 5 results total
        if (results.length >= 5) break;
      }
    }

    return results;
  }

  private sendPlayerOnline(playerID: string) {
    const now = Date.now();
    const last = this.lastOnlineBroadcast.get(playerID) || 0;
    if (now - last < this.ONLINE_BROADCAST_DEBOUNCE_MS) {
      // Skip broadcasting duplicate online event
      return;
    }
    this.lastOnlineBroadcast.set(playerID, now);
    // Instead of broadcasting to everyone, notify only the opponent (if any)
    const client = this.clients.get(playerID);
    if (client && client.opponentID) {
      const opponent = this.clients.get(client.opponentID);
      if (opponent && opponent.ws && opponent.ws.readyState === opponent.ws.OPEN) {
        this.send(opponent.playerID, { type: 'player:online', payload: { playerID } } as any);
        return;
      }
    }
    // Fallback: if no opponent or opponent not connected, avoid broadcasting to all; just log
    console.log(`ℹ️ Player ${playerID} came online but no opponent to notify`);
  }

  private sendPlayerOffline(playerID: string) {
    const client = this.clients.get(playerID);
    if (client && client.opponentID) {
      const opponent = this.clients.get(client.opponentID);
      if (opponent && opponent.ws && opponent.ws.readyState === opponent.ws.OPEN) {
        this.send(opponent.playerID, { type: 'player:offline', payload: { playerID } } as any);
        return;
      }
    }
    // Fallback: log that offline had no opponent to notify
    console.log(`ℹ️ Player ${playerID} went offline but no opponent to notify`);
  }
}

