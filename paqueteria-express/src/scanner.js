// Escáner de QR con la cámara en vivo. Usa BarcodeDetector cuando el teléfono lo trae
// (Android/Chrome) y jsQR en los demás (iPhone). Funciona sin internet.
import jsQR from "jsqr";

export const extractId = (text) => {
  const m = String(text || "").match(/pk-[a-z0-9]{4,}/i);
  return m ? m[0].toLowerCase() : null;
};

export async function startScanner(video, onCode) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  video.muted = true;
  await video.play();

  let detector = null;
  try {
    if ("BarcodeDetector" in window && (await window.BarcodeDetector.getSupportedFormats()).includes("qr_code")) {
      detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    }
  } catch { detector = null; }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let stopped = false, busy = false, timer = 0;

  const tick = async () => {
    if (stopped) return;
    if (!busy && video.readyState >= 2) {
      busy = true;
      try {
        let text = null;
        if (detector) {
          const codes = await detector.detect(video);
          text = codes[0]?.rawValue || null;
        } else {
          const s = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * s); canvas.height = Math.round(video.videoHeight * s);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          text = jsQR(img.data, canvas.width, canvas.height, { inversionAttempts: "dontInvert" })?.data || null;
        }
        if (text && !stopped) {
          const id = extractId(text);
          if (id) { stop(); onCode(id); return; }
        }
      } catch { /* cuadro ilegible, se intenta con el siguiente */ }
      busy = false;
    }
    timer = setTimeout(tick, 120);
  };
  tick();

  function stop() {
    stopped = true; clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
  return stop;
}

// Leer un QR desde una foto (respaldo si no se permite la cámara en vivo).
export async function scanImageFile(file) {
  const img = await createImageBitmap(file);
  const s = Math.min(1, 1400 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  const x = c.getContext("2d"); x.drawImage(img, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height);
  return extractId(jsQR(d.data, c.width, c.height, { inversionAttempts: "attemptBoth" })?.data);
}
