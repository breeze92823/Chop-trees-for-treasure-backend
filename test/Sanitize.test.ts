import assert from "assert";

import { sanitizeProgress } from "../src/sanitize.js";

describe("sanitizeProgress", () => {
  it("rejects non-objects and bounds numbers", () => {
    assert.strictEqual(sanitizeProgress(null), null);
    assert.strictEqual(sanitizeProgress([1]), null);
    const out = sanitizeProgress({ wood: -5, cash: 1e30, strength: NaN, level: 0, rebirths: 2.9, hack: "x" })!;
    assert.strictEqual(out.wood, 0);
    assert.strictEqual(out.cash, 1e18);
    assert.strictEqual(out.strength, undefined);
    assert.strictEqual(out.level, 1);
    assert.strictEqual(out.rebirths, 2);
    assert.ok(!("hack" in out));
  });

  it("keeps well-formed pets, bag, upgrades and passes and drops the rest", () => {
    const out = sanitizeProgress({
      pets: [
        { id: 1, egg: "spotted", name: "Bear" },
        { id: 1, egg: "spotted", name: "Dup" },
        { id: 2, egg: "Bad Egg", name: "Bear" },
        { id: 3, egg: "void", name: "Dragon", tier: 9 },
      ],
      equipped: [1, 1, "x", 3],
      bag: [{ name: "Gold Coin", rarity: "Rare", value: 5 }, { name: "Fake", rarity: "Nope", value: 1 }],
      upgrades: { range: 3.7, bogus: 4, speed: -2 },
      passes: { slots: true, wood2x: "yes", other: true },
      aura: null,
      chopper: "pinechip",
      pity: { Mythic: 4, Secret: "a" },
    })!;
    assert.deepStrictEqual(out.pets, [
      { id: 1, egg: "spotted", name: "Bear" },
      { id: 3, egg: "void", name: "Dragon", tier: 3 },
    ]);
    assert.deepStrictEqual(out.equipped, [1, 3]);
    assert.deepStrictEqual(out.bag, [{ name: "Gold Coin", rarity: "Rare", value: 5 }]);
    assert.deepStrictEqual(out.upgrades, { range: 3, speed: 0 });
    assert.deepStrictEqual(out.passes, { slots: true });
    assert.strictEqual(out.aura, null);
    assert.strictEqual(out.chopper, "pinechip");
    assert.deepStrictEqual(out.pity, { Mythic: 4, Secret: 0 });
  });
});

