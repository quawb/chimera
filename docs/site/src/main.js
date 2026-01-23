import { Game } from "./sim.js";

const canvas = document.getElementById("c");
const uiSel = document.getElementById("sel");
const uiLog = document.getElementById("log");
const wbJson = document.getElementById("wbJson");

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
}
window.addEventListener("resize", resize);
resize();

const game = new Game({ cols: 20, rows: 14, seed: 12345, obstacleDensity: 0.12 });

function log(msg) {
  uiLog.textContent += msg + "\n";
  uiLog.scrollTop = uiLog.scrollHeight;
}
game.onLog = log;

let mode = "move"; // move | shoot | charge | fight

// Mode buttons
document.getElementById("btnMove").onclick = () => (mode = "move");
document.getElementById("btnShoot").onclick = () => (mode = "shoot");
document.getElementById("btnCharge").onclick = () => (mode = "charge");
document.getElementById("btnFight").onclick = () => (mode = "fight");

// Actions
const disBtn = document.getElementById("btnDisengage");
if (disBtn) disBtn.onclick = () => game.tryDisengageSelected();

document.getElementById("btnAim").onclick = () => game.tryAimSelected();
document.getElementById("btnRecover").onclick = () => game.tryRecoverSelected();
document.getElementById("btnEndAct").onclick = () => game.endActivation();
document.getElementById("btnNextRound").onclick = () => game.forceNextRound();

const newMapBtn = document.getElementById("btnNewMap");
if (newMapBtn) newMapBtn.onclick = () => game.newRandomMap();

// Warband import / random
document.getElementById("btnLoadBlue").onclick = () => {
  try {
    game.loadWarbandFromJson(wbJson.value, "Blue");
  } catch (e) {
    log("Load Blue error: " + e.message);
  }
};
document.getElementById("btnLoadRed").onclick = () => {
  try {
    game.loadWarbandFromJson(wbJson.value, "Red");
  } catch (e) {
    log("Load Red error: " + e.message);
  }
};
document.getElementById("btnRandomWarbands").onclick = () => game.randomWarbands();

canvas.addEventListener("click", (e) => {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const x = (e.clientX - rect.left) * dpr;
  const y = (e.clientY - rect.top) * dpr;

  const hitUnitId = game.pickUnit(x, y, canvas);
  if (hitUnitId) {
    game.select(hitUnitId);
    return;
  }

  const { tx, ty } = game.screenToTile(x, y, canvas);
  if (tx < 0 || ty < 0) return;

  if (mode === "move") game.tryMoveSelected(tx, ty);
  if (mode === "charge") game.tryChargeAtTile(tx, ty);
  if (mode === "shoot") game.tryShootAtTile(tx, ty);
  if (mode === "fight") game.tryFightAtTile(tx, ty);
});

function render() {
  const ctx = canvas.getContext("2d");
  game.draw(ctx, canvas);

  const s = game.getSelected();
  if (!s) {
    uiSel.textContent = "(none)";
  } else {
    const engaged = game.isEngaged(s) ? "Yes" : "No";
    uiSel.textContent =
      `${s.name} (${s.team}) ${s.id === game.activeUnitId ? " [ACTIVE]" : ""}\n` +
      `HP: ${s.hp} | AC: ${s.ac}\n` +
      `Actions left: ${s.actionsLeft}\n` +
      `Engaged: ${engaged}\n` +
      `Horror: ${s.horror} (–${s.horror} to rolls)\n` +
      `Suppressed: ${s.suppressed ? "Yes" : "No"}\n` +
      `Aim streak: ${s.aimStreak}\n` +
      `Exhausted: ${s.exhausted ? "Yes" : "No"}\n`;
  }

  requestAnimationFrame(render);
}
render();
