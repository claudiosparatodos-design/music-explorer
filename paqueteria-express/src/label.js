import qrcode from "qrcode-generator";

export const codeOf = (id) => id.toUpperCase();
export const appUrl = () => location.origin + location.pathname;
export const qrText = (id) => appUrl() + "#" + id;

export function drawQR(canvas, text, quiet = 2) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), size = canvas.width, cell = size / (n + quiet * 2);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, size, size); ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (q.isDark(r, c)) ctx.fillRect(Math.floor((c + quiet) * cell), Math.floor((r + quiet) * cell), Math.ceil(cell), Math.ceil(cell));
  }
  return canvas;
}

function wrap(ctx, text, x, y, maxW, lh, maxLines) {
  const words = String(text).split(/\s+/); let line = "", lines = 0;
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width > maxW && line) {
      if (lines === maxLines - 1) { ctx.fillText(line + "…", x, y); return y + lh; }
      ctx.fillText(line, x, y); y += lh; lines++; line = w;
    } else line = t;
  }
  if (line) ctx.fillText(line, x, y);
  return y + lh;
}
function fit(ctx, text, weight, family, start, min, maxW) {
  let s = start;
  do { ctx.font = `${weight} ${s}px ${family}`; s -= 2; } while (ctx.measureText(text).width > maxW && s > min);
}

// Etiqueta de 4×6 pulgadas a 203 dpi (impresoras térmicas de paquetería).
export async function labelCanvas(id, p, piece = 1, total = 1) {
  try { await document.fonts.ready; } catch { /* sin fuentes */ }
  const W = 812, H = 1218, M = 40;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d");
  const D = '"Archivo","Arial Narrow",Arial,sans-serif', B = '"Inter",Arial,sans-serif', Mo = '"JetBrains Mono",monospace';
  x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
  x.fillStyle = "#000"; x.strokeStyle = "#000"; x.lineWidth = 4;
  x.strokeRect(M / 2, M / 2, W - M, H - M);

  // Marca
  x.font = `800 30px ${D}`; x.fillText("PAQUETERÍA EXPRESS", M, M + 30);
  x.font = `600 22px ${B}`;
  const fecha = p.creado ? new Date(p.creado).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" }) : "";
  x.fillText(fecha, W - M - x.measureText(fecha).width, M + 28);

  // Banda de ruta
  let y = M + 52;
  x.fillRect(M / 2, y, W - M, 160);
  x.fillStyle = "#fff";
  x.font = `600 24px ${B}`; x.fillText("DE: " + (p.origen || "").toUpperCase(), M, y + 34);
  const dest = (p.destCiudad || "").toUpperCase();
  fit(x, dest, 800, D, 72, 30, W - 2 * M); x.fillText(dest, M, y + 108);
  x.font = `700 30px ${D}`; x.fillText((p.destEstado || "").toUpperCase(), M, y + 146);
  x.fillStyle = "#000";

  // Destinatario
  y += 160 + 46;
  x.font = `600 22px ${B}`; x.fillText("PARA", M, y); y += 46;
  x.font = `800 44px ${D}`; y = wrap(x, p.destinatario || "", M, y, W - 2 * M, 48, 2);
  if (p.destTel) { x.font = `500 28px ${Mo}`; x.fillText("Tel. " + p.destTel, M, y + 2); y += 42; }
  if (p.destDir) { x.font = `400 24px ${B}`; y = wrap(x, p.destDir, M, y + 4, W - 2 * M, 30, 2); }
  y += 6; x.fillRect(M / 2, y, W - M, 3); y += 38;
  x.font = `600 22px ${B}`; x.fillText("ENVÍA", M, y); y += 34;
  x.font = `600 28px ${B}`; x.fillText([p.remitente, p.remTel].filter(Boolean).join("  ·  ") || "—", M, y);

  // QR + datos
  const qs = 400, qy = H - M / 2 - qs - 112, qx = M;
  x.font = `600 22px ${B}`; x.fillText("Escanea para ver estado y pago", qx, qy - 12);
  const qc = document.createElement("canvas"); qc.width = qs; qc.height = qs;
  drawQR(qc, qrText(id), 2); x.drawImage(qc, qx, qy);
  const rx = qx + qs + 28; let ry = qy + 36;
  x.font = `600 22px ${B}`; x.fillText("CAJA", rx, ry); ry += 58;
  x.font = `800 58px ${D}`; x.fillText(`${piece} de ${total}`, rx, ry); ry += 50;
  if (p.peso) { x.font = `600 22px ${B}`; x.fillText("PESO TOTAL", rx, ry); ry += 44; x.font = `800 38px ${D}`; x.fillText(p.peso + " lb", rx, ry); ry += 42; }
  if (p.contenido) { x.font = `400 22px ${B}`; wrap(x, p.contenido, rx, ry + 6, W - rx - M, 28, 4); }

  // Código de guía
  x.fillRect(M / 2, H - M / 2 - 96, W - M, 96);
  x.fillStyle = "#fff"; x.font = `700 54px ${Mo}`;
  const code = codeOf(id), cw = x.measureText(code).width;
  x.fillText(code, (W - cw) / 2, H - M / 2 - 30);
  return c;
}
