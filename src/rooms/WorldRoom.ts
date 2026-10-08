import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import {
  AVATAR_MAX_LEN,
  GUEST_ID_PREFIX,
  HATCH_COOLDOWN_MS,
  HATCH_MAX_PETS,
  LEADERBOARD_QUERY_LIMIT,
  CURRENCY_MAX,
  LEADERBOARD_REFRESH_MS,
  LEADERBOARD_ROWS,
  NAME_MAX,
  OFFLINE_CASH_PER_HOUR,
  OFFLINE_MAX_SECONDS,
  OFFLINE_MIN_SECONDS,
  OFFLINE_STRENGTH_PER_HOUR,
  PET_ID_MAX,
  PETS_MAX_LEN,
  PLAYTIME_FLUSH_MS,
  POSE_MAX,
  RECONNECT_SECONDS,
  ROOM_MAX_CLIENTS,
  WORLD_BOUNDS,
} from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { sanitizeProgress, resolveTutorialStep } from "../sanitize.js";

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

// One board per stat, matching the four boards in the Leaderboards hall (client world/layout.js
// LEADER.boards: rebirths, cash, strength, time played).
const LEADERBOARD_STATS = ["rebirths", "cash", "strength", "playTime"] as const;
type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
// `avatar` (Bloxity avatar JSON) is only set on a board's #1 row: it drives that board's statue.
type LeaderboardRow = { id: string; name: string; value: number; avatar?: string };
type LeaderboardPayload = Record<LeaderboardStat, LeaderboardRow[]>;
type OnlineRow = { sessionId: string; userId: string | null; username: string; avatar: string } & Record<LeaderboardStat, number>;

// Collapse online rows that still share a userId (e.g. a leave/join racing the same tick) down
// to one, keeping the higher value for the ranked stat. Guests with no id are never collapsed.
function dedupeOnline(rows: OnlineRow[], stat: LeaderboardStat): OnlineRow[] {
  const byUserId = new Map<string, OnlineRow>();
  const anonymous: OnlineRow[] = [];
  for (const row of rows) {
    if (!row.userId) {
      anonymous.push(row);
      continue;
    }
    const existing = byUserId.get(row.userId);
    if (!existing || row[stat] > existing[stat]) byUserId.set(row.userId, row);
  }
  return [...byUserId.values(), ...anonymous];
}

// What `seconds` of offline time pays. Whole numbers only.
export function offlineReward(seconds: number) {
  const hours = Math.min(seconds, OFFLINE_MAX_SECONDS) / 3600;
  return {
    seconds,
    cash: Math.floor(hours * OFFLINE_CASH_PER_HOUR),
    strength: Math.floor(hours * OFFLINE_STRENGTH_PER_HOUR),
  };
}

/**
 * Room every client joins via `client.joinOrCreate("world", { userId, username, avatar })`.
 * Relays each player's pose, Bloxity avatar, equipped pets and aura to the others, broadcasts
 * rare-hatch announcements and the leaderboards, and saves/loads each signed-in player's progress
 * (MongoDB, see db.ts). The game is client-authoritative: no gameplay rules live here.
 * Full rooms spill into a fresh one automatically (maxClients).
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;
  private lastHatch = new Map<string, number>();

  // sessionId -> user id (Bloxity id). Deliberately NOT part of WorldState: it only gates this
  // room's own Mongo reads/writes. Guests have no entry.
  userIds = new Map<string, string>();

  // sessionIds that already got a progress/noProgress answer for their current identity.
  private identified = new Set<string>();

  // sessionId -> epoch ms up to which that connection's playtime has already been counted.
  private playTimeMark = new Map<string, number>();

  // sessionIds with a claimOffline in flight, so a double click can never pay twice.
  private claiming = new Set<string>();

  messages = {
    // Pays out the player's unclaimed offline time. The amount comes from the server's own
    // record (never the client); the doc is bumped here so a tab closed right after claiming
    // keeps the reward, and the client adds the same amounts to its local state.
    claimOffline: async (client: Client) => {
      const p = this.state.players.get(client.sessionId);
      const userId = this.userIds.get(client.sessionId);
      const players = getPlayers();
      if (!p || !userId || !players || this.claiming.has(client.sessionId)) return;
      this.claiming.add(client.sessionId);
      try {
        const doc = await players.findOne({ _id: userId });
        const seconds = doc?.offlineSeconds ?? 0;
        if (seconds < OFFLINE_MIN_SECONDS) return;
        const reward = offlineReward(seconds);
        const res = await players.updateOne(
          { _id: userId, offlineSeconds: seconds },
          { $set: { offlineSeconds: 0, updatedAt: new Date() }, $inc: { cash: reward.cash, strength: reward.strength } },
        );
        if (res && res.modifiedCount === 0) return; // lost a race with another session
        p.cash = Math.min(CURRENCY_MAX, p.cash + reward.cash);
        p.strength = Math.min(CURRENCY_MAX, p.strength + reward.strength);
        client.send("offlineClaimed", { cash: reward.cash, strength: reward.strength });
      } catch (err) {
        console.warn("[WorldRoom] claimOffline failed", err);
      } finally {
        this.claiming.delete(client.sessionId);
      }
    },
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
      this.persistAvatar(client.sessionId, p);
    },
    // Equipped pets, comma-joined ids; anything malformed is ignored.
    setPets: (client: Client, msg: { pets?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof msg?.pets !== "string" || msg.pets.length > PETS_MAX_LEN) return;
      if (msg.pets === "" || msg.pets.split(",").every(isPetId)) p.pets = msg.pets;
    },
    // Equipped aura id ("" = none); same id shape as pets.
    setAura: (client: Client, msg: { aura?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof msg?.aura !== "string") return;
      if (msg.aura === "" || isPetId(msg.aura)) p.aura = msg.aura;
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
    // Debounced push of the durable half of the client state (client usePlayerData). Upserts, so
    // a first save creates the document. Also refreshes the live values the leaderboards read.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch) return;
      this.applyLive(p, patch);

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      // The tutorial step only ever moves forward ($max), so a stale or replayed save can never
      // bring a finished tutorial back.
      const { tutorialStep, ...rest } = patch;
      try {
        await players.updateOne(
          { _id: userId },
          {
            // Display name comes from this connection's own PlayerState, not `msg`.
            $set: { ...rest, username: p.username || "Player", ...(p.avatar ? { avatar: p.avatar } : {}), updatedAt: new Date() },
            ...(tutorialStep !== undefined && { $max: { tutorialStep } }),
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
      }
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest who signs in
    // mid-session). The server answers with progress/noProgress for the new identity.
    identify: (client: Client, msg: { username?: string; userId?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = sanitizeName(msg.username);
      if (typeof msg?.userId === "string") this.setUserId(client, p, msg.userId);
    },
  };

  // Runs once immediately -- a fresh room shouldn't sit on an empty board for a full
  // LEADERBOARD_REFRESH_MS -- then on a timer.
  onCreate() {
    void this.refreshLeaderboard();
    this.clock.setInterval(() => {
      void this.refreshLeaderboard();
    }, LEADERBOARD_REFRESH_MS);
    this.clock.setInterval(() => this.flushAllPlaytime(), PLAYTIME_FLUSH_MS);
  }

  onJoin(client: Client, options?: { username?: string; userId?: string; avatar?: string }) {
    const p = new PlayerState();
    p.username = sanitizeName(options?.username);
    p.avatar = sanitizeAvatar(options?.avatar);
    this.state.players.set(client.sessionId, p);
    this.playTimeMark.set(client.sessionId, Date.now());

    this.setUserId(client, p, options?.userId ?? "");
    this.persistAvatar(client.sessionId, p);
    void this.refreshLeaderboard();
  }

  // Remembers a signed-in player's look so their statue survives them logging off. "" (signed
  // out / no avatar) never overwrites a saved one.
  private persistAvatar(sessionId: string, p: PlayerState) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players || !p.avatar) return;
    players
      .updateOne({ _id: userId }, { $set: { avatar: p.avatar, username: p.username || "Player", updatedAt: new Date() }, $setOnInsert: { version: 1 } }, { upsert: true })
      .catch((err) => console.warn("[WorldRoom] avatar save failed", err));
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      this.forgetSession(client.sessionId);
      return;
    }
    // Count time up to the drop, then pause the clock for the reconnect window.
    this.flushPlaytime(client.sessionId);
    this.playTimeMark.delete(client.sessionId);
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
      this.playTimeMark.set(client.sessionId, Date.now());
    } catch {
      this.forgetSession(client.sessionId);
    }
  }

  // Mirrors a sanitized save into the live roster entry (what the leaderboards rank).
  private applyLive(p: PlayerState, patch: Partial<PlayerDoc>) {
    if (patch.cash !== undefined) p.cash = patch.cash;
    if (patch.strength !== undefined) p.strength = patch.strength;
    if (patch.rebirths !== undefined) p.rebirths = patch.rebirths;
  }

  // Adds the seconds elapsed since this session's last mark to its live playTime and, for a
  // signed-in player, $inc's the same amount into Mongo. $inc (not $set) so it can't race
  // saveProgress and a client can never forge or reset its own time.
  private flushPlaytime(sessionId: string) {
    const mark = this.playTimeMark.get(sessionId);
    if (mark === undefined) return;
    const seconds = Math.floor((Date.now() - mark) / 1000);
    if (seconds <= 0) return;
    // Advance by whole seconds only, so sub-second remainders aren't dropped.
    this.playTimeMark.set(sessionId, mark + seconds * 1000);
    const p = this.state.players.get(sessionId);
    if (p) p.playTime += seconds;
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    players
      .updateOne(
        { _id: userId },
        { $inc: { playTime: seconds }, $set: { username: p?.username || "Player", lastSeenAt: new Date(), updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      )
      .catch((err) => console.warn("[WorldRoom] playtime flush failed", err));
  }

  private flushAllPlaytime() {
    for (const sessionId of [...this.playTimeMark.keys()]) this.flushPlaytime(sessionId);
  }

  // Drops a session's per-connection bookkeeping after a final playtime flush.
  private forgetSession(sessionId: string) {
    this.flushPlaytime(sessionId);
    this.playTimeMark.delete(sessionId);
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
    this.lastHatch.delete(sessionId);
    this.claiming.delete(sessionId);
  }

  // Client-trusted Bloxity user id (guest ids are dropped, see GUEST_ID_PREFIX). A forged id can
  // only read/overwrite the SENDER's own save (there is no cross-player read in `saveProgress`).
  // Called from both onJoin and `identify`; answers with progress / noProgress / serverError.
  private setUserId(client: Client, p: PlayerState, raw: string) {
    let userId = raw.slice(0, 128);
    // Guests (client-made `guest-...` ids) get no identity: nothing is loaded or saved for them.
    if (userId.startsWith(GUEST_ID_PREFIX)) userId = "";
    const prev = this.userIds.get(client.sessionId) || "";
    // No change (e.g. a username-only identify) -- but the very first call must still answer.
    if (userId === prev && this.identified.has(client.sessionId)) return;
    this.identified.add(client.sessionId);

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never shows
      // as two leaderboard rows / two racing Mongo writers (a crashed tab lingers up to
      // RECONNECT_SECONDS via allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
    } else {
      // No identity: stop persisting for this connection. (The client flushes a final
      // saveProgress under the OLD id before sending `identify`.)
      this.userIds.delete(client.sessionId);
    }

    void this.loadProgress(client, userId, p);
    void this.refreshLeaderboard();
  }

  // Seeds this player's live roster values and sends the saved doc to just this client so it can
  // hydrate its state ("progress"), or "noProgress" when there is nothing to load (new account,
  // guest, or Mongo unset). A failed read sends "serverError" so the client does not overwrite a
  // save it could not read.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", {});
        return;
      }
    }
    // The player may have left, or switched identity again, while the read was in flight.
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    if (!doc) {
      client.send("noProgress", {});
      return;
    }
    const live = { ...(sanitizeProgress(doc) ?? {}), tutorialStep: resolveTutorialStep(doc) };
    this.applyLive(p, live);
    // Saved total (already includes anything flushed while signed in this session).
    p.playTime = doc.playTime ?? 0;
    client.send("progress", { ...live, playTime: p.playTime });

    // Time since this account was last connected becomes unclaimed offline earnings.
    const offline = await this.accrueOffline(userId, doc);
    if (offline && this.state.players.get(client.sessionId) === p) client.send("offlineEarnings", offline);
  }

  // Adds the time away since `lastSeenAt` to the saved unclaimed total (capped), stamps the
  // account as seen now, and returns the pending reward (null when below the minimum).
  private async accrueOffline(userId: string, doc: PlayerDoc) {
    const players = getPlayers();
    if (!userId || !players) return null;
    const now = Date.now();
    const away = doc.lastSeenAt ? Math.floor((now - new Date(doc.lastSeenAt).getTime()) / 1000) : 0;
    const gained = away >= OFFLINE_MIN_SECONDS ? away : 0;
    const seconds = Math.min(OFFLINE_MAX_SECONDS, (doc.offlineSeconds ?? 0) + gained);
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeenAt: new Date(now), offlineSeconds: seconds } });
    } catch (err) {
      console.warn("[WorldRoom] accrueOffline failed", err);
      return null;
    }
    return seconds >= OFFLINE_MIN_SECONDS ? offlineReward(seconds) : null;
  }

  // Builds and broadcasts the merged "all-time saved + currently online" leaderboard. Only the
  // server has both the live roster and the sessionId->userId map needed to tell "this online
  // player already IS a saved account" apart from "this saved account is offline". Private so
  // tests can call and await it directly.
  private async refreshLeaderboard() {
    const onlineRows: OnlineRow[] = [];
    const onlineUserIds = new Set<string>();
    this.state.players.forEach((p, sessionId) => {
      const userId = this.userIds.get(sessionId) ?? null;
      if (userId) onlineUserIds.add(userId);
      onlineRows.push({
        sessionId,
        userId,
        username: p.username || "Player",
        avatar: p.avatar,
        rebirths: p.rebirths,
        cash: p.cash,
        strength: p.strength,
        playTime: p.playTime,
      });
    });

    const players = getPlayers();
    const payload = { rebirths: [], cash: [], strength: [], playTime: [] } as LeaderboardPayload;

    for (const stat of LEADERBOARD_STATS) {
      // Online rows first: a connected player's live value is more current than their last save.
      const merged: LeaderboardRow[] = dedupeOnline(onlineRows, stat).map((row) => ({
        id: row.sessionId,
        name: row.username,
        value: row[stat],
        avatar: row.avatar,
      }));

      // Then everyone who has EVER saved, minus accounts already shown live.
      if (players) {
        try {
          const docs = await players
            .find({}, { projection: { _id: 1, username: 1, avatar: 1, [stat]: 1 } })
            .sort({ [stat]: -1 })
            .limit(LEADERBOARD_QUERY_LIMIT)
            .toArray();

          let offlineIndex = 0;
          for (const doc of docs) {
            if (onlineUserIds.has(doc._id)) continue;
            // Synthetic id -- never broadcast another account's raw user id.
            merged.push({
              id: `offline:${stat}:${offlineIndex++}`,
              name: doc.username || "Player",
              value: (doc[stat] as number | undefined) ?? 0,
              avatar: doc.avatar,
            });
          }
        } catch (err) {
          console.warn(`[WorldRoom] leaderboard query failed for stat=${stat}`, err);
        }
      }

      // Collapse rows sharing a display name (the same account under a different id would
      // otherwise appear twice). Keep the higher value but prefer an online row's id so the
      // client can recognise its own row.
      const byName = new Map<string, LeaderboardRow>();
      for (const row of merged) {
        const key = row.name || "Player";
        const existing = byName.get(key);
        if (!existing) {
          byName.set(key, row);
          continue;
        }
        const preferId = existing.id.startsWith("offline:") && !row.id.startsWith("offline:") ? row.id : existing.id;
        byName.set(key, { id: preferId, name: key, value: Math.max(existing.value, row.value), avatar: existing.avatar || row.avatar });
      }
      const deduped = [...byName.values()];

      deduped.sort((a, b) => b.value - a.value);
      // Avatars are big: ship only the #1 row's (the statue), not all ten.
      payload[stat] = deduped.slice(0, LEADERBOARD_ROWS).map((row, i) => (i === 0 && row.avatar ? row : { id: row.id, name: row.name, value: row.value }));
    }

    this.broadcast("leaderboard", payload);
  }
}
