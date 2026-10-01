import * as THREE from 'three';
import { mergeParts } from '../utils/geometry.js';
import { VEHICLE } from '../config/settings.js';

/**
 * 33" arazi lastiği ve jantı — prosedürel.
 *
 * Diş blokları dokuyla değil gerçek geometriyle yapılıyor: silüette görünüyor,
 * gölge düşürüyor ve tekerlek dönerken kenar profili canlanıyor. Dört tekerlek
 * aynı geometriyi paylaştığı için maliyet tek seferlik.
 */

const LUGS_PER_ROW = 15;

export function createWheelGeometries() {
  const radius = VEHICLE.wheelRadius;
  const halfWidth = VEHICLE.wheelWidth * 0.5;

  // --- lastik gövdesi ------------------------------------------------------
  // Yanak profili: boncuktan omuza doğru şişip sırtta düzleşen bir kesit.
  const profile = [
    new THREE.Vector2(radius * 0.62, -halfWidth * 0.92),
    new THREE.Vector2(radius * 0.74, -halfWidth * 1.0),
    new THREE.Vector2(radius * 0.9, -halfWidth * 0.96),
    new THREE.Vector2(radius * 0.975, -halfWidth * 0.78),
    new THREE.Vector2(radius, -halfWidth * 0.55),
    new THREE.Vector2(radius, halfWidth * 0.55),
    new THREE.Vector2(radius * 0.975, halfWidth * 0.78),
    new THREE.Vector2(radius * 0.9, halfWidth * 0.96),
    new THREE.Vector2(radius * 0.74, halfWidth * 1.0),
    new THREE.Vector2(radius * 0.62, halfWidth * 0.92),
  ];

  const carcass = new THREE.LatheGeometry(profile, 34);
  const parts = [carcass];

  // --- diş blokları --------------------------------------------------------
  // Lathe ekseni Y olduğu için bloklar da XZ düzleminde çember üzerine
  // yerleşiyor; eksenel kayma Y'de. İki sıra yarım adım kaydırılmış:
  // çamur lastiklerinin karakteristik zikzak deseni.
  for (let row = 0; row < 2; row++) {
    const axial = (row === 0 ? -1 : 1) * halfWidth * 0.4;
    const phase = row * (Math.PI / LUGS_PER_ROW);
    for (let i = 0; i < LUGS_PER_ROW; i++) {
      const angle = (i / LUGS_PER_ROW) * Math.PI * 2 + phase;
      // x = radyal kalınlık, y = eksenel genişlik, z = çevresel uzunluk
      const lug = new THREE.BoxGeometry(0.04, halfWidth * 0.66, 0.09);
      lug.translate(radius - 0.006, axial, 0);
      lug.rotateY(angle);
      parts.push(lug);
    }
  }

  // Omuz blokları: yanaktan taşan, kumu ısıran dişler.
  for (let i = 0; i < LUGS_PER_ROW; i++) {
    const angle = (i / LUGS_PER_ROW) * Math.PI * 2 + Math.PI / LUGS_PER_ROW / 2;
    for (const side of [-1, 1]) {
      const lug = new THREE.BoxGeometry(0.05, 0.055, 0.065);
      lug.translate(radius * 0.955, side * halfWidth * 0.93, 0);
      lug.rotateY(angle);
      parts.push(lug);
    }
  }

  const tire = mergeParts(parts);
  // Lathe ekseni Y'den tekerlek eksenine (X) çevriliyor.
  tire.rotateZ(Math.PI / 2);
  tire.computeVertexNormals();

  // --- jant ----------------------------------------------------------------
  const rimParts = [];
  const barrel = new THREE.CylinderGeometry(radius * 0.63, radius * 0.63, halfWidth * 1.55, 24, 1, true);
  rimParts.push(barrel);

  const face = new THREE.CylinderGeometry(radius * 0.63, radius * 0.58, 0.035, 24);
  face.translate(0, halfWidth * 0.7, 0);
  rimParts.push(face);

  const hub = new THREE.CylinderGeometry(radius * 0.2, radius * 0.2, halfWidth * 0.9, 16);
  hub.translate(0, halfWidth * 0.5, 0);
  rimParts.push(hub);

  // Beş kollu jant: göbekten dış çembere uzanan kutular.
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2;
    const spoke = new THREE.BoxGeometry(0.075, 0.03, radius * 0.42);
    spoke.translate(0, halfWidth * 0.68, radius * 0.4);
    spoke.rotateY(angle);
    rimParts.push(spoke);
  }

  // Bijon somunları.
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 + 0.3;
    const nut = new THREE.CylinderGeometry(0.017, 0.017, 0.02, 6);
    nut.translate(Math.cos(angle) * 0.075, halfWidth * 0.78, Math.sin(angle) * 0.075);
    rimParts.push(nut);
  }

  const rim = mergeParts(rimParts);
  rim.rotateZ(Math.PI / 2);
  rim.computeVertexNormals();

  return { tire, rim };
}

export function createWheelMaterials() {
  const tire = new THREE.MeshStandardMaterial({
    color: 0x1d1d20,
    roughness: 0.92,
    metalness: 0.02,
  });

  const rim = new THREE.MeshStandardMaterial({
    color: 0x6a6d72,
    roughness: 0.42,
    metalness: 0.85,
  });

  return { tire, rim };
}

/**
 * Dört tekerleği kurar. Direksiyon açısı dış grupta, tekerlek dönüşü iç grupta
 * uygulanıyor — ikisi birbirine karışmasın diye.
 */
export function createWheelRig(parent, count = 4) {
  const { tire, rim } = createWheelGeometries();
  const materials = createWheelMaterials();
  const rigs = [];

  for (let i = 0; i < count; i++) {
    const steerGroup = new THREE.Group();
    const spinGroup = new THREE.Group();

    const tireMesh = new THREE.Mesh(tire, materials.tire);
    const rimMesh = new THREE.Mesh(rim, materials.rim);
    tireMesh.castShadow = true;
    tireMesh.receiveShadow = true;
    rimMesh.castShadow = true;

    spinGroup.add(tireMesh, rimMesh);
    steerGroup.add(spinGroup);
    parent.add(steerGroup);

    rigs.push({ steerGroup, spinGroup });
  }

  return { rigs, geometries: { tire, rim }, materials };
}
