// Zero-build Craft Ledger voucher PNG renderer (2x DPR HTML5 Canvas).

function drawRoundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function loadImageSafe(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function truncateCanvasText(ctx, text, maxWidth) {
  const str = String(text || '').trim();
  if (!str) return '';
  if (ctx.measureText(str).width <= maxWidth) return str;
  let out = str;
  while (out.length > 1 && ctx.measureText(`${out}...`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

export async function renderVoucherCardCanvas(payload) {
  const width = 1200;
  const height = 660;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  const workshopName = String(payload.workshopName || 'MendTrack').trim();
  const workshopLogo = payload.workshopLogo || '';
  const badgeText = String(payload.badgeText || 'LOYALTY VOUCHER').trim();
  const discountLabel = String(payload.discountLabel || '').trim();
  const voucherCode = String(payload.voucherCode || '').trim().toUpperCase();
  const forLabel = String(payload.forLabel || 'ISSUED FOR').trim();
  const customerName = String(payload.customerName || '').trim();
  const codeLabel = String(payload.codeLabel || 'VOUCHER CODE').trim();
  const expiryLabel = String(payload.expiryLabel || '').trim();
  const noteText = String(payload.noteText || '').trim();
  const portalUrl = String(payload.portalUrl || '').trim();

  ctx.fillStyle = '#F5F2EB';
  ctx.fillRect(0, 0, width, height);

  const pad = 34;
  const cardX = pad;
  const cardY = pad;
  const cardW = width - pad * 2;
  const cardH = height - pad * 2;

  ctx.save();
  drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 24);
  ctx.fillStyle = '#FFFDF9';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#D8D1C4';
  ctx.stroke();
  ctx.clip();

  const headH = 136;
  ctx.fillStyle = '#18253E';
  ctx.fillRect(cardX, cardY, cardW, headH);

  ctx.save();
  ctx.strokeStyle = '#9E4316';
  ctx.lineWidth = 4;
  ctx.setLineDash([14, 10]);
  ctx.beginPath();
  ctx.moveTo(cardX, cardY + headH);
  ctx.lineTo(cardX + cardW, cardY + headH);
  ctx.stroke();
  ctx.restore();

  const logoBoxX = cardX + 42;
  const logoBoxY = cardY + 34;
  const logoSize = 68;
  const img = await loadImageSafe(workshopLogo);
  if (img) {
    try {
      ctx.save();
      drawRoundedRect(ctx, logoBoxX, logoBoxY, logoSize, logoSize, 14);
      ctx.fillStyle = '#FFFDF9';
      ctx.fill();
      ctx.clip();
      const scale = Math.min((logoSize - 10) / img.width, (logoSize - 10) / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, logoBoxX + (logoSize - dw) / 2, logoBoxY + (logoSize - dh) / 2, dw, dh);
      ctx.restore();
    } catch (_) {
      drawRoundedRect(ctx, logoBoxX, logoBoxY, logoSize, logoSize, 14);
      ctx.fillStyle = '#9E4316';
      ctx.fill();
      ctx.fillStyle = '#FFFDF9';
      ctx.font = '800 30px "Plus Jakarta Sans", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(workshopName.slice(0, 2).toUpperCase(), logoBoxX + logoSize / 2, logoBoxY + logoSize / 2 + 1);
    }
  } else {
    drawRoundedRect(ctx, logoBoxX, logoBoxY, logoSize, logoSize, 14);
    ctx.fillStyle = '#9E4316';
    ctx.fill();
    ctx.fillStyle = '#FFFDF9';
    ctx.font = '800 30px "Plus Jakarta Sans", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(workshopName.slice(0, 2).toUpperCase(), logoBoxX + logoSize / 2, logoBoxY + logoSize / 2 + 1);
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#FFFDF9';
  ctx.font = '800 34px "Plus Jakarta Sans", Arial, sans-serif';
  ctx.fillText(truncateCanvasText(ctx, workshopName, 620), logoBoxX + logoSize + 22, cardY + 68);

  ctx.fillStyle = '#ECE7DC';
  ctx.font = '700 18px "Plus Jakarta Sans", Arial, sans-serif';
  ctx.fillText(truncateCanvasText(ctx, badgeText, 620), logoBoxX + logoSize + 22, cardY + 100);

  const bodyTop = cardY + headH + 44;
  const leftColX = cardX + 44;

  ctx.fillStyle = '#9E4316';
  ctx.font = '800 74px "Plus Jakarta Sans", Arial, sans-serif';
  ctx.fillText(truncateCanvasText(ctx, discountLabel, cardW - 96), leftColX, bodyTop + 56);

  ctx.fillStyle = '#4A5568';
  ctx.font = '700 16px "Plus Jakarta Sans", Arial, sans-serif';
  ctx.fillText(forLabel.toUpperCase(), leftColX, bodyTop + 114);

  ctx.fillStyle = '#18253E';
  ctx.font = '700 28px "Plus Jakarta Sans", Arial, sans-serif';
  ctx.fillText(truncateCanvasText(ctx, customerName, 540), leftColX, bodyTop + 152);

  if (noteText) {
    ctx.fillStyle = '#4A5568';
    ctx.font = '500 19px "Plus Jakarta Sans", Arial, sans-serif';
    ctx.fillText(truncateCanvasText(ctx, noteText, 540), leftColX, bodyTop + 190);
  }

  const codeBoxW = 430;
  const codeBoxH = 128;
  const codeBoxX = cardX + cardW - codeBoxW - 44;
  const codeBoxY = bodyTop + 92;

  ctx.save();
  drawRoundedRect(ctx, codeBoxX, codeBoxY, codeBoxW, codeBoxH, 16);
  ctx.fillStyle = '#F5F2EB';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = '#9E4316';
  ctx.stroke();
  ctx.restore();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#4A5568';
  ctx.font = '700 15px "Plus Jakarta Sans", Arial, sans-serif';
  ctx.fillText(codeLabel.toUpperCase(), codeBoxX + codeBoxW / 2, codeBoxY + 34);

  const pillW = codeBoxW - 44;
  const pillH = 56;
  const pillX = codeBoxX + 22;
  const pillY = codeBoxY + 50;
  drawRoundedRect(ctx, pillX, pillY, pillW, pillH, 10);
  ctx.fillStyle = '#18253E';
  ctx.fill();

  ctx.fillStyle = '#FFFDF9';
  ctx.font = '700 28px "IBM Plex Mono", Consolas, monospace';
  ctx.textBaseline = 'middle';
  ctx.fillText(truncateCanvasText(ctx, voucherCode, pillW - 24), pillX + pillW / 2, pillY + pillH / 2 + 1);

  const footH = 82;
  const footY = cardY + cardH - footH;
  ctx.fillStyle = '#F5F2EB';
  ctx.fillRect(cardX, footY, cardW, footH);

  ctx.save();
  ctx.strokeStyle = '#D8D1C4';
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.moveTo(cardX, footY);
  ctx.lineTo(cardX + cardW, footY);
  ctx.stroke();
  ctx.restore();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#18253E';
  ctx.font = '700 20px "Plus Jakarta Sans", Arial, sans-serif';
  ctx.fillText(truncateCanvasText(ctx, expiryLabel, 540), leftColX, footY + footH / 2);

  if (portalUrl) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#4A5568';
    ctx.font = '600 18px "IBM Plex Mono", Consolas, monospace';
    ctx.fillText(truncateCanvasText(ctx, portalUrl, 520), cardX + cardW - 44, footY + footH / 2);
  }

  ctx.restore();
  return canvas;
}

export async function downloadVoucherCardPng(payload) {
  const canvas = await renderVoucherCardCanvas(payload);
  const safeCode = String(payload.voucherCode || 'VOUCHER')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
  const fileName = `voucher-${safeCode || 'CARD'}.png`;

  return new Promise((resolve, reject) => {
    try {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('Failed to generate PNG blob'));
            return;
          }
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = fileName;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          setTimeout(() => URL.revokeObjectURL(url), 1500);
          resolve(fileName);
        }, 'image/png');
      } else {
        const dataUrl = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        resolve(fileName);
      }
    } catch (err) {
      reject(err);
    }
  });
}
