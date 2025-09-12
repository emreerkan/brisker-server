export interface Player {
  playerID: string;
  name: string;
  score?: number;
  history?: Array<{ id: string; points: number; timestamp: string; isBrisk?: boolean; briskValue?: number; source?: string; from?: string }>;
  opponentID?: string | null;
  location?: { x: number; y: number } | null;
}

export interface ScoreEntry {
  id: string;
  points: number;
  timestamp: string; // ISO
}

export interface GameState {
  total: number;
  brisk: number;
  history: ScoreEntry[];
  lastThreeScores: number[];
  currentOpponent?: Player;
}

export interface GameSession {
  session_id: string;
  player1_id: string | null;
  player2_id: string | null;
  player1_score: number;
  player2_score: number;
  game_state: GameState;
  status: 'waiting' | 'active' | 'completed' | 'abandoned';
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  winner_id: string | null;
  expires_at: string | null;
}

export type WebSocketEvents =
  | { type: 'connection:established'; payload: {} }
  | { type: 'player:id_assigned'; payload: { playerID: string } }
  | { type: 'player:reconnected'; payload: { playerID: string } }
  | { type: 'player:invalid_id'; payload: { message: string } }
  | { type: 'game:auto_joined'; payload: { opponentID: string; opponentName: string } }
  | { type: 'game:opponent_scored'; payload: { score: number; playerID: string } }
  | { type: 'game:apply_points'; payload: { points: number; from: string } }
  | { type: 'game:apply_points'; payload: { points: number; from: string; meta?: Record<string, any> } }
  | { type: 'game:opponent_undo'; payload: { points?: number; briskValue?: number; from?: string } }
  | { type: 'player:state_update'; payload: { playerID?: string; name?: string; history?: any[]; total?: number; opponentID?: string; location?: { latitude?: number; longitude?: number } } }
  | { type: 'game:resume'; payload: { opponentID: string; opponentName: string; gameState?: any } }
  | { type: 'game:error'; payload: { message: string } }
  | { type: 'player:online'; payload: { playerID: string } }
  | { type: 'player:offline'; payload: { playerID: string } }
  | { type: 'player:name_changed'; payload: { playerID: string; name: string } }
  | { type: 'players:list'; payload: { players: Array<{ playerID: string; name: string; isOnline: boolean; location?: { x: number; y: number } }> } };

export const BEZIQUE_POINTS = [
  20, 40, 50, 60, 80, 100, 150, 200, 250, 300, 400, 500, 600, 800, 1000, 1500,
];
export const BRISK_STEP = 20;
export const BRISK_MAX = 32;
export const WIN_THRESHOLD = 10000;

