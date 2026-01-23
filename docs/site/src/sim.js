// Micro Skirmish Playtester (grid prototype)
// Features: random obstacles, LOS/cover, alternating activations,
// Engagement (no shoot/aim while engaged), Charge (click enemy),
// Disengage (opportunity attack), Suppression + Horror mechanics.

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function manhattan(ax, ay, bx, by) {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function d20(rng) {
  return 1 + Math.floor(rng() * 20);
}

// Bresenham line
function lineTiles(x0, y0, x1, y1) {
  const tiles = [];
  let dx = Math.abs(x1 - x0),
    sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0),
    sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;

  let x = x0,
    y = y0;
  while (true) {
    tiles.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return tiles;
}

// === Builder-aligned stat tables ===
const DEF_WILL_TABLE = {
  0: { mod: -2, cost: 0 },
  1: { mod: 0, cost: 2 },
  2: { mod: 2, cost: 4 },
  3: { mod: 4, cost: 8 },
};

const SHOOT_FIGHT_TABLE = {
  0: { mod: -2, cost: 0 },
  1: { mod: -2, cost: 0 },
  2: { mod: 2, cost: 3 },
  3: { mod: 4, cost: 6 },
};

const SAVE_TARGET_BY_WILL = { 0: 14, 1: 14, 2: 13, 3: 11 };

function defenseMod(t) {
  return (DEF_WILL_TABLE[t] ?? DEF_WILL_TABLE[1]).mod;
}
function willMod(t) {
  return (DEF_WILL_TABLE[t] ?? DEF_WILL_TABLE[1]).mod;
}
function shootMod(t) {
  return (SHOOT_FIGHT_TABLE[t] ?? SHOOT_FIGHT_TABLE[1]).mod;
}
function fightMod(t) {
  return (SHOOT_FIGHT_TABLE[t] ?? SHOOT_FIGHT_TABLE[1]).mod;
}
function savingThrowTargetTier(willTier) {
  const base = SAVE_TARGET_BY_WILL[willTier] ?? SAVE_TARGET_BY_WILL[1];
  return Math.max(10, base);
}

export class Game {
  constructor({ cols, rows, seed, obstacleDensity = 0.12 }) {
    this.cols = cols;
    this.rows = rows;
    this.seed = seed ?? 1;
    this.rng = mulberry32(this.seed);
    this.obstacleDensity = obstacleDensity;

    this.onLog = (msg) => console.log(msg);

    this.round = 1;

    // Alternating activation state (winner chooses later; fixed for prototype)
    this.teamOrder = ["Blue", "Red"];
    this.activationTeamIndex = 0;

    this.units = [];
    this.activeUnitId = null;
    this.selectedId = null;

    this.newRandomMap();
    this.randomWarbands();
    this.startRound();
  }

  log(msg) {
    this.onLog(msg);
  }

  // --- Map / Obstacles ---
  newRandomMap() {
    this.grid = Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => 0)
    );

    // Keep spawn lanes open (left 3 cols, right 3 cols)
    for (let y = 0; y < this.rows; y++) {
      for (let x = 3; x < this.cols - 3; x++) {
        if (this.rng() < this.obstacleDensity) this.grid[y][x] = 1;
      }
    }
    this.log("Generated random obstacles.");
  }

  isObstacle(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows) return true;
    return this.grid[ty][tx] === 1;
  }

  hasLOS(attacker, target) {
    const tiles = lineTiles(attacker.tx, attacker.ty, target.tx, target.ty);
    for (let i = 1; i < tiles.length - 1; i++) {
      if (this.isObstacle(tiles[i].x, tiles[i].y)) return false;
    }
    return true;
  }

  // cover heuristic
  getCover(attacker, target) {
    // Heavy cover if obstacle on LOS between them (excluding endpoints)
    const tiles = lineTiles(attacker.tx, attacker.ty, target.tx, target.ty);
    for (let i = 1; i < tiles.length - 1; i++) {
      if (this.isObstacle(tiles[i].x, tiles[i].y)) return "heavy";
    }

    // Light cover if target adjacent to any obstacle
    const adj = [
      { x: target.tx + 1, y: target.ty },
      { x: target.tx - 1, y: target.ty },
      { x: target.tx, y: target.ty + 1 },
      { x: target.tx, y: target.ty - 1 },
    ];
    if (adj.some((p) => this.isObstacle(p.x, p.y))) return "light";
    return "none";
  }

  // --- Engagement ---
  isEngaged(u) {
    return this.units.some(
      (v) =>
        v.hp > 0 &&
        v.team !== u.team &&
        manhattan(u.tx, u.ty, v.tx, v.ty) === 1
    );
  }

  getAdjacentEnemies(u) {
    return this.units.filter(
      (v) =>
        v.hp > 0 &&
        v.team !== u.team &&
        manhattan(u.tx, u.ty, v.tx, v.ty) === 1
    );
  }

  // --- Units / Warbands ---
  makeUnitFromTiers({ name, team, tx, ty, tiers = {}, extra = {} }) {
    // accept either {defense,will,shoot,fight} or older {def,wp,shoot,fight}
    const defTier = clamp(tiers.defense ?? tiers.def ?? 1, 0, 3);
    const willTier = clamp(tiers.will ?? tiers.wp ?? 1, 0, 3);
    const shootTier = clamp(tiers.shoot ?? 1, 0, 3);
    const fightTier = clamp(tiers.fight ?? 1, 0, 3);

    const mods = {
      def: defenseMod(defTier),
      wp: willMod(willTier),
      shoot: shootMod(shootTier),
      fight: fightMod(fightTier),
    };

    // AC = 10 + Defense Mod + accessory/mutation bonus (not yet computed here)
    const acBonus = Number(extra.acBonus ?? 0);
    const ac = 10 + mods.def + acBonus;

    // Wounds = sum of tiers
    const hp = defTier + willTier + shootTier + fightTier;

    return {
      id: crypto.randomUUID(),
      name,
      team,
      tx,
      ty,

      tiers: { defense: defTier, will: willTier, shoot: shootTier, fight: fightTier },
      mods,
      ac,
      acBonus,

      hp,
      range: Number(extra.range ?? 7),

      suppressed: false,
      exhausted: false,

      horror: 0, // max 5
      gainedHorrorThisRound: false, // 1 token per model per round cap
      gainedHorrorFromSuppressionThisRound: false,

      actionsLeft: 3,
      actionPenaltyNextActivation: 0, // from Charge Shock

      recoveredThisActivation: false,
      aimStreak: 0,
      aimBonus: 0,
    };
  }

  clearTeam(team) {
    this.units = this.units.filter((u) => u.team !== team);
  }

  loadWarbandFromJson(jsonText, team) {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error("Invalid JSON.");
    }

    // If builder export object: { members: [...] }
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.members)) {
      this.loadWarbandFromBuilderExport(parsed, team);
      return;
    }

    if (!Array.isArray(parsed)) {
      throw new Error("Expected a JSON array OR a builder export object with members[].");
    }

    this.loadWarbandFromModelArray(parsed, team);
  }

  loadWarbandFromBuilderExport(warbandObj, team) {
    this.clearTeam(team);

    const spawnX = team === "Blue" ? 1 : this.cols - 2;
    const members = warbandObj.members.slice(0, 5);

    let i = 0;
    for (const m of members) {
      const nm = String(m.name ?? "").trim();
      const name = nm || `${team[0]}${i + 1}`;
      const tx = spawnX;
      const ty = clamp(2 + i * 2, 0, this.rows - 1);

      const unit = this.makeUnitFromTiers({
        name,
        team,
        tx,
        ty,
        tiers: { defense: m.defense, will: m.will, shoot: m.shoot, fight: m.fight },
        extra: { acBonus: 0 }, // future: derive from accessories/mutations
      });

      if (this.isObstacle(unit.tx, unit.ty)) unit.ty = 1 + (i % (this.rows - 2));
      this.units.push(unit);
      i++;
    }

    this.log(`Loaded ${team} warband from builder export (${members.length} models).`);
    this.startRound();
  }

  loadWarbandFromModelArray(arr, team) {
    this.clearTeam(team);
    const spawnX = team === "Blue" ? 1 : this.cols - 2;

    let i = 0;
    for (const m of arr) {
      const name = String(m.name ?? `${team[0]}${i + 1}`);
      const ty = clamp(Number(m.ty ?? 2 + i * 2), 0, this.rows - 1);
      const tx = clamp(Number(m.tx ?? spawnX), 0, this.cols - 1);

      const unit = this.makeUnitFromTiers({
        name,
        team,
        tx,
        ty,
        tiers: m.tiers ?? m,
        extra: { acBonus: Number(m.acBonus ?? 0), range: Number(m.range ?? 7) },
      });

      if (this.isObstacle(unit.tx, unit.ty)) unit.ty = 1 + (i % (this.rows - 2));
      this.units.push(unit);
      i++;
    }

    this.log(`Loaded ${team} warband (${arr.length} models).`);
    this.startRound();
  }

  randomWarbands() {
    this.units = [];

    const makeSide = (team) => {
      const spawnX = team === "Blue" ? 1 : this.cols - 2;
      const names = team === "Blue" ? ["A1", "A2", "A3"] : ["B1", "B2", "B3"];

      for (let i = 0; i < names.length; i++) {
        const unit = this.makeUnitFromTiers({
          name: names[i],
          team,
          tx: spawnX,
          ty: 2 + i * 3,
          tiers: {
            defense: 1 + Math.floor(this.rng() * 3),
            will: 1 + Math.floor(this.rng() * 3),
            shoot: 1 + Math.floor(this.rng() * 3),
            fight: 1 + Math.floor(this.rng() * 3),
          },
        });

        if (this.isObstacle(unit.tx, unit.ty)) unit.ty = 1 + (i % (this.rows - 2));
        this.units.push(unit);
      }
    };

    makeSide("Blue");
    makeSide("Red");

    this.log("Generated random warbands.");
    this.startRound();
  }

  // --- Round / Alternating Activation ---
  startRound() {
    for (const u of this.units) {
      u.exhausted = false;
      u.actionsLeft = 3;
      u.recoveredThisActivation = false;
      u.aimStreak = 0;
      u.aimBonus = 0;
      u.gainedHorrorThisRound = false;
      u.gainedHorrorFromSuppressionThisRound = false;
    }

    this.activationTeamIndex = 0;
    this.pickNextActiveUnit(true);
    this.log(`=== Round ${this.round} begins ===`);
  }

  forceNextRound() {
    this.round += 1;
    this.startRound();
  }

  pickNextActiveUnit(isStart = false) {
    const tA = this.teamOrder[this.activationTeamIndex];
    const tB = this.teamOrder[(this.activationTeamIndex + 1) % this.teamOrder.length];

    let next =
      this.units.find((u) => u.team === tA && !u.exhausted && u.hp > 0) ?? null;

    if (!next) {
      next =
        this.units.find((u) => u.team === tB && !u.exhausted && u.hp > 0) ?? null;
      if (next) this.activationTeamIndex = (this.activationTeamIndex + 1) % this.teamOrder.length;
    }

    if (!next) {
      if (!isStart) this.log("All models Exhausted (or down). Maintenance -> next round.");
      this.round += 1;
      this.startRound();
      return;
    }

    this.activeUnitId = next.id;
    this.selectedId = next.id;

    const penalty = next.actionPenaltyNextActivation || 0;
    next.actionsLeft = clamp(3 - penalty, 1, 3);
    next.actionPenaltyNextActivation = 0;

    next.recoveredThisActivation = false;
    next.aimStreak = 0;
    next.aimBonus = 0;

    this.log(`Active: ${next.name} (${next.team}) [Actions: ${next.actionsLeft}]`);
  }

  endActivation() {
    const u = this.getUnit(this.activeUnitId);
    if (!u) return;

    u.exhausted = true;
    u.actionsLeft = 0;
    u.aimStreak = 0;
    u.aimBonus = 0;

    this.log(`${u.name} becomes Exhausted.`);

    this.activationTeamIndex = (this.activationTeamIndex + 1) % this.teamOrder.length;
    this.pickNextActiveUnit();
  }

  // --- Helpers ---
  getUnit(id) {
    return this.units.find((u) => u.id === id) ?? null;
  }
  getSelected() {
    return this.getUnit(this.selectedId);
  }

  select(id) {
    const u = this.getUnit(id);
    if (!u) return;
    this.selectedId = id;
    this.log(`Selected ${u.name} (${u.team})`);
  }

  canActSelected() {
    const u = this.getSelected();
    if (!u) return false;
    if (u.id !== this.activeUnitId) {
      this.log("Not the active model.");
      return false;
    }
    if (u.actionsLeft <= 0) {
      this.log("No actions left.");
      return false;
    }
    if (u.exhausted) {
      this.log("Model is Exhausted.");
      return false;
    }
    if (u.hp <= 0) {
      this.log("Model is down.");
      return false;
    }
    return true;
  }

  getSaveThreshold(u) {
    return savingThrowTargetTier(u.tiers.will);
  }

  horrorTest(u, reason) {
    const roll = d20(this.rng);
    const total = roll + u.mods.wp - u.horror;
    const thr = this.getSaveThreshold(u);
    const pass = total >= thr;
    this.log(
      `${u.name} Horror test (${reason}): d20(${roll})+WP(${u.mods.wp})-H(${u.horror})=${total} vs ${thr} => ${
        pass ? "PASS" : "FAIL"
      }`
    );
    return { roll, total, thr, pass };
  }

  tryGainHorror(u, source) {
    if (u.gainedHorrorThisRound) {
      this.log(`${u.name} would gain Horror (${source}) but is already at 1 Horror this round.`);
      return false;
    }
    u.horror = clamp(u.horror + 1, 0, 5);
    u.gainedHorrorThisRound = true;
    this.log(`${u.name} gains +1 Horror (${source}). Horror=${u.horror}`);
    return true;
  }

  // --- Actions ---
  tryAimSelected() {
    if (!this.canActSelected()) return;
    const u = this.getSelected();

    if (this.isEngaged(u)) {
      this.log(`${u.name} is Engaged and cannot Aim.`);
      return;
    }

    // cannot Aim if Suppressed unless Heavy Cover (approx)
    if (u.suppressed) {
      const adjObs = [
        this.isObstacle(u.tx + 1, u.ty),
        this.isObstacle(u.tx - 1, u.ty),
        this.isObstacle(u.tx, u.ty + 1),
        this.isObstacle(u.tx, u.ty - 1),
      ].filter(Boolean).length;

      if (adjObs < 2) {
        this.log(`${u.name} is Suppressed and cannot Aim unless in Heavy Cover (approx).`);
        return;
      }
    }

    u.actionsLeft -= 1;
    u.aimStreak = clamp(u.aimStreak + 1, 0, 2);
    u.aimBonus = u.aimStreak === 1 ? 1 : u.aimStreak === 2 ? 3 : 0;

    this.log(`${u.name} Aims (streak ${u.aimStreak}) => next Shoot bonus +${u.aimBonus}. Actions left: ${u.actionsLeft}`);
  }

  tryRecoverSelected() {
    if (!this.canActSelected()) return;
    const u = this.getSelected();
    if (u.recoveredThisActivation) {
      this.log("Recover is once per activation.");
      return;
    }

    u.actionsLeft -= 1;
    u.recoveredThisActivation = true;

    if (u.suppressed) {
      u.suppressed = false;
      this.log(`${u.name} Recovers: removes Suppressed.`);
      return;
    }
    if (u.horror > 0) {
      u.horror -= 1;
      this.log(`${u.name} Recovers: removes 1 Horror. Horror=${u.horror}`);
      return;
    }

    this.log(`${u.name} Recovers: nothing to remove.`);
  }

  tryMoveSelected(tx, ty) {
    if (!this.canActSelected()) return;
    const u = this.getSelected();

    if (this.isObstacle(tx, ty)) {
      this.log("Blocked by obstacle.");
      return;
    }

    const d = manhattan(u.tx, u.ty, tx, ty);
    if (d !== 1) {
      this.log("Move 1 tile only (prototype).");
      return;
    }

    // Suppressed movement horror test
    if (u.suppressed) {
      const t = this.horrorTest(u, "Suppressed Move");
      if (!t.pass) {
        u.actionsLeft -= 1;
        if (!u.gainedHorrorFromSuppressionThisRound) {
          u.gainedHorrorFromSuppressionThisRound = true;
          this.tryGainHorror(u, "Suppression");
        } else {
          this.log(`${u.name} already gained Horror from Suppression this round.`);
        }
        this.log(`${u.name} fails to move (Suppressed). Actions left: ${u.actionsLeft}`);
        u.aimStreak = 0;
        u.aimBonus = 0;
        return;
      }
    }

    // cannot move onto another unit
    const occupied = this.units.some((w) => w.hp > 0 && w.tx === tx && w.ty === ty);
    if (occupied) {
      this.log("Tile occupied.");
      return;
    }

    u.tx = tx;
    u.ty = ty;
    u.actionsLeft -= 1;
    u.aimStreak = 0;
    u.aimBonus = 0;
    this.log(`${u.name} moves to (${tx},${ty}). Actions left: ${u.actionsLeft}`);
  }

  // Charge: click enemy tile, move into adjacency if possible, then defender makes Charge Shock test
  tryChargeAtTile(tx, ty) {
    if (!this.canActSelected()) return;
    const attacker = this.getSelected();

    const target = this.units.find(
      (u) => u.tx === tx && u.ty === ty && u.team !== attacker.team && u.hp > 0
    );
    if (!target) {
      this.log("Charge requires clicking an enemy.");
      return;
    }

    const distNow = manhattan(attacker.tx, attacker.ty, target.tx, target.ty);

    // already adjacent: still counts as charge for Shock
    if (distNow === 1) {
      attacker.actionsLeft -= 1;
      attacker.aimStreak = 0;
      attacker.aimBonus = 0;
      this.log(`${attacker.name} Charges ${target.name} (already in contact).`);
      this.resolveChargeShock(target);
      return;
    }

    // prototype: allow only distance 2 -> one step into adjacency
    if (distNow !== 2) {
      this.log("Charge (prototype): target must be distance 1–2.");
      return;
    }

    // Suppressed charge horror test
    if (attacker.suppressed) {
      const t = this.horrorTest(attacker, "Suppressed Charge");
      if (!t.pass) {
        attacker.actionsLeft -= 1;
        if (!attacker.gainedHorrorFromSuppressionThisRound) {
          attacker.gainedHorrorFromSuppressionThisRound = true;
          this.tryGainHorror(attacker, "Suppression");
        }
        this.log(`${attacker.name} fails to Charge (Suppressed). Actions left: ${attacker.actionsLeft}`);
        attacker.aimStreak = 0;
        attacker.aimBonus = 0;
        return;
      }
    }

    const candidates = [
      { x: target.tx + 1, y: target.ty },
      { x: target.tx - 1, y: target.ty },
      { x: target.tx, y: target.ty + 1 },
      { x: target.tx, y: target.ty - 1 },
    ].filter((p) => {
      if (this.isObstacle(p.x, p.y)) return false;
      if (this.units.some((u) => u.hp > 0 && u.tx === p.x && u.ty === p.y)) return false;
      return manhattan(attacker.tx, attacker.ty, p.x, p.y) === 1;
    });

    if (!candidates.length) {
      this.log("No open tile to Charge into (blocked).");
      return;
    }

    const dest = candidates[0];
    attacker.tx = dest.x;
    attacker.ty = dest.y;
    attacker.actionsLeft -= 1;
    attacker.aimStreak = 0;
    attacker.aimBonus = 0;

    this.log(`${attacker.name} Charges into contact with ${target.name}.`);
    this.resolveChargeShock(target);
  }

  resolveChargeShock(defender) {
    const t = this.horrorTest(defender, "Charge Shock");
    if (!t.pass) {
      this.tryGainHorror(defender, "Charge Shock");
      defender.actionPenaltyNextActivation = Math.min(
        2,
        (defender.actionPenaltyNextActivation || 0) + 1
      );
      this.log(`${defender.name} will have –1 Action next activation (min 1).`);
    }
  }

  tryDisengageSelected() {
    if (!this.canActSelected()) return;
    const u = this.getSelected();

    if (!this.isEngaged(u)) {
      this.log("Not Engaged; Disengage not needed.");
      return;
    }

    // Opportunity attack: first adjacent enemy gets a free Fight
    const enemies = this.getAdjacentEnemies(u);
    const opp = enemies[0];
    if (opp) {
      this.log(`${opp.name} makes an opportunity attack on ${u.name}.`);
      this.resolveFight(opp, u, { isOpportunity: true });
      if (u.hp <= 0) return;
    }

    const options = [
      { x: u.tx + 1, y: u.ty },
      { x: u.tx - 1, y: u.ty },
      { x: u.tx, y: u.ty + 1 },
      { x: u.tx, y: u.ty - 1 },
    ].filter((p) => {
      if (this.isObstacle(p.x, p.y)) return false;
      if (this.units.some((w) => w.hp > 0 && w.tx === p.x && w.ty === p.y)) return false;
      return true;
    });

    if (!options.length) {
      this.log("No space to Disengage into.");
      return;
    }

    const dest = options[0];
    u.tx = dest.x;
    u.ty = dest.y;
    u.actionsLeft -= 1;
    u.aimStreak = 0;
    u.aimBonus = 0;

    this.log(`${u.name} Disengages to (${dest.x},${dest.y}). Actions left: ${u.actionsLeft}`);
  }

  tryShootAtTile(tx, ty) {
    if (!this.canActSelected()) return;
    const attacker = this.getSelected();

    if (this.isEngaged(attacker)) {
      this.log(`${attacker.name} is Engaged and cannot Shoot. Disengage first.`);
      return;
    }

    const target = this.units.find((u) => u.tx === tx && u.ty === ty && u.team !== attacker.team && u.hp > 0);
    if (!target) {
      this.log("No enemy on that tile.");
      return;
    }

    const r = manhattan(attacker.tx, attacker.ty, target.tx, target.ty);
    if (r > attacker.range) {
      this.log("Out of range.");
      return;
    }

    if (!this.hasLOS(attacker, target)) {
      this.log("No line of sight (blocked by obstacle).");
      return;
    }

    attacker.actionsLeft -= 1;

    // Suppressed on being targeted (hit or miss)
    if (!target.suppressed) {
      target.suppressed = true;
      this.log(`${target.name} becomes Suppressed (targeted by fire).`);
    }

    const cover = this.getCover(attacker, target);
    const coverPenalty = cover === "light" ? -1 : cover === "heavy" ? -3 : 0;

    const aimBonus = attacker.aimBonus || 0;
    attacker.aimStreak = 0;
    attacker.aimBonus = 0;

    const suppressedPenalty = attacker.suppressed ? -2 : 0;

    const roll = d20(this.rng);
    const total = roll + attacker.mods.shoot + aimBonus + suppressedPenalty + coverPenalty - attacker.horror;

    // nat20: auto-hit +1 dmg, save only if heavy cover
    if (roll === 20) {
      let dmg = 2;
      this.log(`${attacker.name} SHOOT nat20 => auto-hit (+1 dmg).`);

      if (cover === "heavy") {
        const saveRoll = d20(this.rng);
        const saveTotal = saveRoll + target.mods.wp - target.horror;
        const thr = this.getSaveThreshold(target);
        const pass = saveTotal >= thr;
        this.log(`${target.name} Saving Throw (Heavy Cover): d20(${saveRoll})+WP(${target.mods.wp})-H(${target.horror})=${saveTotal} vs ${thr} => ${pass ? "PASS" : "FAIL"}`);
        if (pass) dmg = 1; // simple reduction
      }

      target.hp -= dmg;
      this.log(`${target.name} takes ${dmg} damage. HP=${target.hp}`);
      if (target.hp <= 0) this.log(`${target.name} is taken out.`);
      return;
    }

    if (roll === 1) {
      this.log(`${attacker.name} SHOOT nat1 => critical miss.`);
      return;
    }

    const hit = total >= target.ac;
    this.log(
      `${attacker.name} shoots ${target.name}: d20(${roll}) +Shoot(${attacker.mods.shoot}) +Aim(${aimBonus}) +Supp(${suppressedPenalty}) +Cover(${coverPenalty}) -H(${attacker.horror}) = ${total} vs AC ${target.ac} => ${
        hit ? "HIT" : "MISS"
      }`
    );

    if (hit) {
      target.hp -= 1;
      this.log(`${target.name} takes 1 damage. HP=${target.hp}`);
      if (target.hp <= 0) this.log(`${target.name} is taken out.`);
    }
  }

  resolveFight(attacker, target, { isOpportunity = false } = {}) {
    const roll = d20(this.rng);
    const total = roll + attacker.mods.fight - attacker.horror;

    if (roll === 20) {
      target.hp -= 2;
      this.log(`${attacker.name} ${isOpportunity ? "OPP" : "FIGHT"} nat20 => ${target.name} takes 2. HP=${target.hp}`);
    } else if (roll === 1) {
      this.log(`${attacker.name} ${isOpportunity ? "OPP" : "FIGHT"} nat1 => miss.`);
    } else {
      const hit = total >= target.ac;
      this.log(`${attacker.name} ${isOpportunity ? "OPP" : "fights"} ${target.name}: d20(${roll})+Fight(${attacker.mods.fight})-H(${attacker.horror})=${total} vs AC ${target.ac} => ${hit ? "HIT" : "MISS"}`);
      if (hit) {
        target.hp -= 1;
        this.log(`${target.name} takes 1 damage. HP=${target.hp}`);
      }
    }

    if (target.hp <= 0) this.log(`${target.name} is taken out.`);
  }

  tryFightAtTile(tx, ty) {
    if (!this.canActSelected()) return;
    const attacker = this.getSelected();

    const target = this.units.find((u) => u.tx === tx && u.ty === ty && u.team !== attacker.team && u.hp > 0);
    if (!target) {
      this.log("No enemy on that tile.");
      return;
    }

    if (manhattan(attacker.tx, attacker.ty, target.tx, target.ty) !== 1) {
      this.log("Fight requires engagement range (adjacent).");
      return;
    }

    attacker.actionsLeft -= 1;
    attacker.aimStreak = 0;
    attacker.aimBonus = 0;

    this.resolveFight(attacker, target);
  }

  // --- UI picking / coords ---
  screenToTile(x, y, canvas) {
    const size = this.getTilePx(canvas);
    const tx = Math.floor((x - this._pad) / size);
    const ty = Math.floor((y - this._pad) / size);
    if (tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows) return { tx: -1, ty: -1 };
    return { tx, ty };
  }

  tileToScreenCenter(tx, ty, canvas) {
    const size = this.getTilePx(canvas);
    return {
      x: this._pad + tx * size + size / 2,
      y: this._pad + ty * size + size / 2,
    };
  }

  getTilePx(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const pad = 12 * dpr;
    const usableW = canvas.width - pad * 2;
    const usableH = canvas.height - pad * 2;
    const size = Math.floor(Math.min(usableW / this.cols, usableH / this.rows));
    this._pad = pad;
    this._size = size;
    return size;
  }

  pickUnit(x, y, canvas) {
    const size = this.getTilePx(canvas);
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      const c = this.tileToScreenCenter(u.tx, u.ty, canvas);
      const r = Math.max(10, size * 0.28);
      if (Math.hypot(x - c.x, y - c.y) <= r) return u.id;
    }
    return null;
  }

  // --- Draw ---
  draw(ctx, canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const size = this.getTilePx(canvas);
    const pad = this._pad;

    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(pad, pad);

    // grid
    ctx.strokeStyle = "#eee";
    for (let x = 0; x <= this.cols; x++) {
      ctx.beginPath();
      ctx.moveTo(x * size, 0);
      ctx.lineTo(x * size, this.rows * size);
      ctx.stroke();
    }
    for (let y = 0; y <= this.rows; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * size);
      ctx.lineTo(this.cols * size, y * size);
      ctx.stroke();
    }

    // obstacles
    ctx.fillStyle = "#999";
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        if (this.grid[y][x] === 1) {
          ctx.fillRect(x * size + 2, y * size + 2, size - 4, size - 4);
        }
      }
    }

    // units
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      const cx = u.tx * size + size / 2;
      const cy = u.ty * size + size / 2;
      const r = Math.max(10, size * 0.28);

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = u.team === "Blue" ? "#1f77b4" : "#d62728";
      ctx.fill();

      // outline: selected + active
      ctx.lineWidth = u.id === this.selectedId ? 4 : 2;
      ctx.strokeStyle = u.id === this.activeUnitId ? "#111" : "#777";
      ctx.stroke();

      // suppressed ring
      if (u.suppressed) {
        ctx.beginPath();
        ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#000";
        ctx.stroke();
      }

      // engaged indicator (small dot)
      const engaged = this.isEngaged(u);
      if (engaged) {
        ctx.beginPath();
        ctx.arc(cx + r - 4, cy - r + 4, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#111";
        ctx.fill();
      }

      // label
      ctx.fillStyle = "#111";
      ctx.font = `${Math.floor(size * 0.28)}px system-ui`;
      ctx.textAlign = "center";
      ctx.fillText(u.name, cx, cy + r + Math.floor(size * 0.3));

      // tiny HUD
      ctx.font = `${Math.floor(size * 0.22)}px system-ui`;
      ctx.fillText(`A:${u.actionsLeft} H:${u.horror}`, cx, cy - r - 4);
    }

    ctx.restore();
  }
}
