// src/main.js
// Micro Skirmish Sandbox (standalone main.js)
// - No dependency on sim.js (safe if files got out of sync)
// - Uses ./data/*.json for random warbands (same data folder as builder)
// - Supports import from (A) your builder warband JSON object OR (B) a simple array-of-models format
// - Enforces: select model -> select action -> click board
// - Move/Charge: 2 tiles per action (max 3 actions/activation)
// - Engagement: adjacent incl diagonals
// - LoS: center-to-center; blocked tiles block; heavy tiles transparent (-3); corner clip = light cover (-1, approximated)
// - Range penalties: >2M => -1, >3M => -3 (1M = 2 tiles); stacks with terrain cover and weapon-specific rules
// - AP reduces defender saving throw target (min 10)
// - Aim applies to next ranged attack only (+1, or +3 if aimed twice consecutively), then resets
// - Suppressed when targeted by Shoot (hit or miss); cannot Aim; must pass Horror Test to Move
// - Horror: -1 per token to all rolls, max 5, max +1 token per model per round

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");

const ui = {
  log: document.getElementById("log"),
  sel: document.getElementById("sel"),
  wbJson: document.getElementById("wbJson"),

  btnMove: document.getElementById("btnMove"),
  btnCharge: document.getElementById("btnCharge"),
  btnShoot: document.getElementById("btnShoot"),
  btnFight: document.getElementById("btnFight"),
  btnDisengage: document.getElementById("btnDisengage"),
  btnRecover: document.getElementById("btnRecover"),
  btnAim: document.getElementById("btnAim"),
  btnEndAct: document.getElementById("btnEndAct"),
  btnNextRound: document.getElementById("btnNextRound"),
  btnNewMap: document.getElementById("btnNewMap"),
  btnLoadBlue: document.getElementById("btnLoadBlue"),
  btnLoadRed: document.getElementById("btnLoadRed"),
  btnRandomWarbands: document.getElementById("btnRandomWarbands"),
};

// --- Canvas sizing ---
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);

// --- RNG helpers ---
function rint(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(arr) {
  return arr[rint(0, arr.length - 1)];
}
function d20() { return rint(1, 20); }
function d4() { return rint(1, 4); }

// --- Grid + board ---
const TILE = 42;
let GRID_W = 22;
let GRID_H = 16;

const TILE_EMPTY = 0;
const TILE_HEAVY = 1; // heavy cover (transparent, -3 to hit)
const TILE_BLOCK = 2; // blocks LoS entirely

function chebDist(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}
function tilesToMeters(tiles) {
  // 1M = 2 tiles. Use exact half.
  return tiles / 2;
}
function withinGrid(x, y) {
  return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;
}

// Bresenham line (tile coordinates, inclusive)
function bresenham(x0, y0, x1, y1) {
  const pts = [];
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0, y = y0;

  while (true) {
    pts.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return pts;
}

// Approx "corner clip" => light cover:
// If line passes adjacent to a block tile (not on the line) we treat as light cover.
function cornerClipLightCover(linePts, board) {
  const seen = new Set(linePts.map(([x,y]) => `${x},${y}`));
  for (const [x, y] of linePts) {
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;
        const nx = x + ox, ny = y + oy;
        if (!withinGrid(nx, ny)) continue;
        if (board[ny][nx] !== TILE_BLOCK) continue;
        if (!seen.has(`${nx},${ny}`)) return true;
      }
    }
  }
  return false;
}

function adjacentToObstacle(tx, ty, board) {
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0 && oy === 0) continue;
      const nx = tx + ox, ny = ty + oy;
      if (!withinGrid(nx, ny)) continue;
      if (board[ny][nx] === TILE_BLOCK || board[ny][nx] === TILE_HEAVY) return true;
    }
  }
  return false;
}

// LoS check center-to-center
function losInfo(ax, ay, bx, by, board) {
  const pts = bresenham(ax, ay, bx, by);

  // Ignore the first point (attacker tile) for obstruction.
  let heavyOnLine = false;
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i];
    const t = board[y][x];
    if (t === TILE_BLOCK) return { hasLoS: false, cover: "block" };
    if (t === TILE_HEAVY) heavyOnLine = true;
  }

  // Terrain cover:
  // - Heavy tile on the line => heavy cover
  // - Else if corner clip OR target adjacent to obstacle => light cover
  if (heavyOnLine) return { hasLoS: true, cover: "heavy" };

  const light =
    cornerClipLightCover(pts, board) ||
    adjacentToObstacle(bx, by, board) ||
    adjacentToObstacle(ax, ay, board);

  return { hasLoS: true, cover: light ? "light" : "none" };
}

// --- Data loading (from builder-style files) ---
const data = {
  shoot: [],
  fight: [],
  accessories: [],
  psychic: [],
  mutations: [],
  warbandTraits: [],
  leaderTraits: [],
};

async function loadAllData() {
  const fetchJson = async (path) => {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${path} (HTTP ${res.status})`);
    return res.json();
  };

  data.shoot = await fetchJson("./data/shoot.json");
  data.fight = await fetchJson("./data/fight.json");
  data.accessories = await fetchJson("./data/accessories.json");
  data.psychic = await fetchJson("./data/psychic_powers.json");
  data.mutations = await fetchJson("./data/mutations.json");
  data.warbandTraits = await fetchJson("./data/warband_traits.json");
  data.leaderTraits = await fetchJson("./data/leader_traits.json");
}

// --- Stat tables (same as builder) ---
const DEF_WILL_TABLE = {
  0: { mod: -2, cost: 0 },
  1: { mod: 0,  cost: 2 },
  2: { mod: 2,  cost: 4 },
  3: { mod: 4,  cost: 8 },
};

const SHOOT_FIGHT_TABLE = {
  0: { mod: -2, cost: 0 },
  1: { mod: -2, cost: 0 },
  2: { mod: 2,  cost: 3 },
  3: { mod: 4,  cost: 6 },
};

const SAVE_TARGET_BY_WILL = { 0: 14, 1: 14, 2: 13, 3: 11 };

function defenseMod(tier) { return (DEF_WILL_TABLE[tier] ?? DEF_WILL_TABLE[1]).mod; }
function willMod(tier)    { return (DEF_WILL_TABLE[tier] ?? DEF_WILL_TABLE[1]).mod; }
function shootMod(tier)   { return (SHOOT_FIGHT_TABLE[tier] ?? SHOOT_FIGHT_TABLE[1]).mod; }
function fightMod(tier)   { return (SHOOT_FIGHT_TABLE[tier] ?? SHOOT_FIGHT_TABLE[1]).mod; }
function clampMin(n, min) { return n < min ? min : n; }

function armorClass(model) {
  return 10 + defenseMod(model.tiers.defense);
}
function saveTarget(model) {
  return clampMin((SAVE_TARGET_BY_WILL[model.tiers.will] ?? 14), 10);
}
function woundsMax(model) {
  const t = model.tiers;
  return (t.defense ?? 0) + (t.shoot ?? 0) + (t.fight ?? 0) + (t.will ?? 0);
}
function horrorPenalty(model) {
  return -(model.horrorTokens ?? 0);
}

// --- Game state ---
const game = {
  board: [],

  round: 1,
  activeTeam: null,          // "Red" or "Blue"
  pendingFirstPicker: null,  // who won initiative and chooses first
  initiative: { Red: 0, Blue: 0 },

  actionSelected: null,      // "Move"|"Charge"|"Shoot"|"Fight"|"Disengage"|"Recover"|"Aim"
  selectedId: null,          // currently selected model (can be non-active)
  activeId: null,            // current activation model id (must belong to activeTeam)
  needsTargetClick: false,   // action awaiting board click

  teams: {
    Red: { name: "Red Warband", trait: null, leaderTrait: null, models: [] },
    Blue:{ name: "Blue Warband", trait: null, leaderTrait: null, models: [] },
  },
};

// --- Logging ---
function log(line) {
  const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  ui.log.textContent += `[${ts}] ${line}\n`;
  ui.log.scrollTop = ui.log.scrollHeight;
}
function clearLog() {
  ui.log.textContent = "";
}

// --- Board gen ---
function newRandomMap() {
  game.board = Array.from({ length: GRID_H }, () => Array.from({ length: GRID_W }, () => TILE_EMPTY));

  // Keep deployment lanes clear-ish near edges:
  const safeCols = 2; // left 2 cols for Blue, right 2 cols for Red
  const densityHeavy = 0.10;
  const densityBlock = 0.08;

  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (x < safeCols || x >= GRID_W - safeCols) continue;
      const r = Math.random();
      if (r < densityBlock) game.board[y][x] = TILE_BLOCK;
      else if (r < densityBlock + densityHeavy) game.board[y][x] = TILE_HEAVY;
    }
  }

  log("New random map generated.");
}

// --- Model helpers ---
let _idCounter = 1;
function newId() { return `m${_idCounter++}`; }

function getAllModels() {
  return [...game.teams.Red.models, ...game.teams.Blue.models];
}
function getModel(id) {
  return getAllModels().find(m => m.id === id) || null;
}
function modelsByTeam(team) {
  return game.teams[team].models;
}
function enemyTeam(team) {
  return team === "Red" ? "Blue" : "Red";
}
function firstActivatableModel(team) {
  return modelsByTeam(team).find(m => !m.dead && !m.exhausted) || null;
}


function isOccupied(tx, ty) {
  for (const m of getAllModels()) {
    if (m.dead) continue;
    if (!m.deployed) continue;
    if (m.tx === tx && m.ty === ty) return true;
  }
  return false;
}

function isEngaged(model) {
  if (!model.deployed || model.dead) return false;
  const enemies = modelsByTeam(enemyTeam(model.team)).filter(m => m.deployed && !m.dead);
  for (const e of enemies) {
    if (chebDist(model.tx, model.ty, e.tx, e.ty) <= 1) return true; // adjacent incl diagonals
  }
  return false;
}

function engagedEnemies(model) {
  const out = [];
  const enemies = modelsByTeam(enemyTeam(model.team)).filter(m => m.deployed && !m.dead);
  for (const e of enemies) {
    if (chebDist(model.tx, model.ty, e.tx, e.ty) <= 1) out.push(e);
  }
  return out;
}

// --- Random warband generation (simple + reroll invalid) ---
const NAME_BITS_A = ["Ash", "Iron", "Grave", "Chrome", "Void", "Feral", "Sewer", "Moon", "Rust", "Bleak", "Glass", "Bone"];
const NAME_BITS_B = ["Cult", "Cabal", "Pack", "Choir", "Horde", "Crew", "Cell", "Order", "Swarm", "Runners", "Knights", "Stalkers"];
const MODEL_BITS = ["Rook", "Vesper", "Moth", "Jaw", "Wisp", "Hex", "Kite", "Grit", "Lumen", "Dreg", "Spite", "Cinder"];

function genWarbandName() { return `The ${pick(NAME_BITS_A)} ${pick(NAME_BITS_B)}`; }
function genModelName() { return `${pick(MODEL_BITS)}-${rint(10, 99)}`; }

function statCost(tiers) {
  const d = (DEF_WILL_TABLE[tiers.defense] ?? DEF_WILL_TABLE[1]).cost;
  const w = (DEF_WILL_TABLE[tiers.will] ?? DEF_WILL_TABLE[1]).cost;
  const s = (SHOOT_FIGHT_TABLE[tiers.shoot] ?? SHOOT_FIGHT_TABLE[1]).cost;
  const f = (SHOOT_FIGHT_TABLE[tiers.fight] ?? SHOOT_FIGHT_TABLE[1]).cost;
  return d + w + s + f;
}

function maxAccessorySlots(tiers) { return tiers.defense; }
function maxPsiMutSlots(tiers) { return tiers.will; }

function buildRandomLoadout(tiers, pointCap) {
  // Reroll strategy in caller if invalid
  const loadout = {
    rangedIdx: null,
    sidearmIdx: null, // optional, not needed in sandbox v1
    meleeIdx: null,
    accessoryIdx: [],
    psychicIdx: [],
    mutationIdx: [],
  };

  const statPts = statCost(tiers);
  if (statPts > pointCap) return null;

  let remaining = pointCap - statPts;

  // Weapons: 1 ranged + 1 melee (optional)
  const rangedChoices = data.shoot
    .map((w, i) => ({ w, i }))
    .filter(x => (x.w?.name || "").toLowerCase() !== "no ranged weapon")
    .filter(x => (x.w?.points ?? 0) <= remaining);

  if (rangedChoices.length) {
    const choice = pick(rangedChoices);
    loadout.rangedIdx = choice.i;
    remaining -= Number(choice.w.points || 0);
  }

  const meleeChoices = data.fight
    .map((w, i) => ({ w, i }))
    .filter(x => (x.w?.name || "").toLowerCase() !== "unarmed")
    .filter(x => (x.w?.points ?? 0) <= remaining);

  if (meleeChoices.length) {
    const choice = pick(meleeChoices);
    loadout.meleeIdx = choice.i;
    remaining -= Number(choice.w.points || 0);
  }

  // Accessories up to defense tier
  const accCap = maxAccessorySlots(tiers);
  for (let k = 0; k < accCap; k++) {
    const choices = data.accessories
      .map((a, i) => ({ a, i }))
      .filter(x => (x.a?.name || "").toLowerCase() !== "no items")
      .filter(x => !loadout.accessoryIdx.includes(x.i))
      .filter(x => (x.a?.points ?? 0) <= remaining);

    if (!choices.length) break;
    const c = pick(choices);
    loadout.accessoryIdx.push(c.i);
    remaining -= Number(c.a.points || 0);
  }

  // Psychic + Mutations up to will tier total
  const pmCap = maxPsiMutSlots(tiers);
  for (let k = 0; k < pmCap; k++) {
    const pool = [];

    for (let i = 0; i < data.psychic.length; i++) {
      const p = data.psychic[i];
      if ((p?.name || "").toLowerCase() === "no psychic powers") continue;
      if (loadout.psychicIdx.includes(i)) continue;
      const pts = Number(p.points || 0);
      if (pts <= remaining) pool.push({ kind: "psy", i, pts });
    }
    for (let i = 0; i < data.mutations.length; i++) {
      const m = data.mutations[i];
      if ((m?.name || "").toLowerCase() === "not mutated") continue;
      if (loadout.mutationIdx.includes(i)) continue;
      const pts = Number(m.points || 0);
      if (pts <= remaining) pool.push({ kind: "mut", i, pts });
    }

    if (!pool.length) break;
    const c = pick(pool);
    if (c.kind === "psy") loadout.psychicIdx.push(c.i);
    else loadout.mutationIdx.push(c.i);
    remaining -= c.pts;
  }

  return loadout;
}

function randomTiersWithinCap(pointCap) {
  // Allocate tiers first then fill gear until cap; reroll invalid.
  // Use tiers 1..3 only (matching builder UI).
  for (let tries = 0; tries < 200; tries++) {
    const tiers = {
      defense: rint(1, 3),
      shoot: rint(1, 3),
      fight: rint(1, 3),
      will: rint(1, 3),
    };
    if (statCost(tiers) <= pointCap) return tiers;
  }
  // fallback
  return { defense: 1, shoot: 1, fight: 1, will: 1 };
}

function makeRandomWarband(team) {
  const wb = game.teams[team];
  wb.name = genWarbandName();
  wb.trait = pick(data.warbandTraits || []) || null;
  wb.leaderTrait = pick(data.leaderTraits || []) || null;

  const models = [];

  // Leader (<=20)
  {
    let leader = null;
    for (let tries = 0; tries < 250; tries++) {
      const tiers = randomTiersWithinCap(20);
      const loadout = buildRandomLoadout(tiers, 20);
      if (!loadout) continue;

      leader = makeModel({
        team,
        role: "Leader",
        name: genModelName(),
        tiers,
        loadout,
        pointCap: 20,
      });
      break;
    }
    if (!leader) {
      leader = makeModel({
        team,
        role: "Leader",
        name: genModelName(),
        tiers: { defense: 1, shoot: 1, fight: 1, will: 1 },
        loadout: { rangedIdx: null, meleeIdx: null, accessoryIdx: [], psychicIdx: [], mutationIdx: [] },
        pointCap: 20,
      });
    }
    models.push(leader);
  }

  // Followers (<=75 each)
  for (let i = 1; i <= 4; i++) {
    let follower = null;
    for (let tries = 0; tries < 250; tries++) {
      const tiers = randomTiersWithinCap(75);
      const loadout = buildRandomLoadout(tiers, 75);
      if (!loadout) continue;

      follower = makeModel({
        team,
        role: `Model ${i}`,
        name: genModelName(),
        tiers,
        loadout,
        pointCap: 75,
      });
      break;
    }
    if (!follower) {
      follower = makeModel({
        team,
        role: `Model ${i}`,
        name: genModelName(),
        tiers: { defense: 1, shoot: 1, fight: 1, will: 1 },
        loadout: { rangedIdx: null, meleeIdx: null, accessoryIdx: [], psychicIdx: [], mutationIdx: [] },
        pointCap: 75,
      });
    }
    models.push(follower);
  }

  wb.models = models;
}

function makeModel({ team, role, name, tiers, loadout }) {
  const m = {
    id: newId(),
    team,
    role,
    name,
    tiers: { ...tiers },

    // loadout indices into the data arrays
    loadout: {
      rangedIdx: loadout.rangedIdx ?? null,
      meleeIdx: loadout.meleeIdx ?? null,
      accessoryIdx: [...(loadout.accessoryIdx || [])],
      psychicIdx: [...(loadout.psychicIdx || [])],
      mutationIdx: [...(loadout.mutationIdx || [])],
    },

    // position
    deployed: false,
    tx: 0,
    ty: 0,

    // combat state
    wounds: 0,
    dead: false,
    exhausted: false,
    suppressed: false,
    horrorTokens: 0,
    horrorGainedThisRound: false,
    nextActActionPenalty: 0,

    // activation state
    actionsLeft: 0,
    aimedCount: 0, // 0/1/2 (consecutive aims)
    movedThisActivation: 0,
    deployedThisGame: false,
  };

  m.wounds = woundsMax(m);
  return m;
}

// --- Initiative / rounds / activation ---
function teamInitiativeBonus(team) {
  // "Both teams roll d20 plus willpower"
  // We'll interpret as highest Willpower modifier among living models.
  const models = modelsByTeam(team).filter(m => !m.dead);
  if (!models.length) return 0;
  return Math.max(...models.map(m => willMod(m.tiers.will)));
}

function rollInitiative() {
  const rRoll = d20() + teamInitiativeBonus("Red");
  const bRoll = d20() + teamInitiativeBonus("Blue");
  game.initiative.Red = rRoll;
  game.initiative.Blue = bRoll;

  if (rRoll === bRoll) {
    log(`Initiative tie: Red ${rRoll} vs Blue ${bRoll} — rerolling.`);
    return rollInitiative();
  }

  const winner = rRoll > bRoll ? "Red" : "Blue";
  game.pendingFirstPicker = winner;
  game.activeTeam = winner;
  log(`Initiative: Red ${rRoll} vs Blue ${bRoll} — ${winner} goes first.`);
}

function startRound() {
  game.round += 1;

  // reset per-round things
  for (const m of getAllModels()) {
    if (m.dead) continue;
    m.exhausted = false;
    m.horrorGainedThisRound = false;
    m.aimedCount = 0;
    m.movedThisActivation = 0;
    // suppression persists
    // action penalty persists until next activation
  }

  game.activeId = null;
  game.actionSelected = null;
  game.needsTargetClick = false;

  rollInitiative();
  updateButtons();
  renderSelected();
}

function endActivation(force = false) {
  const active = getModel(game.activeId);
  if (!active) {
    if (!force) log("No active model to end activation for.");
    return;
  }
  active.exhausted = true;
  active.actionsLeft = 0;
  active.aimedCount = 0;
  active.movedThisActivation = 0;

  log(`${active.team} ${active.name} is Exhausted.`);

  game.activeId = null;
  game.actionSelected = null;
  game.needsTargetClick = false;

  // switch to other team, unless they have no unexhausted models
  const nextTeam = enemyTeam(game.activeTeam);
  const nextHas = modelsByTeam(nextTeam).some(m => !m.dead && !m.exhausted);
  const curHas  = modelsByTeam(game.activeTeam).some(m => !m.dead && !m.exhausted);

  if (nextHas) {
    game.activeTeam = nextTeam;
    log(`Next activation: ${game.activeTeam}`);
  } else if (curHas) {
    // other team is done, current team continues choosing (rare)
    log(`${nextTeam} has no unexhausted models — ${game.activeTeam} continues.`);
  } else {
    // round ends
    log("All models exhausted — starting next round.");
    startRound();
    return;
  }

  updateButtons();
  renderSelected();
}

// --- Action logic ---
const ACTIONS = ["Move", "Charge", "Shoot", "Fight", "Disengage", "Recover", "Aim"];

function setAction(action) {
  if (!ACTIONS.includes(action)) return;

  let active = getModel(game.activeId);

  // ✅ If nothing is active yet, auto-activate the next available model for the active team.
  if (!active) {
    const next = firstActivatableModel(game.activeTeam);
    if (!next) {
      log(`No available models for ${game.activeTeam}.`);
      return;
    }
    game.selectedId = next.id;
    beginActivation(next);
    active = next;
    renderSelected();
  }

  if (active.team !== game.activeTeam) {
    log(`It's ${game.activeTeam}'s turn.`);
    return;
  }
  if (active.exhausted) {
    log("That model is exhausted.");
    return;
  }
  if (active.actionsLeft <= 0) {
    log("No actions left. End activation.");
    return;
  }

  // Suppressed: cannot Aim
  if (action === "Aim" && active.suppressed) {
    log(`${active.name} is Suppressed and cannot Aim.`);
    return;
  }

  // Engagement: cannot Shoot
  if (action === "Shoot" && isEngaged(active)) {
    log(`${active.name} is Engaged and cannot Shoot.`);
    return;
  }

  game.actionSelected = action;
  game.needsTargetClick = true;
  updateButtons();

  // Helpful prompt for deployment
  if (!active.deployed) {
    log(`Deploy ${active.name}: click a tile in your deployment zone (Blue = left 2 cols, Red = right 2 cols).`);
  }
}


function spendAction(model, n = 1) {
  model.actionsLeft = Math.max(0, model.actionsLeft - n);
}

function horrorTest(model, reason) {
  const roll = d20();
  const total = roll + willMod(model.tiers.will) + horrorPenalty(model);
  const target = saveTarget(model);

  log(`${model.team} ${model.name} Horror Test (${reason}): d20(${roll}) + WP(${willMod(model.tiers.will)}) + Horror(${horrorPenalty(model)}) = ${total} vs ${target}`);

  if (total >= target) return true;

  if (!model.horrorGainedThisRound && model.horrorTokens < 5) {
    model.horrorTokens += 1;
    model.horrorGainedThisRound = true;
    log(`${model.name} fails and gains 1 Horror (now ${model.horrorTokens}).`);
  } else {
    log(`${model.name} fails (no Horror gained: max/limit reached).`);
  }
  return false;
}

function applySuppressed(target) {
  if (!target.suppressed) {
    target.suppressed = true;
    log(`${target.name} becomes Suppressed (targeted by Shoot).`);
  } else {
    log(`${target.name} is already Suppressed.`);
  }
}

function computeRangePenalty(attacker, target) {
  const tiles = chebDist(attacker.tx, attacker.ty, target.tx, target.ty);
  const meters = tilesToMeters(tiles);
  // If >2M => -1, if >3M => -3
  if (meters > 3) return -3;
  if (meters > 2) return -1;
  return 0;
}

function weaponByIdx(kind, idx) {
  if (idx === null || idx === undefined) return null;
  if (kind === "ranged") return data.shoot[idx] || null;
  if (kind === "melee") return data.fight[idx] || null;
  return null;
}

function hasAccessory(model, name) {
  const ids = model.loadout.accessoryIdx || [];
  for (const i of ids) {
    const a = data.accessories[i];
    if (!a) continue;
    if ((a.name || "").toLowerCase() === name.toLowerCase()) return true;
  }
  return false;
}

function shootWeaponMods(attacker, target, weapon) {
  // Weapon-specific modifiers always apply regardless of terrain.
  // Implement the important ones by weapon name (simple v1).
  const name = (weapon?.name || "").toLowerCase();
  const tiles = chebDist(attacker.tx, attacker.ty, target.tx, target.ty);
  const meters = Math.ceil(tilesToMeters(tiles)); // coarse for penalties

  let toHitMod = 0;
  let apMod = 0;
  let dmgMod = 0;
  let requiresAim = 0;
  let blocksClose = false;
  let ignoreRangePenalty = false;

  if (name.includes("sidearm")) {
    if (tiles > 2) toHitMod += -2; // Range > 1M
  } else if (name.includes("energy pistol")) {
    if (tiles > 2) toHitMod += -2;
    if (tiles <= 2) apMod += -1; // Range < 1M = -1 AP
  } else if (name.includes("shotgun")) {
    if (tiles <= 2) { apMod += -1; dmgMod += 1; }
    if (tiles > 2) { toHitMod += -2 * meters; }
  } else if (name.includes("sniper")) {
    requiresAim = 2;
    blocksClose = true; // Cannot target Range < 1M
    ignoreRangePenalty = true;
  } else if (name.includes("rocket")) {
    requiresAim = 2;
    blocksClose = true;
  } else if (name.includes("energy rifle")) {
    // reroll handled elsewhere
  }

  return { toHitMod, apMod, dmgMod, requiresAim, blocksClose, ignoreRangePenalty };
}

function doShoot(attacker, target) {
  const weapon = weaponByIdx("ranged", attacker.loadout.rangedIdx);

  // Must have LoS
  const li = losInfo(attacker.tx, attacker.ty, target.tx, target.ty, game.board);
  if (!li.hasLoS) {
    log(`Shoot: No LoS from ${attacker.name} to ${target.name}.`);
    return false;
  }

  // Cannot shoot if engaged
  if (isEngaged(attacker)) {
    log(`Shoot: ${attacker.name} is Engaged and cannot Shoot.`);
    return false;
  }

  // Apply suppression (hit or miss, just being targeted)
  applySuppressed(target);

  // Aim bonus (next attack only)
  const aimBonus = attacker.aimedCount === 0 ? 0 : (attacker.aimedCount === 1 ? 1 : 3);

  // Base modifiers
  const baseShoot = shootMod(attacker.tiers.shoot);
  const horrorMod = horrorPenalty(attacker);

  // Accessory/mutation simple bonuses (minimal v1; extend later)
  let gearMod = 0;
  if (hasAccessory(attacker, "Targeting Reticule")) gearMod += 1;

  // Terrain cover penalty
  let terrainPenalty = 0;
  if (li.cover === "heavy") terrainPenalty -= 3;
  else if (li.cover === "light") terrainPenalty -= 1;

  // Range penalty (stacks with terrain cover)
  let rangePenalty = computeRangePenalty(attacker, target);

  const wmods = shootWeaponMods(attacker, target, weapon);
  if (wmods.ignoreRangePenalty) rangePenalty = 0;

  // Must Aim2 restrictions
  const tiles = chebDist(attacker.tx, attacker.ty, target.tx, target.ty);
  if (wmods.blocksClose && tiles <= 2) {
    log(`Shoot: ${weapon?.name || "Weapon"} cannot target within 1M.`);
    return false;
  }
  if (wmods.requiresAim > 0 && attacker.aimedCount < wmods.requiresAim) {
    log(`Shoot: ${weapon?.name || "Weapon"} requires Aim${wmods.requiresAim} (you have Aim${attacker.aimedCount}).`);
    return false;
  }

  const roll = d20();
  const total =
    roll +
    baseShoot +
    aimBonus +
    gearMod +
    horrorMod +
    terrainPenalty +
    rangePenalty +
    wmods.toHitMod;

  const ac = armorClass(target);

  // Natural 20: auto hit, +1 damage, save only if heavy cover
  // Natural 1: miss
  const nat20 = roll === 20;
  const nat1 = roll === 1;

  const attackLine = `Shoot ${attacker.name} → ${target.name}: d20(${roll}) + Shoot(${baseShoot}) + Aim(${aimBonus}) + Gear(${gearMod}) + Horror(${horrorMod}) + Terrain(${terrainPenalty}) + Range(${rangePenalty}) + Weapon(${wmods.toHitMod}) = ${total} vs AC ${ac}`;
  log(attackLine);

  // Reset aim after any shoot attempt (you said resets after shoot)
  attacker.aimedCount = 0;

  if (nat1) {
    log("→ Natural 1: Miss.");
    return true; // action spent, resolved
  }

  const hit = nat20 ? true : (total >= ac);
  if (!hit) {
    log("→ Miss.");
    return true;
  }

  // Determine damage + AP
  let dmg = Number(weapon?.damage || 0) + wmods.dmgMod;
  let ap = Number(weapon?.ap || 0);
  if (Number.isNaN(ap)) ap = 0; // for ap:"*" we ignore and use mods only (weapon text handled by wmods)
  ap += wmods.apMod;

  if (nat20) dmg += 1;

  // Saving throw target reduced by AP (min 10)
  // Example: base 13, AP 2 -> target 11 (easier to pass)
  // If AP negative, target increases (harder)
  const baseSave = saveTarget(target);
  const effSave = clampMin(baseSave - ap, 10);

  // Nat20: target may Saving Throw only if Heavy Cover
  if (nat20 && li.cover !== "heavy") {
    log(`→ Natural 20: Auto-hit for ${dmg} damage (no save unless Heavy Cover).`);
    applyDamage(target, dmg);
    return true;
  }

  const sroll = d20();
  const stotal = sroll + willMod(target.tiers.will) + horrorPenalty(target);
  log(`Save ${target.name}: d20(${sroll}) + WP(${willMod(target.tiers.will)}) + Horror(${horrorPenalty(target)}) = ${stotal} vs ${effSave} (base ${baseSave}, AP ${ap})`);

  if (stotal >= effSave) {
    log("→ Save succeeds: no damage.");
    return true;
  }

  log(`→ Save fails: takes ${dmg} damage.`);
  applyDamage(target, dmg);
  return true;
}

function doFight(attacker, target) {
  // Must be engaged (adjacent incl diagonals)
  if (chebDist(attacker.tx, attacker.ty, target.tx, target.ty) > 1) {
    log(`Fight: ${target.name} is not in engagement range.`);
    return false;
  }

  const weapon = weaponByIdx("melee", attacker.loadout.meleeIdx);
  const baseFight = fightMod(attacker.tiers.fight);
  const horrorMod = horrorPenalty(attacker);

  let gearMod = 0;
  if (hasAccessory(attacker, "Cybernetics")) gearMod += 1;

  const roll = d20();
  const total = roll + baseFight + gearMod + horrorMod;
  const ac = armorClass(target);

  const nat20 = roll === 20;
  const nat1 = roll === 1;

  log(`Fight ${attacker.name} → ${target.name}: d20(${roll}) + Fight(${baseFight}) + Gear(${gearMod}) + Horror(${horrorMod}) = ${total} vs AC ${ac}`);

  if (nat1) {
    log("→ Natural 1: Miss.");
    return true;
  }

  const hit = nat20 ? true : (total >= ac);
  if (!hit) {
    log("→ Miss.");
    return true;
  }

  let dmg = Number(weapon?.damage || 1);
  let ap = Number(weapon?.ap || 0);
  if (Number.isNaN(ap)) ap = 0;

  if (nat20) dmg += 1;

  const baseSave = saveTarget(target);
  const effSave = clampMin(baseSave - ap, 10);

  // Nat20: auto hit (still allows save unless you want special melee crit rules)
  const sroll = d20();
  const stotal = sroll + willMod(target.tiers.will) + horrorPenalty(target);
  log(`Save ${target.name}: d20(${sroll}) + WP(${willMod(target.tiers.will)}) + Horror(${horrorPenalty(target)}) = ${stotal} vs ${effSave} (base ${baseSave}, AP ${ap})`);

  if (stotal >= effSave) {
    log("→ Save succeeds: no damage.");
    return true;
  }

  log(`→ Save fails: takes ${dmg} damage.`);
  applyDamage(target, dmg);
  return true;
}

function applyDamage(target, dmg) {
  target.wounds -= dmg;
  if (target.wounds <= 0) {
    target.wounds = 0;
    target.dead = true;
    log(`${target.name} is taken Out of Action! Removed from the game.`);
    // If target was selected/active, clear selection safely
    if (game.selectedId === target.id) game.selectedId = null;
    if (game.activeId === target.id) {
      game.activeId = null;
      game.actionSelected = null;
      game.needsTargetClick = false;
    }
  } else {
    log(`${target.name} now has ${target.wounds}/${woundsMax(target)} Wounds.`);
  }
}

// --- Movement ---
function canMoveTo(model, nx, ny) {
  if (!withinGrid(nx, ny)) return false;
  if (game.board[ny][nx] === TILE_BLOCK) return false;
  if (isOccupied(nx, ny)) return false;
  return true;
}

function doMove(model, nx, ny) {
  // Suppressed: must pass horror test to Move
  if (model.suppressed) {
    const ok = horrorTest(model, "Move while Suppressed");
    if (!ok) {
      log(`${model.name} cannot Move (failed Horror Test).`);
      return false;
    }
  }

  const dist = chebDist(model.tx, model.ty, nx, ny);
  if (dist > 2) {
    log(`Move: destination too far (${dist} tiles, max 2 per action).`);
    return false;
  }
  if (!canMoveTo(model, nx, ny)) {
    log("Move: destination blocked/occupied/outside grid.");
    return false;
  }

  model.tx = nx;
  model.ty = ny;
  model.movedThisActivation += 1;
  log(`${model.name} moves to (${nx},${ny}).`);
  return true;
}

function deployOnEdge(model, nx, ny) {
  // Blue deploys on left edge; Red on right edge
  const edgeWidth = 2;
  if (model.team === "Blue") {
    if (nx >= edgeWidth) return false;
  } else {
    if (nx < GRID_W - edgeWidth) return false;
  }

  if (!withinGrid(nx, ny)) return false;
  if (game.board[ny][nx] === TILE_BLOCK) return false;
  if (isOccupied(nx, ny)) return false;

  model.tx = nx;
  model.ty = ny;
  model.deployed = true;
  model.deployedThisGame = true;
  log(`${model.team} deploys ${model.name} at (${nx},${ny}). (Counts as first Move)`);
  return true;
}

function doCharge(attacker, target) {
  // Charge is 2 tiles per action. Click enemy tile. We move into an adjacent tile to the target.
  if (!target.deployed || target.dead) return false;

  const distToEnemy = chebDist(attacker.tx, attacker.ty, target.tx, target.ty);
  // Need to end adjacent. From current position, the chosen adjacent tile must be within 2.
  // We choose the "best" adjacent tile automatically (closest along the line).
  const adj = [];
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0 && oy === 0) continue;
      const nx = target.tx + ox;
      const ny = target.ty + oy;
      if (!withinGrid(nx, ny)) continue;
      if (!canMoveTo(attacker, nx, ny)) continue;
      const d = chebDist(attacker.tx, attacker.ty, nx, ny);
      if (d <= 2) adj.push({ nx, ny, d });
    }
  }
  if (!adj.length) {
    log(`Charge: no reachable adjacent tile to engage ${target.name}.`);
    return false;
  }

  adj.sort((a, b) => a.d - b.d);
  const dest = adj[0];

  attacker.tx = dest.nx;
  attacker.ty = dest.ny;
  log(`${attacker.name} charges into engagement with ${target.name} at (${dest.nx},${dest.ny}).`);

  // Defender horror test: on fail, gain horror + lose 1 action next activation (min 1)
  const ok = horrorTest(target, "Charged");
  if (!ok) {
    target.nextActActionPenalty = Math.max(target.nextActActionPenalty, 1);
    log(`${target.name} will have -1 action next activation (min 1).`);
  }
  return true;
}

function doDisengage(model, nx, ny) {
  const enemies = engagedEnemies(model);
  if (!enemies.length) {
    log("Disengage: not engaged.");
    return false;
  }

  // Move like normal (2 tiles per action), but must end NOT adjacent to any enemy
  const dist = chebDist(model.tx, model.ty, nx, ny);
  if (dist > 2) {
    log("Disengage: destination too far.");
    return false;
  }
  if (!canMoveTo(model, nx, ny)) {
    log("Disengage: destination blocked/occupied.");
    return false;
  }

  // Check new engagement
  for (const e of enemies) {
    if (chebDist(nx, ny, e.tx, e.ty) <= 1) {
      log("Disengage: destination would still be engaged.");
      return false;
    }
  }

  // Opportunity attack: one enemy makes a free Fight
  const attacker = enemies[0];
  log(`Disengage: ${attacker.name} makes an opportunity attack!`);
  // resolve fight (free)
  doFight(attacker, model);

  model.tx = nx;
  model.ty = ny;
  log(`${model.name} disengages to (${nx},${ny}).`);
  return true;
}

// --- Psychic (minimal v1) ---
// You didn’t add Psychic buttons to sandbox.html yet, so this is reserved.
// (We still keep loadout + data for later.)

// --- Recover / Aim ---
function doRecover(model) {
  // Remove 1 horror OR remove suppressed. Prefer horror if any.
  if (model.horrorTokens > 0) {
    model.horrorTokens -= 1;
    log(`${model.name} Recovers: removes 1 Horror (now ${model.horrorTokens}).`);
    return true;
  }
  if (model.suppressed) {
    model.suppressed = false;
    log(`${model.name} Recovers: removes Suppressed.`);
    return true;
  }
  log(`${model.name} Recovers: nothing to remove.`);
  return true;
}

function doAim(model) {
  // Aim stacks: first aim -> +1, second consecutive -> +3
  // You can keep aiming past 2, but it stays at 2.
  model.aimedCount = Math.min(2, model.aimedCount + 1);
  const bonus = model.aimedCount === 1 ? 1 : 3;
  log(`${model.name} Aims (Aim${model.aimedCount}): next Shoot gets +${bonus}.`);
  return true;
}

// --- Turn / activation selection ---
function beginActivation(model) {
  if (model.dead) return false;
  if (model.exhausted) return false;
  if (model.team !== game.activeTeam) return false;

  game.activeId = model.id;
  model.aimedCount = 0;
  model.movedThisActivation = 0;

  // Actions: base 3, apply nextActActionPenalty (min 1)
  const penalty = model.nextActActionPenalty || 0;
  model.nextActActionPenalty = 0;
  model.actionsLeft = Math.max(1, 3 - penalty);

  log(`${model.team} activates ${model.name} (${model.actionsLeft} actions).`);
  return true;
}

function allExhausted(team) {
  return modelsByTeam(team).filter(m => !m.dead).every(m => m.exhausted);
}

function checkRoundEnd() {
  const redDone = allExhausted("Red");
  const blueDone = allExhausted("Blue");
  if (redDone && blueDone) {
    log("All models exhausted — starting next round.");
    startRound();
    return true;
  }
  return false;
}

// --- UI wiring ---
function setActiveButton(btn) {
  const all = [
    ui.btnMove, ui.btnCharge, ui.btnShoot, ui.btnFight,
    ui.btnDisengage, ui.btnRecover, ui.btnAim,
  ];
  for (const b of all) {
    if (!b) continue;
    b.style.outline = "none";
    b.style.boxShadow = "none";
    b.style.border = "1px solid #ddd";
    b.style.background = "#fff";
  }
  if (btn) {
    btn.style.border = "2px solid #111";
    btn.style.boxShadow = "0 0 0 2px rgba(0,0,0,0.06)";
  }
}

function updateButtons() {
  // Highlight selected action
  const action = game.actionSelected;
  setActiveButton(
    action === "Move" ? ui.btnMove :
    action === "Charge" ? ui.btnCharge :
    action === "Shoot" ? ui.btnShoot :
    action === "Fight" ? ui.btnFight :
    action === "Disengage" ? ui.btnDisengage :
    action === "Recover" ? ui.btnRecover :
    action === "Aim" ? ui.btnAim :
    null
  );
}

function renderSelected() {
  const sel = getModel(game.selectedId);
  if (!sel) {
    ui.sel.innerHTML = `<div class="small">—</div>`;
    return;
  }

  const ranged = weaponByIdx("ranged", sel.loadout.rangedIdx);
  const melee = weaponByIdx("melee", sel.loadout.meleeIdx);

  ui.sel.innerHTML = `
    <div><strong>${sel.team} — ${escapeHtml(sel.name)}</strong></div>
    <div class="small">${escapeHtml(sel.role)}</div>
    <hr/>
    <div class="small"><strong>Activation</strong></div>
    <div class="small">Active Team: ${game.activeTeam ?? "—"} | Active Model: ${game.activeId === sel.id ? "YES" : "no"} | Exhausted: ${sel.exhausted ? "YES" : "no"}</div>
    <div class="small">Actions Left: ${sel.actionsLeft ?? 0}</div>
    <hr/>
    <div class="small"><strong>Stats</strong></div>
    <div class="small">Defense T${sel.tiers.defense} (mod ${fmtMod(defenseMod(sel.tiers.defense))})</div>
    <div class="small">Shoot T${sel.tiers.shoot} (mod ${fmtMod(shootMod(sel.tiers.shoot))})</div>
    <div class="small">Fight T${sel.tiers.fight} (mod ${fmtMod(fightMod(sel.tiers.fight))})</div>
    <div class="small">Will T${sel.tiers.will} (mod ${fmtMod(willMod(sel.tiers.will))})</div>
    <div class="small">AC ${armorClass(sel)} | Save ${saveTarget(sel)} | Wounds ${sel.wounds}/${woundsMax(sel)}</div>
    <hr/>
    <div class="small"><strong>Status</strong></div>
    <div class="small">Suppressed: ${sel.suppressed ? "YES" : "no"} | Horror: ${sel.horrorTokens}</div>
    <div class="small">Engaged: ${isEngaged(sel) ? "YES" : "no"}</div>
    <hr/>
    <div class="small"><strong>Weapons</strong></div>
    <div class="small">Ranged: ${escapeHtml(ranged?.name ?? "—")} (D ${ranged?.damage ?? 0}, AP ${ranged?.ap ?? 0})</div>
    <div class="small">Melee: ${escapeHtml(melee?.name ?? "Unarmed")} (D ${melee?.damage ?? 1}, AP ${melee?.ap ?? 0})</div>
  `;
}

function fmtMod(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// --- Import/Export support ---
function loadTeamFromTextarea(team) {
  let txt = ui.wbJson.value.trim();
  if (!txt) {
    log("Import: textarea is empty.");
    return;
  }

  try {
    const parsed = JSON.parse(txt);

    // Option A: builder warband object { name, members:[...], warbandTraitIdx, leaderTraitIdx, ... }
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.members)) {
      const wbObj = parsed;
      const out = builderWarbandToModels(team, wbObj);
      game.teams[team].name = String(wbObj.name || `${team} Warband`);
      game.teams[team].trait = (wbObj.warbandTraitIdx !== "" && wbObj.warbandTraitIdx != null)
        ? (data.warbandTraits[Number(wbObj.warbandTraitIdx)] || null)
        : null;
      game.teams[team].leaderTrait = (wbObj.leaderTraitIdx !== "" && wbObj.leaderTraitIdx != null)
        ? (data.leaderTraits[Number(wbObj.leaderTraitIdx)] || null)
        : null;
      game.teams[team].models = out;
      log(`Imported ${team} from builder warband JSON (${out.length} models).`);
      hardResetAfterRosterChange();
      return;
    }

    // Option B: simple array of models (older sandbox style)
    if (Array.isArray(parsed)) {
      const out = simpleArrayToModels(team, parsed);
      game.teams[team].models = out;
      log(`Imported ${team} from array JSON (${out.length} models).`);
      hardResetAfterRosterChange();
      return;
    }

    throw new Error("Unsupported JSON shape. Paste builder warband JSON or an array of models.");
  } catch (e) {
    log(`Import failed: ${String(e.message || e)}`);
  }
}

function builderWarbandToModels(team, wbObj) {
  // Convert your builder warband shape into sandbox models.
  // Builder member fields: defense/shoot/fight/will, weaponIdx, meleeIdx, accessoryIdx, psychicIdx, mutationIdx, name, role.
  const members = wbObj.members.slice(0, 5);

  return members.map((m, i) => {
    const tiers = {
      defense: Number(m.defense ?? 1),
      shoot: Number(m.shoot ?? 1),
      fight: Number(m.fight ?? 1),
      will: Number(m.will ?? 1),
    };

    const loadout = {
      rangedIdx: m.weaponIdx === "" || m.weaponIdx == null ? null : Number(m.weaponIdx),
      meleeIdx: m.meleeIdx === "" || m.meleeIdx == null ? null : Number(m.meleeIdx),
      accessoryIdx: Array.isArray(m.accessoryIdx) ? m.accessoryIdx.map(Number).filter(Number.isFinite) : [],
      psychicIdx: Array.isArray(m.psychicIdx) ? m.psychicIdx.map(Number).filter(Number.isFinite) : [],
      mutationIdx: Array.isArray(m.mutationIdx) ? m.mutationIdx.map(Number).filter(Number.isFinite) : [],
    };

    return makeModel({
      team,
      role: m.role || (i === 0 ? "Leader" : `Model ${i}`),
      name: String(m.name || genModelName()),
      tiers,
      loadout,
    });
  });
}

function simpleArrayToModels(team, arr) {
  // Expected sample:
  // [{"name":"A1","team":"Blue","tx":2,"ty":3,"tiers":{"def":2,"wp":2,"shoot":2,"fight":2}}]
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const o = arr[i] || {};
    const tiers = o.tiers || {};
    const t = {
      defense: Number(tiers.def ?? tiers.defense ?? 1),
      will: Number(tiers.wp ?? tiers.will ?? 1),
      shoot: Number(tiers.shoot ?? 1),
      fight: Number(tiers.fight ?? 1),
    };

    out.push(makeModel({
      team,
      role: o.role || (i === 0 ? "Leader" : `Model ${i}`),
      name: String(o.name || genModelName()),
      tiers: { defense: t.defense, will: t.will, shoot: t.shoot, fight: t.fight },
      loadout: { rangedIdx: null, meleeIdx: null, accessoryIdx: [], psychicIdx: [], mutationIdx: [] },
    }));
  }
  return out.slice(0, 5);
}

function hardResetAfterRosterChange() {
  // Keep the current map, but reset all deployment and round state.
  for (const m of getAllModels()) {
    m.deployed = false;
    m.dead = false;
    m.exhausted = false;
    m.suppressed = false;
    m.horrorTokens = 0;
    m.horrorGainedThisRound = false;
    m.actionsLeft = 0;
    m.aimedCount = 0;
    m.movedThisActivation = 0;
    m.nextActActionPenalty = 0;
    m.wounds = woundsMax(m);
  }

  game.selectedId = null;
  game.activeId = null;
  game.actionSelected = null;
  game.needsTargetClick = false;

  game.round = 0; // startRound will ++
  clearLog();
  log("Roster changed. Resetting round state.");
  startRound();
}

// --- Mouse interaction ---
function canvasToTile(px, py) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((px - rect.left) / TILE);
  const y = Math.floor((py - rect.top) / TILE);
  return { x, y };
}

canvas.addEventListener("click", (ev) => {
  const { x: tx, y: ty } = canvasToTile(ev.clientX, ev.clientY);
  if (!withinGrid(tx, ty)) return;

  // First: see if click selects a model
  const clickedModel = getAllModels().find(m => !m.dead && m.deployed && m.tx === tx && m.ty === ty) || null;

  // ✅ If we're mid-action (Shoot/Fight/Charge) and click an enemy model,
  // treat it as a target click instead of "selecting" that model.
  const active = getModel(game.activeId);
  if (
    clickedModel &&
    active &&
    game.actionSelected &&
    (game.actionSelected === "Shoot" || game.actionSelected === "Fight" || game.actionSelected === "Charge") &&
    clickedModel.team !== active.team
  ) {
    resolveBoardClick(tx, ty);
    return;
  }

  
  // If no active model, selecting a friendly unexhausted model begins activation (only if it's that team's turn)
  if (clickedModel) {

  // ✅ If an action is selected and you clicked an enemy model,
  // treat this click as a target click (Shoot/Fight/Charge), not as selection.
  const act = getModel(game.activeId);
  if (
    act &&
    game.actionSelected &&
    (game.actionSelected === "Shoot" || game.actionSelected === "Fight" || game.actionSelected === "Charge") &&
    clickedModel.team !== act.team
  ) {
    resolveBoardClick(tx, ty);
    return;
  }

    
    game.selectedId = clickedModel.id;
    renderSelected();

    const active = getModel(game.activeId);
    if (!active) {
      // Start activation only if correct team + not exhausted
      if (clickedModel.team !== game.activeTeam) {
        log(`It's ${game.activeTeam}'s turn. Select a ${game.activeTeam} model.`);
        updateButtons();
        return;
      }
      if (clickedModel.exhausted) {
        log("That model is exhausted.");
        updateButtons();
        return;
      }
      beginActivation(clickedModel);
      updateButtons();
      renderSelected();
      return;
    } else {
      // If there's an active model, don't allow switching mid-activation
      if (clickedModel.id !== active.id) {
        log("You must finish the current activation (or End Activation) before selecting another model.");
      }
      updateButtons();
      return;
    }
  }

  // If click isn't on a model, it's a board click for an action
  resolveBoardClick(tx, ty);
});

function resolveBoardClick(tx, ty) {
  const active = getModel(game.activeId);
  if (!active) {
    log("Select a model to activate first.");
    return;
  }
  if (active.team !== game.activeTeam) {
    log(`It's ${game.activeTeam}'s turn.`);
    return;
  }
  if (active.exhausted) {
    log("That model is exhausted.");
    return;
  }
  if (!game.actionSelected) {
    log("Select an action first.");
    return;
  }
  if (active.actionsLeft <= 0) {
    log("No actions left. End activation.");
    return;
  }

  // Deployment rule: during first activation, player chooses where to deploy; counts as first move.
  if (!active.deployed) {
    const ok = deployOnEdge(active, tx, ty);
    if (!ok) {
      log(`Deploy: must deploy on ${active.team === "Blue" ? "left" : "right"} edge (2 columns), in an empty non-blocked tile.`);
      return;
    }
    spendAction(active, 1);
    game.needsTargetClick = false;
    // Keep action selected so player can continue, but require them to click action again per your pattern
    game.actionSelected = null;
    updateButtons();
    renderSelected();
    return;
  }

  const action = game.actionSelected;
  let resolved = false;

  if (action === "Move") {
    resolved = doMove(active, tx, ty);
  } else if (action === "Disengage") {
    resolved = doDisengage(active, tx, ty);
  } else if (action === "Charge") {
    const target = getAllModels().find(m => !m.dead && m.deployed && m.tx === tx && m.ty === ty && m.team !== active.team) || null;
    if (!target) {
      log("Charge: click an enemy model.");
      return;
    }
    resolved = doCharge(active, target);
  } else if (action === "Shoot") {
    const target = getAllModels().find(m => !m.dead && m.deployed && m.tx === tx && m.ty === ty && m.team !== active.team) || null;
    if (!target) {
      log("Shoot: click an enemy model.");
      return;
    }
    resolved = doShoot(active, target);
  } else if (action === "Fight") {
    const target = getAllModels().find(m => !m.dead && m.deployed && m.tx === tx && m.ty === ty && m.team !== active.team) || null;
    if (!target) {
      log("Fight: click an enemy model.");
      return;
    }
    resolved = doFight(active, target);
  } else if (action === "Recover") {
    resolved = doRecover(active);
  } else if (action === "Aim") {
    resolved = doAim(active);
  }

  if (resolved) {
    spendAction(active, 1);

    // After resolving an action, require player to click action again (your required pattern).
    game.actionSelected = null;
    game.needsTargetClick = false;

    // If active model died somehow (opportunity attack), handle
    if (active.dead) {
      game.activeId = null;
      game.selectedId = null;
    }

    // If no actions left, auto end activation? (I’ll keep it manual; user has End Activation button)
    if (active.actionsLeft <= 0 && !active.dead) {
      log(`${active.name} has no actions left. (Click End Activation)`);
    }

    updateButtons();
    renderSelected();
    checkRoundEnd();
  }
}

// --- Rendering ---
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, GRID_W * TILE, GRID_H * TILE);

  // tiles
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const t = game.board[y][x];
      if (t === TILE_HEAVY) {
        ctx.fillStyle = "#d9d9d9"; // light gray heavy cover
        ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
      } else if (t === TILE_BLOCK) {
        ctx.fillStyle = "#6b6b6b"; // dark gray blocks LoS
        ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
      }
    }
  }

  // grid lines
  ctx.strokeStyle = "#eeeeee";
  ctx.lineWidth = 1;
  for (let x = 0; x <= GRID_W; x++) {
    ctx.beginPath();
    ctx.moveTo(x * TILE, 0);
    ctx.lineTo(x * TILE, GRID_H * TILE);
    ctx.stroke();
  }
  for (let y = 0; y <= GRID_H; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * TILE);
    ctx.lineTo(GRID_W * TILE, y * TILE);
    ctx.stroke();
  }

  // deployment edges hint
  ctx.fillStyle = "rgba(0, 120, 255, 0.05)";
  ctx.fillRect(0, 0, 2 * TILE, GRID_H * TILE);
  ctx.fillStyle = "rgba(255, 0, 0, 0.05)";
  ctx.fillRect((GRID_W - 2) * TILE, 0, 2 * TILE, GRID_H * TILE);

  // models
  for (const m of getAllModels()) {
    if (m.dead) continue;
    if (!m.deployed) continue;

    const cx = m.tx * TILE + TILE / 2;
    const cy = m.ty * TILE + TILE / 2;

    // base circle
    ctx.beginPath();
    ctx.arc(cx, cy, TILE * 0.33, 0, Math.PI * 2);
    ctx.fillStyle = (m.team === "Red") ? "#d33" : "#36f";
    ctx.fill();

    // outline for selected / active
    const isSel = game.selectedId === m.id;
    const isAct = game.activeId === m.id;

    if (isAct) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#111";
      ctx.stroke();
    } else if (isSel) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#111";
      ctx.stroke();
    }

    // status pips
    const pipY = cy - TILE * 0.45;
    // exhausted indicator
    if (m.exhausted) {
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillRect(cx - 10, pipY - 6, 20, 3);
    }

    // suppressed indicator
    if (m.suppressed) {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(cx - 10, pipY, 20, 3);
    }

    // horror tokens
    if (m.horrorTokens > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      for (let i = 0; i < Math.min(5, m.horrorTokens); i++) {
        ctx.beginPath();
        ctx.arc(cx - 10 + i * 5, pipY + 10, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // wounds text
    ctx.fillStyle = "#111";
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(m.wounds), cx, cy);
  }

  requestAnimationFrame(draw);
}

// --- Hook up buttons ---
function bindUI() {
  ui.btnMove?.addEventListener("click", () => setAction("Move"));
  ui.btnCharge?.addEventListener("click", () => setAction("Charge"));
  ui.btnShoot?.addEventListener("click", () => setAction("Shoot"));
  ui.btnFight?.addEventListener("click", () => setAction("Fight"));
  ui.btnDisengage?.addEventListener("click", () => setAction("Disengage"));
  ui.btnRecover?.addEventListener("click", () => setAction("Recover"));
  ui.btnAim?.addEventListener("click", () => setAction("Aim"));

  ui.btnEndAct?.addEventListener("click", () => {
    // If no active model, do nothing
    endActivation(false);
    // If ending activation created end-of-round, startRound already ran
    updateButtons();
    renderSelected();
  });

  ui.btnNextRound?.addEventListener("click", () => {
    log("Next Round forced.");
    startRound();
  });

  ui.btnNewMap?.addEventListener("click", () => {
    newRandomMap();
  });

  ui.btnLoadBlue?.addEventListener("click", () => loadTeamFromTextarea("Blue"));
  ui.btnLoadRed?.addEventListener("click", () => loadTeamFromTextarea("Red"));

  ui.btnRandomWarbands?.addEventListener("click", () => {
    clearLog();
    randomizeBothWarbands();
  });
}

function randomizeBothWarbands() {
  // Reset IDs so imports don’t collide visually
  _idCounter = 1;
  game.teams.Red.models = [];
  game.teams.Blue.models = [];

  makeRandomWarband("Blue");
  makeRandomWarband("Red");

  log(`Blue Warband: ${game.teams.Blue.name}`);
  log(`Red Warband: ${game.teams.Red.name}`);
  if (game.teams.Blue.trait) log(`Blue Trait: ${game.teams.Blue.trait.name}`);
  if (game.teams.Red.trait) log(`Red Trait: ${game.teams.Red.trait.name}`);
  if (game.teams.Blue.leaderTrait) log(`Blue Leader Trait: ${game.teams.Blue.leaderTrait.name}`);
  if (game.teams.Red.leaderTrait) log(`Red Leader Trait: ${game.teams.Red.leaderTrait.name}`);

  hardResetAfterRosterChange();
}

// --- Boot ---
(async function boot() {
  resizeCanvas();
  bindUI();

  try {
    await loadAllData();
  } catch (e) {
    log(`ERROR loading data: ${String(e.message || e)}`);
    log("Make sure ./data/*.json exists relative to sandbox.html");
    return;
  }

  // Fit board to canvas a bit (optional)
  // Use fixed for now so it matches rules better.
  GRID_W = Math.max(18, Math.min(26, Math.floor(canvas.getBoundingClientRect().width / TILE)));
  GRID_H = Math.max(14, Math.min(20, Math.floor(canvas.getBoundingClientRect().height / TILE)));

  newRandomMap();
  clearLog();
  log("Sandbox ready.");

  // Start with random warbands by default
  randomizeBothWarbands();

  requestAnimationFrame(draw);
})();
