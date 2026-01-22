import { Game } from "./sim.js";

const canvas = document.getElementById("c");
const uiSel = document.getElementById("sel");
const uiLog = document.getElementById("log");

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
}
window.addEventListener("resize", resize);
resize();

const game = new Game({
  cols: 20,
  rows: 14,
  seed: 12345,
});

function log(msg) {
  uiLog.textContent += msg + "\n";
  uiLog.scrollTop = uiLog.scrollHeight;
}

game.onLog = log;

let mode = "move"; // "move" | "shoot"

document.getElementById("btnMove").onclick = () => mode = "move";
document.getElementById("btnShoot").onclick = () => mode = "shoot";
document.getElementById("btnEndAct").onclick = () => game.endActivation();
document.getElementById("btnNext").onclick = () => game.nextTurn();

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
  if (mode === "shoot") game.tryShootAtTile(tx, ty);
});

function render() {
  const ctx = canvas.getContext("2d");
  game.draw(ctx, canvas);

  const s = game.getSelected();
  if (!s) uiSel.textContent = "(none)";
  else {
    uiSel.textContent =
      `${s.name} (${s.team})\n` +
      `HP: ${s.hp}\n` +
      `Actions left: ${s.actionsLeft}\n` +
      `Horror: ${s.horror}\n` +
      `Suppressed: ${s.suppressed ? "Yes" : "No"}\n` +
      `Exhausted: ${s.exhausted ? "Yes" : "No"}\n`;
  }

  requestAnimationFrame(render);
}
render();
