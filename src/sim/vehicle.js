import * as THREE from 'three';
import { VEHICLE, STATIC_RIDE_HEIGHT } from '../config/settings.js';
import { solveTire, PEAK_SLIP_RATIO } from './tire.js';
import { createDrivetrain } from './engine.js';
import { clamp, clamp01, lerp, moveTowards } from '../utils/math.js';

const GRAVITY = 9.81;
const AIR_DENSITY = 1.2;

/**
 * Ray-cast süspansiyonlu rijit gövde. Harici fizik motoru yok.
 *
 * Yerel eksenler three.js'in alışılmış düzeni: **ileri = -Z, sağ = +X, yukarı = +Y**.
 *
 * Kritik nokta tekerlek dönüş dinamiğinde: lastik kuvvetinin kayma oranına
 * duyarlılığı düşük hızda o kadar yüksek ki, açık Euler ile 240 Hz bile
 * patlıyor (kararlılık ~1200 Hz gerektiriyor). Bu yüzden tekerlek açısal hızı
 * yarı-örtük çözülüyor: lastik kuvvetinin ω'ya göre eğimi sayısal olarak
 * ölçülüp integrasyona sönümleme olarak giriyor. Eğim negatife döndüğünde
 * (lastik doyduğunda) sıfıra kelepçeleniyor — böylece gerçek patinaj
 * bastırılmıyor, sadece sayısal patlama engelleniyor.
 */
export function createVehicle({ heightfield, propField = null, surface = null }) {
  const cfg = VEHICLE;
  const susp = cfg.suspension;
  const halfTrack = cfg.trackWidth * 0.5;
  const frontZ = -cfg.wheelBase * cfg.comBias;
  const rearZ = cfg.wheelBase * (1 - cfg.comBias);
  const anchorY = susp.restLength - cfg.comHeight;
  const nominalLoad = (cfg.mass * GRAVITY) / 4;

  // Kutu yaklaşımıyla atalet tensörü (genişlik 1.9 m, yükseklik 1.9 m, uzunluk 4.2 m).
  const boxW = 1.9;
  const boxH = 1.9;
  const boxL = 4.2;
  const inertia = new THREE.Vector3(
    ((cfg.mass / 12) * (boxH * boxH + boxL * boxL)) * cfg.inertiaScale.x,
    ((cfg.mass / 12) * (boxW * boxW + boxL * boxL)) * cfg.inertiaScale.y,
    ((cfg.mass / 12) * (boxW * boxW + boxH * boxH)) * cfg.inertiaScale.z
  );

  const wheels = [
    makeWheel('FL', -halfTrack, frontZ, true),
    makeWheel('FR', halfTrack, frontZ, true),
    makeWheel('RL', -halfTrack, rearZ, false),
    makeWheel('RR', halfTrack, rearZ, false),
  ];

  function makeWheel(name, x, z, steerable) {
    return {
      name,
      steerable,
      local: new THREE.Vector3(x, anchorY, z),
      anchor: new THREE.Vector3(),
      center: new THREE.Vector3(),
      contact: new THREE.Vector3(),
      prevContact: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      forward: new THREE.Vector3(),
      right: new THREE.Vector3(),
      suspLength: susp.restLength,
      compression: 0,
      prevCompression: 0,
      load: 0,
      omega: 0,
      spinAngle: 0,
      steerAngle: 0,
      grounded: false,
      hadContact: false,
      /** Tekerlek arazinin değil bir nesnenin (kaya vb.) üstünde mi. */
      onProp: false,
      slipRatio: 0,
      slipAngle: 0,
      /** Tekerleğin altındaki zeminin tepe tutuşu — arayüz ve efektler okur. */
      grip: 0,
      /** Boyuna kayma miktarı 0-1 (patinaj / kilitlenme). */
      spin: 0,
      /** Yanal kayma miktarı 0-1 (savrulma). */
      slide: 0,
      saturation: 0,
      surfaceSpeed: 0,
    };
  }

  const drivetrain = createDrivetrain();

  const state = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    angularVelocity: new THREE.Vector3(),
    steerInput: 0,
    speed: 0,
    forwardSpeed: 0,
    groundedCount: 0,
    airborne: false,
    airborneTime: 0,
    /** Son karede yaşanan en sert düşey darbe (m/s) — toz patlaması için. */
    landingImpact: 0,
    /** Son karede bir nesneye çarpma şiddeti (m/s). */
    impactSpeed: 0,
    /** Son alt adımda gövdeye etki eden bileşke kuvvet (hata ayıklama). */
    netForce: new THREE.Vector3(),
    upsideDown: false,
    upsideDownTime: 0,
    /** El freni tutuşunun o andaki gücü, 0-1 (park freni). */
    parked: 0,
  };

  // Yeniden kullanılan geçici vektörler: adım başına yüzlerce kez çağrıldığı
  // için burada tahsis edilip her yerde paylaşılıyorlar.
  const _up = new THREE.Vector3();
  const _down = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _force = new THREE.Vector3();
  const _torque = new THREE.Vector3();
  const _tmp = new THREE.Vector3();
  const _tmp2 = new THREE.Vector3();
  const _r = new THREE.Vector3();
  const _contactVel = new THREE.Vector3();
  const _steerQuat = new THREE.Quaternion();
  const _invQuat = new THREE.Quaternion();
  const _spinQuat = new THREE.Quaternion();
  const _tireA = { forward: 0, lateral: 0, combined: 0, saturation: 0 };
  const _tireB = { forward: 0, lateral: 0, combined: 0, saturation: 0 };
  const _axisY = new THREE.Vector3(0, 1, 0);
  const loadShare = [0, 0, 0, 0];
  const _propNormal = new THREE.Vector3();
  const _propScratch = [];
  const _propHit = { normal: null };
  const _hitNormal = new THREE.Vector3();
  const _impulse = new THREE.Vector3();
  const _angular = new THREE.Vector3();
  const _spherePos = new THREE.Vector3();

  /**
   * Gövde, uzunluğu boyunca dizilmiş dört küreyle temsil ediliyor. Yarıçap,
   * küreler zeminin altına sarkmayacak şekilde seçildi: küçük taşlar altından
   * geçebilsin, sadece gerçekten büyük nesneler gövdeye çarpsın.
   */
  const BODY_SPHERES = [-1.5, -0.5, 0.5, 1.5];
  const BODY_SPHERE_RADIUS = 0.58;
  /**
   * Kürelerin alt kenarı, görünen şasi tabanıyla hizalı. Daha aşağıda olursa
   * araç altından rahatça geçmesi gereken taşlara görünmez duvar gibi çarpar;
   * daha yukarıda olursa gövde kayanın içine girer.
   */
  const BODY_SPHERE_Y = 0.45;

  function applyForceAt(force, worldPoint) {
    _force.add(force);
    _r.subVectors(worldPoint, state.position);
    _tmp2.crossVectors(_r, force);
    _torque.add(_tmp2);
  }

  /** Işının zemini bulamadan gidebileceği en uzun mesafe. */
  const MAX_REACH = susp.restLength + cfg.wheelRadius + 4;

  /**
   * Şasi aşağı ekseni boyunca yükseklik alanına ışın atar. Arazi bir yükseklik
   * alanı olduğundan genel bir ışın-üçgen testi gerekmiyor; Newton iterasyonu
   * birkaç adımda yakınsıyor.
   *
   * Türevde **arazi eğimi de yer almak zorunda**. Yalnız `down.y` kullanan
   * basit sürüm, araç yana yattığında (ışın yatayına yaklaştığında) yakınsamayı
   * kaybediyor ve tekerlek zeminin metrelerce üstündeyken "temas" bildiriyordu:
   * yay tam sıkışık kuvvet uygulayıp aracı göğe fırlatıyordu.
   */
  function castToGround(anchor, down) {
    let t = 0;
    for (let i = 0; i < 5; i++) {
      const px = anchor.x + down.x * t;
      const py = anchor.y + down.y * t;
      const pz = anchor.z + down.z * t;
      const f = py - heightfield.sampleHeight(px, pz);
      if (Math.abs(f) < 0.003) break;

      const dhdx =
        (heightfield.sampleHeight(px + 0.3, pz) - heightfield.sampleHeight(px - 0.3, pz)) / 0.6;
      const dhdz =
        (heightfield.sampleHeight(px, pz + 0.3) - heightfield.sampleHeight(px, pz - 0.3)) / 0.6;

      let slope = down.y - (dhdx * down.x + dhdz * down.z);
      // Türev sıfıra yaklaşırsa (ışın yüzeye teğet) adım patlar; kelepçelenir.
      if (slope > -0.2) slope = -0.2;

      t -= f / slope;
      if (t <= 0) {
        t = 0;
        break;
      }
      if (t >= MAX_REACH) {
        t = MAX_REACH;
        break;
      }
    }

    /**
     * Nesneler zeminin üstünde durur, dolayısıyla aynı ışın üzerinde daha
     * yakın bir vuruş varsa tekerlek onun üstüne biner. Arazi ve nesneler ayrı
     * çözülüyor: yükseklik alanı için Newton, elipsoidler için analitik kesişim.
     */
    _propHit.normal = null;
    if (propField && propField.count > 0) {
      const hit = propField.raycast(
        anchor.x,
        anchor.y,
        anchor.z,
        down.x,
        down.y,
        down.z,
        t,
        _propNormal,
        _propScratch
      );
      if (hit >= 0) {
        t = hit;
        _propHit.normal = _propNormal;
      }
    }
    return t;
  }

  function step(dt, input) {
    const q = state.quaternion;
    _up.set(0, 1, 0).applyQuaternion(q);
    _down.copy(_up).negate();
    _fwd.set(0, 0, -1).applyQuaternion(q);
    _right.set(1, 0, 0).applyQuaternion(q);
    _invQuat.copy(q).invert();

    state.forwardSpeed = state.velocity.dot(_fwd);
    state.speed = state.velocity.length();
    state.parked = parkStrength(input);

    // --- direksiyon --------------------------------------------------------
    // Hız arttıkça azalan maksimum açı: 90 km/h'de tam kilit fizik olarak
    // mümkün ama sürülemez bir araç demek olurdu.
    const trimFloor = cfg.steering.minTrim;
    const speedTrim =
      trimFloor + (1 - trimFloor) / (1 + Math.abs(state.forwardSpeed) / cfg.steering.speedFalloff);
    let targetSteer = input.steer * cfg.steering.maxAngle * speedTrim;

    /**
     * Karşı direksiyon yardımı — **sapma hızı hatası** üzerinden.
     *
     * İlk denemede ölçüt gövdenin kayma açısıydı ve yanlıştı: o açı düzgün bir
     * virajda da sıfırdan farklı, dolayısıyla yardım her viraja karışıp
     * direksiyonu kesiyordu (42 km/h'te tam kilit isteğine karşı 0.08 rad).
     *
     * Doğru ölçüt, aracın **istenenden fazla dönüp dönmediği**. Bisiklet
     * modeliyle, verilen direksiyon açısı ve hız için beklenen sapma hızı
     * `v·tan(δ)/L`; gerçek sapma hızının bunu aşması, arkanın kaydığı anlamına
     * geliyor. Düzgün virajda hata sıfır, yardım da sıfır.
     *
     * İşaretler: +Y etrafında pozitif dönüş ileri yönü (-Z) **sola** çeviriyor,
     * bu yüzden sağa dönüş negatif sapma hızı demek.
     */
    if (
      state.speed > cfg.steering.counterMinSpeed &&
      input.handbrake < 0.4 &&
      state.groundedCount > 1
    ) {
      const yawRate = state.angularVelocity.dot(_up);
      const reference = (-state.forwardSpeed * Math.tan(state.steerInput)) / cfg.wheelBase;
      let error = yawRate - reference;
      // Ölü bant: lastik gürültüsü direksiyonu titretmesin.
      const dead = cfg.steering.counterDeadband;
      error = error > dead ? error - dead : error < -dead ? error + dead : 0;

      const assist = clamp(
        error * cfg.steering.counterAssist,
        -cfg.steering.maxAngle * 0.55,
        cfg.steering.maxAngle * 0.55
      );
      targetSteer = clamp(targetSteer + assist, -cfg.steering.maxAngle, cfg.steering.maxAngle);
    }

    const rate =
      Math.abs(targetSteer) > Math.abs(state.steerInput)
        ? cfg.steering.speed
        : cfg.steering.returnSpeed;
    state.steerInput = moveTowards(state.steerInput, targetSteer, rate * cfg.steering.maxAngle * dt);

    // --- aktarma organları -------------------------------------------------
    // Devir referansı, tekerleklerin yüke göre ağırlıklı ortalaması. Düz
    // ortalama alınca, havada boşta dönen tek bir tekerlek motoru kesme
    // bölgesine çıkarıp şanzımanı sürekli yukarı vitese zorluyordu.
    let weightedOmega = 0;
    let weightSum = 0;
    for (const w of wheels) {
      // Taban ağırlık, dört tekerlek de havadayken sıfıra bölmeyi engelliyor.
      const weight = w.load + 200;
      weightedOmega += w.omega * weight;
      weightSum += weight;
    }
    weightedOmega /= weightSum;

    drivetrain.update(dt, {
      wheelOmega: weightedOmega,
      throttle: input.throttle,
      brake: input.brake,
      forwardSpeed: state.forwardSpeed,
      lowRange: input.lowRange,
    });

    /**
     * Tork dağılımı yüke orantılı. Dört tekerleğe eşit bölmek açık diferansiyel
     * gibi davranıyordu: havalanan tekerlek boşa dönüp torku yutuyor, zemindeki
     * tekerlek payına düşen çeyreği alıp aracı kımıldatamıyordu. Kilitli 4x4'ün
     * davranışı buna çok daha yakın — tutuşu olan tekerlek torku alır.
     */
    const driveTorque = drivetrain.state.driveTorque;
    let shareSum = 0;
    for (let i = 0; i < 4; i++) {
      // Taban pay, havadaki tekerleğin de bir miktar tork alması için: aksi
      // halde sıçrayışta tekerlekler tamamen durur, iniş sarsıntılı olur.
      loadShare[i] = wheels[i].load + 250;
      shareSum += loadShare[i];
    }
    for (let i = 0; i < 4; i++) loadShare[i] = (loadShare[i] / shareSum) * driveTorque;

    _force.set(0, 0, 0);
    _torque.set(0, 0, 0);

    state.groundedCount = 0;
    // Park freni tutuşunun bütçesi buradan çıkıyor: toplam düşey yük ve
    // tekerleklerin altındaki zeminin ortalama tutuşu.
    let totalLoad = 0;
    let gripSum = 0;

    for (let wi = 0; wi < 4; wi++) {
      const w = wheels[wi];
      const wheelDrive = loadShare[wi];
      w.prevContact.copy(w.contact);
      w.hadContact = w.grounded;
      /**
       * `steerInput` sürücünün girdisi (pozitif = sağa). Tekerleğin yaw'ı ise
       * +Y ekseni etrafında dönüyor ve sağ el kuralı gereği **pozitif dönüş
       * ileri yönü (-Z) sola çeviriyor** — bu yüzden işaret çevriliyor.
       */
      w.steerAngle = w.steerable ? -state.steerInput : 0;

      w.anchor.copy(w.local).applyQuaternion(q).add(state.position);

      const distance = castToGround(w.anchor, _down);
      const rawLength = distance - cfg.wheelRadius;

      w.prevCompression = w.compression;
      w.grounded = rawLength < susp.restLength;
      w.suspLength = clamp(rawLength, susp.restLength - susp.maxTravel, susp.restLength);
      w.compression = susp.restLength - w.suspLength;

      w.center.copy(w.anchor).addScaledVector(_down, w.suspLength);
      w.contact.copy(w.anchor).addScaledVector(_down, distance);

      if (!w.grounded) {
        w.load = 0;
        w.slipRatio = 0;
        w.slipAngle = 0;
        w.spin = 0;
        w.slide = 0;
        w.saturation = 0;
        // Havadaki tekerlek: sadece motor ve fren etkiler.
        w.omega = integrateFreeWheel(w, wheelDrive, input, dt);
        w.spinAngle += w.omega * dt;
        continue;
      }

      state.groundedCount++;
      // Tekerlek bir nesnenin üstündeyse temas normali arazinin değil, o
      // nesnenin yüzeyinin normali — araç kayaya tırmanırken gerçekten yatar.
      if (_propHit.normal) {
        w.normal.copy(_propHit.normal);
        w.onProp = true;
      } else {
        heightfield.sampleNormal(w.contact.x, w.contact.z, w.normal);
        w.onProp = false;
      }

      // Temas noktasının hızı (gövde hızı + dönmenin katkısı).
      _r.subVectors(w.contact, state.position);
      _contactVel.crossVectors(state.angularVelocity, _r).add(state.velocity);

      /**
       * Sönümleme hızı, sıkışmanın kareler arası farkından **değil** temas
       * noktasının gerçek normal hızından alınıyor. Fark yöntemi, tekerlek
       * havadan zemine dönerken sıkışmayı tek adımda 0'dan 10 cm'e sıçratıyor,
       * bu da 24 m/s'lik sahte bir sönümleme hızına ve 90 kN'luk (aracın beş
       * katı) bir kuvvet darbesine dönüşüyordu: araç her tümsekte fırlıyordu.
       */
      const compressionSpeed = -_contactVel.dot(w.normal);
      const damping = compressionSpeed > 0 ? susp.dampingCompress : susp.dampingRebound;
      const springForce = clamp(
        susp.stiffness * w.compression + damping * compressionSpeed,
        0,
        susp.maxForce
      );
      w.load = springForce;

      _tmp.copy(w.normal).multiplyScalar(springForce);
      applyForceAt(_tmp, w.contact);

      // --- temas çerçevesi -------------------------------------------------
      _steerQuat.setFromAxisAngle(_axisY, w.steerAngle);
      w.forward.set(0, 0, -1).applyQuaternion(_steerQuat).applyQuaternion(q);
      // Yönü temas düzlemine yansıt.
      w.forward.addScaledVector(w.normal, -w.forward.dot(w.normal));
      if (w.forward.lengthSq() < 1e-6) w.forward.copy(_fwd);
      w.forward.normalize();
      w.right.crossVectors(w.forward, w.normal).normalize();

      // `_contactVel` süspansiyon hızı için zaten hesaplandı, tekrar gerekmiyor.
      const vF = _contactVel.dot(w.forward);
      const vR = _contactVel.dot(w.right);
      w.surfaceSpeed = vF;

      const kappaDenom = Math.abs(vF) + 0.9;
      w.slipRatio = clamp((w.omega * cfg.wheelRadius - vF) / kappaDenom, -4, 4);
      w.slipAngle = Math.atan2(vR, Math.abs(vF) + 0.7);

      /**
       * Zemin özellikleri tekerlek başına okunuyor. Bölge sınırında araç
       * gerçekten iki farklı zeminin üstünde: sol tekerlekler karda, sağ
       * tekerlekler çayırda olabiliyor ve araç buna göre çekiyor.
       */
      const ground = surface ? surface(w.contact.x, w.contact.z) : cfg.sand;
      const peakGrip = ground.peakGrip ?? cfg.sand.peakGrip;
      const slideGrip = ground.slideGrip ?? cfg.sand.slideGrip;
      w.grip = peakGrip;
      totalLoad += springForce;
      gripSum += peakGrip;

      solveTire({
        slipRatio: w.slipRatio,
        slipAngle: w.slipAngle,
        load: springForce,
        peak: peakGrip,
        slide: slideGrip,
        out: _tireA,
      });

      /**
       * --- tekerlek açısal hızı (yarı-örtük) -------------------------------
       *
       * Sönümleme terimi, lastik kuvvetinin ω'ya göre **yerel** eğiminden
       * gelmek zorunda. Geniş bir fark adımı (0.6 rad/s) eğriyi doyma
       * bölgesine kadar tarayıp ortalama eğimi ölçüyor ve gerçek yerel eğimi
       * üçte birine kadar küçük gösteriyordu; sönümleme yetersiz kalınca
       * tekerlek hızı alt adımlar arasında salınıma giriyor, lastik kuvveti
       * her adımda işaret değiştiriyor ve araç tam gazda yerinde titriyordu.
       */
      const probe = 0.03;
      solveTire({
        slipRatio: clamp(((w.omega + probe) * cfg.wheelRadius - vF) / kappaDenom, -4, 4),
        slipAngle: w.slipAngle,
        load: springForce,
        peak: peakGrip,
        slide: slideGrip,
        out: _tireB,
      });
      const slope = Math.max(0, (_tireB.forward - _tireA.forward) / probe);
      const implicitFactor = 1 + (dt * cfg.wheelRadius * slope) / cfg.wheelInertia;

      let wheelTorque = wheelDrive - _tireA.forward * cfg.wheelRadius;
      wheelTorque -= brakeTorqueFor(w, input, dt);
      w.omega += (dt * wheelTorque) / cfg.wheelInertia / implicitFactor;
      w.spinAngle += w.omega * dt;

      // --- lastik kuvvetleri -------------------------------------------------
      _tmp.copy(w.forward).multiplyScalar(_tireA.forward);
      _tmp.addScaledVector(w.right, _tireA.lateral);

      // Zemin direnci: yuvarlanma direnci + batmayla artan sürükleme.
      const loadRatio = clamp(springForce / nominalLoad, 0, 2.5);
      const rollCoef = ground.rollingResistance ?? cfg.sand.rollingResistance;
      const bogCoef = ground.bogDrag ?? cfg.sand.bogDrag;
      const rolling = -Math.tanh(vF * 2.5) * springForce * rollCoef;
      const bog = -vF * Math.abs(vF) * bogCoef * loadRatio * 0.35;
      _tmp.addScaledVector(w.forward, rolling + bog);

      applyForceAt(_tmp, w.contact);

      w.spin = clamp01(Math.abs(w.slipRatio) / (PEAK_SLIP_RATIO * 4));
      w.slide = clamp01(Math.abs(w.slipAngle) / 0.6);
      w.saturation = _tireA.saturation;
    }

    applyAntiRoll();

    // --- gövdeye etki eden kuvvetler ---------------------------------------
    _force.y -= cfg.mass * GRAVITY;

    const speed = state.velocity.length();
    if (speed > 0.05) {
      const dragMag = 0.5 * AIR_DENSITY * cfg.dragCoefficient * cfg.frontalArea * speed;
      _force.addScaledVector(state.velocity, -dragMag);
    }

    // Park freni **yerçekiminden sonra**: dengelemesi gereken şey tam olarak
    // yamaç boyunca kalan bileşke.
    applyParkingHold(dt, totalLoad, state.groundedCount > 0 ? gripSum / state.groundedCount : 0);

    state.airborne = state.groundedCount === 0;

    /**
     * Yalpa ekseni etrafındaki açısal hız ayrı ele alınıyor. Zeminde
     * sönümleniyor (süspansiyon ve lastik yanağının gerçekte yaptığı iş),
     * havada ise aracı ufka paralel getiren yumuşak bir yardım devreye
     * giriyor — takla riskinin neredeyse tamamı, tepeden yan yatmış halde
     * havalanıp o şekilde inmekten geliyordu.
     */
    const rollRate = state.angularVelocity.dot(_fwd);

    if (state.airborne) {
      state.airborneTime += dt;
      // Havada hafif yön kontrolü: sıçrayışta aracı düzeltebilmek için.
      _tmp.copy(_up).multiplyScalar(-state.steerInput * cfg.airControl * cfg.mass * 2.2);
      _torque.add(_tmp);
      state.angularVelocity.multiplyScalar(Math.exp(-cfg.airDamping * dt));

      // `_right.y > 0` sağ tarafın kalktığı anlamına gelir; ileri ekseni
      // etrafındaki pozitif dönüş sağ tarafı indirir.
      const levelling =
        _right.y * cfg.stability.airLevel - rollRate * cfg.stability.airLevelDamping;
      state.angularVelocity.addScaledVector(_fwd, levelling * dt);
    } else {
      state.airborneTime = 0;
      state.angularVelocity.multiplyScalar(Math.exp(-0.9 * dt));
      state.angularVelocity.addScaledVector(
        _fwd,
        -rollRate * (1 - Math.exp(-cfg.stability.rollDamping * dt))
      );
    }

    integrate(dt);
    resolveBodyCollisions();
    return state;
  }

  /** Dünya uzayında I⁻¹ · v — tork ve darbeleri açısal hıza çevirmek için. */
  function applyInverseInertia(v) {
    v.applyQuaternion(_invQuat);
    v.set(v.x / inertia.x, v.y / inertia.y, v.z / inertia.z);
    v.applyQuaternion(state.quaternion);
    return v;
  }

  /**
   * Gövde-nesne çarpışması. Girişim hem konum düzeltmesiyle (araç kayanın
   * içinde kalmasın) hem de darbeyle (hız ve dönüş gerçekçi tepki versin)
   * çözülüyor.
   *
   * Darbe temas noktasına uygulandığı için köşesiyle kayaya çarpan araç
   * savruluyor — ortadan çarpınca ise sadece duruyor. Kuvvet yerine anlık
   * darbe kullanılıyor: 240 Hz'de bile derin girişimi tek adımda temizlemek
   * gerekiyor, yay benzeri bir kuvvet aracı fırlatırdı.
   */
  function resolveBodyCollisions() {
    if (!propField || propField.count === 0) return;

    _invQuat.copy(state.quaternion).invert();

    for (let s = 0; s < BODY_SPHERES.length; s++) {
      _spherePos
        .set(0, BODY_SPHERE_Y, BODY_SPHERES[s])
        .applyQuaternion(state.quaternion)
        .add(state.position);

      const penetration = propField.resolveSphere(
        _spherePos.x,
        _spherePos.y,
        _spherePos.z,
        BODY_SPHERE_RADIUS,
        _hitNormal,
        _propScratch
      );
      if (penetration <= 0) continue;

      // Konum düzeltmesi kısmi: tamamını tek adımda uygulamak, iki nesne
      // arasına sıkışan aracı zıplatıyor.
      state.position.addScaledVector(_hitNormal, penetration * 0.7);

      // Temas noktası: kürenin nesneye bakan yüzeyi.
      _r.copy(_spherePos).addScaledVector(_hitNormal, -BODY_SPHERE_RADIUS).sub(state.position);
      _contactVel.crossVectors(state.angularVelocity, _r).add(state.velocity);

      const normalSpeed = _contactVel.dot(_hitNormal);
      if (normalSpeed >= 0) continue;

      // Etkin kütle: 1/m + n · (I⁻¹(r × n) × r)
      _tmp.crossVectors(_r, _hitNormal);
      applyInverseInertia(_tmp);
      _tmp2.crossVectors(_tmp, _r);
      const denom = 1 / cfg.mass + _hitNormal.dot(_tmp2);
      if (denom <= 1e-9) continue;

      const restitution = 0.12;
      let j = (-(1 + restitution) * normalSpeed) / denom;
      // Üst sınır, sayısal kazalarda aracın fırlamasını engeller.
      j = Math.min(j, cfg.mass * 26);

      _impulse.copy(_hitNormal).multiplyScalar(j);

      // Teğet sürtünme: kayaya sürtünen araç hız kaybetsin, üstünden kaymasın.
      _tmp.copy(_contactVel).addScaledVector(_hitNormal, -normalSpeed);
      const tangentSpeed = _tmp.length();
      if (tangentSpeed > 0.01) {
        _tmp.multiplyScalar(1 / tangentSpeed);
        const friction = Math.min(j * 0.55, tangentSpeed * cfg.mass * 0.5);
        _impulse.addScaledVector(_tmp, -friction);
      }

      state.velocity.addScaledVector(_impulse, 1 / cfg.mass);
      _angular.crossVectors(_r, _impulse);
      applyInverseInertia(_angular);
      state.angularVelocity.add(_angular);

      if (-normalSpeed > state.impactSpeed) state.impactSpeed = -normalSpeed;
    }
  }

  function brakeTorqueFor(w, input, dt) {
    const isFront = w.local.z < 0;
    const bias = isFront ? cfg.brakes.bias : 1 - cfg.brakes.bias;
    let torque = input.brake * cfg.brakes.maxTorque * bias * 2;
    // El freni normalde yalnız arkayı kilitler (drift). Araç neredeyse durmuşken
    // park frenine dönüşüp dört tekerleği birden tutuyor: yoksa ön tekerlekler
    // dönmeye devam edip yamaçta aracı aşağı yuvarlıyordu.
    if (!isFront || state.parked > 0) {
      torque += input.handbrake * cfg.brakes.handbrakeTorque;
    }
    if (torque <= 0) return 0;

    // Fren, tekerleği bir adımda ters yöne çeviremez.
    const stopTorque = (Math.abs(w.omega) * cfg.wheelInertia) / dt;
    return Math.sign(w.omega) * Math.min(torque, stopTorque);
  }

  function integrateFreeWheel(w, driveTorque, input, dt) {
    let torque = driveTorque - brakeTorqueFor(w, input, dt);
    // Havada tekerlek serbest: sadece iç sürtünme yavaşlatır.
    torque -= w.omega * 0.35;
    return w.omega + (dt * torque) / cfg.wheelInertia;
  }

  /**
   * El freni tutuşu — park freni.
   *
   * Kilitli tekerlek tek başına aracı yerinde tutmuyor: lastik kayma modeli,
   * ω = 0 iken bile kayma oranı üzerinden sürtünme kuvveti üretiyor ve o kuvvet
   * yamaç boyunca yerçekimini tam dengelemiyor — araç santim santim kayıyor.
   * Gerçekte bunu **statik** sürtünme yapıyor: yüzeyler kaymaya başlamadığı
   * sürece temas noktası hiç hareket etmiyor ve kuvvet, ihtiyaç neyse o oluyor.
   *
   * Burada modellenen şey tam olarak bu. Bu adımda hızı sıfırlayacak kuvvet
   * hesaplanıp **sürtünme bütçesiyle** (μ_statik · toplam düşey yük)
   * kelepçeleniyor. Bütçe yetiyorsa araç çakılı duruyor; yamaç bütçeyi aşacak
   * kadar dikse kelepçe devreye girip aracı kaymaya bırakıyor. Yani "yerinde
   * tut" bir hile değil, statik sürtünmenin kendisi.
   *
   * Yalnız düşük hızda: yüksek hızda el freni hâlâ arka tekerlekleri kilitleyen
   * bir drift aracı.
   *
   * @returns 0-1 arası tutuş oranı (fren torku bunu okuyor).
   */
  function applyParkingHold(dt, totalLoad, avgGrip) {
    const strength = state.parked;
    if (strength <= 0) return;

    const budget =
      (cfg.sand.holdGrip / Math.max(0.2, cfg.sand.peakGrip)) * avgGrip * totalLoad * strength;

    /**
     * İki şeyi birden iptal ediyor:
     *
     *  1. **Birikmiş düzlem içi bileşke** — yamaçta yerçekiminin aşağı iten
     *     payı. Yalnız hız iptal edilseydi, her adımda yerçekimi g·sinθ·dt
     *     kadar yeni hız üretir, bir sonraki adım onu keser ve araç adım başına
     *     o kadar yol alırdı: 8°'lik bir yamaçta on saniyede ~6 cm sürünme.
     *  2. **Kalan hız** — lastik gürültüsünden ve süspansiyon salınımından
     *     arta kalan.
     *
     * Düşey eksene dokunulmuyor; orası süspansiyonun işi.
     */
    _tmp.set(
      -_force.x - (state.velocity.x * cfg.mass) / dt,
      0,
      -_force.z - (state.velocity.z * cfg.mass) / dt
    );
    const needed = _tmp.length();
    if (needed > budget) _tmp.setLength(budget);
    _force.add(_tmp);

    // Sapma da tutulmalı: yalnız öteleme durdurulursa araç yerinde dönüyor.
    const yawRate = state.angularVelocity.dot(_up);
    _tmp.copy(_up).multiplyScalar(-yawRate * inertia.y * strength);
    _torque.add(_tmp);

    /**
     * Bütçe yettiyse kalan mikro sürüklenmeyi tamamen kes. Bütçe yetmiyorsa
     * (yamaç statik sürtünmenin taşıyabileceğinden dik) `needed` bütçenin
     * üstünde kalıyor ve bu dal hiç çalışmıyor — araç kayıyor, kelepçe
     * fizikselliğini koruyor.
     */
    if (needed <= budget && state.speed < 0.35 && strength > 0.85) {
      state.velocity.x = 0;
      state.velocity.z = 0;
      state.angularVelocity.multiplyScalar(0.05);
    }
  }

  /**
   * Tutuşun gücü — kuvvetten önce, adımın başında hesaplanıyor ki fren torku da
   * aynı kareyi görsün. Temas sayısı bir önceki alt adımdan geliyor; 240 Hz'de
   * dört milisaniyelik bir gecikme, tekerleklerin kilitlenmesinde fark etmiyor.
   */
  function parkStrength(input) {
    if (input.handbrake <= 0.35 || state.groundedCount < 3) return 0;
    const engage = clamp01((input.handbrake - 0.35) / 0.35);
    const speedGate = clamp01(
      (cfg.stability.holdSpeed - state.speed) / cfg.stability.holdSpeed
    );
    return engage * speedGate;
  }

  /**
   * Denge çubukları: aynı akstaki iki tekerleğin sıkışma farkı, gövdeyi çok
   * çöken tarafta **yukarı**, az çöken tarafta aşağı iter. İşaret kritik —
   * ters çevrilirse çubuk yalpayı bastırmak yerine büyütür ve araç sürekli
   * çapraz askıda kalıp iki tekerleğini havalandırır.
   */
  function applyAntiRoll() {
    for (let axle = 0; axle < 2; axle++) {
      const left = wheels[axle * 2];
      const right = wheels[axle * 2 + 1];
      if (!left.grounded || !right.grounded) continue;

      const delta = left.compression - right.compression;
      const magnitude = delta * cfg.antiRoll;
      _tmp.copy(_up).multiplyScalar(magnitude);
      applyForceAt(_tmp, left.contact);
      _tmp.copy(_up).multiplyScalar(-magnitude);
      applyForceAt(_tmp, right.contact);
    }
  }

  function integrate(dt) {
    const prevVelY = state.velocity.y;
    state.netForce.copy(_force);

    state.velocity.addScaledVector(_force, dt / cfg.mass);
    state.position.addScaledVector(state.velocity, dt);

    // Tork gövde eksenlerine çevrilip atalet tensörüne bölünüyor.
    _tmp.copy(_torque).applyQuaternion(_invQuat);
    _tmp.set(_tmp.x / inertia.x, _tmp.y / inertia.y, _tmp.z / inertia.z);
    _tmp.applyQuaternion(state.quaternion);
    state.angularVelocity.addScaledVector(_tmp, dt);

    const maxSpin = 9;
    if (state.angularVelocity.lengthSq() > maxSpin * maxSpin) {
      state.angularVelocity.setLength(maxSpin);
    }

    // q' = q + 0.5 * ω ⊗ q * dt
    _spinQuat.set(
      state.angularVelocity.x,
      state.angularVelocity.y,
      state.angularVelocity.z,
      0
    );
    _spinQuat.multiply(state.quaternion);
    state.quaternion.x += _spinQuat.x * 0.5 * dt;
    state.quaternion.y += _spinQuat.y * 0.5 * dt;
    state.quaternion.z += _spinQuat.z * 0.5 * dt;
    state.quaternion.w += _spinQuat.w * 0.5 * dt;
    state.quaternion.normalize();

    // Güvenlik ağı: büyük bir sıçrayıştan sonra tek karede zemine gömülürse
    // araç dışarı itilir; yoksa süspansiyon bir daha asla temas bulamaz.
    const ground = heightfield.sampleHeight(state.position.x, state.position.z);
    const minHeight = ground + 0.35;
    if (state.position.y < minHeight) {
      state.position.y = minHeight;
      if (state.velocity.y < 0) state.velocity.y *= -0.15;
    }

    const impact = prevVelY - state.velocity.y;
    if (state.groundedCount > 0 && impact > state.landingImpact) {
      state.landingImpact = impact;
    }

    _up.set(0, 1, 0).applyQuaternion(state.quaternion);
    state.upsideDown = _up.y < 0.15;
    state.upsideDownTime = state.upsideDown ? state.upsideDownTime + dt : 0;
  }

  /** Aracı verilen noktaya, araziye hizalı ve düz biçimde koyar. */
  function resetTo(x, z, heading = 0) {
    const ground = heightfield.sampleHeight(x, z);
    // Doğrudan denge yüksekliğine bırakılıyor; yay kursunun tepesinden
    // düşürmek her sıfırlamada gereksiz bir çöküş yaratıyordu.
    state.position.set(x, ground + STATIC_RIDE_HEIGHT + 0.02, z);
    state.velocity.set(0, 0, 0);
    state.angularVelocity.set(0, 0, 0);

    const normal = heightfield.sampleNormal(x, z, new THREE.Vector3());
    const align = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    state.quaternion.copy(align).multiply(yaw);

    state.steerInput = 0;
    state.landingImpact = 0;
    state.upsideDownTime = 0;
    state.parked = 0;
    drivetrain.reset();
    for (const w of wheels) {
      w.omega = 0;
      w.compression = 0;
      w.prevCompression = 0;
      w.suspLength = susp.restLength;
      w.grounded = false;
      w.contact.set(x, ground, z);
      w.prevContact.copy(w.contact);
    }
  }

  /**
   * Ters dönmüş aracı bulunduğu yerde doğrultur. Yönü korunur, hız sıfırlanır
   * — tam sıfırlamadan farkı, sürücünün haritanın öbür ucuna ışınlanmaması.
   */
  function selfRight() {
    _fwd.set(0, 0, -1).applyQuaternion(state.quaternion);
    const heading = Math.atan2(-_fwd.x, -_fwd.z);
    resetTo(state.position.x, state.position.z, heading);
  }

  return {
    state,
    wheels,
    drivetrain,
    step,
    resetTo,
    selfRight,
    nominalLoad,
    config: cfg,
    /** Km/h cinsinden gösterge hızı. */
    get speedKmh() {
      return state.speed * 3.6;
    },
    get forwardVector() {
      return _fwd;
    },
    consumeLandingImpact() {
      const value = state.landingImpact;
      state.landingImpact = 0;
      return value;
    },
    consumeImpact() {
      const value = state.impactSpeed;
      state.impactSpeed = 0;
      return value;
    },
  };
}
