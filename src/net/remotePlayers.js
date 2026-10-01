import * as THREE from 'three';
import { VEHICLE } from '../config/settings.js';
import { INTERP_DELAY, MAX_EXTRAPOLATION, makeStateSlot, unpackState } from './protocol.js';
import { createJeep } from '../render/jeepModel.js';
import { clamp, clamp01 } from '../utils/math.js';

/**
 * Uzak oyuncuların araçları.
 *
 * Ağdan gelen anlık görüntüler doğrudan sahneye yazılmıyor; her eş için bir
 * tampon tutuluyor ve sahne `INTERP_DELAY` kadar **geriden** oynatılıyor. Bunun
 * karşılığı sabit bir gecikme, kazancı ise iki paket arasının interpolasyonla
 * doldurulabilmesi: 20 Hz'lik bir akışı doğrudan uygulamak, uzak aracı saniyede
 * yirmi kez ışınlanan bir şeye çevirir.
 *
 * Zaman damgası olarak gönderenin saati değil **paketin bize varış anı**
 * kullanılıyor. Saatleri senkronlamak gerekmiyor; tek gereken paketlerin
 * aralarındaki sürenin korunması, o da varış anlarında zaten var.
 *
 * Uzak araçlar iz de bırakıyor. Çok oyunculu bir haritada asıl görmek istenen
 * şey bu: sen yokken başkasının kumda bıraktığı çizgiler.
 */

const WHEEL_LOCALS = (() => {
  const anchorY = VEHICLE.suspension.restLength - VEHICLE.comHeight;
  const half = VEHICLE.trackWidth * 0.5;
  const frontZ = -VEHICLE.wheelBase * VEHICLE.comBias;
  const rearZ = VEHICLE.wheelBase * (1 - VEHICLE.comBias);
  return [
    new THREE.Vector3(-half, anchorY, frontZ),
    new THREE.Vector3(half, anchorY, frontZ),
    new THREE.Vector3(-half, anchorY, rearZ),
    new THREE.Vector3(half, anchorY, rearZ),
  ];
})();

/** Tamponda en fazla kaç anlık görüntü tutulacağı. */
const BUFFER_LIMIT = 24;

export function createRemotePlayers({
  scene,
  weather,
  heightfield,
  trackMap,
  rutfield,
  particles,
  surface,
}) {
  const peers = new Map();

  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _tmpQuat = new THREE.Quaternion();
  const _contact = new THREE.Vector3();
  const _forward = new THREE.Vector3();
  const _local = new THREE.Vector3();
  const _toSlot = makeStateSlot();
  const _spraySlot = { contact: new THREE.Vector3() };

  function ensure(identity) {
    let peer = peers.get(identity.id);
    if (peer) {
      if (identity.name) peer.identity = { ...peer.identity, ...identity };
      return peer;
    }

    const jeep = createJeep({ scene, weather, lights: false });
    if (identity.color !== undefined) jeep.setBodyColor(identity.color);

    peer = {
      identity,
      jeep,
      buffer: [],
      slot: makeStateSlot(),
      lastSeen: performance.now() * 0.001,
      /** Önceki karede tekerleklerin değdiği noktalar — iz segmentleri için. */
      prevContacts: Array.from({ length: 4 }, () => new THREE.Vector3()),
      hadContact: [false, false, false, false],
      visible: false,
      ping: 0,
    };
    peers.set(identity.id, peer);
    return peer;
  }

  function remove(id) {
    const peer = peers.get(id);
    if (!peer) return;
    peer.jeep.dispose();
    peers.delete(id);
  }

  function receive(identity, packed, now = performance.now() * 0.001) {
    const peer = ensure(identity);
    peer.lastSeen = now;
    peer.buffer.push({ t: now, s: packed });
    if (peer.buffer.length > BUFFER_LIMIT) peer.buffer.shift();
  }

  function setPing(id, ping) {
    const peer = peers.get(id);
    if (peer) peer.ping = ping;
  }

  /** Uzun süre haber alınamayan eşleri döndürür (oturum onları düşürür). */
  function stale(timeout, now = performance.now() * 0.001) {
    const out = [];
    for (const [id, peer] of peers) if (now - peer.lastSeen > timeout) out.push(id);
    return out;
  }

  function update(dt, now = performance.now() * 0.001) {
    const renderTime = now - INTERP_DELAY;

    for (const peer of peers.values()) {
      const buffer = peer.buffer;
      if (buffer.length === 0) continue;

      // Oynatma anını kuşatan iki paketi bul; eskiyenleri at ama en az birini
      // bırak, yoksa duran bir araç tamponu boşaltıp kaybolur.
      while (buffer.length > 2 && buffer[1].t <= renderTime) buffer.shift();

      let alpha = 0;
      let from = buffer[0];
      let to = buffer[1] || null;

      if (to && to.t > from.t) {
        alpha = clamp01((renderTime - from.t) / (to.t - from.t));
      } else {
        // Elde tek paket kaldı: kısa süre hızla ileri sür, sonra dondur.
        to = null;
        alpha = 0;
      }

      unpackState(from.s, peer.slot);
      applySlot(peer, peer.slot, to, alpha, renderTime, dt);
      peer.visible = true;
    }
  }

  function applySlot(peer, a, to, alpha, renderTime, dt) {
    let px = a.px;
    let py = a.py;
    let pz = a.pz;
    _quat.set(a.qx, a.qy, a.qz, a.qw);
    let steer = a.steer;
    let brake = a.brake;

    if (to) {
      const b = unpackState(to.s, _toSlot);
      px += (b.px - px) * alpha;
      py += (b.py - py) * alpha;
      pz += (b.pz - pz) * alpha;
      _quat.slerp(_tmpQuat.set(b.qx, b.qy, b.qz, b.qw), alpha);
      steer += (b.steer - steer) * alpha;
      brake += (b.brake - brake) * alpha;
      for (let i = 0; i < 4; i++) {
        const wa = a.wheels[i];
        const wb = b.wheels[i];
        wa.suspLength += (wb.suspLength - wa.suspLength) * alpha;
        wa.steerAngle += (wb.steerAngle - wa.steerAngle) * alpha;
        // Dönüş açısı 2π'de sarıyor; kısa yoldan interpolasyon yoksa tekerlek
        // her turda bir kere geri sıçrıyor.
        wa.spinAngle += shortestAngle(wa.spinAngle, wb.spinAngle) * alpha;
        wa.grounded = alpha < 0.5 ? wa.grounded : wb.grounded;
        wa.slide += (wb.slide - wa.slide) * alpha;
        wa.spin += (wb.spin - wa.spin) * alpha;
        wa.load += (wb.load - wa.load) * alpha;
      }
    } else {
      // Ekstrapolasyon: son bilinen hızla, sınırlı süre.
      const ahead = clamp(renderTime - peer.buffer[peer.buffer.length - 1].t, 0, MAX_EXTRAPOLATION);
      px += a.vx * ahead;
      py += a.vy * ahead;
      pz += a.vz * ahead;
    }

    _pos.set(px, py, pz);
    peer.jeep.root.position.copy(_pos);
    peer.jeep.root.quaternion.copy(_quat);
    peer.jeep.setSteering(steer);
    peer.jeep.setBraking(brake);
    peer.jeep.setHeadlights(a.headlights);

    for (let i = 0; i < 4; i++) {
      const w = a.wheels[i];
      peer.jeep.setWheel(i, w.suspLength, w.steerAngle, w.spinAngle);
    }

    stampRemoteTracks(peer, a, dt);
  }

  function stampRemoteTracks(peer, slot, dt) {
    if (!trackMap || dt <= 0) return;
    const halfWidth = VEHICLE.wheelWidth * 0.5;
    _forward.set(0, 0, -1).applyQuaternion(peer.jeep.root.quaternion);

    for (let i = 0; i < 4; i++) {
      const w = slot.wheels[i];
      if (!w.grounded) {
        peer.hadContact[i] = false;
        continue;
      }

      _local
        .copy(WHEEL_LOCALS[i])
        .setY(WHEEL_LOCALS[i].y - w.suspLength - VEHICLE.wheelRadius);
      _contact.copy(_local).applyQuaternion(peer.jeep.root.quaternion).add(peer.jeep.root.position);

      if (!heightfield.isInsidePlayfield(_contact.x, _contact.z, 1)) {
        peer.hadContact[i] = false;
        continue;
      }

      const prev = peer.prevContacts[i];
      let px = prev.x;
      let pz = prev.z;
      if (!peer.hadContact[i] || Math.hypot(_contact.x - px, _contact.z - pz) > 2.5) {
        px = _contact.x;
        pz = _contact.z;
      }

      const ground = surface(_contact.x, _contact.z);
      const load = clamp(w.load / ((VEHICLE.mass * 9.81) / 4), 0, 2.2) * ground.trackDepth;
      trackMap.stampWheel(px, pz, _contact.x, _contact.z, {
        halfWidth,
        load,
        slide: w.slide,
        spin: w.spin,
        dt,
      });

      if (rutfield) {
        const dig = Math.min(1, w.slide * 0.55 + w.spin * 0.45);
        const advance = Math.min(1, Math.hypot(_contact.x - px, _contact.z - pz) / 0.5);
        rutfield.stampSegment(
          px,
          pz,
          _contact.x,
          _contact.z,
          halfWidth * 1.5,
          load * (advance * 0.16 + dig * dt * 1.1)
        );
      }

      if (particles) {
        const amount = clamp01(w.slide * 0.85 + w.spin * 0.75) * clamp01(w.load / ((VEHICLE.mass * 9.81) / 4));
        if (amount > 0.08) {
          _spraySlot.contact.copy(_contact);
          particles.emitSpray(_spraySlot, amount, _forward, dt);
        }
      }

      prev.copy(_contact);
      peer.hadContact[i] = true;
    }
  }

  function clear() {
    for (const id of [...peers.keys()]) remove(id);
  }

  return {
    peers,
    ensure,
    remove,
    receive,
    setPing,
    stale,
    update,
    clear,
    get count() {
      return peers.size;
    },
  };
}

/** İki açı arasındaki en kısa fark (-π, π]. */
function shortestAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
