# Chop Trees for Treasure — server

Colyseus server for the `Chop-trees-for-treasure` client: progress saving, multiplayer presence
(poses, Bloxity avatars, pets, auras, hatch announcements) and leaderboards. Same stack and Bloxity
Legion deploy flow as `Lift-rock-for-treasure-new-backend`.

```
npm install
npm start        # tsx watch, ws://localhost:2567 (playground + /monitor in dev), GET /health
npm test         # mocha integration tests with an in-memory fake Mongo collection
npm run build    # -> build/, run with `node build/index.js` (see Dockerfile)
```

Config (all optional locally, see `.env.example`): `MONGODB_URI` (without it nothing persists and
the client keeps its progress in localStorage), `CLIENT_ORIGIN`, `PORT`.

## Protocol (client `src/systems/net.js`)

Room: `world` (`joinOrCreate("world", { userId, username, avatar })`), up to 50 players per room;
extra players get a new room. `userId` is the Bloxity id; ids starting `guest-` are never saved.

| Client → server | Purpose |
| --- | --- |
| `pose` | `x y z yaw speed01 grounded pose` (~15 Hz) |
| `setAvatar` / `setPets` / `setAura` | Bloxity avatar JSON, equipped pet ids (comma-joined), aura id |
| `hatch` | `{ pets: [id] }` rare-hatch announcement (throttled) |
| `saveProgress` | the persisted `usePlayerData` keys, debounced (sanitized, upserted in Mongo) |
| `claimOffline` | pay out the unclaimed offline time (amount comes from the server's own record) |
| `identify` | `{ userId, username }` after a sign-in / sign-out; answered with `progress` / `noProgress` |

| Server → client | Purpose |
| --- | --- |
| `progress` | the saved document (hydrates `usePlayerData`) |
| `noProgress` | new account, guest, or no Mongo — keep the local state (and push it) |
| `serverError` | the saved document could not be read; the client must not overwrite it |
| `leaderboard` | `{ rebirths, cash, strength, playTime }`, rows `{ id, name, value }`, top 10 |
| `offlineEarnings` | `{ seconds, cash, strength }` waiting to be claimed, sent after `progress` |
| `offlineClaimed` | `{ cash, strength }` just paid; the client adds the same amounts |
| `hatched` | `{ username, pets }` someone else's rare hatch |

Room state (`WorldState.players`) syncs pose, pets, aura, avatar, name and the leaderboard stats
(`rebirths cash strength playTime`). Playtime is measured by the server clock, never client-reported.

Offline earnings: the gap between an account's `lastSeenAt` (heartbeat + disconnect, server clock) and its next join accrues into `offlineSeconds` (min 60 s, capped at 12 h), paid per hour at `OFFLINE_CASH_PER_HOUR` / `OFFLINE_STRENGTH_PER_HOUR` in `src/constants.ts`. `claimOffline` is a compare-and-set on `offlineSeconds`, so a double click or a second tab pays once.

The game is client-authoritative: the server only enforces shape and bounds on saves
(`src/sanitize.ts`). Caps and the `upgrades`/`passes` key lists in `src/constants.ts` must be kept in
step with the client's `data/` files by hand, as must `SPAWN` and `WORLD_BOUNDS` with `data/config.js`.
`saveProgress` can carry hundreds of pets, so the WebSocket transport raises Colyseus's 4 KB message
cap (`MAX_PAYLOAD_BYTES`, `src/app.config.ts`).

## Deploy

`.github/workflows/deploy.yml`: pull requests run build + tests; pushes to `dev` deploy the dev
channel and `main` the prod channel on Bloxity Legion (image pushed to GHCR). Needs the repo
variable `LEGION_GAME_ID` (= the client's `GAME_SLUG`, `chop-trees-for-treasure`) and the secret
`LEGION_DEPLOY_TOKEN`.
