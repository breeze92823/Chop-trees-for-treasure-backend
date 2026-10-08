// Keep in step with the client's data/config.js.
export const ROOM_MAX_CLIENTS = 50;

// Where a player appears for everyone else before their first `pose` arrives
// (client data/config.js SPAWN).
export const SPAWN = { x: 0, y: 0.3, z: 6 };

// Walkable bounds (client data/config.js WORLD_BOUNDS: the hub basin plus the forest corridor
// north to world/layout.js FOREST_END_Z = -819), with a little slack: a forged pose cannot put a
// player outside the world for everyone else to see.
export const WORLD_BOUNDS = { minX: -36, maxX: 56, minZ: -822, maxZ: 30, minY: -40, maxY: 200 };

// Longest accepted strings.
export const NAME_MAX = 64;
export const POSE_MAX = 32;
// Bloxity avatar JSON, relayed as-is. Kept under the 4 KB cap of the join request's options.
export const AVATAR_MAX_LEN = 3000;

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB). A
// `saveProgress` carrying hundreds of pets and the bag needs more room.
export const MAX_PAYLOAD_BYTES = 128 * 1024;

// Pets: equipped list (comma-joined ids) and hatch announcements. Ids are slugs
// like "frost_dragon"; at most 3 per announcement, one announcement per second.
export const PETS_MAX_LEN = 200;
export const PET_ID_MAX = 32;
export const HATCH_MAX_PETS = 3;
export const HATCH_COOLDOWN_MS = 1000;

// Leaderboards: how often WorldRoom re-queries Mongo for the all-time top players per stat, how
// many rows it fetches per stat before merging with the live roster, and how many it sends.
export const LEADERBOARD_REFRESH_MS = 15_000;
export const LEADERBOARD_QUERY_LIMIT = 20;
export const LEADERBOARD_ROWS = 10;

// Playtime: how often each connected player's elapsed time is added to their total.
export const PLAYTIME_FLUSH_MS = 30_000;

// Offline earnings: time away (measured by the SERVER clock) pays out per hour, pro-rated by the
// second. Shorter absences than the minimum pay nothing; the unclaimed total stops growing at the cap.
export const OFFLINE_CASH_PER_HOUR = 500;
export const OFFLINE_STRENGTH_PER_HOUR = 50;
export const OFFLINE_MIN_SECONDS = 60;
export const OFFLINE_MAX_SECONDS = 12 * 3600;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// Upper bounds for saved values, so a forged payload cannot push a bogus number onto the
// leaderboards. Generous ceilings, not game rules.
export const CURRENCY_MAX = 1_000_000_000_000_000_000; // wood, robux, cash, strength, xp
export const REBIRTH_MAX = 1_000_000;
export const LEVEL_MAX = 1_000_000;
export const UPGRADE_LEVEL_MAX = 1_000; // client data/upgrades.js max is 40
export const PETS_OWNED_MAX = 5_000; // owned pets (hatching makes these pile up)
export const BAG_SAVE_MAX = 200; // client data/loot.js BAG_MAX is 4 + backpack upgrades
export const DISCOVERED_MAX = 2_000; // Index entries (pets + treasures)
export const OWNED_IDS_MAX = 200; // owned choppers / auras / artifacts
export const SPINS_MAX = 1_000_000_000;
export const TIER_MAX = 3; // client data/forge.js FORGE_TIERS: Normal, Golden, Diamond, Void
export const ITEM_VALUE_MAX = 1_000_000_000_000;
export const TEXT_MAX = 64; // names

// Client data/loot.js RARITIES (treasure in the Bag).
export const RARITIES: readonly string[] = [
  "Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic", "Secret", "Celestial", "Divine",
];

// Client usePlayerData `upgrades` keys (data/upgrades.js UPGRADES ids) and `passes` keys.
export const UPGRADE_IDS: readonly string[] = ["range", "speed", "backpack", "move", "eggluck", "petslots"];
export const PASS_IDS: readonly string[] = ["slots", "wood2x"];

// Client data/quests.js QUESTS ids and QUEST_GROUPS ids (usePlayerData `quests`).
export const QUEST_IDS: readonly string[] = ["sell", "time", "strength", "mythic"];
export const QUEST_GROUP_IDS: readonly string[] = ["quick", "daily"];

// Client data/tutorial.js: the onboarding runs steps 0..TUTORIAL_DONE_STEP (5 = finished).
export const TUTORIAL_DONE_STEP = 5;

// The client's per-browser fallback id for players who are not signed in to Bloxity
// (systems/net.js localGuestId). Guests are never persisted.
export const GUEST_ID_PREFIX = "guest-";
