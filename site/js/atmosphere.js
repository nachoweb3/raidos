// A bounded, decorative star field. No pointer interception or hidden-tab work.
const canvas = document.createElement("canvas");
canvas.className = "terminal-atmosphere";
canvas.setAttribute("aria-hidden", "true");
document.body.prepend(canvas);
const ctx = canvas.getContext("2d");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
let points = [], width = 0, height = 0, frame = 0, last = 0;
function resize() {
  width = innerWidth; height = innerHeight;
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  canvas.width = width * dpr; canvas.height = height * dpr;
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  points = Array.from({ length: Math.min(65, Math.floor(width / 22)) }, () => ({ x: Math.random() * width, y: Math.random() * height, r: .5 + Math.random(), speed: .06 + Math.random() * .13 }));
}
function draw(now) {
  if (!ctx || reduced.matches || document.hidden) { frame = 0; return; }
  if (now - last > 40) {
    const delta = Math.min(100, now - last) / 40; last = now;
    ctx.clearRect(0, 0, width, height);
    for (const point of points) {
      point.y -= point.speed * delta;
      if (point.y < 0) point.y = height;
      ctx.fillStyle = "rgba(135,221,237,.35)";
      ctx.beginPath(); ctx.arc(point.x, point.y, point.r, 0, Math.PI * 2); ctx.fill();
    }
  }
  frame = requestAnimationFrame(draw);
}
function sync() {
  cancelAnimationFrame(frame); frame = 0;
  canvas.hidden = reduced.matches;
  if (!document.hidden && !reduced.matches) frame = requestAnimationFrame(draw);
}
resize(); sync();
addEventListener("resize", resize, { passive: true });
document.addEventListener("visibilitychange", sync);
reduced.addEventListener("change", sync);
