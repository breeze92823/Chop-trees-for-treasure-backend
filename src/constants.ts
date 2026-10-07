// Keep in step with the client's data/config.js.
export const ROOM_MAX_CLIENTS = 50;

// Where a player appears for everyone else before their first `pose` arrives
// (client data/config.js SPAWN).
export const SPAWN = { x: 0, y: 0.3, z: 8 };

// Walkable bounds (client data/config.js WORLD_BOUNDS), with a little slack: a forged pose
// cannot put a player outside the world for everyone else to see.
export const WORLD_BOUNDS = { minX: -61, maxX: 61, minZ: -61, maxZ: 61, minY: -40, maxY: 200 };

// Longest accepted strings.
export const NAME_MAX = 64;
export const POSE_MAX = 32;
// Bloxity avatar JSON, relayed as-is. Kept under Colyseus's 4 KB WebSocket message cap, which
// drops the whole connection for anything larger.
export const AVATAR_MAX_LEN = 3000;

// Pets: equipped list (comma-joined ids) and hatch announcements. Ids are slugs
// like "frost_dragon"; at most 3 per announcement, one announcement per second.
export const PETS_MAX_LEN = 200;
export const PET_ID_MAX = 32;
export const HATCH_MAX_PETS = 3;
export const HATCH_COOLDOWN_MS = 1000;
