import assert from "assert";
import type { Collection } from "mongodb";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { SPAWN, WORLD_BOUNDS } from "../src/constants.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";

// waitForNextPatch() resolves on the server's tick, which can be before a
// connected client has decoded it; poll the client's view instead.
async function until(check: () => boolean, ms = 1000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

// Hand-rolled fake `players` collection implementing only the subset WorldRoom.ts calls:
// find().sort().limit().toArray(), updateOne() (upsert, $set/$inc), findOne().
function fakePlayersCollection(seed: PlayerDoc[] = []) {
  const docs = new Map<string, PlayerDoc>(seed.map((d) => [d._id, d]));
  const fake = {
    docs,
    async findOne(filter: { _id: string }) {
      return docs.get(filter._id) ?? null;
    },
    async updateOne(filter: { _id: string }, update: any, options: any) {
      const existing = docs.get(filter._id);
      if (!existing && !options?.upsert) return;
      const base = existing ?? ({ _id: filter._id, ...(update.$setOnInsert ?? {}) } as PlayerDoc);
      const next = { ...base, ...(update.$set ?? {}) } as any;
      for (const [k, v] of Object.entries(update.$inc ?? {})) next[k] = (next[k] ?? 0) + (v as number);
      docs.set(filter._id, next as PlayerDoc);
    },
    find(_filter: any) {
      let sortField: string | null = null;
      let limitN = Infinity;
      const cursor = {
        sort(spec: Record<string, number>) {
          sortField = Object.keys(spec)[0];
          return cursor;
        },
        limit(n: number) {
          limitN = n;
          return cursor;
        },
        async toArray() {
          let arr = Array.from(docs.values());
          if (sortField) {
            const field = sortField;
            arr = arr.slice().sort((a: any, b: any) => (b[field] ?? 0) - (a[field] ?? 0));
          }
          return arr.slice(0, limitN);
        },
      };
      return cursor;
    },
  };
  return fake as unknown as Collection<PlayerDoc> & { docs: Map<string, PlayerDoc> };
}

describe("WorldRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());
  beforeEach(async () => {
    await colyseus.cleanup();
  });
  afterEach(() => __setPlayersForTest(null));

  it("starts a joining player at the spawn, with their name and avatar", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const avatar = JSON.stringify({ equipped: { hatId: "3" }, proportions: { height: 1.2 } });
    const c1 = await colyseus.connectTo(room, { username: "Boomer", avatar });
    const c2 = await colyseus.connectTo(room);
    await room.waitForNextPatch();

    const s = c2.state.players.get(c1.sessionId)!;
    assert.strictEqual(s.username, "Boomer");
    assert.strictEqual(s.avatar, avatar);
    assert.strictEqual(s.x, SPAWN.x);
    assert.strictEqual(s.z, SPAWN.z);
  });

  it("relays pose to other players and sanitises it", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c1 = await colyseus.connectTo(room);
    const c2 = await colyseus.connectTo(room);
    await room.waitForNextPatch();

    c1.send("pose", { x: 1.5, y: 2, z: -3, yaw: 0.5, speed01: 7, grounded: false, pose: "swing" });
    await room.waitForNextPatch();
    const s = c2.state.players.get(c1.sessionId)!;
    assert.strictEqual(s.x, 1.5);
    assert.strictEqual(s.y, 2);
    assert.strictEqual(s.z, -3);
    assert.strictEqual(s.yaw, 0.5);
    assert.strictEqual(s.speed01, 1); // clamped to 0..1
    assert.strictEqual(s.grounded, false);
    assert.strictEqual(s.pose, "swing");

    // NaN is ignored, null clears the pose, out-of-world positions are clamped.
    c1.send("pose", { x: NaN, z: 99999, pose: null });
    await room.waitForNextPatch();
    const s2 = c2.state.players.get(c1.sessionId)!;
    assert.strictEqual(s2.x, 1.5);
    assert.strictEqual(s2.z, WORLD_BOUNDS.maxZ);
    assert.strictEqual(s2.pose, "");
  });

  it("relays avatar changes and rejects oversized ones", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c1 = await colyseus.connectTo(room, { avatar: "{}" });
    const c2 = await colyseus.connectTo(room);
    await room.waitForNextPatch();

    c1.send("setAvatar", { avatar: '{"equipped":{"backId":"9"}}' });
    await room.waitForNextPatch();
    assert.strictEqual(c2.state.players.get(c1.sessionId)!.avatar, '{"equipped":{"backId":"9"}}');

    c1.send("setAvatar", { avatar: "x".repeat(3500) });
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(c2.state.players.get(c1.sessionId)!.avatar, '{"equipped":{"backId":"9"}}'); // ignored

    c1.send("setAvatar", { avatar: "" }); // signing out clears it
    await until(() => c2.state.players.get(c1.sessionId)!.avatar === "");
    assert.strictEqual(c2.state.players.get(c1.sessionId)!.avatar, "");
  });

  it("relays equipped pets and rejects malformed lists", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c1 = await colyseus.connectTo(room);
    const c2 = await colyseus.connectTo(room);
    await room.waitForNextPatch();

    c1.send("setPets", { pets: "lion,bear" });
    await room.waitForNextPatch();
    assert.strictEqual(c2.state.players.get(c1.sessionId)!.pets, "lion,bear");

    c1.send("setPets", { pets: "lion,<script>" });
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(c2.state.players.get(c1.sessionId)!.pets, "lion,bear"); // ignored

    c1.send("setPets", { pets: "" });
    await until(() => c2.state.players.get(c1.sessionId)!.pets === "");
    assert.strictEqual(c2.state.players.get(c1.sessionId)!.pets, "");
  });

  it("announces hatches to the others, throttled", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c1 = await colyseus.connectTo(room, { username: "Ashan" });
    const c2 = await colyseus.connectTo(room);
    await room.waitForNextPatch();

    const got: any[] = [];
    const own: any[] = [];
    c2.onMessage("hatched", (m) => got.push(m));
    c1.onMessage("hatched", (m) => own.push(m));
    c1.send("hatch", { pets: ["lion"] });
    c1.send("hatch", { pets: ["panther"] }); // inside the cooldown
    c1.send("hatch", { pets: ["bad id"] });
    await new Promise((r) => setTimeout(r, 150));
    assert.deepStrictEqual(got, [{ username: "Ashan", pets: ["lion"] }]);
    assert.deepStrictEqual(own, []); // the sender shows its own
  });

  it("removes a player who leaves", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c1 = await colyseus.connectTo(room);
    const c2 = await colyseus.connectTo(room);
    await room.waitForNextPatch();
    assert.strictEqual(c2.state.players.size, 2);

    await c1.leave();
    await room.waitForNextPatch();
    assert.strictEqual(c2.state.players.size, 1);
    assert.strictEqual(c2.state.players.has(c1.sessionId), false);
  });


  it("saves a signed-in player's progress", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u1", username: "Ashan" });

    c.send("saveProgress", {
      wood: 120, cash: 50, strength: 33, rebirths: 1,
      pets: [{ id: 1, egg: "spotted", name: "Bear" }], equipped: [1],
    });
    await until(() => fake.docs.has("u1"));
    const doc = fake.docs.get("u1")!;
    assert.strictEqual(doc.wood, 120);
    assert.strictEqual(doc.username, "Ashan");
    assert.deepStrictEqual(doc.equipped, [1]);
    assert.strictEqual(room.state.players.get(c.sessionId)!.rebirths, 1);
  });

  it("sends a returning account its saved progress, and noProgress to a new one", async () => {
    const fake = fakePlayersCollection([
      {
        _id: "u2", username: "Back", wood: 900, cash: 7, strength: 40, level: 3,
        pets: [{ id: 4, egg: "void", name: "Dragon", tier: 1 }], playTime: 100, version: 1, updatedAt: new Date(),
      },
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});

    // The reply can land before a client handler is registered, so capture it server-side.
    const sent: [string, any][] = [];
    const orig = (room as any).loadProgress.bind(room);
    (room as any).loadProgress = (c: any, ...rest: any[]) => {
      const send = c.send.bind(c);
      c.send = (type: string, msg: any) => {
        sent.push([type, msg]);
        send(type, msg);
      };
      return orig(c, ...rest);
    };

    const back = await colyseus.connectTo(room, { userId: "u2", username: "Back" });
    const fresh = await colyseus.connectTo(room, { userId: "u-new", username: "Fresh" });
    await until(() => sent.length >= 2);

    const progress = sent.find(([t]) => t === "progress")![1];
    assert.strictEqual(progress.wood, 900);
    assert.deepStrictEqual(progress.pets, [{ id: 4, egg: "void", name: "Dragon", tier: 1 }]);
    assert.strictEqual(progress.playTime, 100);
    assert.ok(sent.some(([t]) => t === "noProgress"));

    const p = room.state.players.get(back.sessionId)!;
    assert.strictEqual(p.cash, 7);
    assert.strictEqual(p.strength, 40);
    assert.ok(fresh);
  });

  it("accepts a save far larger than Colyseus's default 4 KB message cap", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "big", username: "Hoarder" });
    const pets = Array.from({ length: 800 }, (_, i) => ({ id: i + 1, egg: "spotted", name: "Bear" }));
    c.send("saveProgress", { wood: 1, pets });
    await until(() => fake.docs.has("big"), 2000);
    assert.strictEqual(fake.docs.get("big")!.pets!.length, 800);
  });

  it("never persists guests", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "guest-abc", username: "Guest" });
    c.send("saveProgress", { wood: 5, cash: 9 });
    await until(() => room.state.players.get(c.sessionId)?.cash === 9);
    assert.strictEqual(fake.docs.size, 0);
    assert.strictEqual(room.state.players.get(c.sessionId)!.cash, 9); // still on the live board
  });

  it("broadcasts leaderboards merging saved and online players", async () => {
    const fake = fakePlayersCollection([
      { _id: "old", username: "Veteran", cash: 5000, strength: 10, rebirths: 4, playTime: 9, version: 1, updatedAt: new Date() },
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u3", username: "Newbie" });
    let boards: any = null;
    c.onMessage("leaderboard", (m) => (boards = m));
    c.send("saveProgress", { cash: 100, rebirths: 1 });
    await until(() => room.state.players.get(c.sessionId)?.cash === 100);
    boards = null;
    await (room as any).refreshLeaderboard();
    await until(() => boards !== null);
    assert.deepStrictEqual(boards.cash.map((r: any) => r.name), ["Veteran", "Newbie"]);
    assert.deepStrictEqual(boards.rebirths.map((r: any) => r.value), [4, 1]);
    assert.ok(boards.playTime && boards.strength);
  });
});
