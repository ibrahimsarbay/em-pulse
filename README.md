# EM Pulse — Acil Tıp Makale Radarı

**Derin Soluk** projesi için günlük güncellenen acil tıp makale radarı.

Son 7 günde yayımlanan makaleleri PubMed'den çeker, etki skoruna göre sıralar.

---

## Kurulum

### 1. GitHub'a yükle

```bash
git init
git add .
git commit -m "em-pulse: ilk commit"
git remote add origin https://github.com/KULLANICI/em-pulse.git
git push -u origin main
```

### 2. GitHub Secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**

| Secret | Değer |
|--------|-------|
| `FTP_SERVER` | Hosting FTP sunucusu |
| `FTP_USERNAME` | FTP kullanıcı adı |
| `FTP_PASSWORD` | FTP şifresi |
| `FTP_REMOTE_DIR` | Örn: `/public_html/pulse/` |

### 3. İlk çalıştırma

Actions → **EM Pulse — Güncelle & Deploy** → **Run workflow**

Veri çekimi ~3-5 dakika sürer. Hazır olunca `public/data/pulse.json` oluşur ve FTP'ye yüklenir.

Bundan sonra her sabah 04:00 UTC (07:00 TR) otomatik güncellenir.

---

## Yapı

```
.
├── .github/
│   └── workflows/
│       └── update.yml          ← GitHub Actions: günlük fetch + FTP deploy
├── scripts/
│   └── fetch.js                ← PubMed → pulse.json
├── public/
│   ├── em-pulse.html           ← Frontend (siteye at)
│   └── data/
│       ├── pulse.json          ← fetch.js tarafından üretilir
│       └── meta.json           ← son güncelleme bilgisi
└── package.json
```

---

## Etki Skoru Hesabı

Her makalenin skoru 4 bileşenden oluşur:

| Bileşen | Katkı |
|---------|-------|
| **Dergi Tier** | T1: +30, T2: +18, T3: +8 |
| **Makale Tipi** | Kılavuz: +30, Meta-analiz: +25, RKÇ: +20, Derleme: +10, Özgün: +8 |
| **Güncellik** | Bugün: +10, Dün: +9, ... 7 gün: +2 |
| **Anahtar Kelime** | EM-kritik terimler varsa: +5 |

---

## Lokal Test

```bash
npm install
node scripts/fetch.js --force
# → public/data/pulse.json oluşur

# public/ klasörünü aç:
npx serve public
# → http://localhost:3000/em-pulse.html
```

---

## Dergi Eklemek

`scripts/fetch.js` dosyasındaki `JOURNALS` dizisine ekle:

```js
{ issn: '1234-5678', name: 'Yeni Dergi', tier: 2 },
```

Commit → Actions otomatik tetiklenir.
