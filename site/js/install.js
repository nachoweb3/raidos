let deferredInstall;
const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
function updateButtons() {
  document.querySelectorAll("[data-install-app]").forEach(button => {
    button.hidden = standalone();
  });
}
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault(); deferredInstall = event; updateButtons();
});
window.addEventListener("appinstalled", () => { deferredInstall = null; updateButtons(); });
async function installApp() {
  if (standalone()) return;
  if (deferredInstall) {
    const prompt = deferredInstall;
    deferredInstall = null;
    await prompt.prompt();
    await prompt.userChoice;
    updateButtons();
    return;
  }
  document.getElementById("installAppDialog")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "installAppDialog"; dialog.className = "raydium-create";
  dialog.innerHTML = '<h2>Instala TRENCHES</h2><p>Abre la app desde tu pantalla de inicio.</p><h3>Android</h3><p>Abre esta web en Chrome. En el men\u00fa de los tres puntos, elige <b>Instalar aplicaci\u00f3n</b> o <b>A\u00f1adir a pantalla de inicio</b>.</p><h3>iPhone / iPad</h3><p>Abre esta web en Safari. Pulsa <b>Compartir</b>, despu\u00e9s <b>A\u00f1adir a pantalla de inicio</b> y confirma con <b>A\u00f1adir</b>.</p><p>Si est\u00e1s dentro de Telegram o de otra app, abre primero el enlace en tu navegador. Necesitas conexi\u00f3n para consultar mercados y operar.</p><button class="btn btn-primary" type="button">Entendido</button>';
  dialog.querySelector("button").addEventListener("click", () => dialog.close());
  document.body.append(dialog); dialog.showModal();
}
document.querySelectorAll("[data-install-app]").forEach(button => button.addEventListener("click", installApp));
updateButtons();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", {updateViaCache:"none"}).catch(() => {});
