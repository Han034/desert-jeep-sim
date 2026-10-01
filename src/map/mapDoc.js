import { applyStroke } from './terrainBrush.js';

/**
 * Harita belgesi — projenin **veri** yüzü.
 *
 * Bir harita, prosedürel arazinin üstüne uygulanan bir fırça darbesi listesi ve
 * açıkça yerleştirilmiş nesnelerden ibaret. Bilinçli olarak düz JSON: ikili
 * paketleme yok, base64 yok. Sebebi üç tane:
 *
 *  1. **Firebase.** Realtime Database bir JSON ağacı; belge olduğu gibi
 *     yazılabiliyor, alan alan güncellenebiliyor.
 *  2. **Artımlı senkron.** Tek bir fırça darbesi tek bir küçük nesne; çok
 *     oyunculu oturumda haritayı yeniden göndermek yerine darbeyi yollamak
 *     yetiyor (`net/protocol.js`).
 *  3. **Geri alma bedava.** Listenin sonunu atıp baştan oynatmak yeterli.
 *
 * Yükseklik ızgarasının kendisi saklanmıyor: 2048² float, 16 MB eder. Darbe
 * listesi tipik bir haritada birkaç yüz kilobayt.
 */

export const MAP_VERSION = 1;
const STORAGE_PREFIX = 'desert.map.';

export function createEmptyDoc(name = 'Adsız harita') {
  return {
    v: MAP_VERSION,
    name,
    /** Arazi ve bölge fırçası darbeleri, uygulanma sırasında. */
    strokes: [],
    /** Nesneler: [tür, x, z, ölçek, dönüş, en-boy oynaması, salınım]. */
    props: [],
    /** Aracın doğacağı nokta; null ise en düz yer aranır. */
    spawn: null,
    /** Haritanın kendi varsayılan havası. */
    weather: null,
    updatedAt: Date.now(),
  };
}

/**
 * Belgeyi sahneye uygular: araziyi prosedürel haline döndürür, darbeleri
 * yeniden oynatır, nesneleri yükler.
 *
 * `onlyStrokesFrom` verilirse arazi sıfırlanmaz ve yalnız o indeksten sonraki
 * darbeler uygulanır — sürüklerken ve ağdan gelen tek darbede kullanılıyor.
 */
export function applyDoc(doc, { heightfield, props, renderer, onlyStrokesFrom = null }) {
  if (onlyStrokesFrom === null) {
    heightfield.restoreBase();
    for (const stroke of doc.strokes) applyStroke(heightfield, stroke);
    if (props) props.fromJSON(doc.props);
  } else {
    for (let i = onlyStrokesFrom; i < doc.strokes.length; i++) {
      applyStroke(heightfield, doc.strokes[i]);
    }
  }
  if (renderer) heightfield.flushTexture(renderer);
}

/** Belgeyi metne çevirir. Darbeler tek satırda: dosya gözle okunabilir kalsın. */
export function serialize(doc) {
  return JSON.stringify(
    { ...doc, v: MAP_VERSION, updatedAt: Date.now() },
    (key, value) => (typeof value === 'number' ? round(value) : value),
    1
  );
}

export function deserialize(text) {
  const doc = JSON.parse(text);
  if (!doc || typeof doc !== 'object') throw new Error('Harita dosyası okunamadı.');
  if (doc.v > MAP_VERSION) {
    throw new Error(`Harita sürümü ${doc.v}, bu yapı en fazla ${MAP_VERSION} okuyor.`);
  }
  return {
    ...createEmptyDoc(doc.name || 'Adsız harita'),
    ...doc,
    strokes: Array.isArray(doc.strokes) ? doc.strokes : [],
    props: Array.isArray(doc.props) ? doc.props : [],
  };
}

// --- tarayıcı deposu -------------------------------------------------------

export function listLocal() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key.startsWith(STORAGE_PREFIX)) continue;
    try {
      const doc = JSON.parse(localStorage.getItem(key));
      out.push({ slot: key.slice(STORAGE_PREFIX.length), name: doc.name, updatedAt: doc.updatedAt });
    } catch {
      // Bozuk kayıt listeyi boşaltmasın.
    }
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function saveLocal(doc, slot = slugify(doc.name)) {
  localStorage.setItem(STORAGE_PREFIX + slot, serialize(doc));
  return slot;
}

export function loadLocal(slot) {
  const text = localStorage.getItem(STORAGE_PREFIX + slot);
  if (!text) return null;
  return deserialize(text);
}

export function deleteLocal(slot) {
  localStorage.removeItem(STORAGE_PREFIX + slot);
}

// --- dosya -----------------------------------------------------------------

export function downloadDoc(doc) {
  const blob = new Blob([serialize(doc)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${slugify(doc.name)}.harita.json`;
  link.click();
  // Tarayıcının indirmeyi başlatması için bir tur bekle.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickDocFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      file
        .text()
        .then((text) => resolve(deserialize(text)))
        .catch(reject);
    });
    input.click();
  });
}

function slugify(name) {
  return (
    name
      .toLocaleLowerCase('tr')
      .replace(/[ğ]/g, 'g')
      .replace(/[ü]/g, 'u')
      .replace(/[ş]/g, 's')
      .replace(/[ı]/g, 'i')
      .replace(/[ö]/g, 'o')
      .replace(/[ç]/g, 'c')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'harita'
  );
}

/** Dosyayı şişirmemek için: santimetre altı hassasiyetin kimseye faydası yok. */
function round(v) {
  return Math.round(v * 1000) / 1000;
}
