import * as THREE from 'three';
import { mergeParts } from '../utils/geometry.js';
import { VEHICLE, STATIC_RIDE_HEIGHT } from '../config/settings.js';
import { createWheelRig } from './wheels.js';
import { clamp01, smoothstep } from '../utils/math.js';

/**
 * Prosedürel arazi jipi. Hazır bir `.glb` yerine geometriden kurulmasının iki
 * pratik sebebi var: indirilecek varlık yok ve ölçüler doğrudan fizik
 * ayarlarından (dingil mesafesi, iz genişliği, lastik yarıçapı) besleniyor —
 * tekerlekler her zaman süspansiyonun gerçekte olduğu yerde duruyor.
 *
 * Yerel eksenler araç fiziğiyle aynı: **ileri = -Z**, orijin ağırlık merkezi,
 * zemin y = -0.76.
 */

/**
 * Gövde geometrisi **zemine göre** yazılıyor: `MODEL_GROUND_Y` sabit kalıyor ve
 * gövde grubu, fiziğin statik sürüş yüksekliğine göre kaydırılıyor. Böylece
 * ağırlık merkezi (fizik için) serbestçe alçaltılıp yükseltilebiliyor ama
 * aracın görünen duruşu değişmiyor.
 */
const MODEL_GROUND_Y = -0.76;
const GROUND_Y = MODEL_GROUND_Y;
/** Gövdenin fizik orijinine göre düşey kayması. */
const BODY_LIFT = -STATIC_RIDE_HEIGHT - MODEL_GROUND_Y;

const BODY_WIDTH = 1.62;
const HALF_BODY = BODY_WIDTH / 2;
/**
 * Kaldırılmış arazi gövdesi. Tekerlek yuvası, süspansiyonun statik konumun
 * üstünde kalan 26 cm'lik sıkışma kursunu yutacak kadar yüksek — daha alçak
 * bir yuvada tekerlek tam sıkışmada çamurluğun içinden geçiyordu.
 */
const FLOOR_Y = -0.36;
const BELT_Y = 0.4;
const ARCH_R = 0.7;
/** Zemine göre yazılan üst gövde parçalarının ortak yükseltmesi. */
const UP = 0.16;

/**
 * @param lights Gerçek far ışıkları kurulsun mu. Uzak oyuncuların jipleri için
 *   kapatılıyor: her jip üç `SpotLight` demek ve ileri render'da ışık sayısı
 *   doğrudan parça gölgelendirici maliyetine yazılıyor — dört oyunculu bir
 *   odada sahnedeki ışık sayısı dörde katlanırdı. Uzaktaki jipin farı yine
 *   yanıyor görünüyor, sadece etrafını aydınlatmıyor.
 */
export function createJeep({ scene, weather, lights = true }) {
  const root = new THREE.Group();
  scene.add(root);

  const body = new THREE.Group();
  // Gövde zemine göre modellendi; fizik orijini (ağırlık merkezi) daha aşağıda
  // olduğu için aradaki fark burada telafi ediliyor.
  body.position.y = BODY_LIFT;
  root.add(body);

  const materials = createMaterials();
  const frontZ = -VEHICLE.wheelBase * VEHICLE.comBias;
  const rearZ = VEHICLE.wheelBase * (1 - VEHICLE.comBias);

  /**
   * Süspansiyon üst bağlantı noktaları — `sim/vehicle.js` içindeki `w.local`
   * ile aynı sayılar, aynı sırayla (FL, FR, RL, RR). Burada tekrar
   * hesaplanıyorlar çünkü uzak oyuncuların jipleri bir fizik gövdesine bağlı
   * değil: ağdan yalnız süspansiyon uzunlukları geliyor.
   */
  const anchorY = VEHICLE.suspension.restLength - VEHICLE.comHeight;
  const halfTrack = VEHICLE.trackWidth * 0.5;
  const wheelLocals = [
    new THREE.Vector3(-halfTrack, anchorY, frontZ),
    new THREE.Vector3(halfTrack, anchorY, frontZ),
    new THREE.Vector3(-halfTrack, anchorY, rearZ),
    new THREE.Vector3(halfTrack, anchorY, rearZ),
  ];

  // --- boya --------------------------------------------------------------
  const paintParts = [];

  // Yan paneller: klasik jip silueti tek bir profilden çıkarılıp iki yana
  // kopyalanıyor; aradaki boşluk açık kokpiti veriyor.
  const sideProfile = buildSideProfile(frontZ, rearZ);
  for (const side of [-1, 1]) {
    const panel = sideProfile.clone();
    panel.translate(side * (HALF_BODY - 0.05), 0, 0);
    paintParts.push(panel);
  }

  paintParts.push(box(BODY_WIDTH, 0.09, 3.2, 0, FLOOR_Y + 0.045, 0.05));
  // Arka gövde (bagaj bölmesi) ve motor kaputu.
  paintParts.push(box(BODY_WIDTH, 0.7, 1.04, 0, FLOOR_Y + 0.38, rearZ + 0.2));
  paintParts.push(box(BODY_WIDTH, 0.1, 1.08, 0, 0.06 + UP, frontZ - 0.24));
  // Ön göğüs ve torpido kaidesi.
  paintParts.push(box(BODY_WIDTH, 0.2, 0.14, 0, 0.17 + UP, -0.82));
  // Izgara paneli.
  paintParts.push(box(BODY_WIDTH - 0.06, 0.46, 0.09, 0, -0.05 + UP, -2.0));

  const paintGeometry = mergeParts(paintParts);
  applyDust(paintGeometry, 0.55);
  const paintMesh = new THREE.Mesh(paintGeometry, materials.paint);
  paintMesh.castShadow = true;
  paintMesh.receiveShadow = true;
  body.add(paintMesh);

  // --- koyu metal: tamponlar, çamurluk genişleticileri, kafes, basamaklar --
  const darkParts = [];

  darkParts.push(box(1.98, 0.17, 0.22, 0, -0.2, -2.1));
  darkParts.push(box(1.98, 0.17, 0.2, 0, -0.2, rearZ + 0.82));
  // Vinç.
  darkParts.push(cylinder(0.075, 0.36, 0, -0.2, -2.16, 'x'));

  const flareX = VEHICLE.trackWidth * 0.5 - 0.02;
  for (const side of [-1, 1]) {
    darkParts.push(box(0.11, 0.11, 1.9, side * 0.94, -0.42, 0.12));
    darkParts.push(flare(side * flareX, FLOOR_Y, frontZ));
    darkParts.push(flare(side * flareX, FLOOR_Y, rearZ));
  }

  // Rollbar: ana kemer, ön uzantılar ve arka payandalar.
  const cageR = 0.038;
  const hoopY = 0.82 + UP;
  for (const side of [-1, 1]) {
    const x = side * (HALF_BODY - 0.06);
    const hoopBase = new THREE.Vector3(x, BELT_Y - 0.04, 0.72);
    const hoopTop = new THREE.Vector3(x, hoopY, 0.58);
    const header = new THREE.Vector3(x, hoopY, -0.7);
    const cowl = new THREE.Vector3(x, 0.28 + UP, -0.86);
    const stay = new THREE.Vector3(x, 0.3 + UP, rearZ + 0.42);

    darkParts.push(tube(hoopBase, hoopTop, cageR));
    darkParts.push(tube(hoopTop, header, cageR));
    darkParts.push(tube(header, cowl, cageR));
    darkParts.push(tube(hoopTop, stay, cageR * 0.85));
  }
  darkParts.push(
    tube(
      new THREE.Vector3(-(HALF_BODY - 0.06), hoopY, 0.58),
      new THREE.Vector3(HALF_BODY - 0.06, hoopY, 0.58),
      cageR
    )
  );
  darkParts.push(
    tube(
      new THREE.Vector3(-(HALF_BODY - 0.06), hoopY, -0.7),
      new THREE.Vector3(HALF_BODY - 0.06, hoopY, -0.7),
      cageR
    )
  );

  // Şnorkel: kaputun sağ kenarından A direği boyunca yukarı.
  darkParts.push(
    tube(
      new THREE.Vector3(HALF_BODY - 0.02, 0.02 + UP, frontZ - 0.32),
      new THREE.Vector3(HALF_BODY - 0.02, 0.66 + UP, -0.98),
      0.045
    )
  );
  darkParts.push(cylinder(0.062, 0.16, HALF_BODY - 0.02, 0.72 + UP, -0.98, 'z'));

  // Tavan ışıldağı gövdesi ve egzoz.
  darkParts.push(box(1.02, 0.09, 0.09, 0, 0.89 + UP, -0.7));
  darkParts.push(cylinder(0.035, 0.3, -0.5, -0.36, rearZ + 0.75, 'z'));

  const darkGeometry = mergeParts(darkParts);
  applyDust(darkGeometry, 0.75);
  const darkMesh = new THREE.Mesh(darkGeometry, materials.dark);
  darkMesh.castShadow = true;
  darkMesh.receiveShadow = true;
  body.add(darkMesh);

  // --- ızgara dilimleri ve iç mekân ---------------------------------------
  const interiorParts = [];
  // Jeep'in yedi dilimli ızgarası.
  for (let i = 0; i < 7; i++) {
    const x = (i - 3) * 0.185;
    interiorParts.push(box(0.12, 0.34, 0.05, x, -0.05 + UP, -2.03));
  }
  for (const side of [-1, 1]) {
    // Koltuklar.
    interiorParts.push(box(0.48, 0.11, 0.5, side * 0.36, -0.2 + UP, 0.2));
    const back = box(0.48, 0.56, 0.11, side * 0.36, 0.11 + UP, 0.47);
    back.rotateX(-0.18);
    interiorParts.push(back);
    interiorParts.push(box(0.24, 0.16, 0.12, side * 0.36, 0.42 + UP, 0.53));
  }
  // Torpido ve vites kolu.
  interiorParts.push(box(BODY_WIDTH - 0.14, 0.16, 0.2, 0, 0.2 + UP, -0.72));
  interiorParts.push(cylinder(0.022, 0.22, 0, 0.0 + UP, -0.18, 'y'));

  const interiorGeometry = mergeParts(interiorParts);
  const interiorMesh = new THREE.Mesh(interiorGeometry, materials.interior);
  interiorMesh.castShadow = true;
  body.add(interiorMesh);

  // --- direksiyon ----------------------------------------------------------
  const steeringWheel = new THREE.Group();
  const rimGeo = new THREE.TorusGeometry(0.16, 0.02, 8, 22);
  const spokeGeo = mergeParts(
    [0, 2.09, 4.19].map((a) => {
      const g = new THREE.BoxGeometry(0.15, 0.018, 0.03);
      g.translate(0.075, 0, 0);
      g.rotateZ(a);
      return g;
    })
  );
  const wheelDisc = new THREE.Mesh(mergeParts([rimGeo, spokeGeo]), materials.interior);
  steeringWheel.add(wheelDisc);
  steeringWheel.position.set(-0.36, 0.2 + UP, -0.6);
  steeringWheel.rotation.x = -1.15;
  body.add(steeringWheel);

  // --- cam -----------------------------------------------------------------
  const glass = new THREE.Mesh(new THREE.BoxGeometry(1.44, 0.55, 0.015), materials.glass);
  glass.position.set(0, 0.55 + UP, -0.79);
  glass.rotation.x = 0.263;
  body.add(glass);

  // --- lambalar ------------------------------------------------------------
  const lampParts = [];
  for (const side of [-1, 1]) {
    lampParts.push(cylinder(0.105, 0.05, side * 0.5, -0.03 + UP, -2.04, 'z'));
    lampParts.push(cylinder(0.045, 0.045, side * 0.71, -0.03 + UP, -2.03, 'z'));
  }
  for (let i = 0; i < 4; i++) {
    lampParts.push(cylinder(0.05, 0.05, (i - 1.5) * 0.24, 0.89 + UP, -0.75, 'z'));
  }
  const headlampGeometry = mergeParts(lampParts);
  const headlamps = new THREE.Mesh(headlampGeometry, materials.lamp);
  body.add(headlamps);

  const tailParts = [];
  for (const side of [-1, 1]) {
    tailParts.push(box(0.13, 0.22, 0.05, side * 0.6, 0.06 + UP, rearZ + 0.73));
  }
  const tailLights = new THREE.Mesh(mergeParts(tailParts), materials.tail);
  body.add(tailLights);

  // --- yedek lastik --------------------------------------------------------
  const wheelRig = createWheelRig(root, 4);
  const spare = new THREE.Group();
  const spareTire = new THREE.Mesh(wheelRig.geometries.tire, wheelRig.materials.tire);
  const spareRim = new THREE.Mesh(wheelRig.geometries.rim, wheelRig.materials.rim);
  spare.add(spareTire, spareRim);
  spare.rotation.y = Math.PI / 2;
  spare.scale.setScalar(0.94);
  spare.position.set(0.06, 0.08 + UP, rearZ + 0.95);
  spareTire.castShadow = true;
  body.add(spare);

  // --- farlar (gerçek ışık kaynakları) -------------------------------------
  const headlights = [];
  let roofLight = null;

  if (lights) {
    for (const side of [-1, 1]) {
      // Sönümleme kasten fizikselin (2) altında: gerçek ters-kare yasasıyla
      // huzme kaputun önünde bembeyaz patlayıp on metre ötede kayboluyor.
      const spot = new THREE.SpotLight(0xfff0d0, 0, 110, 0.46, 0.62, 1.15);
      spot.position.set(side * 0.5, -0.03 + UP, -2.06);
      spot.target.position.set(side * 0.5, -0.45, -22);
      spot.castShadow = false;
      body.add(spot);
      body.add(spot.target);
      headlights.push(spot);
    }

    // Işıldak: gece için uzun menzilli tek huzme.
    roofLight = new THREE.SpotLight(0xffffff, 0, 190, 0.3, 0.5, 1.05);
    roofLight.position.set(0, 0.92 + UP, -0.78);
    roofLight.target.position.set(0, -0.2, -40);
    body.add(roofLight);
    body.add(roofLight.target);
  }

  let lastHeadlightState = null;

  /**
   * Fizik durumunu modele işler. Süspansiyon sıkışması tekerlekleri düşey
   * hareket ettirir; gövde zaten fizik gövdesinin quaternion'unu takip ettiği
   * için yalpa ve dalış ayrıca hesaplanmaz.
   */
  function setWheel(index, suspLength, steerAngle, spinAngle) {
    const rig = wheelRig.rigs[index];
    const local = wheelLocals[index];
    rig.steerGroup.position.set(local.x, local.y - suspLength, local.z);
    rig.steerGroup.rotation.y = steerAngle;
    rig.spinGroup.rotation.x = spinAngle;
  }

  function setHeadlights(on) {
    if (on === lastHeadlightState) return;
    lastHeadlightState = on;
    for (const spot of headlights) spot.intensity = on ? 26 : 0;
    if (roofLight) roofLight.intensity = on ? 34 : 0;
    materials.lamp.emissiveIntensity = on ? 2.6 : 0.15;
  }

  function sync(vehicle, input) {
    root.position.copy(vehicle.state.position);
    root.quaternion.copy(vehicle.state.quaternion);

    for (let i = 0; i < 4; i++) {
      const w = vehicle.wheels[i];
      setWheel(i, w.suspLength, w.steerAngle, w.spinAngle);
    }

    steeringWheel.rotation.z = -vehicle.state.steerInput * 3.4;
    setHeadlights(weather.state.headlights);

    // Fren lambaları frene basıldıkça parlar.
    const braking = Math.max(input?.brake ?? 0, input?.handbrake ?? 0);
    materials.tail.emissiveIntensity = 0.25 + braking * 2.6;
  }

  return {
    root,
    body,
    materials,
    wheelRig,
    headlights,
    roofLight,
    sync,
    setWheel,
    setHeadlights,
    setSteering(value) {
      steeringWheel.rotation.z = -value * 3.4;
    },
    setBraking(value) {
      materials.tail.emissiveIntensity = 0.25 + value * 2.6;
    },
    setBodyColor(hex) {
      materials.paint.color.setHex(hex);
    },
    dispose() {
      scene.remove(root);
    },
  };
}

// ---------------------------------------------------------------------------
// geometri yardımcıları
// ---------------------------------------------------------------------------

function box(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function cylinder(radius, length, x, y, z, axis) {
  const g = new THREE.CylinderGeometry(radius, radius, length, 18);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/** İki nokta arasına silindir gerer — kafes boruları için. */
function tube(from, to, radius, segments = 10) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const length = dir.length();
  const g = new THREE.CylinderGeometry(radius, radius, length, segments);
  g.translate(0, length / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.normalize()
  );
  g.applyQuaternion(q);
  g.translate(from.x, from.y, from.z);
  return g;
}

/** Tekerlek üstüne oturan çamurluk genişleticisi. */
function flare(x, y, z) {
  const g = new THREE.TorusGeometry(ARCH_R + 0.03, 0.058, 8, 22, Math.PI);
  g.rotateY(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/**
 * Jipin yan silueti. Tek bir kapalı profil: altta iki tekerlek yuvası oyulmuş,
 * üstte kaput → göğüs → bel hattı → bagaj kapağı çizgisi.
 */
function buildSideProfile(frontZ, rearZ) {
  // Profil XY düzleminde çiziliyor; +X ileri yön. En sonda Y ekseninde
  // çeyrek tur döndürülünce +X, aracın -Z'sine (ileri) oturuyor.
  const frontX = -frontZ;
  const rearX = -rearZ;

  const shape = new THREE.Shape();
  shape.moveTo(-2.02, FLOOR_Y);
  shape.lineTo(rearX - ARCH_R, FLOOR_Y);
  shape.absarc(rearX, FLOOR_Y, ARCH_R, Math.PI, 0, true);
  shape.lineTo(frontX - ARCH_R, FLOOR_Y);
  shape.absarc(frontX, FLOOR_Y, ARCH_R, Math.PI, 0, true);
  shape.lineTo(2.0, FLOOR_Y);
  shape.lineTo(2.06, -0.18 + UP);
  shape.lineTo(2.06, 0.02 + UP);
  shape.lineTo(1.92, 0.1 + UP);
  shape.lineTo(0.88, 0.13 + UP);
  shape.lineTo(0.82, BELT_Y);
  shape.lineTo(-1.0, BELT_Y + 0.02);
  shape.lineTo(-1.92, BELT_Y);
  shape.lineTo(-2.02, 0.08 + UP);
  shape.lineTo(-2.02, FLOOR_Y);
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.1,
    bevelEnabled: true,
    bevelThickness: 0.022,
    bevelSize: 0.022,
    bevelSegments: 2,
    curveSegments: 12,
  });

  geometry.rotateY(Math.PI / 2);
  geometry.translate(-0.05, 0, 0);
  return geometry;
}

/**
 * Alt gövdeye toz bindirir. Ayrı bir shader yerine vertex renkleri
 * kullanılıyor: `vertexColors` zaten diffuse'u çarpıyor, ekstra program yok.
 */
function applyDust(geometry, strength) {
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const dustColor = new THREE.Color(0xc7a274);
  const clean = new THREE.Color(0xffffff);
  const mixed = new THREE.Color();

  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    // Zemine yakın yüzeyler tozlu, üst yüzeyler temiz.
    const dust = clamp01(1 - smoothstep(GROUND_Y + 0.1, GROUND_Y + 0.95, y)) * strength;
    mixed.copy(clean).lerp(dustColor, dust);
    colors[i * 3] = mixed.r;
    colors[i * 3 + 1] = mixed.g;
    colors[i * 3 + 2] = mixed.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function createMaterials() {
  return {
    paint: new THREE.MeshStandardMaterial({
      color: 0x2f5158,
      roughness: 0.52,
      metalness: 0.22,
      vertexColors: true,
    }),
    dark: new THREE.MeshStandardMaterial({
      color: 0x24262a,
      roughness: 0.62,
      metalness: 0.55,
      vertexColors: true,
    }),
    interior: new THREE.MeshStandardMaterial({
      color: 0x1a1b1d,
      roughness: 0.85,
      metalness: 0.1,
    }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x9fc4cc,
      roughness: 0.06,
      metalness: 0.1,
      transparent: true,
      opacity: 0.24,
    }),
    lamp: new THREE.MeshStandardMaterial({
      color: 0xfff4dc,
      emissive: 0xffe6b8,
      emissiveIntensity: 0.15,
      roughness: 0.18,
      metalness: 0.1,
    }),
    tail: new THREE.MeshStandardMaterial({
      color: 0x7a1414,
      emissive: 0xff2a12,
      emissiveIntensity: 0.25,
      roughness: 0.3,
    }),
  };
}
