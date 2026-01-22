// Micro Skirmish: rules harness + canvas rendering
// Adds: random obstacles, alternating activations, suppression + horror, charge shock, aim/recover, simple LOS & cover

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function manhattan(ax, ay, bx, by) {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function d20(rng) { return 1 + Math.floor(rng() * 20); }

// Bresenham line
function lineTiles(x0, y0, x1, y1) {
  const tiles = [];
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;

  let x = x0, y = y0;
  while (true) {
    tiles.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return tiles;
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

    // Alternating activation state
    this.teamOrder = ["Blue", "Red"]; // winner can choose later; keeping fixed for now
    this.activationTeamIndex = 0;

    // round-limited horror gain
    // rule: 1 horror token per model per round (global cap)
    // we enforce this for charge shock + suppressed-move. (Auto-hit horror not implemented yet.)
    this.units = [];
    this.activeUnitId = null;
    this.selectedId = null;

    this.newRandomMap();
    this.randomWarbands();
    this.startRound();
  }

  log(msg) { this.onLog(msg); }

  // --- Map / Obstacles ---
  newRandomMap() {
    // 0 = empty, 1 = obstacle
    this.grid = Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, () => 0));

    // keep spawn lanes relatively open (left 3 cols, right 3 cols)
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

  // cover heuristic
  getCover(attacker, target) {
    // Heavy cover if there is an obstacle directly on LOS between them (excluding endpoints)
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
    if (adj.some(p => this.isObstacle(p.x, p.y))) return "light";
    return "none";
  }

  hasLOS(attacker, target) {
    const tiles = lineTiles(attacker.tx, attacker.ty, target.tx, target.ty);
    for (let i = 1; i < tiles.length - 1; i++) {
      if (this.isObstacle(tiles[i].x, tiles[i].y)) return false;
    }
    return true;
  }

  // --- Units / Warbands ---
  makeUnitFromTiers({ name, team, tx, ty, tiers }) {
    // tiers are 1-3
    const defTier = clamp(tiers.def ?? 2, 1, 3);
    const wpTier = clamp(tiers.wp ?? 2, 1, 3);
    const shootTier = clamp(tiers.shoot ?? 2, 1, 3);
    const fightTier = clamp(tiers.fight ?? 2, 1, 3);

    const defMod = defTier === 1 ? 0 : defTier === 2 ? 2 : 4;
    const wpMod = wpTier === 1 ? 0 : wpTier === 2 ? 2 : 4;
    const shootMod = shootTier === 1 ? -2 : shootTier === 2 ? 2 : 4;
    const fightMod = fightTier === 1 ? -2 : fightTier === 2 ? 2 : 4;

    const ac = 10 + defMod;
    const hp = defTier + wpTier + shootTier + fightTier; // sum of tiers
    const range = 7; // prototype default

    return {
      id: crypto.randomUUID(),
      name,
      team,
      tx, ty,
      tiers: { def: defTier, wp: wpTier, shoot: shootTier, fight: fightTier },
      mods: { def: defMod, wp: wpMod, shoot: shootMod, fight: fightMod },
      ac,
      hp,
      range,

      suppressed: false,
      exhausted: false,

      horror: 0, // max 5
      gainedHorrorThisRound: false, // global 1 token per round cap
      gainedHorrorFromSuppressionThisRound: false, // also capped

      actionsLeft: 3,
      actionPenaltyNextActivation: 0,

      recoveredThisActivation: false,
      aimStreak: 0, // counts consecutive Aim actions this activation (0/1/2)
      aimBonus: 0,  // computed from aimStreak for next Shoot
    };
  }

  clearTeam(team) {
    this.units = this.units.filter(u => u.team !== team);
  }

  loadWarbandFromJson(jsonText, team) {
    let arr;
    try { arr = JSON.parse(jsonText); }
    catch { throw new Error("Invalid JSON."); }

    if (!Array.isArray(arr)) throw new Error("Expected a JSON array of models.");

    this.clearTeam(team);

    // spawn zone: left for Blue, right for Red
    const spawnX = team === "Blue" ? 1 : this.cols - 2;

    let i = 0;
    for (const m of arr) {
      const name = String(m.name ?? `${team[0]}${i + 1}`);
      const ty = clamp(Number(m.ty ?? (2 + i * 2)), 0, this.rows - 1);
      const tx = clamp(Number(m.tx ?? spawnX), 0, this.cols - 1);

      const unit = this.makeUnitFromTiers({
        name,
        team,
        tx,
        ty,
        tiers: m.tiers ?? { def: 2, wp: 2, shoot: 2, fight: 2 },
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
            def: 1 + Math.floor(this.rng() * 3),
            wp: 1 + Math.floor(this.rng() * 3),
            shoot: 1 + Math.floor(this.rng() * 3),
            fight: 1 + Math.floor(this.rng() * 3),
          }
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
    this.round = this.round ?? 1;
    for (const u of this.units) {
      u.exhausted = false;
      u.actionsLeft = 3;
      u.recoveredThisActivation = false;
      u.aimStreak = 0;
      u.aimBonus = 0;
      u.gainedHorrorThisRound = false;
      u.gainedHorrorFromSuppressionThisRound = false;
      // action penalty applies when model becomes active
    }
    this.activationTeamIndex = 0;
    this.pickNextActiveUnit(true);
    this.log(`=== Round ${this.round} begins ===`);
  }

  forceNextRound() {
    this.round += 1;
    this.startRound();
  }

  teamHasReady(team) {
    return this.units.some(u => u.team === team && !u.exhausted && u.hp > 0);
  }

  allExhaustedOrDead() {
    return this.units.every(u => u.hp <= 0 || u.exhausted);
  }

  pickNextActiveUnit(isStart = false) {
    // Alternating: try current team; if none, try other; if none, maintenance/next round
    const tA = this.teamOrder[this.activationTeamIndex];
    const tB = this.teamOrder[(this.activationTeamIndex + 1) % this.teamOrder.length];

    let next = this.units.find(u => u.team === tA && !u.exhausted && u.hp > 0) ?? null;

    if (!next) {
      next = this.units.find(u => u.team === tB && !u.exhausted && u.hp > 0) ?? null;
      if (next) this.activationTeamIndex = (this.activationTeamIndex + 1) % this.teamOrder.length;
    }

    if (!next) {
      // no one ready -> next round
      if (!isStart) this.log("All models Exhausted (or down). Maintenance -> next round.");
      this.round += 1;
      this.startRound();
      return;
    }

    this.activeUnitId = next.id;
    this.selectedId = next.id;

    // apply action penalty next activation (from Charge Shock)
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

    // Alternate to the other team for the next activation (if possible)
    this.activationTeamIndex = (this.activationTeamIndex + 1) % this.teamOrder.length;
    this.pickNextActiveUnit();
  }

  // --- Helpers ---
  getUnit(id) { return this.units.find(u => u.id === id) ?? null; }
  getSelected() { return this.getUnit(this.selectedId); }

  select(id) {
    const u = this.getUnit(id);
    if (!u) return;
    this.selectedId = id;
    this.log(`Selected ${u.name} (${u.team})`);
  }

  canActSelected() {
    const u = this.getSelected();
    if (!u) return false;
    if (u.id !== this.activeUnitId) { this.log("Not the active model."); return false; }
    if (u.actionsLeft <= 0) { this.log("No actions left."); return false; }
    if (u.exhausted) { this.log("Model is Exhausted."); return false; }
    if (u.hp <= 0) { this.log("Model is down."); return false; }
    return true;
  }

  // Saving Throw Threshold based on WP tier: 14 / 13 / 11, min 10
  getSaveThreshold(u) {
    const t = u.tiers.wp;
    const base = (t === 1) ? 14 : (t === 2) ? 13 : 11;
    return Math.max(10, base);
  }

  // Horror test: d20 + WPmod - horrorTokens vs threshold
  horrorTest(u, reason) {
    const roll = d20(this.rng);
    const total = roll + u.mods.wp - u.horror;
    const thr = this.getSaveThreshold(u);
    const pass = total >= thr;
    this.log(`${u.name} Horror test (${reason}): d20(${roll})+WP(${u.mods.wp})-H(${u.horror})=${total} vs ${thr} => ${pass ? "PASS" : "FAIL"}`);
    return { roll, total, thr, pass };
  }

  // 1 horror per model per round cap
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

    // cannot Aim if Suppressed unless Heavy Cover
    if (u.suppressed) {
      // treat "in heavy cover" as adjacent to obstacle AND also LOS block would be heavy in getCover
      // simple: adjacent to obstacle counts as cover; only allow if at least light? user rule says heavy cover, so require "heavy"
      // We approximate: adjacent obstacle = heavy for aiming permission if at least 2 adjacent obstacles
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

    if (u.actionsLeft <= 0) return;

    u.actionsLeft -= 1;
    u.aimStreak = clamp(u.aimStreak + 1, 0, 2);
    u.aimBonus = (u.aimStreak === 1) ? 1 : (u.aimStreak === 2) ? 3 : 0;

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
    if (this.isObstacle(tx, ty)) { this.log("Blocked by obstacle."); return; }

    // 4-dir move 1 tile (prototype)
    const d = manhattan(u.tx, u.ty, tx, ty);
    if (d !== 1) { this.log("Move 1 tile only (prototype)."); return; }

    // Suppressed movement horror test
    if (u.suppressed) {
      const t = this.horrorTest(u, "Suppressed Move");
      if (!t.pass) {
        u.actionsLeft -= 1;
        // fail adds 1 horror max per round (also global cap)
        // additionally, cap suppression-sourced horror once/round is naturally covered by global cap; we keep a separate flag anyway
        if (!u.gainedHorrorFromSuppressionThisRound) {
          u.gainedHorrorFromSuppressionThisRound = true;
          this.tryGainHorror(u, "Suppression");
        } else {
          this.log(`${u.name} already gained Horror from Suppression this round.`);
        }
        this.log(`${u.name} fails to move (Suppressed). Actions left: ${u.actionsLeft}`);
        u.aimStreak = 0; u.aimBonus = 0;
        return;
      }
    }

    u.tx = tx; u.ty = ty;
    u.actionsLeft -= 1;
    u.aimStreak = 0; u.aimBonus = 0;
    this.log(`${u.name} moves to (${tx},${ty}). Actions left: ${u.actionsLeft}`);
  }

  tryChargeSelected(tx, ty) {
    if (!this.canActSelected()) return;
    const attacker = this.getSelected();

    if (this.isObstacle(tx, ty)) { this.log("Blocked by obstacle."); return; }

    // Charge is a move into adjacency with an enemy (prototype: must end adjacent)
    const d = manhattan(attacker.tx, attacker.ty, tx, ty);
    if (d !== 1) { this.log("Charge: move 1 tile (prototype)."); return; }

    // If suppressed, Charge also requires the suppressed move test (per your rule)
    if (attacker.suppressed) {
      const t = this.horrorTest(attacker, "Suppressed Charge");
      if (!t.pass) {
        attacker.actionsLeft -= 1;
        if (!attacker.gainedHorrorFromSuppressionThisRound) {
          attacker.gainedHorrorFromSuppressionThisRound = true;
          this.tryGainHorror(attacker, "Suppression");
        } else {
          this.log(`${attacker.name} already gained Horror from Suppression this round.`);
        }
        this.log(`${attacker.name} fails to Charge (Suppressed). Actions left: ${attacker.actionsLeft}`);
        attacker.aimStreak = 0; attacker.aimBonus = 0;
        return;
      }
    }

    // move attacker
    attacker.tx = tx; attacker.ty = ty;
    attacker.actionsLeft -= 1;
    attacker.aimStreak = 0; attacker.aimBonus = 0;

    // Find a defender adjacent after charge (prototype: any enemy adjacent)
    const defender = this.units.find(u =>
      u.team !== attacker.team &&
      u.hp > 0 &&
      manhattan(u.tx, u.ty, attacker.tx, attacker.ty) === 1
    );

    this.log(`${attacker.name} Charges to (${tx},${ty}).`);

    if (!defender) return;

    // Charge Shock: defender Horror test; on fail +1 Horror and -1 action next activation (min 1)
    const t = this.horrorTest(defender, "Charge Shock");
    if (!t.pass) {
      this.tryGainHorror(defender, "Charge Shock");
      defender.actionPenaltyNextActivation = clamp((defender.actionPenaltyNextActivation || 0) + 1, 0, 2);
      this.log(`${defender.name} will have –1 Action next activation (min 1).`);
    }
  }

  tryShootAtTile(tx, ty) {
    if (!this.canActSelected()) return;
    const attacker = this.getSelected();

    const target = this.units.find(u => u.tx === tx && u.ty === ty && u.team !== attacker.team && u.hp > 0);
    if (!target) { this.log("No enemy on that tile."); return; }

    const r = manhattan(attacker.tx, attacker.ty, target.tx, target.ty);
    if (r > attacker.range) { this.log("Out of range."); return; }

    if (!this.hasLOS(attacker, target)) { this.log("No line of sight (blocked by obstacle)."); return; }

    attacker.actionsLeft -= 1;

    // Apply Suppressed when targeted by Shoot (hit or miss)
    if (!target.suppressed) {
      target.suppressed = true;
      this.log(`${target.name} becomes Suppressed (targeted by fire).`);
    }

    // Determine cover penalty
    const cover = this.getCover(attacker, target);
    const coverPenalty = (cover === "light") ? -1 : (cover === "heavy") ? -3 : 0;

    // Aim bonus is consumed on shoot
    const aimBonus = attacker.aimBonus || 0;
    attacker.aimStreak = 0;
    attacker.aimBonus = 0;

    // suppressed penalty (to shoot)
    const suppressedPenalty = attacker.suppressed ? -2 : 0;

    // horror penalty already subtracted as -horror
    const roll = d20(this.rng);

    // Natural 20/1 handling (minimal)
    const baseTotal = roll + attacker.mods.shoot + aimBonus + suppressedPenalty + coverPenalty - attacker.horror;

    if (roll === 20) {
      // auto hit, +1 dmg; target may save only if Heavy Cover
      let dmg = 2;
      this.log(`${attacker.name} SHOOT nat20 => auto-hit (+1 dmg).`);
      if (cover === "heavy") {
        const save = d20(this.rng) + target.mods.wp - target.horror;
        const thr = this.getSaveThreshold(target);
        const pass = save >= thr;
        this.log(`${target.name} Saving Throw (Heavy Cover): d20+WP-H = ${save} vs ${thr} => ${pass ? "PASS" : "FAIL"}`);
        if (pass) dmg = 1; // reduce by 1 (simple)
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

    const hit = baseTotal >= target.ac;
    this.log(`${attacker.name} shoots ${target.name}: d20(${roll}) +Shoot(${attacker.mods.shoot}) +Aim(${aimBonus}) +Supp(${suppressedPenalty}) +Cover(${coverPenalty}) -H(${attacker.horror}) = ${baseTotal} vs AC ${target.ac} => ${hit ? "HIT" : "MISS"}`);

    if (hit) {
      target.hp -= 1;
      this.log(`${target.name} takes 1 damage. HP=${target.hp}`);
      if (target.hp <= 0) this.log(`${target.name} is taken out.`);
    }
  }

  tryFightAtTile(tx, ty) {
    if (!this.canActSelected()) return;
    const attacker = this.getSelected();

    const target = this.units.find(u => u.tx === tx && u.ty === ty && u.team !== attacker.team && u.hp > 0);
    if (!target) { this.log("No enemy on that tile."); return; }

    // Must be adjacent
    const d = manhattan(attacker.tx, attacker.ty, target.tx, target.ty);
    if (d !== 1) { this.log("Fight requires adjacency."); return; }

    attacker.actionsLeft -= 1;
    attacker.aimStreak = 0; attacker.aimBonus = 0;

    const roll = d20(this.rng);
    const total = roll + attacker.mods.fight - attacker.horror; // horror affects all rolls

    if (roll === 20) {
      target.hp -= 2;
      this.log(`${attacker.name} FIGHT nat20 => auto-hit (+1 dmg). ${target.name} HP=${target.hp}`);
      if (target.hp <= 0) this.log(`${target.name} is taken out.`);
      return;
    }
    if (roll === 1) {
      this.log(`${attacker.name} FIGHT nat1 => miss.`);
      return;
    }

    const hit = total >= target.ac;
    this.log(`${attacker.name} fights ${target.name}: d20(${roll})+Fight(${attacker.mods.fight})-H(${attacker.horror})=${total} vs AC ${target.ac} => ${hit ? "HIT" : "MISS"}`);
    if (hit) {
      target.hp -= 1;
      this.log(`${target.name} takes 1 damage. HP=${target.hp}`);
      if (target.hp <= 0) this.log(`${target.name} is taken out.`);
    }
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

    // background
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
      ctx.lineWidth = (u.id === this.selectedId) ? 4 : 2;
      ctx.strokeStyle = (u.id === this.activeUnitId) ? "#111" : "#777";
      ctx.stroke();

      // suppressed ring
      if (u.suppressed) {
        ctx.beginPath();
        ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#000";
        ctx.stroke();
      }

      // label
      ctx.fillStyle = "#111";
      ctx.font = `${Math.floor(size * 0.28)}px system-ui`;
      ctx.textAlign = "center";
      ctx.fillText(u.name, cx, cy + r + Math.floor(size * 0.30));

      // tiny HUD: actions
      ctx.font = `${Math.floor(size * 0.22)}px system-ui`;
      ctx.fillText(`A:${u.actionsLeft} H:${u.horror}`, cx, cy - r - 4);
    }

    ctx.restore();

    // status footer
    ctx.fillStyle = "#111";
    ctx.font = `${Math.floor(14 * (window.devicePixelRatio || 1))}px system-ui`;
  }
}
