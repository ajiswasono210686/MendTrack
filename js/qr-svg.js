// Zero-build offline ISO/IEC 18004 QR Code SVG generator (Byte mode, EC Level M, Versions 1-10).

const ALIGNMENT_COORDS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

// [ecCodewordsPerBlock, group1Blocks, group1DataCodewords, group2Blocks, group2DataCodewords]
const VERSION_EC_M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const rem = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    for (let j = 0; j < ecCount - 1; j++) {
      rem[j] = rem[j + 1] ^ gfMul(gen[j + 1], factor);
    }
    rem[ecCount - 1] = gfMul(gen[ecCount], factor);
  }
  return rem;
}

function pushBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) {
    bits.push((value >>> i) & 1);
  }
}

function selectVersion(byteLength) {
  for (let v = 1; v <= 10; v++) {
    const [, g1, d1, g2, d2] = VERSION_EC_M[v];
    const totalDataBytes = g1 * d1 + g2 * d2;
    const countBits = v >= 10 ? 16 : 8;
    const capacityBytes = Math.floor((totalDataBytes * 8 - 4 - countBits) / 8);
    if (byteLength <= capacityBytes) return v;
  }
  throw new Error('QR payload exceeds supported Version 10-M capacity.');
}

function buildCodewords(bytes, version) {
  const [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = VERSION_EC_M[version];
  const totalDataCodewords = g1Blocks * g1Data + g2Blocks * g2Data;
  const bits = [];

  // Mode indicator: 0100 (Byte)
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) pushBits(bits, b, 8);

  const totalDataBits = totalDataCodewords * 8;
  const terminator = Math.min(4, totalDataBits - bits.length);
  pushBits(bits, 0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCodewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0;
    for (let j = 0; j < 8; j++) val = (val << 1) | bits[i + j];
    dataCodewords.push(val);
  }

  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (dataCodewords.length < totalDataCodewords) {
    dataCodewords.push(padBytes[padIdx % 2]);
    padIdx++;
  }

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < g1Blocks; i++) {
    const block = dataCodewords.slice(offset, offset + g1Data);
    offset += g1Data;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }
  for (let i = 0; i < g2Blocks; i++) {
    const block = dataCodewords.slice(offset, offset + g2Data);
    offset += g2Data;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }

  const interleaved = [];
  const maxDataLen = Math.max(g1Data, g2Data);
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) interleaved.push(block[i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) {
      interleaved.push(block[i]);
    }
  }
  return interleaved;
}

function createMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size));

  const setFn = (r, c, dark) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = dark ? 1 : 0;
    isFunction[r][c] = 1;
  };

  // Finder patterns + 1-module white separators
  const placeFinder = (top, left) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark =
          inOuter &&
          (dr === 0 ||
            dr === 6 ||
            dc === 0 ||
            dc === 6 ||
            (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFn(r, c, dark);
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const centers = ALIGNMENT_COORDS[version] || [];
  for (const rCenter of centers) {
    for (const cCenter of centers) {
      if (isFunction[rCenter][cCenter]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFn(rCenter + dr, cCenter + dc, dist !== 1);
        }
      }
    }
  }

  // Reserve format info strips + fixed dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFn(8, i, false);
      setFn(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setFn(8, size - 1 - i, false);
    if (i < 7) setFn(size - 1 - i, 8, false);
  }
  setFn(size - 8, 8, true);

  // Version info blocks for Version >= 7
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vBits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = Boolean((vBits >>> i) & 1);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, dark);
      setFn(b, a, dark);
    }
  }

  return { size, modules, isFunction };
}

function placeDataBits(size, modules, isFunction, codewords) {
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset++) {
        const c = right - offset;
        if (isFunction[r][c]) continue;
        let dark = 0;
        if (bitIndex < totalBits) {
          const cw = codewords[bitIndex >>> 3];
          dark = (cw >>> (7 - (bitIndex & 7))) & 1;
          bitIndex++;
        }
        modules[r][c] = dark;
      }
    }
    upward = !upward;
  }
}

function maskBit(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

function writeFormatBits(size, modules, mask) {
  // EC Level M = 00
  const data = (0b00 << 3) | (mask & 7);
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  for (let i = 0; i <= 5; i++) modules[8][i] = (bits >>> (14 - i)) & 1;
  modules[8][7] = (bits >>> 8) & 1;
  modules[8][8] = (bits >>> 7) & 1;
  modules[7][8] = (bits >>> 6) & 1;
  for (let i = 9; i < 15; i++) modules[14 - i][8] = (bits >>> (14 - i)) & 1;

  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = (bits >>> i) & 1;
  for (let i = 0; i < 7; i++) modules[size - 1 - i][8] = (bits >>> (14 - i)) & 1;
}

function evaluatePenalty(size, modules) {
  let penalty = 0;

  // N1: adjacent same-color modules in rows and columns
  for (let r = 0; r < size; r++) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      if (modules[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }
  for (let c = 0; c < size; c++) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      if (modules[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  // N2: 2x2 same-color blocks
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }

  // N3: finder-like 1:1:3:1:1 with 4-module light padding
  const matchesFinder = (arr, start) => {
    const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    let m1 = true;
    let m2 = true;
    for (let i = 0; i < 11; i++) {
      if (arr[start + i] !== p1[i]) m1 = false;
      if (arr[start + i] !== p2[i]) m2 = false;
      if (!m1 && !m2) return false;
    }
    return true;
  };
  const colBuf = new Uint8Array(size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      if (matchesFinder(modules[r], c)) penalty += 40;
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r < size; r++) colBuf[r] = modules[r][c];
    for (let r = 0; r <= size - 11; r++) {
      if (matchesFinder(colBuf, r)) penalty += 40;
    }
  }

  // N4: dark/light balance
  let darkCount = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) darkCount++;
    }
  }
  const percent = (darkCount * 100) / (size * size);
  const steps = Math.floor(Math.abs(percent - 50) / 5);
  penalty += steps * 10;

  return penalty;
}

export function generateQrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  const version = selectVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);
  const { size, modules, isFunction } = createMatrix(version);
  placeDataBits(size, modules, isFunction, codewords);

  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestMatrix = null;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.map((row) => Uint8Array.from(row));
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFunction[r][c] && maskBit(mask, r, c)) {
          candidate[r][c] ^= 1;
        }
      }
    }
    writeFormatBits(size, candidate, mask);
    const penalty = evaluatePenalty(size, candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
      bestMatrix = candidate;
    }
  }

  return { version, mask: bestMask, size, modules: bestMatrix };
}

export function renderQrSvg(text, options = {}) {
  const quietZone = Number.isInteger(options.quietZone) ? options.quietZone : 4;
  const label = String(options.ariaLabel || 'QR Code')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const { size, modules } = generateQrMatrix(text);
  const total = size + quietZone * 2;
  const pathParts = [];

  for (let r = 0; r < size; r++) {
    const y = r + quietZone;
    let c = 0;
    while (c < size) {
      if (!modules[r][c]) {
        c++;
        continue;
      }
      const start = c;
      while (c < size && modules[r][c]) c++;
      const runWidth = c - start;
      pathParts.push(`M${start + quietZone},${y}h${runWidth}v1h-${runWidth}z`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#FFFFFF"/><path d="${pathParts.join('')}" fill="#000000"/></svg>`;
}
