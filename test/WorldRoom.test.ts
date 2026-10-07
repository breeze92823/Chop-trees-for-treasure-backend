import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { SPAWN, WORLD_BOUNDS } from "../src/constants.js";

// waitForNextPatch() resolves on the server's tick, which can be before a
// connected client has decoded it; poll the client's view instead.
async function until(check: () => boolean, ms = 1000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

describe("WorldRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());
  beforeEach(async () => {
    await colyseus.cleanup();
  });

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
});
