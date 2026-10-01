# Arazi Jip Simülasyonu

Dört bölgeli bir haritada jip süren, aracın hareketine göre zeminde **kalıcı
lastik izleri** bırakan bir tarayıcı simülasyonu. Haritayı içinden düzenlemek
için bir editör ve odada birlikte sürmek için bir ağ katmanı içeriyor.
Vite + Three.js, tek çalışma zamanı bağımlılığı `three`.

```bash
npm install
npm run dev
```

## Kontroller

| Tuş | İşlev |
|---|---|
| `W` / `S` | Gaz / fren (durunca geri vites) |
| `A` / `D` | Direksiyon |
| `Boşluk` | El freni — hızlıyken drift, dururken park freni |
| `Shift` | Düşük vites (4L) — dik yokuşlar için |
| `C` | Kamera: takip / kaput / kokpit |
| `F` | Farlar |
| `T` | Zaman & hava paneli |
| `P` | Fotoğraf modu |
| `M` | **Harita editörü** |
| `N` | **Çok oyunculu panel** |
| `R` | Aracı sıfırla |

### Editörde

| Giriş | İşlev |
|---|---|
| Sol tık | Seçili fırçayı uygula |
| Sağ tık sürükle | Kamerayı döndür |
| Orta tık sürükle | Kamerayı kaydır |
| Tekerlek | Yakınlaştır |
| `Ctrl` + tekerlek | Fırça boyu |
| `Shift` + tekerlek | Fırça gücü |
| `Ctrl` + `Z` | Geri al |

## Harita: dört bölge

Harita dört çeyreğe ayrılır — **çöl**, **orman**, **karlı**, **çayır** — ve
sınırlar gürültüyle bükülüp birbirine karışır. Çayır bölgesinde dolanan bir
toprak **patika** var.

Bölgeye göre değişen her şey `src/config/biomes.js` içinde **veri** olarak
duruyor: arazi biçimi (genlik, sırt keskinliği, duruş açısı), zemin renkleri,
pürüzlülük, iz derinliği, hangi nesnelerin serpileceği ve **lastik tutuşu**.
Kar belirgin şekilde kaygan, çayır ve patika kumdan tutuşlu — sürücü bölge
değiştirdiğini renkten önce direksiyondan anlar. İleride bir harita üretim
aracı yazıldığında üreteceği şey tam olarak bu yapı; motor tarafında
değiştirilecek kod yok.

Bölge ağırlıkları hem CPU dizisi (fizik, nesne serpme, arayüz) hem RGBA dokusu
(zemin shader'ı) olarak servis edilir; dört palet tek materyalde, tek programda
harmanlanır.

## Harita editörü

`M` ile sürüşten editöre geçilir: simülasyon durur, kamera serbest kalır, sol
tık fırçaya bağlanır. Fırçalar üç grup:

- **Arazi** — yükselt, alçalt, düzle, yumuşat, pürüzlendir.
- **Bölge** — zemini dört bölgeden birine boyar. Renk değişmez, **tutuş da
  değişir**: kara boyanan bir yamaç gerçekten kayganlaşır.
- **Nesne** — seçili türü fırça alanına serper, siler; ya da doğuş noktasını
  taşır.

### Belge biçimi

Kaydedilen şey yükseklik ızgarası değil, prosedürel arazinin üstüne uygulanan
**fırça darbesi listesi** (`src/map/mapDoc.js`). Yükleme, araziyi el değmemiş
haline döndürüp darbeleri sırayla yeniden oynatmak demek. Üç kazancı var:

1. Belge düz JSON — Firebase Realtime Database'e olduğu gibi yazılabiliyor.
2. Çok oyunculuda haritayı yeniden göndermek yerine **tek darbe** yollamak
   yetiyor.
3. Geri alma bedava: listenin sonunu at, baştan oyna.

Bedeli, darbelerin sıraya bağlı olması — `yumuşat` ve `düzle` o anki yüzeyi
okuyor, dolayısıyla aradan tek bir darbe çıkarılamıyor.

Nesneler ise açıkça, tek tek saklanıyor (prosedürel serpme, editöre girildiğinde
belgeye somutlaştırılıyor). Dosyanın büyük kısmını bu liste tutuyor: ~1900
nesneli bir harita ~145 KB. Karşılığında serpilmiş her ağaç da silinebiliyor.

Haritalar `localStorage`'a kaydediliyor ve JSON dosyası olarak dışa/içe
aktarılabiliyor.

### Arazi ızgarası

Arazi 1024² ızgarada üretilip aşındırılıyor, sonra bikübik ile **2048²'ye
büyütülüyor** (1 m/texel). Prosedürel arazi için gereksiz — aşınmadan sonra en
küçük dalga boyu ~15 m — ama fırçanın çözebileceği en küçük ayrıntı texel
boyutuyla sınırlı. Büyütme üretimi ve on altı aşınma geçişini hiç
pahalılaştırmıyor; bedeli 0.4 sn açılış ve 16 MB doku.

Fırça sürüklenirken dokunun tamamını yüklemek 2048² R32F'te kare başına 16 MB
demek olurdu; `copyTextureToTexture` ile yalnız kirlenen dikdörtgen gidiyor.
Sürükleme bitince ufuk haritası (gölgeler ve örtme) yeniden pişiriliyor — o
harita "arazi değişmez" varsayımı üzerine kurulu.

## Çok oyunculu

`N` ile açılan panelden bir odaya girilir. Otorite yok: her istemci kendi
aracını simüle edip sonucu yayınlıyor. Otoriter bir sunucu, 240 Hz'lik araç
fiziğini sunucuda çalıştırmayı ve girdi tahmini/geri sarma kurmayı
gerektirirdi; bu oyunda kazandıracağı tek şey başkasının aracına çarpmak
olurdu, ki araçlar zaten birbirinin içinden geçiyor.

- `net/protocol.js` — mesaj tipleri ve araç durumunun düz diziye paketlenmesi.
  Süspansiyon uzunlukları ve tekerlek dönüşleri de gidiyor; onlarsız uzak jip
  zeminde süzülen bir kutu gibi görünüyor. Temas ve kayma bilgisi de var:
  **uzak araçlar da iz bırakıyor.**
- `net/transport.js` — taşıma arayüzü. `BroadcastChannelTransport` sunucusuz,
  sekmeler arası gerçek çok oyunculu veriyor (ikinci bir sekme açıp aynı oda
  adını girin); `LoopbackTransport` gecikme, jitter ve paket kaybı taklit eden
  botlarla ağ kodunu tek sekmede sınıyor.
- `net/remotePlayers.js` — anlık görüntüler doğrudan uygulanmıyor; sahne iki
  paket süresi **geriden** oynatılıp aradaki interpolasyonla dolduruluyor.
  20 Hz'lik bir akışı doğrudan uygulamak, uzak aracı saniyede yirmi kez
  ışınlanan bir şeye çevirir. Zaman damgası olarak gönderenin saati değil
  paketin varış anı kullanılıyor — saat senkronu gerekmiyor.
- `net/firebaseTransport.js` — Firebase RTDB adaptörü, aynı arayüzü uyguluyor.
  `npm install firebase` ve yapılandırma yeterli. Veri düzeninin kritik ayrımı:
  **anlık görüntüler `set`, olaylar `push`** — saniyede yirmi kez kuyruğa
  yazılsa oda birkaç dakikada yüz binlerce düğüm biriktirir.

Harita, katılımda bir kez tam olarak, sonrasında fırça darbesi başına
senkronlanıyor. Kimin göndereceği kimlik sıralamasıyla çözülüyor (odadaki en
küçük kimlik), böylece merkezî bir otorite olmadan tek kopya gidiyor.

## Nasıl çalışıyor

### İz sistemi

İzler zemine yapıştırılmış bir doku değil; dünya-sabit bir render target'ta
biriken bir yükseklik alanı.

- `render/trackMap.js` — 512 m'lik oynanabilir alanı kaplayan kalıcı RT.
  Her fizik alt adımında her tekerlek için `önceki → şimdiki` temas noktası
  arasına bir kapsül damgalanır (additive blend, `autoClear = false`).
  Kanallar: **R** oyuk derinliği · **G** kenara savrulan malzeme · **B**
  sıkışma · **A** tazelik.
- Rüzgâr aşınması tek bir tam ekran quad'ı ile `ReverseSubtract` blend
  kullanarak uygulanır. 8 bit hassasiyette bir karelik aşınma sıfıra
  yuvarlandığı için, aşınma CPU'da "borç" olarak birikip eşiği aşınca tek
  seferde uygulanır; kalan hata dither ile dağıtılır.
- `render/sandMaterial.js` haritayı hem **vertex yer değiştirmesi** (yakın
  kabukta gerçek çukur) hem de **fragment normali** olarak okur. Lastik dişi
  deseni, iz haritası çözünürlüğünden ince olduğu için fragment'ta prosedürel
  üretilir; yönünü oyuğun kendi gradyanından alır.
- `sim/rutfield.js` — aynı damgaların CPU'daki ikizi. Süspansiyon ray-cast'i
  bunu okuduğu için araç kendi bıraktığı ize oturur. Mini-harita da buradan
  çizilir.

### Arazi

- `sim/heightfield.js` açılışta tek bir yükseklik alanı üretir ve hem fiziğe
  (CPU dizisi) hem shader'a (`R32F` doku) aynı Catmull-Rom bikübik filtresiyle
  servis eder — fizik ile görüntünün ayrışması mümkün değil.
- Her bölgenin arazisi aynı parametrik katmandan farklı ayarlarla çıkar ve
  ağırlıklarla harmanlanır.
- Ham fraktal gürültü 60-80°'lik duvarlar üretip kaya gibi göründüğü için,
  üretimden sonra **termal aşınma** geçişi uygulanır: zeminin duruş açısını
  (kum 32°, orman toprağı 40°) aşan her yamaçtan malzeme alınıp aşağı taşınır.
  Çölün karakteristik biçimi — yatık rüzgâr yüzü, keskin tepe çizgisi, dik
  kayma yüzü — buradan çıkar.
- `render/terrain.js` üç iç içe kabuk kullanır: 64 m yakın (0.125 m/vertex,
  kameraya kilitli), 768 m orta, 3072 m uzak. Dıştaki kabuk içtekinin ayak
  izinde `discard` eder; içteki kabuğun dış halkası aşağı sarkan bir "etek"e
  dönüşerek dikişi kapatır.

### Işıklandırma: ufuk haritası

Tarayıcıda donanım ışın izleme (RTX/DXR) yok — ne WebGL2'de ne de WebGPU'nun
yayınlanmış sürümünde. Ama arazi üçgen çorbası değil bir **yükseklik alanı**
olduğu için ışını BVH yerine dokuda yürütebiliyoruz.

Yine de her kare, her piksel için güneşe doğru adım atmak 1080p'de yüz
milyonlarca doku okuması demek. Arazi statik olduğundan bu iş açılışta bir kez
yapılıyor (`render/horizonMap.js`): her noktada, sekiz azimut yönünde ufkun
tanjantı GPU'da pişirilip iki RGBA dokusuna sıkıştırılıyor.

Saklanan şey gölge değil **ufuk profili** — güneş saat kaydırıcısıyla gezdiği
için gölge, o anki yükseklik tanjantı ile o yöndeki ufuk tanjantının
karşılaştırılmasından çıkıyor. Sonuç: menzil sınırsız, gölge haritası kademesi
yok, gölge sızması ve akne yok, çalışma zamanı maliyeti iki doku okuması.

Aynı profilden ortam örtme de bedavaya geliyor: sekiz yöndeki ufkun kapattığı
gökyüzü oranı.

Bunun yan etkisi: **arazi artık gölge haritasına yazmıyor**. İkisi birlikte
çalışsaydı yakın plandaki tepe gölgeleri iki kez uygulanırdı. Karşılığında her
karede 400 bin vertex'lik bir derinlik geçişi tamamen kalktı. Gölge haritası
artık yalnız ağaç, kaya ve aracın gölgesini taşıyor; arazinin gölgesi ise aynı
ufuk aramasıyla onlara da uygulanıyor (`render/terrainShadow.js`).

Temas ölçeğindeki örtme için ayrıca `GTAOPass` var. Kendi normal/derinlik
tamponunu `scene.overrideMaterial` ile çizdiği için araziyi düz bir tabla
olarak görürdü; bu yüzden G-tamponunu `render/gbuffer.js` kendisi çiziyor ve
araziye yer değiştirmesini taşıyan bir normal materyali veriyor.

### Görüntü zinciri

- **Kenar yumuşatma.** `antialias: true` yalnız doğrudan ekrana çizerken
  geçerli; sahne composer'ın hedefine çizildiği anda etkisi kalmıyordu. Ara
  tampon elle, çok örnekli kuruluyor (Ultra 8×, Yüksek 4×). Kum tepesinin
  gökyüzüne karşı silueti ve ağaç dalları en çok bundan kazanıyor.
- **Ton eşleme AgX.** ACES parlak alanları doyurup beyaza çekiyordu — kar
  tamamen düzleşiyor, gün batımında gökyüzü turuncu bir lekeye dönüyordu.
- **"Look" katmanı.** AgX'in bedeli belirgin şekilde nötr oturması: altın
  saatteki kumun sıcaklığını yutuyordu. Doygunluk ve kontrast, ton eşlemeden
  önce doğrusal HDR tamponda geri veriliyor — sinema hattındaki
  "tone mapper + look" ayrımının aynısı.
- **Keskinleştirme.** Çizim tamponu ekrandan büyük olduğunda (pixelRatio 1.5)
  küçültme adımı kumun dalgacıklarını ve iz kenarlarını yumuşatıyordu. Ters
  keskinlik maskesi bloom'dan sonra uygulanıyor ki parlama halkalarının kenarını
  çizmesin.
- **Rüzgâr salınımı.** Bitki örtüsü rüzgârda salınıyor; salınımın gücü örnek
  başına bir nitelikten geliyor, böylece aynı materyali paylaşan kaya ve kütük
  hiç kıpırdamıyor. Faz örneğin dünya konumundan türetiliyor — aksi halde çayır
  tek parça bir örtü gibi dalgalanıyordu.

### Araç

`sim/vehicle.js` — harici fizik motoru yok. Ray-cast süspansiyonlu rijit gövde,
sabit 240 Hz alt adım. Lastik modeli (`sim/tire.js`) boyuna ve yanal kaymayı
tek bir bileşik kayma vektöründe birleştirir, böylece sürtünme dairesi
kendiliğinden korunur. Tork dağılımı yüke orantılıdır (kilitli 4x4 davranışı):
havalanan tekerlek torku yutmaz.

**Devrilme dengesi.** Araç ancak yanal ivme statik devrilme katsayısını
(SSF = yarı-iz / yerden ağırlık merkezi yüksekliği) aştığında devrilir. Ağırlık
merkezi alçak, iz geniş tutuluyor: SSF ≈ **1.85**, lastik tutuşu ise en fazla
**1.55**. Aradaki pay sayesinde düz zeminde takla atmak imkânsız — ölçüldü:
60 saniyelik tam gaz slalomda sıfır takla, en fazla 13° gövde yatışı, dört
tekerlek zamanın %89'unda zeminde. Geriye kalan risk — tepeden yan yatmış halde
havalanıp o şekilde inmek — havada devreye giren yumuşak bir düzleştirme
yardımıyla karşılanıyor; yine de ters dönerse araç 2.5 saniye sonra kendini
toplar.

Tutuşu yükseltmenin bedeli devrilme payından ödendiği için ikisi birlikte
ayarlanıyor: ağırlık merkezi 4 cm indirilip SSF 1.7'den 1.85'e çıkarıldı, tutuş
da 1.35'ten 1.55'e. Fren ölçümünde yavaşlama tavanı 1.4 g'den 1.6 g'ye çıktı —
tam olarak katsayıların söylediği kadar.

**Park freni.** Kilitli tekerlek tek başına aracı yerinde tutmuyor: lastik
modeli ω = 0 iken bile kayma oranı üzerinden kuvvet üretiyor ve o kuvvet yamaç
boyunca yerçekimini tam dengelemiyor. Gerçekte bunu **statik sürtünme** yapıyor —
yüzeyler kaymaya başlamadığı sürece kuvvet, ihtiyaç neyse o oluyor.

`Boşluk` neredeyse durmuş bir araçta bunu modelliyor: yamaç boyunca kalan
bileşke ve artık hız, statik sürtünme bütçesiyle (μ · toplam düşey yük)
kelepçelenerek iptal ediliyor, dört tekerlek birden kilitleniyor. Ölçüldü —
8°'den 48°'ye kadar yamaçlarda on saniyede **3 mm'nin altında** kayma; el freni
olmadan aynı yamaçlarda 0.9 ile 106 m arası. Yüksek hızda tutuş devrede değil:
el freni orada hâlâ yalnız arkayı kilitleyen bir drift aracı.

Yalnız hızı iptal etmek yetmiyordu — her adımda yerçekimi g·sinθ·dt kadar yeni
hız üretiyor, bir sonraki adım onu kesiyor ve araç adım başına o kadar yol
alıyordu: 8°'lik yamaçta on saniyede 6 cm sürünme. Bileşke kuvvetin kendisi de
iptal edilince sürünme ölçülemez hale geldi.

**Karşı direksiyon yardımı.** Gerçek bir direksiyonda kendiliğinden hizalanma
torku, araç savrulmaya başladığında direksiyonu doğru yöne itiyor; klavyede bu
geri bildirim hiç yok ve araç bir kez döndü mü tuşla yakalamak imkânsız. Ölçüt
olarak **sapma hızı hatası** kullanılıyor: bisiklet modeliyle beklenen sapma
hızı `v·tan(δ)/L`, gerçek sapma hızının bunu aşması arkanın kaydığı anlamına
geliyor. Düzgün bir virajda hata sıfır, yardım da sıfır. (İlk denemede ölçüt
gövdenin kayma açısıydı ve yanlıştı — o açı düzgün virajda da sıfırdan farklı,
dolayısıyla yardım her viraja karışıp direksiyonu kesiyordu.) El freni
çekiliyken tamamen devre dışı: kasten atılan drift'e karışmamalı.

**Tekerlek dinamiği.** Lastik kuvvetinin kayma oranına duyarlılığı düşük hızda
o kadar yüksek ki açık Euler ile 240 Hz bile kararsız. Tekerlek açısal hızı bu
yüzden yarı-örtük çözülür: lastik kuvvetinin ω'ya göre **yerel** eğimi sayısal
olarak ölçülüp integrasyona sönümleme olarak girer. Fark adımının küçük olması
kritik — geniş bir adım eğriyi doyma bölgesine kadar tarayıp eğimi olduğundan
küçük gösteriyor, sönümleme yetersiz kalınca araç tam gazda yerinde titriyor.
Eğim negatife döndüğünde (lastik doyduğunda) sıfıra kelepçelenir; gerçek
patinaj bastırılmaz, yalnız sayısal patlama engellenir.

### Ses

`sim/audio.js` — ses dosyası yok, her şey WebAudio ile sentezleniyor. Sebebi
indirme boyutu değil **sürekli değişkenlik**: kayıttan çalınan bir motor sesi
devir aralığında ya hızlandırılıyor (ciyaklama) ya çapraz karıştırılıyor (nefes
nefese geçişler). Sentezde devir doğrudan frekans, yük doğrudan filtre kesim
noktası; ikisi de kesintisiz.

Beş kanal: motor, patinaj (bant geçiren gürültü, merkez frekansı zeminin
tutuşuyla kayıyor — kumda hışırtı, sert zeminde cıyaklama), yuvarlanma, rüzgâr
ve tek atımlı darbe zarfı. Hepsi tek bir gürültü tamponunu paylaşıyor, çıkışta
yumuşak bir sınırlayıcı var.

**Motorun tonu.** İlk sürüm ince ve vızıltılıydı, üstelik devirden bağımsız gibi
duyulan sürekli bir uğultusu vardı. Üç değişiklik:

- **Duyulamayan altı kesildi.** Altı silindirli bir motorun temel frekansı
  rölantide (850 d/dak) 42 Hz'e düşüyor; bir de yarım frekanstan çalan bir alt
  osilatör vardı, yani 21 Hz. O bölgede kulak neredeyse hiçbir şey duymuyor ama
  hoparlör çalışıyor — sonuç dipsesli bir uğultuydu. Alt osilatör kaldırıldı,
  çıkışa 58 Hz'lik bir yüksek geçiren kondu. Tını bozulmuyor: motorun karakterini
  üst harmonikler taşıyor.
- **Dalga tablosu.** Testere dişi bütün harmonikleri 1/n ile zayıflatıyor.
  Yerine, 2. ve 3. harmoniği öne çıkarıp yukarısını hızla söndüren özel bir
  `PeriodicWave` kondu — gövde buradan geliyor.
- **Doyum ve gövde rezonansı.** Yükle sürülen yumuşak kırpma (egzozun hırıltısı
  bu doğrusalsızlıktan geliyor) ve devirle kayan bir tepe filtre (ses kutusu
  etkisi).

Spektrumla doğrulandı: rölantide enerji 60–160 Hz bandında, 20–50 Hz bandı onun
7 dB altında; tam gazda 600 Hz–3 kHz bandı **32 dB** yükseliyor, yani ses yükle
gerçekten açılıyor. Rüzgâr kanalı da artık fırtına şiddetine bağlı — eskiden
sakin havadaki 3.5 m/s'lik taban rüzgârdan sürekli bir tıslama geliyordu.

Tarayıcılar ses bağlamını kullanıcı etkileşimi olmadan başlatmıyor; ilk tuş ya
da tıklamada açılıyor. Sekme arka plana geçince susuyor.

### Nesne çarpışması

`sim/propField.js` her kayayı, ağaç gövdesini ve kaya oluşumunu bir
**elipsoid** ile temsil eder ve düzgün bir ızgaraya kaydeder. İki ayrı bayrak
iki ayrı soruyu yanıtlar:

- `blocksWheel` — tekerlek ışını bunu görür, araç **üstüne biner**. Küçük
  kayalar böylece aracı sarsar, süspansiyon çalışır.
- `blocksBody` — gövdeyi temsil eden dört küre buna **giremez**. Girişim hem
  konum düzeltmesiyle hem temas noktasına uygulanan darbeyle çözülür: köşesiyle
  kayaya çarpan araç savrulur, ortadan çarpan durur.

## Bilinen sınırlar

- İzlerin kalıcı olması dünya-sabit bir iz dokusu gerektirdiği için sürülebilir
  alan 512 m ile sınırlı (her bölgeye 256×256 m). Sınırda doğal bir çanak
  kenarı yükselir; uzak kabuk ve sis ötede devam ettiği için ufuk sonsuz
  görünür.
- Kalite ön ayarını değiştirmek iz haritasını yeniden kurar ve mevcut izleri
  siler.
- Ufuk haritası 512² çözünürlükte, 2048 m üzerinde 4 m/texel. Gölge kenarı bu
  ölçekte yumuşak; yarı gölge bandı bunu gizliyor ama keskin bir gölge çizgisi
  beklenmemeli. Çözünürlüğü artırmak pişirme maliyetini dörde katlıyor ve zayıf
  GPU'larda tarayıcının sürücü zaman aşımına takılabiliyor.
- Ufuk sekiz azimut yönünde örnekleniyor ve aradaki açılar interpolasyonla
  bulunuyor; çok uzun gölgelerde yön kuantalanması hafifçe fark edilebilir.
- Ufuk haritası **statik araziyi** varsayar. İzler zemini birkaç santim
  çukurlaştırıyor ama haritaya yansımıyor — bu ölçekte gölgeyi etkilemiyor.
- GTAO ek bir normal/derinlik geçişi gerektiriyor; "Orta" kalitede kapalı.
- Rüzgâr aşınması bölgeden bağımsız tek bir hızda çalışır; bölgeye göre değişen
  şey izin **derinliği**, silinme hızı değil.
- Fırçanın çözebileceği en küçük ayrıntı 1 m (arazi ızgarasının texel boyu);
  altındaki fırça boyları bikübik filtrenin altında yumuşayarak kayboluyor.
- Fırça darbeleri sıraya bağlı: aradan tek bir darbe çıkarılamıyor, geri alma
  hep listenin sonundan.
- Editörde yapılan bölge boyaması nesne serpmesini değiştirmiyor: çöl kumuna
  kar boyanınca zemin ve tutuş değişiyor ama kuru çalılar yerinde kalıyor.
- Çok oyunculuda araçlar birbirinin içinden geçiyor; uzak araçlar iz bırakıyor
  ama çarpışma gövdesi taşımıyor.
- Ufuk haritasının yeniden pişirilmesi tüm haritayı kapsıyor; büyük bir fırça
  darbesinden sonra gölgelerin oturması yarım saniye alıyor.

## Dosya düzeni

```
src/
  main.js               kurulum + sabit adımlı ana döngü
  config/
    settings.js         dünya, araç, kalite ve tuş ayarları
    biomes.js           bölge tanımları ve patika (harita verisi)
  sim/                  heightfield, rutfield, propField, surface,
                        vehicle, tire, engine, input, weather, audio
  map/                  mapDoc (belge biçimi), terrainBrush, editor
  net/                  protocol, transport, firebaseTransport,
                        session, remotePlayers
  render/               scene, terrain, sandMaterial, glsl, trackMap,
                        horizonMap, terrainShadow, gbuffer,
                        jeepModel, wheels, particles, props, propKinds,
                        cameraRig
  ui/                   hud, controlsPanel, editorPanel, netPanel,
                        photoMode, style.css
  utils/                math, noise, geometry
```

Hata ayıklarken `window.desert` üzerinden sahneye erişilebilir;
`desert.tick(dt)` simülasyonu elle sabit adımlarla sürer.
