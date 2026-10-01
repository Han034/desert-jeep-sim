export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

export const clamp01 = (v) => clamp(v, 0, 1);

export const lerp = (a, b, t) => a + (b - a) * t;

export const inverseLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));

export const remap = (v, inMin, inMax, outMin, outMax) =>
  lerp(outMin, outMax, clamp01(inverseLerp(inMin, inMax, v)));

export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Kare hızından bağımsız üstel yumuşatma. `lerp(a, b, 0.1)` gibi bir ifadenin
 * aksine, 30 fps ile 144 fps arasında aynı hızda yakınsar.
 */
export function damp(current, target, lambda, dt) {
  return lerp(target, current, Math.exp(-lambda * dt));
}

export function moveTowards(current, target, maxDelta) {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** Açıyı [-PI, PI] aralığına indirger. */
export function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Deterministik sahne üretimi için hızlı, tohumlanabilir PRNG. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Catmull-Rom ağırlıkları. Yükseklik alanı hem CPU'da hem GPU'da bununla
 * örneklenir; bilineer örneklemenin bıraktığı 1 m'lik ızgara kırıklarını
 * ortadan kaldırır (C1 sürekli yüzey).
 */
export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}
