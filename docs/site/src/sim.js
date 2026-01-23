// src/sim.js
// Chimera / Micro Skirmish sandbox simulation core
// Assumptions are minimized; rules implemented per your latest spec.

export const GRID_W = 22;
export const GRID_H = 14;

export const TEAM_BLUE = "Blue";
export const TEAM_RED = "Red";

export const TILE_EMPTY = 0;
export const TILE_HEAVY = 1;   // light gray: can shoot through, applies heavy cover penalty to-hit
export const TILE_BLOCK = 2;   // dark gray: blocks LoS entirely

export const ACTIONS_PER_ACTIVATION = 3;
export const MOVE_PER_ACTION = 2; // grid spaces per action (Move or Charge)

export const MAX_HORROR = 5;

export const DEF_WILL_TABLE = {
  0: { mod: -2, cost: 0 },
  1: { mod: 0,  cost: 2 },
  2: { mod: 2,  cost: 4 },
  3: { mod: 4,  cost: 8 },
};

export const SHOOT_FIGHT_TABLE = {
  0: { mod: -2, cost: 0 },
  1: { mod: -2, cost: 0 },
  2: { mod: 2,  cost: 3 },
  3: { mod: 4,  cost: 6 },
};

export const SAVE_TARGET_BY_WILL = { 0: 14, 1: 14, 2: 13, 3: 11 };

export function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
export function randint(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }

export function rollDie(sides) { return randint(1, sides); }
export function rollD20() { return rollDie(20); }

export function defenseMod(tier) { return (DEF_WILL_TABLE[tier] ?? DEF_WILL_TABLE[1]).mod; }
export function willMod(tier)    { return (DEF_WILL_TABLE[tier] ?? DEF_WILL_TABLE[1]).mod; }
export function shootMod(tier)   { return (SHOOT_FIGHT_TABLE[tier] ?? SHOOT_FIGHT_TABLE[1]).mod; }
export function fightMod(tier)   { return (SHOOT_FIGHT_TABLE[tier] ?? SHOOT_FIGHT_TABLE[1]).mod; }

export function statPointsCost(m) {
  const d = (DEF_WILL_TABLE[m.defense] ?? DEF_WILL_TABLE[1]).cost;
  const w = (DEF_WILL_TABLE[m.will] ?? DEF_WILL_TABLE[1]).cost;
  const s = (SHOOT_FIGHT_TABLE[m.shoot] ?? SHOOT_FIGHT_TABLE[1]).cost;
  const f = (SHOOT_FIGHT_TABLE[m.fight] ?? SHOOT_FIGHT_TABLE[1]).cost;
  return d + w + s + f;
}

export function woundsTotal(m) {
  // base wounds = sum of tiers
  let w = (m.defense ?? 0) + (m.shoot ?? 0) + (m.fight ?? 0) + (m.will ?? 0);

  // mutation: Monstrous (+1 Wound)
  if (m.mutations?.some(x => (x?.name ?? "").toLowerCase() === "monstrous")) w += 1;

  return w;
}

export function equipmentCapacity(m) { return m.defense ?? 0; }
export function psychicMutationCapacity(m) { return m.will ?? 0; }

export function savingThrowTarget(m) {
  const base = SAVE_TARGET_BY_WILL[m.will] ?? SAVE_TARGET_BY_WILL[1];
  return Math.max(10, base);
}

export function armorClass(m) {
  let ac = 10 + defenseMod(m.defense ?? 1);

  // accessories / mutations that add AC
  if (m.accessories?.some(a => (a?.name ?? "").toLowerCase() === "heavy armor")) ac += 1;
  if (m.mutations?.some(mu => (mu?.name ?? "").toLowerCase() === "chitin armor")) ac += 1;

  return ac;
}

export function modelHas(m, nameLower) {
  const n = nameLower.toLowerCase();
  const hasAcc = (m.accessories ?? []).some(a => (a?.name ?? "").toLowerCase() === n);
  const hasMut = (m.mutations ?? []).some(a => (a?.name ?? "").toLowerCase() === n);
  const hasPsi = (m.psychic ?? []).some(a => (a?.name ?? "").toLowerCase() === n);
  return hasAcc || hasMut || hasPsi;
}

export function distGrid(a, b) {
  const dx = (a.tx - b.tx);
  const dy = (a.ty - b.ty);
  return Math.sqrt(dx*dx + dy*dy);
}

export function distM(a, b) {
  // 1 M = 2 grid spaces
  return distGrid(a, b) / 2;
}

export function isAdjacent(a, b) {
  const dx = Math.abs(a.tx - b.tx);
  const dy = Math.abs(a.ty - b.ty);
  return (dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0));
}

export function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;
}

export function key(x, y) { return `${x},${y}`; }

export function neighbors8(x, y) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (inBounds(nx, ny)) out.push({ x: nx, y: ny });
    }
  }
  return out;
}

// Bresenham line between cell centers.
// Returns cells visited INCLUDING endpoints.
export function bresenhamCells(x0, y0, x1, y1) {
  const cells = [];
  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  let sx = (x0 < x1) ? 1 : -1;
  let sy = (y0 < y1) ? 1 : -1;
  let err = dx - dy;

  let x = x0, y = y0;
  while (true) {
    cells.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx)  { err += dx; y += sy; }
  }
  return cells;
}

// LoS: center-to-center. Block tiles block completely.
// Heavy tiles do not block but impose heavy cover penalty.
// If a diagonal step "clips a corner", count as light cover.
export function lineOfSight(grid, from, to) {
  const cells = bresenhamCells(from.tx, from.ty, to.tx, to.ty);

  let blocked = false;
  let heavyThrough = false;
  let cornerClipLight = false;

  for (let i = 1; i < cells.length - 1; i++) {
    const c = cells[i];
    const t = grid[c.y][c.x];
    if (t === TILE_BLOCK) { blocked = true; break; }
    if (t === TILE_HEAVY) heavyThrough = true;

    // corner clip heuristic: if the line makes a diagonal step, and either
    // of the orthogonally-adjacent cells at that corner is blocking,
    // treat as "light cover"
    const prev = cells[i - 1];
    const next = cells[i + 1];
    const d1x = c.x - prev.x, d1y = c.y - prev.y;
    const d2x = next.x - c.x, d2y = next.y - c.y;

    const diagonalStep = (Math.abs(d1x) === 1 && Math.abs(d1y) === 1) || (Math.abs(d2x) === 1 && Math.abs(d2y) === 1);
    if (diagonalStep) {
      // check orthogonal corner neighbors around c relative to prev
      const ox1 = prev.x, oy1 = c.y;
      const ox2 = c.x, oy2 = prev.y;
      if (inBounds(ox1, oy1) && grid[oy1][ox1] === TILE_BLOCK) cornerClipLight = true;
      if (inBounds(ox2, oy2) && grid[oy2][ox2] === TILE_BLOCK) cornerClipLight = true;
    }
  }

  return { blocked, heavyThrough, cornerClipLight, cells };
}

export function touchingObstacle(grid, m) {
  // touching = any adjacent (8) tile is an obstacle (heavy or block)
  const ns = neighbors8(m.tx, m.ty);
  for (const n of ns) {
    const t = grid[n.y][n.x];
    if (t === TILE_BLOCK || t === TILE_HEAVY) return true;
  }
  return false;
}

export function rollWithMods(ctx, label, baseRollFn, mods, logFn) {
  const raw = baseRollFn();
  const totalMods = mods.reduce((a, b) => a + b, 0);
  const total = raw + totalMods;
  logFn(`${label}: d20=${raw} ${totalMods ? (totalMods >= 0 ? `+${totalMods}` : `${totalMods}`) : ""} → ${total}`);
  return { raw, total, totalMods };
}

// Basic name generator (simple but flavorful)
const NAME_A = ["Ash", "Mire", "Quawb", "Vanta", "Sable", "Hex", "Null", "Gore", "Weld", "Kelo", "Rift", "Pale"];
const NAME_B = ["Warden", "Mason", "Ghoul", "Clade", "Vox", "Rider", "Splice", "Husk", "Mirror", "Knife", "Oracle", "Drifter"];
const WB_A = ["The", "House", "Order", "Cult", "Choir", "Syndicate", "Gang", "Circle", "Legion", "Coven", "Assembly"];
const WB_B = ["of Rust", "of Glass", "of Teeth", "of Echoes", "of Bone", "of Static", "of Ash", "of Ink", "of Rot", "of Cables", "of Night"];

export function genName() {
  return `${NAME_A[randint(0, NAME_A.length - 1)]} ${NAME_B[randint(0, NAME_B.length - 1)]}`;
}
export function genWarbandName() {
  return `${WB_A[randint(0, WB_A.length - 1)]} ${WB_B[randint(0, WB_B.length - 1)]}`;
}

// ---------- Data Loading ----------
export async function loadTables(basePath = "./data") {
  const get = async (p) => {
    const res = await fetch(`${basePath}/${p}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch ${p}: HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error(`${p} must be an array`);
    return json;
  };

  const tables = {
    shoot: await get("shoot.json"),
    fight: await get("fight.json"),
    accessories: await get("accessories.json"),
    psychic: await get("psychic_powers.json"),
    mutations: await get("mutations.json"),
    warbandTraits: await get("warband_traits.json"),
    leaderTraits: await get("leader_traits.json"),
    rules: await get("rules.json").catch(() => []),
  };

  return tables;
}

// ---------- Random warband generation ----------
function pickRandom(arr, pred = null) {
  const list = pred ? arr.filter(pred) : arr.slice();
  if (!list.length) return null;
  return list[randint(0, list.length - 1)];
}

function sumPoints(arr) {
  return (arr ?? []).reduce((a, x) => a + (Number(x?.points) || 0), 0);
}

function weaponPoints(w) {
  return (Number(w?.points) || 0);
}

function tryBuildModel(tables, role, pointCap) {
  // Randomly allocate tiers first (1–3), then fill gear until cap; reroll invalid loadouts.
  // Respect capacity: accessories <= defense tier, psi+mut <= will tier.
  const maxAttempts = 400;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const m = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2),
      role,
      name: genName(),

      team: null, // assigned later
      tx: -1, ty: -1,
      deployed: false,

      defense: randint(1, 3),
      shoot: randint(1, 3),
      fight: randint(1, 3),
      will: randint(1, 3),

      // loadout objects
      ranged: null,
      sidearm: null,
      melee: null,
      accessories: [],
      psychic: [],
      mutations: [],

      // runtime state
      woundsMax: 0,
      wounds: 0,
      exhausted: false,
      actionsRemaining: ACTIONS_PER_ACTIVATION,
      actionPenaltyNext: 0, // lose 1 action next activation
      suppressed: false,
      horror: 0,
      horrorGainedThisRound: false,
      aimConsecutive: 0, // consecutive aim actions this activation
      aimBonus: 0,       // applied to next ranged attack only
      recoveredThisActivation: false,

      // reroll trackers
      rerollShootUsed: false,
      rerollFightUsed: false,
    };

    // apply Psychic Scars at creation (start with 1 horror, +1 will mod)
    // We apply +1 will mod later during rolling, but represent it as a flag:
    m.hasPsychicScars = false;

    // 1) pick ranged weapon (can be "No Ranged Weapon" or anything)
    // avoid rocket/sniper requiring Aim 2/1 for simplicity? We'll allow them but enforce in logic.
    m.ranged = pickRandom(tables.shoot);

    // 2) pick melee weapon
    m.melee = pickRandom(tables.fight);

    // 3) fill accessories up to capacity and cap points
    const accCap = equipmentCapacity(m);
    const pmCap = psychicMutationCapacity(m);

    // Determine "core" points (tiers + weapons)
    const basePts = statPointsCost(m) + weaponPoints(m.ranged) + weaponPoints(m.melee);
    if (basePts > pointCap) continue;

    // Helper: add random gear while under cap
    const accPool = tables.accessories.filter(a => (Number(a?.points) || 0) > 0);
    const psiPool = tables.psychic.filter(p => (Number(p?.points) || 0) > 0);
    const mutPool = tables.mutations.filter(mu => (Number(mu?.points) || 0) > 0);

    // Choose some psi/mut up to pmCap
    const pmChoices = [];
    const totalPmSlots = pmCap;
    for (let i = 0; i < totalPmSlots; i++) {
      // 60/40 psi vs mut
      const choosePsi = Math.random() < 0.6;
      const pick = choosePsi ? pickRandom(psiPool) : pickRandom(mutPool);
      if (!pick) continue;
      pmChoices.push(pick);
    }

    // random subset (sometimes fewer)
    const pmFinal = pmChoices.filter(() => Math.random() < 0.7);
    // split into psi/mut, but enforce total slots
    m.psychic = pmFinal.filter(x => x.power_type || x.range || x.horror_generated !== undefined).slice(0, totalPmSlots);
    m.mutations = pmFinal.filter(x => x.type !== undefined && x.power_type === undefined).slice(0, Math.max(0, totalPmSlots - m.psychic.length));

    // Add Psychic Scars sometimes
    if (m.mutations.some(mu => (mu?.name ?? "").toLowerCase() === "psychic scars")) {
      m.hasPsychicScars = true;
      m.horror = 1;
    }

    // Choose accessories up to cap
    const accFinal = [];
    for (let i = 0; i < accCap; i++) {
      if (Math.random() < 0.6) {
        const a = pickRandom(accPool);
        if (a) accFinal.push(a);
      }
    }
    m.accessories = accFinal.slice(0, accCap);

    // Now check points cap and reroll if over
    const totalPts = basePts + sumPoints(m.accessories) + sumPoints(m.psychic) + sumPoints(m.mutations);
    if (totalPts > pointCap) continue;

    // finalize wounds
    m.woundsMax = woundsTotal(m);
    m.wounds = m.woundsMax;

    return { model: m, points: totalPts };
  }

  return null;
}

export function randomWarband(tables, team) {
  const warband = {
    name: genWarbandName(),
    team,
    warbandTrait: pickRandom(tables.warbandTraits),
    leaderTrait: pickRandom(tables.leaderTraits),
    models: [],
  };

  // Leader ≤ 20
  let leaderBuilt = tryBuildModel(tables, "Leader", 20);
  if (!leaderBuilt) leaderBuilt = tryBuildModel(tables, "Leader", 20); // one more try
  if (!leaderBuilt) throw new Error("Could not build a leader within 20 points after many attempts.");

  const leader = leaderBuilt.model;
  leader.team = team;
  leader.isLeader = true;

  // Followers ≤ 75 each
  const followers = [];
  for (let i = 0; i < 4; i++) {
    const built = tryBuildModel(tables, `Follower ${i+1}`, 75);
    if (!built) throw new Error("Could not build follower within 75 points.");
    built.model.team = team;
    built.model.isLeader = false;
    followers.push(built.model);
  }

  warband.models = [leader, ...followers];
  return warband;
}

// ---------- Import / Export ----------
export function exportWarbandForSandbox(wb) {
  // keep a stable export structure the sandbox can re-import
  return {
    name: wb.name,
    team: wb.team,
    warbandTrait: wb.warbandTrait,
    leaderTrait: wb.leaderTrait,
    models: wb.models.map(m => ({
      id: m.id,
      role: m.role,
      name: m.name,
      team: m.team,
      defense: m.defense,
      shoot: m.shoot,
      fight: m.fight,
      will: m.will,
      ranged: m.ranged,
      melee: m.melee,
      accessories: m.accessories,
      psychic: m.psychic,
      mutations: m.mutations,
    })),
  };
}

export function importWarbandFromAnyJSON(tables, json, teamOverride = null) {
  // Supports:
  // (A) builder warband format: { members:[{ defense/shoot/fight/will, weaponIdx, meleeIdx, accessoryIdx, psychicIdx, mutationIdx, name }], ... }
  // (B) sandbox format: { models:[...], name, team... }
  // (C) legacy: array of models [{name, team, tx, ty, tiers:{def,wp,shoot,fight}}]

  const team = teamOverride || (json?.team) || TEAM_BLUE;

  // (C) legacy
  if (Array.isArray(json)) {
    const models = json.map((r, i) => {
      const tiers = r.tiers || {};
      const m = {
        id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2),
        role: i === 0 ? "Leader" : `Follower ${i}`,
        name: String(r.name ?? genName()),
        team: String(r.team ?? team),
        tx: Number.isFinite(r.tx) ? r.tx : -1,
        ty: Number.isFinite(r.ty) ? r.ty : -1,
        deployed: Number.isFinite(r.tx) && Number.isFinite(r.ty),

        defense: Number(tiers.def ?? 1),
        will: Number(tiers.wp ?? 1),
        shoot: Number(tiers.shoot ?? 1),
        fight: Number(tiers.fight ?? 1),

        ranged: pickRandom(tables.shoot),
        melee: pickRandom(tables.fight),
        accessories: [],
        psychic: [],
        mutations: [],

        woundsMax: 0,
        wounds: 0,
        exhausted: false,
        actionsRemaining: ACTIONS_PER_ACTIVATION,
        actionPenaltyNext: 0,
        suppressed: false,
        horror: 0,
        horrorGainedThisRound: false,
        aimConsecutive: 0,
        aimBonus: 0,
        recoveredThisActivation: false,
        rerollShootUsed: false,
        rerollFightUsed: false,
        isLeader: (i === 0),
        hasPsychicScars: false,
      };
      m.woundsMax = woundsTotal(m);
      m.wounds = m.woundsMax;
      return m;
    });

    return {
      name: `Imported ${team}`,
      team,
      warbandTrait: pickRandom(tables.warbandTraits),
      leaderTrait: pickRandom(tables.leaderTraits),
      models,
    };
  }

  // (B) sandbox
  if (json && typeof json === "object" && Array.isArray(json.models)) {
    const wb = {
      name: String(json.name ?? `Imported ${team}`),
      team,
      warbandTrait: json.warbandTrait ?? pickRandom(tables.warbandTraits),
      leaderTrait: json.leaderTrait ?? pickRandom(tables.leaderTraits),
      models: [],
    };

    wb.models = json.models.map((r, i) => {
      const m = {
        id: r.id || (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)),
        role: String(r.role ?? (i === 0 ? "Leader" : `Follower ${i}`)),
        name: String(r.name ?? genName()),
        team: teamOverride || String(r.team ?? team),
        tx: -1, ty: -1,
        deployed: false,

        defense: Number(r.defense ?? 1),
        shoot: Number(r.shoot ?? 1),
        fight: Number(r.fight ?? 1),
        will: Number(r.will ?? 1),

        ranged: r.ranged ?? pickRandom(tables.shoot),
        melee: r.melee ?? pickRandom(tables.fight),
        accessories: Array.isArray(r.accessories) ? r.accessories : [],
        psychic: Array.isArray(r.psychic) ? r.psychic : [],
        mutations: Array.isArray(r.mutations) ? r.mutations : [],

        woundsMax: 0,
        wounds: 0,
        exhausted: false,
        actionsRemaining: ACTIONS_PER_ACTIVATION,
        actionPenaltyNext: 0,
        suppressed: false,
        horror: 0,
        horrorGainedThisRound: false,
        aimConsecutive: 0,
        aimBonus: 0,
        recoveredThisActivation: false,
        rerollShootUsed: false,
        rerollFightUsed: false,
        isLeader: (i === 0),
        hasPsychicScars: false,
      };

      if (m.mutations?.some(mu => (mu?.name ?? "").toLowerCase() === "psychic scars")) {
        m.hasPsychicScars = true;
        m.horror = 1;
      }

      m.woundsMax = woundsTotal(m);
      m.wounds = m.woundsMax;
      return m;
    });

    return wb;
  }

  // (A) builder warband
  if (json && typeof json === "object" && Array.isArray(json.members)) {
    const wb = {
      name: String(json.name ?? `Imported ${team}`),
      team,
      warbandTrait: tables.warbandTraits[Number(json.warbandTraitIdx)] ?? pickRandom(tables.warbandTraits),
      leaderTrait: tables.leaderTraits[Number(json.leaderTraitIdx)] ?? pickRandom(tables.leaderTraits),
      models: [],
    };

    wb.models = json.members.map((mem, i) => {
      const ranged = (mem.weaponIdx === "" || mem.weaponIdx == null) ? null : tables.shoot[Number(mem.weaponIdx)];
      const melee = (mem.meleeIdx === "" || mem.meleeIdx == null) ? null : tables.fight[Number(mem.meleeIdx)];

      const accessories = Array.isArray(mem.accessoryIdx)
        ? mem.accessoryIdx.map(n => tables.accessories[Number(n)]).filter(Boolean)
        : [];

      const psychic = Array.isArray(mem.psychicIdx)
        ? mem.psychicIdx.map(n => tables.psychic[Number(n)]).filter(Boolean)
        : [];

      const mutations = Array.isArray(mem.mutationIdx)
        ? mem.mutationIdx.map(n => tables.mutations[Number(n)]).filter(Boolean)
        : [];

      const m = {
        id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2),
        role: String(mem.role ?? (i === 0 ? "Leader" : `Follower ${i}`)),
        name: String(mem.name ?? genName()),
        team: teamOverride || team,

        tx: -1, ty: -1,
        deployed: false,

        defense: Number(mem.defense ?? 1),
        shoot: Number(mem.shoot ?? 1),
        fight: Number(mem.fight ?? 1),
        will: Number(mem.will ?? 1),

        ranged: ranged ?? null,
        melee: melee ?? null,
        accessories,
        psychic,
        mutations,

        woundsMax: 0,
        wounds: 0,
        exhausted: false,
        actionsRemaining: ACTIONS_PER_ACTIVATION,
        actionPenaltyNext: 0,
        suppressed: false,
        horror: 0,
        horrorGainedThisRound: false,
        aimConsecutive: 0,
        aimBonus: 0,
        recoveredThisActivation: false,
        rerollShootUsed: false,
        rerollFightUsed: false,
        isLeader: (i === 0),
        hasPsychicScars: false,
      };

      if (m.mutations?.some(mu => (mu?.name ?? "").toLowerCase() === "psychic scars")) {
        m.hasPsychicScars = true;
        m.horror = 1;
      }

      m.woundsMax = woundsTotal(m);
      m.wounds = m.woundsMax;

      return m;
    });

    // ensure ranged/melee exist
    for (const m of wb.models) {
      if (!m.ranged) m.ranged = pickRandom(tables.shoot);
      if (!m.melee) m.melee = pickRandom(tables.fight);
    }

    return wb;
  }

  throw new Error("Unrecognized import JSON format.");
}

// ---------- Map generation ----------
export function makeEmptyGrid() {
  const g = [];
  for (let y = 0; y < GRID_H; y++) {
    const row = new Array(GRID_W).fill(TILE_EMPTY);
    g.push(row);
  }
  return g;
}

export function randomMap() {
  const g = makeEmptyGrid();

  // sprinkle obstacles with some clustering
  const heavyCount = Math.floor(GRID_W * GRID_H * 0.08);
  const blockCount = Math.floor(GRID_W * GRID_H * 0.06);

  // keep edges mostly clear for deployment
  const edgeClear = (x, y) => (x <= 1 || x >= GRID_W - 2);

  const place = (type, count) => {
    let placed = 0;
    let tries = 0;
    while (placed < count && tries < count * 40) {
      tries++;
      const x = randint(0, GRID_W - 1);
      const y = randint(0, GRID_H - 1);
      if (edgeClear(x, y)) continue;
      if (g[y][x] !== TILE_EMPTY) continue;

      g[y][x] = type;
      placed++;

      // small cluster chance
      if (Math.random() < 0.35) {
        for (const n of neighbors8(x, y)) {
          if (placed >= count) break;
          if (edgeClear(n.x, n.y)) continue;
          if (g[n.y][n.x] === TILE_EMPTY && Math.random() < 0.35) {
            g[n.y][n.x] = type;
            placed++;
          }
        }
      }
    }
  };

  place(TILE_HEAVY, heavyCount);
  place(TILE_BLOCK, blockCount);

  return g;
}

// ---------- Game State ----------
export function makeGame(tables) {
  const grid = randomMap();

  const blue = randomWarband(tables, TEAM_BLUE);
  const red = randomWarband(tables, TEAM_RED);

  const game = {
    tables,
    grid,
    warbands: { [TEAM_BLUE]: blue, [TEAM_RED]: red },
    models: [...blue.models, ...red.models],

    round: 1,
    activeTeam: null,
    waitingFor: "init", // init | pickModel | deploy | action | target
    activeModelId: null,

    selectedModelId: null,
    selectedAction: null, // Move|Charge|Shoot|Fight|Disengage|Recover|Aim|Psychic|End

    // per-round trackers
    log: [],
  };

  return game;
}

export function getModel(game, id) {
  return game.models.find(m => m.id === id) || null;
}

export function livingModels(game, team = null) {
  return game.models.filter(m => m.wounds > 0 && (!team || m.team === team));
}

export function unexhaustedModels(game, team) {
  return livingModels(game, team).filter(m => !m.exhausted);
}

export function maxWillModInTeam(game, team) {
  const ms = livingModels(game, team);
  if (!ms.length) return 0;
  let best = -999;
  for (const m of ms) {
    let mod = willMod(m.will);
    if (m.hasPsychicScars) mod += 1;
    best = Math.max(best, mod);
  }
  return best;
}

export function log(game, s) {
  game.log.push(s);
  if (game.log.length > 500) game.log.shift();
}

// ---------- Turn / round flow ----------
export function startRound(game) {
  // reset per-round caps
  for (const m of livingModels(game)) {
    m.horrorGainedThisRound = false;
    m.rerollShootUsed = false;
    m.rerollFightUsed = false;
  }

  // if everyone exhausted, clear exhausted
  const allLiving = livingModels(game);
  const allExhausted = allLiving.length > 0 && allLiving.every(m => m.exhausted);
  if (allExhausted) {
    for (const m of allLiving) m.exhausted = false;
  }

  const blueMod = maxWillModInTeam(game, TEAM_BLUE);
  const redMod = maxWillModInTeam(game, TEAM_RED);

  const b = rollDie(20);
  const r = rollDie(20);
  const bt = b + blueMod;
  const rt = r + redMod;

  log(game, `=== Round ${game.round} Initiative ===`);
  log(game, `Blue rolls d20(${b}) + WPmod(${blueMod}) = ${bt}`);
  log(game, `Red  rolls d20(${r}) + WPmod(${redMod}) = ${rt}`);

  if (bt > rt) {
    game.activeTeam = TEAM_BLUE;
    log(game, `Blue wins initiative and activates first.`);
  } else if (rt > bt) {
    game.activeTeam = TEAM_RED;
    log(game, `Red wins initiative and activates first.`);
  } else {
    // tie: re-roll (simple)
    game.activeTeam = (Math.random() < 0.5) ? TEAM_BLUE : TEAM_RED;
    log(game, `Tie! Random pick → ${game.activeTeam} activates first.`);
  }

  game.activeModelId = null;
  game.waitingFor = "pickModel";
  game.selectedAction = null;
}

export function beginActivation(game, model) {
  game.activeModelId = model.id;
  model.exhausted = false; // should already be, but safe
  model.recoveredThisActivation = false;
  model.aimConsecutive = 0;
  model.aimBonus = 0;

  const penalty = clamp(model.actionPenaltyNext, 0, 2);
  model.actionPenaltyNext = 0;

  model.actionsRemaining = clamp(ACTIONS_PER_ACTIVATION - penalty, 1, ACTIONS_PER_ACTIVATION);

  log(game, `--- ${model.team} activates ${model.name} (${model.role}) [${model.actionsRemaining} actions] ---`);

  if (!model.deployed) {
    log(game, `Deploy: click a tile on your board edge (deployment counts as 1 Move action).`);
    game.waitingFor = "deploy";
    return;
  }

  game.waitingFor = "action";
}

export function endActivation(game) {
  const m = getModel(game, game.activeModelId);
  if (!m) return;

  m.exhausted = true;
  game.activeModelId = null;
  game.selectedAction = null;

  // check victory
  const blueAlive = livingModels(game, TEAM_BLUE).length;
  const redAlive = livingModels(game, TEAM_RED).length;
  if (blueAlive === 0 || redAlive === 0) {
    log(game, `=== GAME OVER: ${blueAlive === 0 ? "Red" : "Blue"} wins! ===`);
    game.waitingFor = "init";
    return;
  }

  // alternate team; if next team has no unexhausted, keep current until both done
  const nextTeam = (game.activeTeam === TEAM_BLUE) ? TEAM_RED : TEAM_BLUE;
  const nextHas = unexhaustedModels(game, nextTeam).length > 0;
  const curHas = unexhaustedModels(game, game.activeTeam).length > 0;

  if (nextHas) {
    game.activeTeam = nextTeam;
  } else if (curHas) {
    // stay
  } else {
    // round ends
    game.round += 1;
    startRound(game);
    return;
  }

  game.waitingFor = "pickModel";
}

// ---------- Rules helpers ----------
export function canShoot(game, attacker) {
  // cannot shoot if engaged
  for (const e of livingModels(game)) {
    if (e.team !== attacker.team && e.deployed && isAdjacent(attacker, e)) return false;
  }
  return true;
}

export function engagedEnemies(game, m) {
  return livingModels(game).filter(e => e.team !== m.team && e.deployed && isAdjacent(m, e));
}

export function effectiveWillMod(m) {
  let mod = willMod(m.will);
  if (m.hasPsychicScars) mod += 1;
  if (modelHas(m, "psychic focus")) mod += 1;
  return mod;
}

export function effectiveShootMod(m) {
  let mod = shootMod(m.shoot);
  if (modelHas(m, "targeting reticule")) mod += 1;
  // horror penalty applied elsewhere
  return mod;
}

export function effectiveFightMod(m) {
  let mod = fightMod(m.fight);
  if (modelHas(m, "cybernetics")) mod += 1;
  return mod;
}

export function horrorPenalty(m) {
  return -clamp(m.horror ?? 0, 0, MAX_HORROR);
}

// terrain cover penalties:
export function terrainCoverPenalty(game, attacker, defender) {
  // touching obstacle grants light cover (unless defender cannot benefit from cover)
  if (modelHas(defender, "monstrous")) return 0;

  const touches = touchingObstacle(game.grid, defender);
  if (!touches) return 0;
  return -1; // light cover only
}

export function losAndCover(game, attacker, defender) {
  const los = lineOfSight(game.grid, attacker, defender);
  if (los.blocked) return { ok: false, los, coverPenalty: 0 };

  let coverPenalty = 0;

  // heavy cover tiles along the LoS path impose -3
  if (los.heavyThrough) coverPenalty += -3;

  // corner clip counts as light cover (-1)
  if (los.cornerClipLight) coverPenalty += -1;

  // touching obstacle but clear LoS = light cover
  coverPenalty += terrainCoverPenalty(game, attacker, defender);

  return { ok: true, los, coverPenalty };
}

export function rangePenalty(attacker, defender) {
  const dM = distM(attacker, defender);
  if (dM > 3) return -3;
  if (dM > 2) return -1;
  return 0;
}

export function applyDamage(game, target, dmg) {
  target.wounds = Math.max(0, target.wounds - dmg);
  log(game, `${target.name} takes ${dmg} damage → ${target.wounds}/${target.woundsMax} wounds`);
  if (target.wounds <= 0) {
    log(game, `${target.name} is taken Out of Action!`);
    // remove from board (keep in list but "dead")
    target.deployed = false;
    target.tx = -1; target.ty = -1;
  }
}

export function gainHorror(game, m, amount = 1, reason = "") {
  if (amount <= 0) return;

  // max 1 gained per model per round
  if (m.horrorGainedThisRound) {
    log(game, `${m.name} would gain Horror but already gained one this round.`);
    return;
  }
  const before = m.horror;
  m.horror = clamp(m.horror + amount, 0, MAX_HORROR);
  m.horrorGainedThisRound = true;
  log(game, `${m.name} gains ${m.horror - before} Horror${reason ? ` (${reason})` : ""} → ${m.horror}/${MAX_HORROR}`);
}

export function horrorTest(game, m, label = "Horror test") {
  const mods = [
    effectiveWillMod(m),
    horrorPenalty(m),
  ];
  const { raw, total } = rollWithMods(game, `${label} for ${m.name}`, () => rollDie(20), mods, (s) => log(game, s));
  const target = savingThrowTarget(m);
  const pass = total >= target;
  log(game, `${m.name} vs Save ${target} → ${pass ? "PASS" : "FAIL"}`);
  return { raw, total, pass, target };
}

// ---------- Action resolution ----------
export function spendAction(game, m, reason) {
  m.actionsRemaining = Math.max(0, m.actionsRemaining - 1);
  m.aimConsecutive = (reason === "Aim") ? (m.aimConsecutive + 1) : 0;
  if (reason !== "Aim") m.aimBonus = 0; // aim bonus persists only until next ranged attack, but non-aim should break "consecutive aim" anyway.
}

export function moveModel(game, m, toX, toY) {
  m.tx = toX; m.ty = toY;
}

export function isTileOccupied(game, x, y) {
  return livingModels(game).some(m => m.deployed && m.tx === x && m.ty === y);
}

export function canStepOn(game, x, y) {
  if (!inBounds(x, y)) return false;
  const t = game.grid[y][x];
  if (t === TILE_BLOCK) return false;
  // heavy cover is terrain you can stand on (fine)
  if (isTileOccupied(game, x, y)) return false;
  return true;
}

export function tilesWithinChebyshev(fromX, fromY, maxSteps) {
  const out = [];
  for (let y = fromY - maxSteps; y <= fromY + maxSteps; y++) {
    for (let x = fromX - maxSteps; x <= fromX + maxSteps; x++) {
      if (!inBounds(x, y)) continue;
      const dx = Math.abs(x - fromX);
      const dy = Math.abs(y - fromY);
      const cheb = Math.max(dx, dy);
      if (cheb <= maxSteps) out.push({ x, y });
    }
  }
  return out;
}

export function resolveMove(game, m, toX, toY) {
  if (!m.deployed) return { ok: false, reason: "Not deployed" };
  if (m.actionsRemaining <= 0) return { ok: false, reason: "No actions" };

  // suppressed: must pass horror test to move, else movement fails (action still spent)
  if (m.suppressed) {
    const ht = horrorTest(game, m, "Suppressed Move test");
    if (!ht.pass) {
      gainHorror(game, m, 1, "Suppressed Move failed");
      spendAction(game, m, "Move");
      log(game, `${m.name} fails to move due to suppression.`);
      return { ok: false, reason: "Suppressed and failed horror test" };
    }
  }

  const options = tilesWithinChebyshev(m.tx, m.ty, MOVE_PER_ACTION);
  const legal = options.some(p => p.x === toX && p.y === toY);
  if (!legal) return { ok: false, reason: "Out of range" };
  if (!canStepOn(game, toX, toY)) return { ok: false, reason: "Blocked or occupied" };

  moveModel(game, m, toX, toY);
  spendAction(game, m, "Move");
  log(game, `${m.name} moves to (${toX},${toY}). [${m.actionsRemaining} actions left]`);
  return { ok: true };
}

export function resolveCharge(game, m, target) {
  if (!m.deployed) return { ok: false, reason: "Not deployed" };
  if (m.actionsRemaining <= 0) return { ok: false, reason: "No actions" };
  if (!target || target.team === m.team || target.wounds <= 0 || !target.deployed) return { ok: false, reason: "Invalid target" };

  // charge is a move (2 grid spaces) that must end adjacent (including diagonals)
  const options = tilesWithinChebyshev(m.tx, m.ty, MOVE_PER_ACTION);
  // valid end positions: empty tile within range that is adjacent to target
  const ends = options.filter(p => !isTileOccupied(game, p.x, p.y) && canStepOn(game, p.x, p.y) && isAdjacent({ tx: p.x, ty: p.y }, target));
  if (!ends.length) return { ok: false, reason: "No reachable engagement position" };

  // choose the end closest to target (simple)
  ends.sort((a, b) => (Math.abs(a.x - target.tx) + Math.abs(a.y - target.ty)) - (Math.abs(b.x - target.tx) + Math.abs(b.y - target.ty)));
  const end = ends[0];

  moveModel(game, m, end.x, end.y);
  spendAction(game, m, "Charge");
  log(game, `${m.name} charges into engagement with ${target.name} at (${end.x},${end.y}).`);

  // target takes horror test; on fail gains horror + loses 1 action next activation (min 1)
  const ht = horrorTest(game, target, `Charge Horror test (defender)`);
  if (!ht.pass) {
    gainHorror(game, target, 1, "Charged");
    target.actionPenaltyNext = clamp((target.actionPenaltyNext || 0) + 1, 0, 2);
    log(game, `${target.name} will lose 1 action next activation (min 1).`);
  }

  return { ok: true };
}

export function resolveAim(game, m) {
  if (m.actionsRemaining <= 0) return { ok: false, reason: "No actions" };
  if (m.suppressed) {
    log(game, `${m.name} cannot Aim while Suppressed.`);
    return { ok: false, reason: "Suppressed" };
  }

  // 1 action => +1
  // 2 consecutive aim actions => +3
  spendAction(game, m, "Aim");
  if (m.aimConsecutive >= 2) {
    m.aimBonus = 3;
    log(game, `${m.name} aims (2nd consecutive) → +3 to next Shoot.`);
  } else {
    m.aimBonus = 1;
    log(game, `${m.name} aims → +1 to next Shoot.`);
  }
  log(game, `${m.name} [${m.actionsRemaining} actions left]`);
  return { ok: true };
}

export function resolveRecover(game, m) {
  if (m.actionsRemaining <= 0) return { ok: false, reason: "No actions" };
  if (m.recoveredThisActivation) {
    log(game, `${m.name} already used Recover this activation.`);
    return { ok: false, reason: "Already recovered" };
  }

  spendAction(game, m, "Recover");
  m.recoveredThisActivation = true;

  if (m.horror > 0) {
    m.horror = Math.max(0, m.horror - 1);
    log(game, `${m.name} recovers: removes 1 Horror → ${m.horror}/${MAX_HORROR}.`);
    return { ok: true };
  }
  if (m.suppressed) {
    m.suppressed = false;
    log(game, `${m.name} recovers: removes Suppressed.`);
    return { ok: true };
  }

  log(game, `${m.name} recovers but had nothing to remove.`);
  return { ok: true };
}

export function resolveDisengage(game, m, toX, toY) {
  if (m.actionsRemaining <= 0) return { ok: false, reason: "No actions" };

  const enemiesAdj = engagedEnemies(game, m);
  if (!enemiesAdj.length) {
    log(game, `${m.name} is not engaged; Disengage does nothing.`);
    return { ok: false, reason: "Not engaged" };
  }

  // move within 2, but must end NOT adjacent to any enemy
  const options = tilesWithinChebyshev(m.tx, m.ty, MOVE_PER_ACTION);
  const legal = options.some(p => p.x === toX && p.y === toY);
  if (!legal) return { ok: false, reason: "Out of range" };
  if (!canStepOn(game, toX, toY)) return { ok: false, reason: "Blocked or occupied" };

  // must end not adjacent to any enemy
  const endPos = { tx: toX, ty: toY };
  const adjacentEnemyAfter = livingModels(game).some(e => e.team !== m.team && e.deployed && isAdjacent(endPos, e));
  if (adjacentEnemyAfter) return { ok: false, reason: "Must end not engaged" };

  // opportunity attack: first adjacent enemy gets a free fight
  const attacker = enemiesAdj[0];
  log(game, `${m.name} disengages → ${attacker.name} makes an opportunity attack!`);

  // move happens after the op attack (typical)
  // resolve a fight attack
  resolveFightAttack(game, attacker, m, { free: true, label: "Opportunity Attack" });

  // now move
  moveModel(game, m, toX, toY);
  spendAction(game, m, "Disengage");
  log(game, `${m.name} disengages to (${toX},${toY}). [${m.actionsRemaining} actions left]`);
  return { ok: true };
}

function weaponReqAim(w) {
  const nm = String(w?.name ?? "").toLowerCase();
  if (nm.includes("rocket launcher")) return 2;
  if (nm.includes("sniper rifle")) return 1;
  return 0;
}

function weaponToHitBonusAndPenaltyFromText(attacker, defender, weapon) {
  // Implement a few weapon-specific modifiers explicitly.
  // You said weapon-specific modifiers always apply regardless of terrain.
  let mod = 0;
  const nm = String(weapon?.name ?? "").toLowerCase();
  const dM = distM(attacker, defender);

  if (nm.includes("sidearm")) {
    if (dM > 1) mod += -2;
  } else if (nm.includes("energy pistol")) {
    if (dM > 1) mod += -2;
  } else if (nm.includes("shotgun")) {
    if (dM > 1) {
      // "-2 to hit x distance away" : interpret as -2 * ceil(M away beyond 1)
      const distSteps = Math.ceil(dM);
      mod += -2 * distSteps;
    }
  } else if (nm.includes("sniper rifle")) {
    // ignores range-based to-hit penalties: we'll remove rangePenalty later by skipping it in caller
  }

  return mod;
}

function weaponApDamage(attacker, defender, weapon) {
  // Handle AP="*" weapons via effect_text and range.
  let ap = Number(weapon?.ap);
  let dmg = Number(weapon?.damage) || 0;
  const nm = String(weapon?.name ?? "").toLowerCase();
  const dM = distM(attacker, defender);

  if (String(weapon?.ap ?? "") === "*") ap = 0;

  if (nm.includes("energy pistol")) {
    // Range < 1 = -1 AP (i.e., AP becomes 1 at close range)
    if (dM < 1) ap = 1;
  } else if (nm.includes("shotgun")) {
    // Range < 1 = -1 AP +1 Damage
    if (dM < 1) { ap = 1; dmg += 1; }
  }

  return { ap: ap || 0, dmg };
}

export function resolveShoot(game, attacker, defender) {
  if (attacker.actionsRemaining <= 0) return { ok: false, reason: "No actions" };
  if (!defender || defender.team === attacker.team || defender.wounds <= 0 || !defender.deployed) return { ok: false, reason: "Invalid target" };
  if (!canShoot(game, attacker)) {
    log(game, `${attacker.name} is engaged and cannot Shoot (must Disengage first).`);
    return { ok: false, reason: "Engaged" };
  }

  const losInfo = losAndCover(game, attacker, defender);
  if (!losInfo.ok) {
    log(game, `${attacker.name} has no Line of Sight to ${defender.name}.`);
    return { ok: false, reason: "No LoS" };
  }

  // suppression happens when targeted (hit or miss)
  defender.suppressed = true;
  log(game, `${defender.name} becomes Suppressed (targeted by Shoot).`);

  const weapon = attacker.ranged;
  const reqAim = weaponReqAim(weapon);
  if (reqAim > 0 && attacker.aimConsecutive < reqAim) {
    log(game, `${weapon?.name ?? "Weapon"} requires Aim ${reqAim} before firing.`);
    return { ok: false, reason: "Needs Aim" };
  }

  const targetAC = armorClass(defender);

  const isSniper = String(weapon?.name ?? "").toLowerCase().includes("sniper rifle");
  const rangeMod = isSniper ? 0 : rangePenalty(attacker, defender);

  const coverMod = losInfo.coverPenalty;

  const weaponMod = weaponToHitBonusAndPenaltyFromText(attacker, defender, weapon);

  const mods = [
    effectiveShootMod(attacker),
    attacker.aimBonus || 0,
    weaponMod,
    rangeMod,
    coverMod,
    horrorPenalty(attacker),
  ];

  const { raw, total } = rollWithMods(game, `Shoot to-hit (${attacker.name} → ${defender.name})`, () => rollDie(20), mods, (s) => log(game, s));

  // aim is consumed on shoot attempt
  attacker.aimBonus = 0;
  attacker.aimConsecutive = 0;

  spendAction(game, attacker, "Shoot");

  // natural 20: automatic hit, +1 damage, save only if heavy cover
  const nat20 = (raw === 20);
  const nat1 = (raw === 1);

  if (nat1) {
    log(game, `Natural 1 → automatic miss.`);
    log(game, `${attacker.name} [${attacker.actionsRemaining} actions left]`);
    return { ok: true };
  }

  let hit = nat20 || (total >= targetAC);
  log(game, `vs AC ${targetAC} → ${hit ? "HIT" : "MISS"}`);

  if (!hit) {
    // reroll logic (Extra Eyes: reroll failed Shoot once per round)
    if (!attacker.rerollShootUsed && modelHas(attacker, "extra eyes")) {
      attacker.rerollShootUsed = true;
      log(game, `${attacker.name} uses Extra Eyes to reroll a failed Shoot roll.`);
      // re-run once with same mods but new d20
      const rr = rollWithMods(game, `Reroll Shoot to-hit`, () => rollDie(20), mods, (s) => log(game, s));
      const rrNat20 = (rr.raw === 20);
      const rrNat1 = (rr.raw === 1);
      if (rrNat1) {
        log(game, `Reroll Natural 1 → miss.`);
        log(game, `${attacker.name} [${attacker.actionsRemaining} actions left]`);
        return { ok: true };
      }
      hit = rrNat20 || (rr.total >= targetAC);
      log(game, `Reroll vs AC ${targetAC} → ${hit ? "HIT" : "MISS"}`);
      if (!hit) {
        log(game, `${attacker.name} [${attacker.actionsRemaining} actions left]`);
        return { ok: true };
      }
      // if rrNat20 apply nat20 behavior
      if (rrNat20) {
        return resolveHitDamageAndSave(game, attacker, defender, weapon, { nat20: true, losInfo });
      }
    }

    log(game, `${attacker.name} [${attacker.actionsRemaining} actions left]`);
    return { ok: true };
  }

  return resolveHitDamageAndSave(game, attacker, defender, weapon, { nat20, losInfo });
}

function resolveHitDamageAndSave(game, attacker, defender, weapon, { nat20, losInfo }) {
  const { ap, dmg } = weaponApDamage(attacker, defender, weapon);
  const finalDmg = nat20 ? (dmg + 1) : dmg;

  // Save target reduced by AP (min 10)
  const baseSave = savingThrowTarget(defender);
  const saveTarget = Math.max(10, baseSave - (ap || 0));

  const heavyCoverPresent = !!losInfo?.los?.heavyThrough;
  if (nat20 && !heavyCoverPresent) {
    log(game, `Natural 20: automatic hit (+1 dmg), no Saving Throw (unless Heavy Cover).`);
    applyDamage(game, defender, finalDmg);
    return { ok: true };
  }

  const mods = [
    effectiveWillMod(defender),
    horrorPenalty(defender),
  ];
  const { total } = rollWithMods(game, `Saving Throw (${defender.name})`, () => rollDie(20), mods, (s) => log(game, s));
  const pass = total >= saveTarget;

  log(game, `${defender.name} vs Save ${saveTarget} (base ${baseSave} - AP ${ap || 0}) → ${pass ? "SUCCESS" : "FAIL"}`);

  if (!pass) {
    applyDamage(game, defender, finalDmg);
  } else {
    log(game, `${defender.name} takes no damage.`);
  }

  return { ok: true };
}

export function resolveFightAttack(game, attacker, defender, { free = false, label = "Fight" } = {}) {
  if (!free && attacker.actionsRemaining <= 0) return { ok: false, reason: "No actions" };
  if (!defender || defender.team === attacker.team || defender.wounds <= 0 || !defender.deployed) return { ok: false, reason: "Invalid target" };
  if (!isAdjacent(attacker, defender)) {
    log(game, `${attacker.name} is not in engagement with ${defender.name}.`);
    return { ok: false, reason: "Not engaged" };
  }

  const weapon = attacker.melee;
  const targetAC = armorClass(defender);

  let mods = [
    effectiveFightMod(attacker),
    horrorPenalty(attacker),
  ];

  // Unarmed penalty: if unarmed, -2 to hit unless Clawed Limbs mutation
  const isUnarmed = String(weapon?.name ?? "").toLowerCase().includes("unarmed");
  if (isUnarmed && !modelHas(attacker, "clawed limbs")) mods.push(-2);

  const { raw, total } = rollWithMods(game, `${label} to-hit (${attacker.name} → ${defender.name})`, () => rollDie(20), mods, (s) => log(game, s));
  if (!free) spendAction(game, attacker, "Fight");

  const nat20 = (raw === 20);
  const nat1 = (raw === 1);

  if (nat1) {
    log(game, `Natural 1 → miss.`);
    return { ok: true };
  }

  let hit = nat20 || (total >= targetAC);
  log(game, `vs AC ${targetAC} → ${hit ? "HIT" : "MISS"}`);

  if (!hit) {
    // Reinforced Weapon: reroll fight hit roll once per round
    if (!attacker.rerollFightUsed && modelHas(attacker, "reinforced weapon")) {
      attacker.rerollFightUsed = true;
      log(game, `${attacker.name} uses Reinforced Weapon to reroll a failed Fight roll.`);
      const rr = rollWithMods(game, `Reroll Fight to-hit`, () => rollDie(20), mods, (s) => log(game, s));
      if (rr.raw === 1) {
        log(game, `Reroll Natural 1 → miss.`);
        return { ok: true };
      }
      const rrNat20 = (rr.raw === 20);
      hit = rrNat20 || (rr.total >= targetAC);
      log(game, `Reroll vs AC ${targetAC} → ${hit ? "HIT" : "MISS"}`);
      if (!hit) return { ok: true };
      return resolveMeleeDamageAndSave(game, attacker, defender, weapon, { nat20: rrNat20 });
    }

    return { ok: true };
  }

  return resolveMeleeDamageAndSave(game, attacker, defender, weapon, { nat20 });
}

function resolveMeleeDamageAndSave(game, attacker, defender, weapon, { nat20 }) {
  const baseSave = savingThrowTarget(defender);

  let ap = Number(weapon?.ap) || 0;
  let dmg = Number(weapon?.damage) || 0;

  // mutation: Monstrous (+1 melee dmg)
  if (modelHas(attacker, "monstrous")) dmg += 1;

  const finalDmg = nat20 ? (dmg + 1) : dmg;
  const saveTarget = Math.max(10, baseSave - ap);

  if (nat20) {
    // Nat 20 rule says "save only if heavy cover" but in melee heavy cover doesn't make sense.
    // We'll still allow save normally in melee (consistent with your earlier “fight works same”).
  }

  const mods = [
    effectiveWillMod(defender),
    horrorPenalty(defender),
  ];
  const { total } = rollWithMods(game, `Saving Throw (${defender.name})`, () => rollDie(20), mods, (s) => log(game, s));
  const pass = total >= saveTarget;
  log(game, `${defender.name} vs Save ${saveTarget} (base ${baseSave} - AP ${ap}) → ${pass ? "SUCCESS" : "FAIL"}`);

  if (!pass) applyDamage(game, defender, finalDmg);
  else log(game, `${defender.name} takes no damage.`);

  return { ok: true };
}

// Psychic powers
export function resolvePsychic(game, caster, power, target, targetPos = null) {
  if (caster.actionsRemaining <= 0) return { ok: false, reason: "No actions" };
  if (!power) return { ok: false, reason: "No power selected" };

  const pName = String(power.name ?? "Psychic Power");

  // Some powers are effects:
  const type = String(power.power_type ?? "").toLowerCase();

  // Horrible Scream: pick one grid box; everyone within 2 grid spaces affected; auto-hit; save or gain 1 horror
  if (pName.toLowerCase() === "horrible scream") {
    if (!targetPos) return { ok: false, reason: "Needs target position" };
    spendAction(game, caster, "Psychic");
    log(game, `${caster.name} uses Horrible Scream at (${targetPos.x},${targetPos.y}) (AoE radius 2 tiles).`);

    const affected = livingModels(game).filter(m => m.deployed && distGrid({ tx: targetPos.x, ty: targetPos.y }, m) <= 2);
    for (const m of affected) {
      const mods = [ effectiveWillMod(m), horrorPenalty(m) ];
      const { total } = rollWithMods(game, `Save vs Horrible Scream (${m.name})`, () => rollDie(20), mods, (s) => log(game, s));
      const saveT = savingThrowTarget(m);
      const pass = total >= saveT;
      log(game, `${m.name} vs Save ${saveT} → ${pass ? "PASS" : "FAIL"}`);
      if (!pass) gainHorror(game, m, 1, "Horrible Scream");
    }
    log(game, `${caster.name} [${caster.actionsRemaining} actions left]`);
    return { ok: true };
  }

  // Fear (per your correction): auto-hit; defender saves vs their save target; fail => move 1M away (2 tiles)
  if (pName.toLowerCase() === "fear") {
    if (!target || target.team === caster.team) return { ok: false, reason: "Invalid target" };
    // requires LoS? We'll require LoS if deployed
    const losInfo = losAndCover(game, caster, target);
    if (!losInfo.ok) {
      log(game, `${caster.name} has no LoS to ${target.name} for Fear.`);
      return { ok: false, reason: "No LoS" };
    }

    spendAction(game, caster, "Psychic");
    log(game, `${caster.name} uses Fear on ${target.name} (auto-hit).`);

    const mods = [ effectiveWillMod(target), horrorPenalty(target) ];
    const { total } = rollWithMods(game, `Saving Throw (${target.name})`, () => rollDie(20), mods, (s) => log(game, s));
    const saveT = savingThrowTarget(target);
    const pass = total >= saveT;
    log(game, `${target.name} vs Save ${saveT} → ${pass ? "SUCCESS" : "FAIL"}`);

    if (!pass) {
      // move 1M away (2 tiles): choose a tile that increases distance from caster
      const opts = tilesWithinChebyshev(target.tx, target.ty, MOVE_PER_ACTION)
        .filter(p => canStepOn(game, p.x, p.y));
      opts.sort((a, b) => distGrid({ tx: b.x, ty: b.y }, caster) - distGrid({ tx: a.x, ty: a.y }, caster));
      if (opts.length) {
        const pick = opts[0];
        moveModel(game, target, pick.x, pick.y);
        log(game, `${target.name} flees to (${pick.x},${pick.y}).`);
      }
      gainHorror(game, target, 1, "Fear");
    }

    log(game, `${caster.name} [${caster.actionsRemaining} actions left]`);
    return { ok: true };
  }

  // Heal: wounds only, within 1M and LoS (or self)
  if (pName.toLowerCase() === "heal") {
    // allow self if no target
    const tgt = target || caster;
    if (tgt !== caster) {
      const d = distM(caster, tgt);
      if (d > 1) return { ok: false, reason: "Out of range" };
      const losInfo = losAndCover(game, caster, tgt);
      if (!losInfo.ok) return { ok: false, reason: "No LoS" };
    }

    spendAction(game, caster, "Psychic");
    const amt = rollDie(4);
    tgt.wounds = Math.min(tgt.woundsMax, tgt.wounds + amt);
    log(game, `${caster.name} casts Heal on ${tgt.name}: heals d4=${amt} → ${tgt.wounds}/${tgt.woundsMax}`);
    log(game, `${caster.name} [${caster.actionsRemaining} actions left]`);
    return { ok: true };
  }

  // Inspire: target ally in LoS may immediately free Move or Recover
  if (pName.toLowerCase() === "inspire") {
    if (!target || target.team !== caster.team) return { ok: false, reason: "Must target ally" };
    const losInfo = losAndCover(game, caster, target);
    if (!losInfo.ok) return { ok: false, reason: "No LoS" };

    spendAction(game, caster, "Psychic");
    log(game, `${caster.name} casts Inspire on ${target.name}: ${target.name} may immediately Move or Recover.`);

    // Sandbox simplification: we grant an immediate free Recover if they have horror/suppressed; else a free Move 2 tiles toward nearest enemy
    if (target.horror > 0 || target.suppressed) {
      const beforeH = target.horror;
      if (target.horror > 0) target.horror = Math.max(0, target.horror - 1);
      else target.suppressed = false;
      log(game, `${target.name} uses Inspire to Recover immediately. Horror ${beforeH}→${target.horror}, Suppressed=${target.suppressed ? "Yes" : "No"}`);
    } else {
      const enemies = livingModels(game).filter(e => e.team !== target.team && e.deployed);
      if (enemies.length) {
        enemies.sort((a, b) => distGrid(target, a) - distGrid(target, b));
        const nearest = enemies[0];
        const opts = tilesWithinChebyshev(target.tx, target.ty, MOVE_PER_ACTION).filter(p => canStepOn(game, p.x, p.y));
        opts.sort((a, b) => distGrid({ tx: a.x, ty: a.y }, nearest) - distGrid({ tx: b.x, ty: b.y }, nearest));
        if (opts.length) {
          moveModel(game, target, opts[0].x, opts[0].y);
          log(game, `${target.name} uses Inspire to Move to (${opts[0].x},${opts[0].y}).`);
        }
      }
    }

    log(game, `${caster.name} [${caster.actionsRemaining} actions left]`);
    return { ok: true };
  }

  // Blink: place the psychic anywhere (cannot ignore engagement; cannot be placed into engagement)
  if (pName.toLowerCase() === "blink") {
    if (!targetPos) return { ok: false, reason: "Needs destination tile" };
    const dest = { tx: targetPos.x, ty: targetPos.y };
    if (!canStepOn(game, dest.tx, dest.ty)) return { ok: false, reason: "Blocked or occupied" };

    // cannot be placed into engagement: destination must not be adjacent to any enemy
    const adjacentEnemy = livingModels(game).some(e => e.team !== caster.team && e.deployed && isAdjacent(dest, e));
    if (adjacentEnemy) return { ok: false, reason: "Blink cannot place into engagement" };

    spendAction(game, caster, "Psychic");
    moveModel(game, caster, dest.tx, dest.ty);
    log(game, `${caster.name} blinks to (${dest.tx},${dest.ty}).`);
    log(game, `${caster.name} [${caster.actionsRemaining} actions left]`);
    return { ok: true };
  }

  // Default psychic attack: d20 + WPmod + modifiers vs AC, target saves like normal
  if (!target || target.team === caster.team) return { ok: false, reason: "Invalid target" };
  const losInfo = losAndCover(game, caster, target);
  if (!losInfo.ok) return { ok: false, reason: "No LoS" };

  const targetAC = armorClass(target);
  const mods = [
    effectiveWillMod(caster),
    horrorPenalty(caster),
  ];

  const { raw, total } = rollWithMods(game, `Psychic to-hit (${caster.name} → ${target.name})`, () => rollDie(20), mods, (s) => log(game, s));
  spendAction(game, caster, "Psychic");

  if (raw === 1) {
    log(game, `Natural 1: Psychic backfires on caster (take 1 damage).`);
    applyDamage(game, caster, 1);
    return { ok: true };
  }

  const hit = (raw === 20) || (total >= targetAC);
  log(game, `vs AC ${targetAC} → ${hit ? "HIT" : "MISS"}`);
  if (!hit) return { ok: true };

  // For sandbox default: treat as 1 damage, AP 0 unless power says otherwise
  let ap = 0;
  let dmg = 1;
  if (pName.toLowerCase() === "mind stab") {
    ap = 3; // "Roll with -3 AP" meaning it reduces save by 3
    dmg = 1;
  }

  const baseSave = savingThrowTarget(target);
  const saveTarget = Math.max(10, baseSave - ap);

  const saveMods = [ effectiveWillMod(target), horrorPenalty(target) ];
  const save = rollWithMods(game, `Saving Throw (${target.name})`, () => rollDie(20), saveMods, (s) => log(game, s));
  const pass = save.total >= saveTarget;
  log(game, `${target.name} vs Save ${saveTarget} (base ${baseSave} - AP ${ap}) → ${pass ? "SUCCESS" : "FAIL"}`);

  if (!pass) applyDamage(game, target, dmg);
  return { ok: true };
}
