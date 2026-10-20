// SVG path builder; null samples leave a gap
export const line = (s, k, max, w = 640, h = 120) => s.map((p, i) => p[k] == null ? '' :
  `${i && s[i - 1][k] != null ? 'L' : 'M'}${(i / Math.max(1, s.length - 1) * w).toFixed(1)},${(h - 4 - Math.min(p[k], max) / max * (h - 8)).toFixed(1)}`).join('');
