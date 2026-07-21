/* Dependency-free QR Code generator.
 * Byte mode, error-correction level L, single-block versions 1-5 (up to ~106
 * bytes — plenty for a join URL). Implemented per ISO/IEC 18004 with full
 * data-mask selection, so codes scan reliably on phone cameras. Renders SVG.
 */
(function (global) {
  'use strict';

  // ---- GF(256), primitive polynomial 0x11d --------------------------------
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  // ---- Per-version spec (EC level L, single block): [dataCW, ecCW, alignCenter]
  const SPEC = {
    1: [19, 7, 0],
    2: [34, 10, 18],
    3: [55, 15, 22],
    4: [80, 20, 26],
    5: [108, 26, 30],
  };
  // 15-bit format strings for EC level L, masks 0..7 (BCH-encoded + mask xor)
  const FORMAT_L = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];

  const MASK = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function utf8(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return bytes;
  }

  function chooseVersion(byteLen) {
    for (let v = 1; v <= 5; v++) {
      // mode (4) + count (8) + data (8*n) + terminator must fit dataCW*8
      if (SPEC[v][0] * 8 >= 4 + 8 + byteLen * 8) return v;
    }
    throw new Error('QR: data too long');
  }

  function makeBytes(bytes, version) {
    const dataCW = SPEC[version][0];
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(0b0100, 4);            // byte mode
    push(bytes.length, 8);      // char count (byte mode, versions 1-9)
    for (const b of bytes) push(b, 8);
    const cap = dataCW * 8;
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0); // terminator
    while (bits.length % 8 !== 0) bits.push(0);
    const cw = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      cw.push(v);
    }
    const pads = [0xec, 0x11];
    let p = 0;
    while (cw.length < dataCW) cw.push(pads[p++ % 2]);
    return cw;
  }

  // Reed-Solomon EC codewords (LFSR division).
  function ecc(data, ecLen) {
    let gen = [1];
    for (let i = 0; i < ecLen; i++) {
      const ng = new Array(gen.length + 1).fill(0);
      for (let j = 0; j < gen.length; j++) {
        ng[j] ^= gen[j];
        ng[j + 1] ^= mul(gen[j], EXP[i]);
      }
      gen = ng;
    }
    const rem = new Array(ecLen).fill(0);
    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ rem[0];
      rem.shift();
      rem.push(0);
      if (factor !== 0) for (let j = 0; j < ecLen; j++) rem[j] ^= mul(gen[j + 1], factor);
    }
    return rem;
  }

  function buildMatrix(text) {
    const bytes = utf8(text);
    const version = chooseVersion(bytes.length);
    const [dataCW, ecCW, alignC] = SPEC[version];
    const size = 17 + version * 4;

    const data = makeBytes(bytes, version);
    const all = data.concat(ecc(data, ecCW)); // single block: data then EC

    const m = Array.from({ length: size }, () => new Array(size).fill(0));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (r, c, v) => { m[r][c] = v ? 1 : 0; fn[r][c] = true; };

    // Finder patterns + separators
    const finder = (r0, c0) => {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const r = r0 + dr, c = c0 + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const ring = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
            (dr === 0 || dr === 6 || dc === 0 || dc === 6);
          const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          set(r, c, ring || core ? 1 : 0);
        }
      }
    };
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      set(6, i, i % 2 === 0 ? 1 : 0);
      set(i, 6, i % 2 === 0 ? 1 : 0);
    }

    // Dark module
    set(size - 8, 8, 1);

    // Alignment pattern (single, centered) for versions 2-5
    if (alignC) {
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const border = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          set(alignC + dr, alignC + dc, border ? 1 : 0);
        }
      }
    }

    // Reserve format-info areas (marked function so data skips them)
    for (let i = 0; i < 9; i++) {
      if (!fn[8][i]) set(8, i, 0);
      if (!fn[i][8]) set(i, 8, 0);
    }
    for (let i = 0; i < 8; i++) {
      if (!fn[8][size - 1 - i]) set(8, size - 1 - i, 0);
      if (!fn[size - 1 - i][8]) set(size - 1 - i, 8, 0);
    }

    // Place data bits (zigzag, upward/downward columns, skip timing col 6)
    const totalBits = all.length * 8;
    const bitAt = (idx) => (all[idx >> 3] >> (7 - (idx & 7))) & 1;
    let bit = 0;
    let up = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col = 5;
      for (let i = 0; i < size; i++) {
        const row = up ? size - 1 - i : i;
        for (let j = 0; j < 2; j++) {
          const c = col - j;
          if (fn[row][c]) continue;
          m[row][c] = bit < totalBits ? bitAt(bit++) : 0;
        }
      }
      up = !up;
    }

    // Choose the best mask by penalty score
    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(m, fn, mask);
      drawFormat(m, size, mask);
      const s = penalty(m, size);
      if (s < bestScore) { bestScore = s; best = mask; }
      applyMask(m, fn, mask); // undo (XOR is its own inverse)
    }
    applyMask(m, fn, best);
    drawFormat(m, size, best);

    return { m, size };
  }

  function applyMask(m, fn, mask) {
    const size = m.length;
    const f = MASK[mask];
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (!fn[r][c] && f(r, c)) m[r][c] ^= 1;
  }

  function drawFormat(m, size, mask) {
    const fmt = FORMAT_L[mask];
    const bit = (i) => (fmt >> i) & 1;
    // First copy around the top-left finder: bits 0-5 down column 8,
    // then the corner, then bits 9-14 along row 8.
    for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
    m[7][8] = bit(6);
    m[8][8] = bit(7);
    m[8][7] = bit(8);
    for (let i = 9; i <= 14; i++) m[8][14 - i] = bit(i);
    // Second copy: bits 0-7 along row 8 (right side), bits 8-14 up column 8
    // (bottom), then the always-dark module.
    for (let i = 0; i <= 7; i++) m[8][size - 1 - i] = bit(i);
    for (let i = 8; i <= 14; i++) m[size - 15 + i][8] = bit(i);
    m[size - 8][8] = 1; // dark module
  }

  // Standard penalty evaluation (4 rules).
  function penalty(m, size) {
    let score = 0;
    // Rule 1: runs of 5+ same color in rows and columns
    for (let r = 0; r < size; r++) {
      let rc = 1, cc = 1;
      for (let i = 1; i < size; i++) {
        rc = m[r][i] === m[r][i - 1] ? rc + 1 : 1;
        if (rc === 5) score += 3; else if (rc > 5) score += 1;
        cc = m[i][r] === m[i - 1][r] ? cc + 1 : 1;
        if (cc === 5) score += 3; else if (cc > 5) score += 1;
      }
    }
    // Rule 2: 2x2 blocks of same color
    for (let r = 0; r < size - 1; r++)
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    // Rule 3: finder-like 1:1:3:1:1 patterns with 4-module light run
    const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const match = (get, i, len) => {
      const a = P1, b = P2;
      let m1 = true, m2 = true;
      for (let k = 0; k < 11; k++) { const g = get(i + k); if (g !== a[k]) m1 = false; if (g !== b[k]) m2 = false; }
      return m1 || m2;
    };
    for (let r = 0; r < size; r++)
      for (let c = 0; c <= size - 11; c++) {
        if (match((k) => m[r][k], c)) score += 40;
        if (match((k) => m[k][r], c)) score += 40;
      }
    // Rule 4: overall dark proportion
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function render(container, text, opts) {
    opts = opts || {};
    const quiet = opts.quiet != null ? opts.quiet : 4;
    let matrix;
    try {
      matrix = buildMatrix(text);
    } catch (e) {
      container.innerHTML = '<div style="font-size:12px;color:#333">' + text + '</div>';
      return;
    }
    const { m, size } = matrix;
    const total = size + quiet * 2;
    const cells = [];
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (m[r][c] === 1) cells.push('<rect x="' + (c + quiet) + '" y="' + (r + quiet) + '" width="1" height="1"/>');
    const px = opts.size || 176;
    container.innerHTML =
      '<svg width="' + px + '" height="' + px + '" viewBox="0 0 ' + total + ' ' + total +
      '" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="' + total + '" height="' + total + '" fill="#ffffff"/>' +
      '<g fill="#000000">' + cells.join('') + '</g></svg>';
  }

  global.QR = { render };
})(window);
