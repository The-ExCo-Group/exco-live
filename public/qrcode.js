/* Minimal, dependency-free QR generator.
 * Byte mode, error-correction level L, versions 1-5 (single data block).
 * Enough to encode a LAN join URL (up to 108 bytes). Renders crisp SVG.
 * Uses fixed mask pattern 0; format bits are the standard L/mask-0 string.
 */
(function (global) {
  'use strict';

  // GF(256) tables, primitive polynomial 0x11d
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
  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  // version -> { size, dataCW, ecCW, align }
  const VERSIONS = {
    1: { dataCW: 19, ecCW: 7, align: null },
    2: { dataCW: 34, ecCW: 10, align: 18 },
    3: { dataCW: 55, ecCW: 15, align: 22 },
    4: { dataCW: 80, ecCW: 20, align: 26 },
    5: { dataCW: 108, ecCW: 26, align: 30 },
  };
  // Standard 15-bit format info for EC level L + mask 0
  const FORMAT_L_MASK0 = 0b111011111000100;

  function chooseVersion(len) {
    for (let v = 1; v <= 5; v++) if (VERSIONS[v].dataCW - 2 >= len) return v; // -2 for mode+count overhead margin
    throw new Error('QR: data too long for v1-5');
  }

  function rsGenerator(n) {
    let poly = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= gfMul(poly[j], 1);
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncodeCorrect(data, ecCount) {
    const gen = rsGenerator(ecCount); // length ecCount+1
    const buf = data.concat(new Array(ecCount).fill(0));
    for (let i = 0; i < data.length; i++) {
      const coef = buf[i];
      if (coef !== 0) {
        for (let j = 0; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], coef);
      }
    }
    return buf.slice(data.length);
  }

  function encodeData(text, version) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 128) bytes.push(c);
      else if (c < 2048) {
        bytes.push(192 | (c >> 6), 128 | (c & 63));
      } else {
        bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
      }
    }
    const info = VERSIONS[version];
    const bits = [];
    const push = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };
    push(0b0100, 4); // byte mode
    push(bytes.length, 8); // char count (versions 1-9)
    for (const b of bytes) push(b, 8);
    // terminator
    const cap = info.dataCW * 8;
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    // to bytes
    const dataCW = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      dataCW.push(v);
    }
    // pad
    const pads = [0xec, 0x11];
    let pi = 0;
    while (dataCW.length < info.dataCW) dataCW.push(pads[pi++ % 2]);
    return dataCW;
  }

  function buildMatrix(text) {
    const bytesLen = (() => {
      let n = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        n += c < 128 ? 1 : c < 2048 ? 2 : 3;
      }
      return n;
    })();
    const version = chooseVersion(bytesLen + 3);
    const info = VERSIONS[version];
    const size = 17 + version * 4;

    const data = encodeData(text, version);
    const ec = rsEncodeCorrect(data, info.ecCW);
    const all = data.concat(ec);

    const m = Array.from({ length: size }, () => new Array(size).fill(null));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));

    const setFn = (r, c, v) => {
      m[r][c] = v;
      fn[r][c] = true;
    };
    const placeFinder = (r, c) => {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const rr = r + dr,
            cc = c + dc;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          const inRing =
            dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
            (dr === 0 || dr === 6 || dc === 0 || dc === 6);
          const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          setFn(rr, cc, inRing || inCore ? 1 : 0);
        }
      }
    };
    placeFinder(0, 0);
    placeFinder(0, size - 7);
    placeFinder(size - 7, 0);

    // timing patterns
    for (let i = 8; i < size - 8; i++) {
      setFn(6, i, i % 2 === 0 ? 1 : 0);
      setFn(i, 6, i % 2 === 0 ? 1 : 0);
    }
    // dark module
    setFn(size - 8, 8, 1);

    // alignment pattern
    if (info.align != null) {
      const a = info.align;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isBorder = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFn(a + dr, a + dc, isBorder ? 1 : 0);
        }
      }
    }

    // reserve format info areas
    for (let i = 0; i < 9; i++) {
      if (!fn[8][i]) { m[8][i] = 0; fn[8][i] = true; }
      if (!fn[i][8]) { m[i][8] = 0; fn[i][8] = true; }
    }
    for (let i = 0; i < 8; i++) {
      if (!fn[8][size - 1 - i]) { m[8][size - 1 - i] = 0; fn[8][size - 1 - i] = true; }
      if (!fn[size - 1 - i][8]) { m[size - 1 - i][8] = 0; fn[size - 1 - i][8] = true; }
    }

    // place data with mask 0 ((r+c)%2==0)
    const bitAt = (idx) => (all[idx >> 3] >> (7 - (idx & 7))) & 1;
    let bit = 0;
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--; // skip timing column
      for (let i = 0; i < size; i++) {
        const row = upward ? size - 1 - i : i;
        for (let c = 0; c < 2; c++) {
          const cc = col - c;
          if (fn[row][cc]) continue;
          let v = bit < all.length * 8 ? bitAt(bit++) : 0;
          if ((row + cc) % 2 === 0) v ^= 1; // mask 0
          m[row][cc] = v;
        }
      }
      upward = !upward;
    }

    // format info (15 bits), EC=L mask=0
    const fmt = FORMAT_L_MASK0;
    const fbit = (i) => (fmt >> i) & 1;
    // around top-left
    for (let i = 0; i <= 5; i++) m[8][i] = fbit(i);
    m[8][7] = fbit(6);
    m[8][8] = fbit(7);
    m[7][8] = fbit(8);
    for (let i = 9; i <= 14; i++) m[14 - i][8] = fbit(i);
    // around top-right / bottom-left
    for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = fbit(i);
    for (let i = 8; i <= 14; i++) m[8][size - 15 + i] = fbit(i);
    m[size - 8][8] = 1; // dark module stays

    return { m, size };
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
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (m[r][c] === 1) {
          cells.push(
            '<rect x="' + (c + quiet) + '" y="' + (r + quiet) + '" width="1.02" height="1.02"/>'
          );
        }
      }
    }
    const px = opts.size || 176;
    container.innerHTML =
      '<svg width="' + px + '" height="' + px + '" viewBox="0 0 ' + total + ' ' + total +
      '" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="' + total + '" height="' + total + '" fill="#ffffff"/>' +
      '<g fill="#0e0f1a">' + cells.join('') + '</g></svg>';
  }

  global.QR = { render };
})(window);
