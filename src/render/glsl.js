/**
 * Arazi shader'larının paylaştığı GLSL parçaları.
 *
 * Tasarımın anahtarı şu: sahnedeki her yükseklik katmanı (kum tepeleri, lastik
 * oyukları, kum dalgacıkları) bir yükseklik alanı olduğu için **gradyanları
 * doğrudan toplanabilir**. Her katman için ayrı normal hesaplayıp harmanlamak
 * yerine gradyanları toplayıp sonunda tek bir normal kuruyoruz — hem daha ucuz
 * hem matematiksel olarak doğru.
 */

export const HEIGHT_SAMPLER_GLSL = /* glsl */ `
uniform sampler2D uHeightMap;
uniform float uHeightExtent;
uniform float uHeightRes;

float hfTexel(vec2 ij) {
  vec2 c = clamp(ij, vec2(0.0), vec2(uHeightRes - 1.0));
  return texture2D(uHeightMap, (c + 0.5) / uHeightRes).r;
}

float crValue(float p0, float p1, float p2, float p3, float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return 0.5 * (2.0 * p1
    + (-p0 + p2) * t
    + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
    + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3);
}

float crDeriv(float p0, float p1, float p2, float p3, float t) {
  return 0.5 * ((-p0 + p2)
    + 2.0 * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t
    + 3.0 * (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t * t);
}

/**
 * Catmull-Rom bikübik yükseklik + analitik gradyan. Gradyan, yüksekliği veren
 * 16 texel okumasının aynısından türetiliyor: normal bedavaya geliyor ve
 * yüzeyle birebir tutarlı oluyor.
 */
float sampleTerrain(vec2 world, out vec2 grad) {
  float texel = uHeightExtent / uHeightRes;
  vec2 g = (world + uHeightExtent * 0.5) / texel - 0.5;
  vec2 i0 = floor(g);
  vec2 t = g - i0;

  float rows[4];
  float dRows[4];

  for (int r = 0; r < 4; r++) {
    float j = i0.y + float(r) - 1.0;
    float p0 = hfTexel(vec2(i0.x - 1.0, j));
    float p1 = hfTexel(vec2(i0.x,       j));
    float p2 = hfTexel(vec2(i0.x + 1.0, j));
    float p3 = hfTexel(vec2(i0.x + 2.0, j));
    rows[r]  = crValue(p0, p1, p2, p3, t.x);
    dRows[r] = crDeriv(p0, p1, p2, p3, t.x);
  }

  float h  = crValue(rows[0], rows[1], rows[2], rows[3], t.y);
  float dx = crValue(dRows[0], dRows[1], dRows[2], dRows[3], t.y) / texel;
  float dz = crDeriv(rows[0], rows[1], rows[2], rows[3], t.y) / texel;

  grad = vec2(dx, dz);
  return h;
}

float sampleTerrainHeight(vec2 world) {
  vec2 ignored;
  return sampleTerrain(world, ignored);
}
`;

/**
 * Ufuk haritasından güneş gölgesi ve ortam örtme.
 *
 * Açılışta pişirilen ufuk profili sayesinde gölge, menzil sınırı olmadan iki
 * doku okumasıyla çıkıyor: güneşin yükseklik tanjantı o yöndeki ufuk
 * tanjantının altındaysa nokta gölgede. `uHeightExtent` yükseklik
 * örnekleyicisinden geliyor, bu yüzden bu parça ondan sonra eklenmeli.
 */
export const TERRAIN_SHADOW_GLSL = /* glsl */ `
uniform sampler2D uHorizonA;
uniform sampler2D uHorizonB;
uniform sampler2D uTerrainAO;
uniform vec4 uSunSel0A;
uniform vec4 uSunSel0B;
uniform vec4 uSunSel1A;
uniform vec4 uSunSel1B;
uniform float uSunSlotBlend;
uniform float uSunTangent;
uniform float uSunShadowStrength;
uniform float uTerrainAOStrength;

float terrainSunShadow(vec2 world) {
  if (uSunShadowStrength <= 0.001) return 1.0;
  vec2 uv = world / uHeightExtent + 0.5;
  vec4 a = texture2D(uHorizonA, uv);
  vec4 b = texture2D(uHorizonB, uv);

  // Değişken indeksle dizi okuma yerine maske ile seçim (GLSL ES 1.00 kısıtı).
  float h0 = dot(a, uSunSel0A) + dot(b, uSunSel0B);
  float h1 = dot(a, uSunSel1A) + dot(b, uSunSel1B);
  float horizon = mix(h0, h1, uSunSlotBlend) * 2.0;

  /**
   * Yarı gölge. Bant genişliği güneşin tanjantıyla orantılı: sabit bir bant,
   * alçak güneşte (tanjant küçükken) açısal olarak devasa olup gölge kenarını
   * bulanık bir lekeye çeviriyor, tepedeyken ise hiç görünmüyordu. Orantılı
   * tutunca yumuşaklık günün her saatinde aynı açısal genişlikte kalıyor.
   */
  float band = max(0.014, uSunTangent * 0.07);
  float lit = smoothstep(horizon - band, horizon + band, uSunTangent);
  return mix(1.0, lit, uSunShadowStrength);
}

float terrainOcclusion(vec2 world) {
  vec2 uv = world / uHeightExtent + 0.5;
  float ao = texture2D(uTerrainAO, uv).r;
  return mix(1.0, ao, uTerrainAOStrength);
}
`;

/**
 * Bölge ağırlıkları ve patika maskesi. Ağırlıklar RGBA kanallarında
 * (R=çöl, G=orman, B=kar, A=çayır) ve toplamları 1.
 */
export const BIOME_SAMPLER_GLSL = /* glsl */ `
uniform sampler2D uBiomeMap;
uniform sampler2D uPathMap;
uniform float uPathExtent;

vec4 sampleBiome(vec2 world) {
  vec2 uv = world / uHeightExtent + 0.5;
  vec4 w = texture2D(uBiomeMap, clamp(uv, 0.0, 1.0));
  // 8 bit yuvarlaması toplamı tam 1 yapmaz; normalize edilmezse renkler
  // bölge sınırlarında hafifçe koyulaşıyor.
  float sum = w.r + w.g + w.b + w.a;
  return w / max(sum, 1e-4);
}

float samplePath(vec2 world) {
  vec2 uv = world / uPathExtent + 0.5;
  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture2D(uPathMap, uv).r * inside.x * inside.y;
}

/** Dört bölge değerinin ağırlıklı karışımı. */
float blendBiome(float a, float b, float c, float d, vec4 w) {
  return a * w.r + b * w.g + c * w.b + d * w.a;
}

vec3 blendBiomeColor(vec3 a, vec3 b, vec3 c, vec3 d, vec4 w) {
  return a * w.r + b * w.g + c * w.b + d * w.a;
}
`;

export const TRACK_SAMPLER_GLSL = /* glsl */ `
uniform sampler2D uTrackMap;
uniform float uTrackExtent;
uniform float uRutDepth;
uniform float uBermHeight;
uniform float uTreadStrength;

/** İz haritası kanalları: R oyuk, G berm, B sıkışma, A tazelik. */
vec4 sampleTrack(vec2 world) {
  vec2 uv = world / uTrackExtent + 0.5;
  // Oynanabilir alanın dışında iz yok; kenarda tekrar etmesin diye maskeleniyor.
  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture2D(uTrackMap, uv) * inside.x * inside.y;
}

/**
 * İzin yüzeye kattığı yükseklik farkı: ortada çukur, kenarlarda yığın.
 *
 * Berm, oyuğun taşırdığı kumdur — oyuğun kendisini dolduracak kadar
 * büyüyemez. Bu bağ olmadan iki kanal da tekrarlanan geçişlerde 1'e doyuyor,
 * yığın çukuru birebir götürüyor ve net yükseklik farkı sıfıra iniyordu:
 * iz haritası doluyken bile kum dümdüz görünüyordu.
 */
float trackHeight(vec4 trk) {
  float rut = trk.r;
  float berm = trk.g * (1.0 - rut * 0.8);
  return berm * uBermHeight - rut * uRutDepth;
}

float trackHeightAt(vec2 world) {
  return trackHeight(sampleTrack(world));
}
`;

/**
 * İz gradyanı ve lastik diş deseni — sadece fragment shader'da kullanılır.
 * Orta ve uzak kabuk izleri geometri olarak çözemez; bu fonksiyon sayesinde
 * izler oralarda da gölgelenmede tam çözünürlükte görünür.
 */
export const TRACK_DETAIL_GLSL = /* glsl */ `
vec2 trackGradient(vec2 world, float eps) {
  float hl = trackHeightAt(world - vec2(eps, 0.0));
  float hr = trackHeightAt(world + vec2(eps, 0.0));
  float hd = trackHeightAt(world - vec2(0.0, eps));
  float hu = trackHeightAt(world + vec2(0.0, eps));
  return vec2(hr - hl, hu - hd) / (2.0 * eps);
}

/**
 * Lastik dişleri. İz haritası çözünürlüğü (12 cm/texel) diş aralığını (10 cm)
 * saklayamaz, bu yüzden desen prosedürel olarak fragment'ta üretilir. Yönü,
 * oyuğun gradyanından geliyor: oyuk uzun ve ince olduğu için gradyan her zaman
 * ize dik bakar, dolayısıyla ona dik eksen de aracın gittiği yöndür.
 */
vec2 treadGradient(vec2 world, vec2 rutGrad, float rut) {
  float gl = length(rutGrad);
  if (gl < 1e-4 || rut < 0.02) return vec2(0.0);
  vec2 across = rutGrad / gl;
  vec2 along = vec2(-across.y, across.x);

  float s = dot(world, along);
  float lug = sin(s * 54.0) * 0.5 + sin(s * 27.0 + 1.7) * 0.5;
  // Dişler oyuğun tabanında belirgin, kenarlara doğru siliniyor.
  float mask = uTreadStrength * rut * rut;
  float d = cos(s * 54.0) * 54.0 * 0.5 + cos(s * 27.0 + 1.7) * 27.0 * 0.5;
  return along * d * mask * 0.0016 + across * lug * mask * 0.0004;
}
`;

export const NOISE_GLSL = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

float fbm2(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * valueNoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}
`;

/**
 * Kum dalgacıkları. Faz bükümü tek bir fbm okumasıyla hesaplanıp sabit kabul
 * ediliyor; böylece dalga fonksiyonu saf sinüs kalıyor ve gradyanı sonlu fark
 * yerine analitik olarak çıkıyor (üç kat daha ucuz).
 */
export const RIPPLE_GLSL = /* glsl */ `
uniform vec2 uWindDir;
uniform float uRippleStrength;

vec2 rippleGradient(vec2 world, float fade) {
  if (fade <= 0.0005) return vec2(0.0);

  float warp = fbm2(world * 0.055) * 2.6;
  float warpFine = fbm2(world * 0.21 + 31.7) * 1.4;

  float k1 = 1.15;
  float k2 = 4.6;
  float p1 = dot(world, uWindDir) * k1 + warp;
  float p2 = dot(world, uWindDir) * k2 + warpFine;

  // Dalgacıklar rüzgâra dik uzanır; genlik rüzgâr yönünde değişir.
  float a1 = 0.030;
  float a2 = 0.011;
  float d = cos(p1) * a1 * k1 + cos(p2) * a2 * k2;

  // Rüzgâra dik yönde hafif düzensizlik, çizgilerin tekdüze olmasını engeller.
  vec2 perp = vec2(-uWindDir.y, uWindDir.x);
  float side = fbm2(world * 0.4 + 7.3) * 0.02;

  return (uWindDir * d + perp * side) * uRippleStrength * fade;
}
`;
