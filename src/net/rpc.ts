/**
 * JSON-RPC 2.0 client for the roguelike GSP.
 *
 * All methods map directly to the RPC stubs defined in
 * ~/Projects/xayaroguelike/rpc-stubs/rog.json.
 */

// --- Response types (match statejson.cpp output) ---

export interface PlayerInfo {
  name: string;
  level: number;
  xp: number;
  gold: number;
  stats: {
    strength: number;
    dexterity: number;
    constitution: number;
    intelligence: number;
  };
  skill_points: number;
  stat_points: number;
  combat_record: {
    kills: number;
    deaths: number;
    visits_completed: number;
  };
  registered_height: number;
  hp: number;
  max_hp: number;
  current_segment: number;
  in_channel: boolean;
  effective_stats: {
    attack_power: number;
    defense: number;
    equip_attack: number;
    equip_defense: number;
  };
  inventory: Array<{
    item_id: string;
    quantity: number;
    slot: string;
    item_data?: string;
  }>;
  known_spells: string[];
  active_visit: { visit_id: number; segment_id: number } | null;
}

export interface SegmentSummary {
  id: number;
  discoverer: string;
  depth: number;
  max_players: number;
  created_height: number;
  visit_count: number;
}

export interface SegmentInfo {
  id: number;
  discoverer: string;
  seed: string;
  depth: number;
  max_players: number;
  created_height: number;
  gates: Record<string, { x: number; y: number }>;
  links: Record<string, { to_segment: number; to_direction: string }>;
  visits: Array<{
    id: number;
    initiator: string;
    status: string;
    created_height: number;
  }>;
}

export interface VisitSummary {
  id: number;
  segment_id: number;
  initiator: string;
  status: string;
  depth: number;
  max_players: number;
  created_height: number;
  players: number;
}

export interface FullState {
  players: Array<{
    name: string;
    level: number;
    gold: number;
    kills: number;
    deaths: number;
    visits_completed: number;
    hp: number;
    max_hp: number;
    current_segment: number;
    in_channel: boolean;
  }>;
  segments: SegmentSummary[];
  visits: VisitSummary[];
  dungeon_id?: string;
}

// --- RPC client ---

export class RpcClient {
  private nextId = 1;

  constructor(public url: string) {}

  private async call(method: string, params: unknown[]): Promise<unknown> {
    const body = {
      jsonrpc: "2.0",
      method,
      params,
      id: this.nextId++,
    };

    const resp = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new Error(`RPC HTTP ${resp.status}: ${resp.statusText}`);
    }

    const json = await resp.json();

    if (json.error) {
      throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
    }

    // The framework wraps results:
    //   getcurrentstate → result.gamestate
    //   custom methods  → result.data
    const result = json.result;
    if (result && typeof result === "object") {
      if ("gamestate" in result) return result.gamestate;
      if ("data" in result) return result.data;
    }
    return result;
  }

  async getcurrentstate(): Promise<FullState> {
    return (await this.call("getcurrentstate", [])) as FullState;
  }

  async getplayerinfo(name: string): Promise<PlayerInfo | null> {
    return (await this.call("getplayerinfo", [name])) as PlayerInfo | null;
  }

  async listsegments(): Promise<SegmentSummary[]> {
    return (await this.call("listsegments", [])) as SegmentSummary[];
  }

  async getsegmentinfo(id: number): Promise<SegmentInfo | null> {
    return (await this.call("getsegmentinfo", [id])) as SegmentInfo | null;
  }

  async listvisits(status: string): Promise<VisitSummary[]> {
    return (await this.call("listvisits", [status])) as VisitSummary[];
  }

  async waitforchange(knownBlock: string): Promise<string> {
    return (await this.call("waitforchange", [knownBlock])) as string;
  }
}
