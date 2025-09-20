const ws = new WebSocket("ws://localhost:8001/");
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const rect = canvas.getBoundingClientRect();

function uvToCanvasClipped(u, v) {
  const screenX = u * window.innerWidth;
  const screenY = v * window.innerHeight;
  const rect = canvas.getBoundingClientRect();

  if (
    screenX < rect.left ||
    screenX > rect.right ||
    screenY < rect.top ||
    screenY > rect.bottom
  ) {
    return null;
  }

  const canvasX = (screenX - rect.left) * (canvas.width / rect.width);
  const canvasY = (screenY - rect.top) * (canvas.height / rect.height);

  return { x: canvasX, y: canvasY };
}

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  rect = canvas.getBoundingClientRect();
  draw();
}

function draw(x, y, blink) {
  if (blink) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'red';
  let pos = uvToCanvasClipped(x, y);
  if (pos) {
    ctx.font = "16px serif";
    ctx.fillText(`[${x}, ${y}]`, pos.x, pos.y + 50);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

ws.addEventListener("message", (e) => {
  const d = JSON.parse(e.data);
  draw(d.x, d.y, d.blink)
});

resize();
window.addEventListener("resize", resizeCanvas);
