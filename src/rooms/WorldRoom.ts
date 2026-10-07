import { Room, Client } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import {
  AVATAR_MAX_LEN,
  HATCH_COOLDOWN_MS,
  HATCH_MAX_PETS,
  NAME_MAX,
  PET_ID_MAX,
  PETS_MAX_LEN,
  POSE_MAX,
  ROOM_MAX_CLIENTS,
  WORLD_BOUNDS,
} from "../constants.js";

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function sanitizeAvatar(raw: unknown): string {
  return typeof raw === "string" && raw.length <= AVATAR_MAX_LEN ? raw : "";
}

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

const PET_ID = new RegExp(`^[a-z0-9_]{1,${PET_ID_MAX}}$`);
const isPetId = (raw: unknown): raw is string => typeof raw === "string" && PET_ID.test(raw);

/**
 * Room every client joins via `client.joinOrCreate("world", { userId, username, avatar })`.
 * Relays each player's pose, Bloxity avatar and equipped pets to the others, and
 * broadcasts rare-hatch announcements; holds no game rules.
 * Full rooms spill into a fresh one automatically (maxClients).
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;
  private lastHatch = new Map<string, number>();

  messages = {
    // Position / gait, throttled client-side (client data/config.js NET.sendHz).
    pose: (client: Client, msg: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const b = WORLD_BOUNDS;
      if (finite(msg?.x)) p.x = clamp(msg.x, b.minX, b.maxX);
      if (finite(msg?.y)) p.y = clamp(msg.y, b.minY, b.maxY);
      if (finite(msg?.z)) p.z = clamp(msg.z, b.minZ, b.maxZ);
      if (finite(msg?.yaw)) p.yaw = msg.yaw;
      if (finite(msg?.speed01)) p.speed01 = clamp(msg.speed01, 0, 1);
      if (typeof msg?.grounded === "boolean") p.grounded = msg.grounded;
      if (msg?.pose === null) p.pose = "";
      else if (typeof msg?.pose === "string" && msg.pose.length <= POSE_MAX) p.pose = msg.pose;
    },
    // Bloxity avatar JSON; sent on connect and whenever the portal reports a change.
    setAvatar: (client: Client, msg: { avatar?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      // "" = signed out (back to the default look); an oversized or non-string payload is ignored.
      if (typeof msg?.avatar === "string" && msg.avatar.length <= AVATAR_MAX_LEN) p.avatar = msg.avatar;
    },
    // Equipped pets, comma-joined ids; anything malformed is ignored.
    setPets: (client: Client, msg: { pets?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof msg?.pets !== "string" || msg.pets.length > PETS_MAX_LEN) return;
      if (msg.pets === "" || msg.pets.split(",").every(isPetId)) p.pets = msg.pets;
    },
    // A rare hatch: announced to everyone else as { username, pets }. Throttled per client.
    hatch: (client: Client, msg: { pets?: unknown }) => {
      const p = this.state.players.get(client.sessionId);
      const pets = msg?.pets;
      if (!p || !Array.isArray(pets) || !pets.length || pets.length > HATCH_MAX_PETS || !pets.every(isPetId)) return;
      const now = Date.now();
      if (now - (this.lastHatch.get(client.sessionId) ?? 0) < HATCH_COOLDOWN_MS) return;
      this.lastHatch.set(client.sessionId, now);
      this.broadcast("hatched", { username: p.username, pets }, { except: client });
    },
    // Re-states identity after a login/logout that happens AFTER join.
    identify: (client: Client, msg: { username?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (p && typeof msg?.username === "string") p.username = sanitizeName(msg.username);
    },
  };

  onJoin(client: Client, options?: { username?: string; avatar?: string }) {
    const p = new PlayerState();
    p.username = sanitizeName(options?.username);
    p.avatar = sanitizeAvatar(options?.avatar);
    this.state.players.set(client.sessionId, p);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.lastHatch.delete(client.sessionId);
  }
}
