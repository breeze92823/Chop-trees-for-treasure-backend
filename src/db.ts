import { MongoClient, type Collection } from "mongodb";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

export interface PetDoc {
  id: number;
  egg: string;
  name: string;
  tier?: number;
}

export interface LootDoc {
  name: string;
  rarity: string;
  value: number;
}

// Mirrors the persisted half of the client's store/usePlayerData.js.
export interface PlayerDoc {
  _id: string; // Bloxity user id -- see WorldRoom.ts (guests are never saved)
  // Display name as of the last save, so an offline leaderboard row still has something to show.
  username?: string;
  // Bloxity avatar JSON (equipped cosmetics + proportions) as last reported, so the #1 statues of
  // an offline player can still be dressed. Only ever broadcast for a board's top row.
  avatar?: string;
  wood?: number;
  robux?: number;
  strength?: number;
  cash?: number;
  level?: number;
  xp?: number;
  xpNeeded?: number;
  rebirths?: number;
  pets?: PetDoc[];
  equipped?: number[];
  discovered?: string[];
  nextPetId?: number;
  bag?: LootDoc[];
  choppers?: string[];
  chopper?: string;
  auras?: string[];
  aura?: string | null;
  spins?: number;
  pity?: { Mythic: number; Secret: number };
  luckyRolls?: number;
  discoveredItems?: string[];
  upgrades?: Record<string, number>;
  artifacts?: string[];
  artifact?: string;
  passes?: Record<string, boolean>;
  luckUntil?: number;
  // Total seconds connected, measured by the SERVER clock (WorldRoom.ts flushPlaytime) --
  // never client-reported.
  playTime?: number;
  version: number;
  updatedAt: Date;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");

    // refreshLeaderboard() sorts by each of these; createIndex is idempotent. A failure only
    // means those queries stay unindexed, never blocks startup.
    try {
      await players.createIndex({ rebirths: -1 });
      await players.createIndex({ cash: -1 });
      await players.createIndex({ strength: -1 });
      await players.createIndex({ playTime: -1 });
    } catch (err) {
      console.warn("[db] failed to create leaderboard indexes:", err);
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the leaderboard/save logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
