/**
 * Tek merkezî ayar dosyası. Fizik, arazi ve iz sistemi aynı sabitleri okur —
 * dünya ölçeğiyle ilgili bir sayı değişecekse burada değişir.
 *
 * Birimler: metre, saniye, kilogram, radyan.
 */

export const WORLD = {
  /**
   * İzlerin kaydedildiği ve aracın sürebildiği alan. İz haritası dünya-sabit
   * olduğu için bu alan sonlu olmak zorunda: 512 m'lik kare, merkez orijinde.
   */
  playfield: 512,

  /** Yükseklik alanının kapsadığı kare (uzak arazi de bunun içinden beslenir). */
  heightExtent: 2048,
  /**
   * **Üretim** çözünürlüğü: 1024 örnek / 2048 m = 2 m/örnek. Gürültü ve aşınma
   * geçişi bu ızgarada çalışıyor. Daha yükseği hem üretimi hem on altı aşınma
   * geçişini dört katına çıkarır ve açılışı saniyelerce uzatırdı.
   */
  heightRes: 1024,
  /**
   * Üretimden sonra bikübik ile kaç kat büyütüleceği. Prosedürel arazi için
   * gereksiz (aşınmadan sonra en küçük dalga boyu ~15 m), ama **harita
   * editörü** doğrudan bu ızgarayı oyuyor: fırçanın çözebileceği en küçük
   * ayrıntı texel boyutuyla sınırlı. 2 kat → 1 m/texel, yani 5 m'lik bir rampa
   * bile tanınabilir şekilde şekillendirilebiliyor. Bedeli 0.4 sn açılış ve
   * 16 MB doku; üretimi ve aşınmayı hiç pahalılaştırmıyor.
   */
  heightDetail: 2,

  /** Kum tepelerinin tepe-dip genliği. */
  duneHeight: 26,
  /** Kumun duruş açısı (derece). Aşınma geçişi yamaçları bunun altına indirir. */
  angleOfRepose: 32,
  /** Hâkim rüzgâr yönü (tepe siluetlerinin eğimini ve kumun savruluşunu belirler). */
  windAngle: 0.62,

  /** Kameraya kilitli, izlerin gerçek geometri olarak çukurlaştığı kabuk. */
  nearPatch: 64,
  /**
   * Orta kabuk oynanabilir alandan (512 m) geniş tutuluyor: böylece orta/uzak
   * dikişi, 300 m'deki çanak kenarının ötesine düşüyor ve içeriden bakınca
   * tepenin arkasında kalıyor.
   */
  midSize: 768,
  /**
   * 2 m/vertex. Pürüzsüz kum tepelerinde bu çözünürlüğün gerçek yüzeyden
   * sapması santimetrenin altında kalıyor; daha yoğun bir ızgara sadece gölge
   * geçişini pahalılaştırırdı.
   */
  midSegments: 384,
  /** Ufku dolduran uzak kabuk. */
  farSize: 3072,
  farSegments: 192,
};

/** İz haritasının bir metreye düşen texel sayısı (kalite ön ayarına göre değişir). */
export const trackPixelsPerMeter = (trackRes) => trackRes / WORLD.playfield;

export const QUALITY_PRESETS = {
  ultra: {
    label: 'Ultra',
    trackRes: 4096,
    nearSegments: 512,
    shadowMapSize: 4096,
    particleScale: 1,
    postFx: true,
    ambientOcclusion: true,
    /**
     * Post-process zincirinin ara tamponundaki örnek sayısı. `antialias: true`
     * yalnız doğrudan ekrana çizildiğinde işe yarıyor; composer devredeyken
     * sahne bir render target'a çiziliyor ve o bayrağın hiçbir etkisi kalmıyor.
     * Kenar kırıklığının asıl kaynağı da burası: kum tepesinin gökyüzüne karşı
     * silueti ve ağaç dalları.
     */
    msaa: 8,
    maxPixelRatio: 2,
    propDensity: 1,
  },
  yuksek: {
    label: 'Yüksek',
    // 3072 texel / 512 m ≈ 6 texel/m: bir lastik izi ~2 texel genişliğinde
    // düşüyor. 2048'de iz tek texele sıkışıp bulanık bir şeride dönüşüyordu.
    trackRes: 3072,
    nearSegments: 384,
    shadowMapSize: 2048,
    particleScale: 0.7,
    postFx: true,
    ambientOcclusion: true,
    msaa: 4,
    maxPixelRatio: 1.5,
    propDensity: 0.8,
  },
  orta: {
    label: 'Orta',
    trackRes: 1536,
    nearSegments: 256,
    shadowMapSize: 1024,
    particleScale: 0.45,
    postFx: false,
    ambientOcclusion: false,
    msaa: 0,
    maxPixelRatio: 1,
    propDensity: 0.5,
  },
};

export const DEFAULT_QUALITY = 'yuksek';

/**
 * Jip ayarları. Wrangler benzeri kısa dingilli, 33" lastikli, ağır bir arazi
 * aracı: yüksek ağırlık merkezi yalpayı belirgin yapar, kısa dingil çevikleştirir.
 */
export const VEHICLE = {
  mass: 1780,
  /** Atalet tensörü çarpanları (kutu yaklaşımı üzerinden elle ayarlandı). */
  inertiaScale: { x: 1.35, y: 1.0, z: 1.6 },

  wheelBase: 2.46,
  /** Geniş iz: devrilme eşiğini doğrudan yükselten en ucuz kaldıraç. */
  trackWidth: 1.74,
  wheelRadius: 0.42,
  wheelWidth: 0.33,
  /**
   * Ağırlık merkezinin **yüksüz** tekerlek merkezine göre yüksekliği.
   *
   * Bu sayı devrilmeyi belirliyor: statik devrilme katsayısı (SSF) =
   * yarı-iz / yerden ağırlık merkezi yüksekliği. Araç ancak yanal ivme SSF'yi
   * aştığında devrilir. İlk değerle (0.51) SSF 1.05 çıkıyordu ve lastik
   * tutuşuyla tam olarak aynıydı — yani her tam tutuşlu viraj bir takla
   * adayıydı.
   *
   * 0.24'te yüklü ağırlık merkezi yerden 0.47 m'de ve SSF ≈ **1.85**. Tutuş
   * 1.55'e çıkarıldığı için pay yine 0.3 civarında: araç yola daha sıkı
   * tutunuyor ama devrilme eşiği tutuşun üstünde kalıyor.
   *
   * Görünen duruş değişmiyor: jip modeli gövdeyi `STATIC_RIDE_HEIGHT`e göre
   * kuruyor, yani fizik orijini alçalırken gövde aynı oranda yukarı kayıyor.
   */
  comHeight: 0.24,
  /** Ağırlık merkezinin dingiller arasındaki konumu (0 = ön aks, 1 = arka aks). */
  comBias: 0.47,

  /**
   * Uzun kurslu, yumuşak arazi süspansiyonu. Statik çöküş 19 cm, toplam kurs
   * 45 cm: tekerlekler tümsek ve çukurlarda gözle görülür şekilde çalışıyor,
   * gövde dalgalı zeminde de dört tekerleğini zeminde tutuyor.
   */
  suspension: {
    restLength: 0.62,
    maxTravel: 0.45,
    stiffness: 23000,
    /**
     * Sönümleme yükseltildi. Yay sertliği aynı bırakıldı — istenen şey uzun
     * kurslu, tümsekte gerçekten çalışan bir süspansiyondu — ama az sönümlenen
     * yay, tümsekten sonra iki üç kez salınıp aracı "yüzer" gösteriyordu.
     * Sönümleme kursu kısaltmıyor, yalnız salınımı tek harekette bitiriyor.
     */
    dampingCompress: 4000,
    dampingRebound: 3100,
    /** Yay kuvvetinin bir karede aktarabileceği üst sınır (patlamaları önler). */
    maxForce: 90000,
  },

  /**
   * Denge çubukları. Alçalan ağırlık merkezi ve yükselen tutuşla birlikte
   * artırıldı: yalpayı kesiyor ama artikülasyonu öldürecek kadar sert değil.
   */
  antiRoll: 5400,

  engine: {
    /** Devir başına tork eğrisi (d/dak → Nm), lineer interpolasyon. */
    torqueCurve: [
      [800, 250],
      [1500, 340],
      [2400, 415],
      [3200, 430],
      [4000, 395],
      [4800, 320],
      [5600, 210],
    ],
    idleRpm: 850,
    maxRpm: 5600,
    /** Otomatik vites geçiş eşikleri. */
    shiftUpRpm: 4700,
    shiftDownRpm: 1900,
    gearRatios: [3.59, 2.19, 1.41, 1.0, 0.83],
    reverseRatio: 3.16,
    finalDrive: 4.1,
    /** Düşük vites (4L) çarpanı — Shift ile devreye girer. */
    lowRangeMultiplier: 2.72,
    flywheelInertia: 0.42,
    engineBraking: 22,
  },

  brakes: {
    maxTorque: 5200,
    handbrakeTorque: 7200,
    /** Fren dengesi (0 = tamamen arka, 1 = tamamen ön). */
    bias: 0.62,
  },

  steering: {
    maxAngle: 0.56,
    /** Direksiyonun sonuna kadar dönme süresi (s). */
    speed: 3.0,
    returnSpeed: 4.6,
    /** Hız arttıkça direksiyon açısını kısan eğri (m/s cinsinden yarı-değer). */
    speedFalloff: 14,
    /** Yüksek hızda kalan en küçük direksiyon oranı. */
    minTrim: 0.28,
    /**
     * Karşı direksiyon yardımının gücü (rad direksiyon / (rad/s sapma hatası)).
     *
     * Gerçek bir direksiyonda ön tekerleklerin kendiliğinden hizalanma torku,
     * araç savrulmaya başladığında direksiyonu doğru yöne itiyor; sürücü
     * genelde o itişe izin vererek karşı direksiyon veriyor. Klavyede bu geri
     * bildirim hiç yok — araç bir kez döndü mü tuşla yakalamak imkânsız.
     *
     * Ölçüt, aracın istenenden fazla dönmesi (bkz. `sim/vehicle.js`); düzgün
     * bir virajda yardım sıfır kalıyor. El freni çekiliyken tamamen devre dışı:
     * kasten atılan drift'e karışmamalı.
     */
    counterAssist: 0.35,
    /** Ölü bant (rad/s) — lastik gürültüsü direksiyonu titretmesin. */
    counterDeadband: 0.16,
    /** Yardımın uygulanmaya başladığı hız (m/s) — park manevrasına karışmasın. */
    counterMinSpeed: 4,
  },

  /** Aerodinamik ve tekerlek dönüş ataleti. */
  dragCoefficient: 0.92,
  frontalArea: 2.85,
  wheelInertia: 2.4,

  /**
   * Zemin davranışının taban değerleri. Bölgeye göre (kum, orman toprağı, kar,
   * patika) `config/biomes.js` içindeki çarpanlarla ölçeklenir.
   */
  sand: {
    /** Normal kuvvete oranla yuvarlanma direnci. */
    rollingResistance: 0.052,
    /** Tekerleğin zemine batma derinliğini belirleyen basınç katsayısı. */
    sinkage: 0.055,
    /** Batan tekerleğin ek sürükleme direnci. */
    bogDrag: 1.8,
    /** Tepe sürtünme katsayısı. Devrilme eşiği (SSF ≈ 1.85) bunun üstünde. */
    peakGrip: 1.55,
    /**
     * Kayma büyüdükçe düşülen seviye. Tepeye yakın tutulması, savrulan aracın
     * kendini toparlayabilmesi demek; düşük bırakılınca araç bir kez kaydı mı
     * geri dönmüyordu.
     */
    slideGrip: 1.3,
    /**
     * El freniyle duran aracı yerinde tutan **statik** sürtünme katsayısı.
     * Gerçekte statik sürtünme kinetikten yüksek; buradaki pay, park frenli
     * aracın yamaçta kaymamasını sağlayan şey. Bu katsayının izin verdiğinden
     * daha dik bir yamaçta araç yine kayar — kelepçe fizikselliğini koruyor.
     */
    holdGrip: 1.9,
  },

  /** Havadayken gövdeye uygulanan sönümleme ve hafif yön kontrolü. */
  airControl: 1.4,
  airDamping: 0.32,

  /**
   * Devrilmeye karşı yardımlar. Alçak ağırlık merkezi düz zeminde takla atmayı
   * zaten imkânsız kılıyor; geriye kalan riskli an, tepeden havalanıp yan
   * yatmış halde inmek. Bunlar o anı yumuşatıyor.
   */
  stability: {
    /** Zeminde yalpa hızını söndüren katsayı (1/s). */
    rollDamping: 3.8,
    /**
     * El freni tutuşunun tam güce ulaştığı hız (m/s). Bunun üstünde el freni
     * yine sadece arka tekerlekleri kilitliyor — drift aracı olmaktan çıkmasın.
     */
    holdSpeed: 2.2,
    /** Havadayken aracı ufka paralel getiren yardım (rad/s²). */
    airLevel: 2.6,
    /** Aynı yardımın sönümleme terimi — salınmasını engeller. */
    airLevelDamping: 1.9,
    /** Ters dönen araç kaç saniye sonra kendini toplasın. */
    autoRightDelay: 2.5,
  },
};

export const KEYS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  lowRange: ['ShiftLeft', 'ShiftRight'],
  camera: ['KeyC'],
  headlights: ['KeyF'],
  photo: ['KeyP'],
  panel: ['KeyT'],
  reset: ['KeyR'],
  editor: ['KeyM'],
  network: ['KeyN'],
};

/**
 * Statik sürüş yüksekliği: yüklü haldeki ağırlık merkezinin zeminden yüksekliği.
 * Jip modeli gövdeyi bu ölçüye göre kuruyor.
 */
export const STATIC_RIDE_HEIGHT =
  VEHICLE.wheelRadius +
  VEHICLE.comHeight -
  (VEHICLE.mass * 9.81) / 4 / VEHICLE.suspension.stiffness;

/** Simülasyon sabit adımı — yay kuvvetlerinin kare hızından bağımsız kalması için. */
export const FIXED_DT = 1 / 240;
/** Bir karede işlenebilecek en fazla alt adım (sekme arkaplandayken spiral engeli). */
export const MAX_SUBSTEPS = 12;
