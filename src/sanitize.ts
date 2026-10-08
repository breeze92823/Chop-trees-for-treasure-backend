import {
  CURRENCY_MAX, REBIRTH_MAX, LEVEL_MAX, UPGRADE_LEVEL_MAX, PETS_OWNED_MAX, BAG_SAVE_MAX, DISCOVERED_MAX,
  OWNED_IDS_MAX, SPINS_MAX, TIER_MAX, ITEM_VALUE_MAX, TEXT_MAX, PET_ID_MAX, RARITIES, UPGRADE_IDS, PASS_IDS, QUEST_IDS, QUEST_GROUP_IDS, TUTORIAL_DONE_STEP,
} from "./constants.js";
import type { LootDoc, PetDoc, PlayerDoc } from "./db.js";

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
export function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}
export function clampInt(v: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function text(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= TEXT_MAX ? v : null;
}

// Ids of chopper / aura / artifact / egg / pet: lowercase slugs like "frost_dragon".
const SLUG = new RegExp(`^[a-z0-9_]{1,${PET_ID_MAX}}$`);
export const isSlug = (v: unknown): v is string => typeof v === "string" && SLUG.test(v);

// Owned chopper / aura / artifact ids -> slugs only, no duplicates, capped.
export function sanitizeSlugs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isSlug))].slice(0, OWNED_IDS_MAX);
}

// Owned pets { id, egg, name, tier? }; ids are the client's running counter, unique per pet.
export function sanitizePets(raw: unknown): PetDoc[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: PetDoc[] = [];
  for (const it of raw.slice(0, PETS_OWNED_MAX)) {
    if (!isObject(it) || !finite(it.id) || !Number.isInteger(it.id) || it.id < 0 || seen.has(it.id)) continue;
    const name = text(it.name);
    if (!name || !isSlug(it.egg)) continue;
    seen.add(it.id);
    const pet: PetDoc = { id: it.id, egg: it.egg, name };
    if (finite(it.tier) && it.tier > 0) pet.tier = clampInt(it.tier, TIER_MAX);
    out.push(pet);
  }
  return out;
}

// Equipped pet ids (numbers into `pets`).
export function sanitizeEquipped(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((n): n is number => finite(n) && Number.isInteger(n) && n >= 0);
  return [...new Set(ids)].slice(0, 32);
}

// Carried treasure { name, rarity, value }.
export function sanitizeBag(raw: unknown): LootDoc[] {
  if (!Array.isArray(raw)) return [];
  const out: LootDoc[] = [];
  for (const it of raw.slice(0, BAG_SAVE_MAX)) {
    if (!isObject(it)) continue;
    const name = text(it.name);
    if (!name || typeof it.rarity !== "string" || !RARITIES.includes(it.rarity) || !finite(it.value)) continue;
    out.push({ name, rarity: it.rarity, value: clampNum(it.value, ITEM_VALUE_MAX) });
  }
  return out;
}

// Index entries ("egg:Name" pets, treasure names).
export function sanitizeDiscovered(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names = raw.map(text).filter((n): n is string => n !== null);
  return [...new Set(names)].slice(0, DISCOVERED_MAX);
}

// { range: 3, ... } -> known upgrade ids with integer levels.
function sanitizeLevels(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(raw)) return out;
  for (const id of UPGRADE_IDS) if (finite(raw[id])) out[id] = clampInt(raw[id] as number, UPGRADE_LEVEL_MAX);
  return out;
}

function sanitizePasses(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!isObject(raw)) return out;
  for (const id of PASS_IDS) if (typeof raw[id] === "boolean") out[id] = raw[id] as boolean;
  return out;
}

// Potion stock counts / boost end timestamps, keyed by the client's potion and boost ids.
const POTION_IDS = ["master", "luck", "cash", "strength"];
const BOOST_IDS = ["strength", "cash", "wood"];
function sanitizeKeyed(raw: unknown, ids: string[], max: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(raw)) return out;
  for (const id of ids) if (finite(raw[id])) out[id] = clampNum(raw[id] as number, max);
  return out;
}

// Quest progress toward each goal, ids already paid this period, and the reset epoch per group.
function sanitizeQuests(raw: unknown): NonNullable<PlayerDoc["quests"]> {
  const out = { progress: {} as Record<string, number>, done: [] as string[], epoch: {} as Record<string, number> };
  if (!isObject(raw)) return out;
  out.progress = sanitizeKeyed(raw.progress, QUEST_IDS as string[], CURRENCY_MAX);
  if (Array.isArray(raw.done)) out.done = [...new Set(raw.done.filter((id): id is string => QUEST_IDS.includes(id as string)))];
  if (isObject(raw.epoch)) {
    for (const id of QUEST_GROUP_IDS) if (finite(raw.epoch[id])) out.epoch[id] = clampInt(raw.epoch[id] as number, 1e9);
  }
  return out;
}

// The game is client-authoritative -- no server-side gameplay validation. What IS enforced:
// shape and bounds, so a malformed payload can never corrupt this player's own Mongo document.
// A forged number can only ever affect the sender's own save and their leaderboard rows.
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};

  for (const key of ["wood", "robux", "strength", "cash", "xp", "xpNeeded"] as const) {
    if (finite(raw[key])) out[key] = clampNum(raw[key] as number, CURRENCY_MAX);
  }
  if (finite(raw.level)) out.level = clampInt(raw.level, LEVEL_MAX, 1);
  if (finite(raw.rebirths)) out.rebirths = clampInt(raw.rebirths, REBIRTH_MAX);
  if (finite(raw.nextPetId)) out.nextPetId = clampInt(raw.nextPetId, Number.MAX_SAFE_INTEGER, 1);
  if (finite(raw.spins)) out.spins = clampInt(raw.spins, SPINS_MAX);
  if (finite(raw.luckyRolls)) out.luckyRolls = clampInt(raw.luckyRolls, SPINS_MAX);
  if (finite(raw.luckUntil)) out.luckUntil = clampNum(raw.luckUntil, 8.64e15);
  if (finite(raw.questGold)) out.questGold = clampNum(raw.questGold, CURRENCY_MAX);
  if (finite(raw.tutorialStep)) out.tutorialStep = clampInt(raw.tutorialStep, TUTORIAL_DONE_STEP);
  if (raw.quests !== undefined) out.quests = sanitizeQuests(raw.quests);
  if (raw.rewards !== undefined) out.rewards = sanitizeSlugs(raw.rewards);
  if (raw.potions !== undefined) out.potions = sanitizeKeyed(raw.potions, POTION_IDS, 999_999);
  if (raw.boostUntil !== undefined) out.boostUntil = sanitizeKeyed(raw.boostUntil, BOOST_IDS, 8.64e15);
  if (raw.pets !== undefined) out.pets = sanitizePets(raw.pets);
  if (raw.equipped !== undefined) out.equipped = sanitizeEquipped(raw.equipped);
  if (raw.discovered !== undefined) out.discovered = sanitizeDiscovered(raw.discovered);
  if (raw.discoveredItems !== undefined) out.discoveredItems = sanitizeDiscovered(raw.discoveredItems);
  if (raw.bag !== undefined) out.bag = sanitizeBag(raw.bag);
  if (raw.choppers !== undefined) out.choppers = sanitizeSlugs(raw.choppers);
  if (isSlug(raw.chopper)) out.chopper = raw.chopper;
  if (raw.auras !== undefined) out.auras = sanitizeSlugs(raw.auras);
  if (raw.aura === null) out.aura = null;
  else if (isSlug(raw.aura)) out.aura = raw.aura;
  if (raw.artifacts !== undefined) out.artifacts = sanitizeSlugs(raw.artifacts);
  if (isSlug(raw.artifact)) out.artifact = raw.artifact;
  if (raw.upgrades !== undefined) out.upgrades = sanitizeLevels(raw.upgrades);
  if (raw.passes !== undefined) out.passes = sanitizePasses(raw.passes);
  if (isObject(raw.pity)) {
    out.pity = {
      Mythic: finite(raw.pity.Mythic) ? clampInt(raw.pity.Mythic, SPINS_MAX) : 0,
      Secret: finite(raw.pity.Secret) ? clampInt(raw.pity.Secret, SPINS_MAX) : 0,
    };
  }
  return out;
}

// What loadProgress sends down as tutorialStep: a doc that predates the field belongs to a
// player who was never shown the tutorial, so it reads as finished.
export function resolveTutorialStep(doc: Partial<PlayerDoc>): number {
  return finite(doc.tutorialStep) ? clampInt(doc.tutorialStep, TUTORIAL_DONE_STEP) : TUTORIAL_DONE_STEP;
}
