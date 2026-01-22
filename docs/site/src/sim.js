// Tiny rules harness: grid, units, select/move/shoot, suppressed
// Expand from here: charge, fight, horror tests, AI, terrain, LOS, etc.

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

export class Game {
  constructor({ cols, rows, seed }) {
    this.cols = cols;
    this.rows = rows;
    this.rng = mulberry32(seed ?? 1);
    this.tileSize = 44; // logical size, scaled by canvas DPR in drawing

    this.onLog = (msg) => console.log(msg);

    // Minimal demo units (later: load from JSON)
    this.units = [
      this.makeUnit("A1", "Blue", 2, 3),
      this.makeUnit("A2", "Blue", 2, 5),
      this.makeUnit("B1", "Red", 17, 3),
      this.makeUnit("B2", "Red", 17, 5),
    ];

    this.teamOrder = ["Blue", "Red"];
    this.turnIndex = 0;
    this.activeTeam = this.teamOrder[this.turnIndex];
    this.activeUnitId = this.findNextReadyUnit(this.activeTeam)?.id ?? null;

    this.selectedId = this.activeUnitId;

    this.log(`Start: ${this.activeTeam} activates ${this.selectedId}`);
  }

  makeUnit(name, team, tx, ty) {
    return {
      id: crypto.randomUUID(),
      name,
      team,
      tx, ty,
      hp: 5,
      fp: 2,
      prowess: 2,
      willpower: 1,
      armor: 10, // AC-like
      range: 6,  // tiles
      suppressed: false,
      exhausted: false,
      horror: 0,
      actionsLeft: 3,
      // tracking
      gainedSuppressionThisRound: false,
      gainedHorrorFromSuppressionThisRound: false,
      actionPenaltyNextActivation: 0,
    };
  }

  log(msg) { this.onLog(msg); }

  getUnit(id) { return this.units.find(u => u.id === id) ?? null; }

  getSelected() { return this.getUnit(this.selectedId); }

  select(id) {
    const u = this.getUnit(id);
    if (!u) return;
    this.selectedId = id;
    this.log(`Selected ${u.name} (${u.team})`);
  }

  // --- coordinate helpers ---
  screenToTile(x, y, canvas) {
    const size = this.getTilePx(canvas);
    const tx = Math.floor(x / size);
    const ty = Math.floor(y / size);
    if (tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows) return { tx: -1, ty: -1 };
    return { tx, ty };
  }

  tileToScreenCenter(tx, ty, canvas) {
    const size = this.getTilePx(canvas);
    return {
      x: tx * size + size / 2,
      y: ty * size + size / 2,
    };
  }

  getTilePx(canvas) {
    // Fit grid to canvas with padding
    const pad = 12 * (window.devicePixelRatio || 1);
    const usableW = canvas.width - pad * 2;
    const usableH = canvas.height - pad * 2;
    const size = Math.floor(Math.min(usableW / this.cols, usableH / this.rows));
    this._pad = pad;
    this._size = size;
    return size;
  }

  // pick a unit by clicking near its drawn circle
  pickUnit(x, y, canvas) {
    const size = this.getTilePx(canvas);
    for (const u of this.units) {
      const c = this.tileToScreenCenter(u.tx, u.ty, canvas);
      const r = Math.max(10, size * 0.28);
      if (Math.hypot(x - c.x, y - c.y) <= r) return u.id;
    }
    return null;
  }

  // --- turn / activation management ---
  findNextReadyUnit(team) {
    return this.units.find(u => u.team === team && !u.exhausted && u.hp > 0) ?? null;
  }

  endActivation() {
    const u = this.getUnit(this.activeUnitId);
    if (!u) return;

    u.exhausted = true;
    u.actionsLeft = 0;
    this.log(`${u.name} becomes Exhausted.`);

    const next = this.findNextReadyUnit(this.activeTeam);
    if (next) {
      this.activeUnitId = next.id;
      // apply any action penalty
      next.actionsLeft = Math.max(1, 3 - (next.actionPenaltyNextActivation || 0));
      next.actionPenaltyNextActivation = 0;

      this.selectedId = next.id;
      this.log(`${this.activeTeam} activates ${next.name}.`);
    } else {
      this.log(`${this.activeTeam} has no ready models.`);
    }
  }

  nextTurn() {
    // Maintenance: reset exhausted, clear round-limited flags
    for (const u of this.units) {
      u.exhausted = false;
      u.actionsLeft = 3;
      u.gainedSuppressionThisRound = false;
      u.gainedHorrorFromSuppressionThisRound = false;
    }

    this.turnIndex = (this.turnIndex + 1) % this.teamOrder.length;
    this.activeTeam = this.teamOrder[this.turnIndex];

    const next = this.findNextReadyUnit(this.activeTeam);
    this.activeUnitId = next?.id ?? null;
    this.selectedId = this.activeUnitId;

    this.log(`--- New Turn: ${this.activeTeam} ---`);
    if (next) this.log(`${this.activeTeam} activates ${next.name}.`);
  }

  // --- actions ---
  canActSelected() {
    const u = this.getSelected();
    if (!u) return false;
    if (u.id !== this.activeUnitId) { this.log(`Not your active model.`); return false; }
    if (u.actionsLeft <= 0) { this.log(`No actions left.`); return false; }
    if (u.exhausted) { this.log(`Model is Exhausted.`); return false; }
    if (u.hp <= 0) { this.log(`Model is down.`); return false; }
    return true;
  }

  tryMoveSelected(tx, ty) {
    if (!this.canActSelected()) return;
    const u = this.getSelected();

    const d = Math.abs(u.tx - tx) + Math.abs(u.ty - ty);
    if (d !== 1) { this.log(`Move 1 tile only (prototype).`); return; }

    // TODO: suppression movement horror test here
    u.tx = tx; u.ty = ty;
    u.actionsLeft -= 1;
    this.log(`${u.name} moves to (${tx},${ty}). Actions left: ${u.actionsLeft}`);
  }

  tryShootAtTile(tx, ty) {
    if (!this.canActSelected()) return;
    const attacker = this.getSelected();

    const target = this.units.find(u => u.tx === tx && u.ty === ty && u.team !== attacker.team && u.hp > 0);
    if (!target) { this.log(`No enemy on that tile.`); return; }

    const range = Math.abs(attacker.tx - target.tx) + Math.abs(attacker.ty - target.ty);
    if (range > attacker.range) { this.log(`Out of range.`); return; }

    attacker.actionsLeft -= 1;

    // Simplified hit: d20 + fp vs armor (no cover yet)
    const roll = 1 + Math.floor(this.rng() * 20);
    const total = roll + attacker.fp;
    const hit = total >= target.armor;

    // Apply Suppressed on being targeted (hit or miss) once per round
    if (!target.suppressed && !target.gainedSuppressionThisRound) {
      target.suppressed = true;
      target.gainedSuppressionThisRound = true;
      this.log(`${target.name} becomes Suppressed (targeted by fire).`);
    }

    if (hit) {
      target.hp -= 1;
      this.log(`${attacker.name} shoots ${target.name}: d20(${roll})+FP(${attacker.fp})=${total} HIT. ${target.name} HP=${target.hp}`);
      if (target.hp <= 0) this.log(`${target.name} is down!`);
    } else {
      this.log(`${attacker.name} shoots ${target.name}: d20(${roll})+FP(${attacker.fp})=${total} MISS.`);
    }
  }

  // --- drawing ---
  draw(ctx, canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const size = this.getTilePx(canvas);
    const pad = this._pad;

    // background
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // grid
    ctx.save();
    ctx.translate(pad, pad);
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

    // units
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      const cx = u.tx * size + size / 2;
      const cy = u.ty * size + size / 2;
      const r = Math.max(10, size * 0.28);

      // body
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = u.team === "Blue" ? "#1f77b4" : "#d62728";
      ctx.fill();

      // outline
      ctx.lineWidth = (u.id === this.selectedId) ? 4 : 2;
      ctx.strokeStyle = (u.id === this.activeUnitId) ? "#111" : "#777";
      ctx.stroke();

      // status ring for suppressed
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
    }

    ctx.restore();
  }
}
