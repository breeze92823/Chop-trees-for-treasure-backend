# Game base server

Colyseus room that relays player poses and Bloxity avatars between clients. It holds no game rules and no database.

```
npm install
npm start       # tsx watch, ws://localhost:2567, GET /health, dev playground at /
npm test        # 4 integration tests (relay, sanitising, avatar cap, leave)
npm run build   # tsc -> build/, run with `node build/index.js` (see Dockerfile)
```

- [src/rooms/WorldRoom.ts](src/rooms/WorldRoom.ts): messages `pose`, `setAvatar`, `identify`; up to 50 players per room, extra players spill into a new room.
- [src/rooms/schema/WorldState.ts](src/rooms/schema/WorldState.ts): the synced `PlayerState`. Add fields here to sync more about a character.
- [src/constants.ts](src/constants.ts): spawn, world bounds and size caps; keep in step with the client's `src/data/config.js`.

Persistence (progress saves, leaderboards) is deliberately absent; see `Lift-rock-for-treasure-new-backend` for a MongoDB-backed version of the same room.
