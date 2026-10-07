import { schema, t, type SchemaType } from "@colyseus/schema";
import { SPAWN } from "../../constants.js";

// The live roster: everything other clients need to draw this player. The
// server stores and relays it untouched; the game is client-authoritative.
// To sync something new about a character (a held item, a title, a team),
// add a field here, accept it in WorldRoom's `pose`/`appearance` handler, and
// read it in the client's components/RemotePlayers.jsx.
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    x: t.float64().default(SPAWN.x),
    y: t.float64().default(SPAWN.y),
    z: t.float64().default(SPAWN.z),
    yaw: t.float64().default(0),
    speed01: t.float64().default(0), // 0..1 gait factor -- purely cosmetic
    grounded: t.boolean().default(true),
    pose: t.string().default(""), // client avatarAnim pose name ("" = none), e.g. "swing"
    // Equipped pets as comma-joined pet ids (client data/eggs.js), drawn following the player.
    pets: t.string().default(""),
    // The player's Bloxity avatar { equipped, proportions } as an opaque JSON string,
    // stored and relayed as-is (length-capped, never parsed here).
    avatar: t.string().default(""),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
