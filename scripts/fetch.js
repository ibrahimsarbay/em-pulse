/**
 * EM Pulse — fetch.js
 * 
 * PubMed'den son 7 günün acil tıp makalelerini çeker,
 * etki skoru hesaplar, JSON olarak kaydeder.
 *
 * Kullanım:
 *   node scripts/fetch.js          → sadece yeni veri varsa güncelle
 *   node scripts/fetch.js --force  → zorla güncelle
 *
 * Çıktı:
 *   public/data/pulse.json   → skorlanmış makale listesi
 *   public/data/meta.json    → son güncelleme bilgisi
 */

import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, '..', 'public', 'data');
const OUT_FILE   = path.join(DATA_DIR, 'pulse.json');
const META_FILE  = path.join(DATA_DIR, 'meta.json');
const HIST_FILE  = path.join(DATA_DIR, 'history.json');
const SCIMAGO_CSV = path.join(__dirname, '..', 'data', 'scimago.csv');

const DAYS_BACK  = 7;
const DELAY_MS   = 400;
const BATCH_SIZE = 200;

// ── Scimago SJR → Tier eşleşmesi ──────────────────────────────────────────
// SJR > 1.0  → Tier 1 (yüksek etki)
// SJR 0.4–1.0 → Tier 2 (orta etki)
// SJR < 0.4  → Tier 3 (düşük/niş)
function sjrToTier(sjr) {
  if (sjr >= 1.0) return 1;
  if (sjr >= 0.4) return 2;
  return 3;
}

// ISSN'i normalize et: tire ve boşlukları kaldır, küçük harfe çevir
function normalizeISSN(issn) {
  return (issn || '').replace(/[-\s]/g, '').toLowerCase();
}

/** Scimago CSV'yi oku, ISSN → { sjr, title, quartile } map'i kur */
async function loadScimago() {
  const sjiMap = new Map(); // normalizedISSN → { sjr, title, quartile }
  try {
    const raw = await fs.readFile(SCIMAGO_CSV, 'utf-8');
    const lines = raw.split('\n');

    // Başlık satırını bul
    const header = lines[0].split(';').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
    const colIssn      = header.findIndex(h => h === 'issn');
    const colSjr       = header.findIndex(h => h.includes('sjr') && !h.includes('quartile') && !h.includes('best'));
    const colTitle     = header.findIndex(h => h === 'title');
    const colQuartile  = header.findIndex(h => h.includes('best quartile') || h.includes('sjr best'));

    if (colIssn === -1 || colSjr === -1) {
      console.warn('  ⚠ Scimago CSV: ISSN veya SJR sütunu bulunamadı — elle tier kullanılacak');
      return sjiMap;
    }

    let matched = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Noktalı virgülle ayır (tırnak içindeki virgüllere dikkat)
      const cols = parseCsvLine(line, ';');

      const issnRaw   = (cols[colIssn]   || '').replace(/^"|"$/g, '').trim();
      const sjrRaw    = (cols[colSjr]    || '').replace(/^"|"$/g, '').replace(',', '.').trim();
      const titleRaw  = (cols[colTitle]  || '').replace(/^"|"$/g, '').trim();
      const quartile  = (cols[colQuartile] || '').replace(/^"|"$/g, '').trim();

      const sjr = parseFloat(sjrRaw);
      if (!issnRaw || isNaN(sjr)) continue;

      // Scimago bazen birden fazla ISSN koyuyor (virgülle ayrılmış)
      const issns = issnRaw.split(',').map(s => normalizeISSN(s));
      for (const issn of issns) {
        if (issn.length >= 7) {
          sjiMap.set(issn, { sjr, title: titleRaw, quartile });
          matched++;
        }
      }
    }
    console.log(`  ✓ Scimago: ${matched} ISSN kaydı yüklendi`);
  } catch (e) {
    console.warn(`  ⚠ Scimago CSV okunamadı (${e.message}) — elle tier kullanılacak`);
  }
  return sjiMap;
}

/** Basit CSV satır parser (tırnak içi ayraçları atlar) */
function parseCsvLine(line, sep = ';') {
  const cols = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === sep && !inQ) { cols.push(cur); cur = ''; }
    else { cur += c; }
  }
  cols.push(cur);
  return cols;
}

// ── Dergi listesi — tier artık Scimago'dan gelecek ────────────────────────
// fallbackTier: Scimago'da bulunamazsa kullanılır
const JOURNALS = [
  // EM dergileri
  { issn: '0196-0644', name: 'Annals of Emergency Medicine', fallbackTier: 1 },
  { issn: '1097-6760', name: 'Annals of Emergency Medicine', fallbackTier: 1 },
  { issn: '1532-1770', name: 'Resuscitation', fallbackTier: 1 },
  { issn: '0300-9572', name: 'Resuscitation', fallbackTier: 1 },
  { issn: '0735-6757', name: 'American Journal of Emergency Medicine', fallbackTier: 1 },
  { issn: '1931-3543', name: 'CHEST', fallbackTier: 1 },
  { issn: '0012-3692', name: 'CHEST', fallbackTier: 1 },
  { issn: '2165-8048', name: 'Academic Emergency Medicine', fallbackTier: 1 },
  { issn: '1553-2712', name: 'Academic Emergency Medicine', fallbackTier: 1 },
  { issn: '1556-3316', name: 'Emergency Medicine Clinics of NA', fallbackTier: 2 },
  { issn: '1472-0205', name: 'Emergency Medicine Journal', fallbackTier: 2 },
  { issn: '1471-227X', name: 'BMC Emergency Medicine', fallbackTier: 2 },
  { issn: '0736-4679', name: 'Journal of Emergency Medicine', fallbackTier: 2 },
  { issn: '1090-1280', name: 'Journal of Emergency Medicine', fallbackTier: 2 },
  { issn: '2057-5858', name: 'BMJ Open Emergency Medicine', fallbackTier: 2 },
  { issn: '1865-1372', name: 'International Journal of Emergency Medicine', fallbackTier: 2 },
  { issn: '2211-4203', name: 'European Journal of Emergency Medicine', fallbackTier: 2 },
  { issn: '0969-9546', name: 'European Journal of Emergency Medicine', fallbackTier: 2 },
  { issn: '1742-6731', name: 'Emergency Medicine Australasia', fallbackTier: 2 },
  { issn: '2588-9834', name: 'Turkish Journal of Emergency Medicine', fallbackTier: 2 },
  { issn: '2452-2473', name: 'Turkish Journal of Emergency Medicine', fallbackTier: 2 },
  { issn: '1078-0998', name: 'Pediatric Emergency Care', fallbackTier: 2 },
  { issn: '0749-5161', name: 'Prehospital Emergency Care', fallbackTier: 2 },
  { issn: '1090-3127', name: 'Prehospital Emergency Care', fallbackTier: 2 },
  // YBÜ
  { issn: '0090-3493', name: 'Critical Care Medicine', fallbackTier: 1 },
  { issn: '1364-8535', name: 'Critical Care', fallbackTier: 1 },
  { issn: '1466-609X', name: 'Critical Care', fallbackTier: 1 },
  { issn: '0342-4642', name: 'Intensive Care Medicine', fallbackTier: 1 },
  { issn: '1432-1238', name: 'Intensive Care Medicine', fallbackTier: 1 },
  // Cerrahi
  { issn: '0003-4932', name: 'Annals of Surgery', fallbackTier: 1 },
  { issn: '1528-1140', name: 'Annals of Surgery', fallbackTier: 1 },
  { issn: '2168-6254', name: 'JAMA Surgery', fallbackTier: 1 },
  // Göğüs cerrahisi
  { issn: '0003-4975', name: 'Annals of Thoracic Surgery', fallbackTier: 2 },
  { issn: '1552-6259', name: 'Annals of Thoracic Surgery', fallbackTier: 2 },
  { issn: '1010-7940', name: 'European J Cardiothoracic Surgery', fallbackTier: 2 },
  { issn: '1873-734X', name: 'European J Cardiothoracic Surgery', fallbackTier: 2 },
  { issn: '1547-4127', name: 'Thoracic Surgery Clinics', fallbackTier: 2 },
  { issn: '1547-4135', name: 'Thoracic Surgery Clinics', fallbackTier: 2 },
  { issn: '0022-5223', name: 'J Thoracic & Cardiovascular Surgery', fallbackTier: 2 },
  { issn: '1569-9293', name: 'Interactive CardioVascular & Thoracic Surgery', fallbackTier: 2 },
  { issn: '0040-6376', name: 'Thorax', fallbackTier: 1 },
  { issn: '1468-3296', name: 'Thorax', fallbackTier: 1 },
  // Travma
  { issn: '2163-0763', name: 'Journal of Trauma & Acute Care Surgery', fallbackTier: 1 },
  { issn: '0020-1383', name: 'Injury', fallbackTier: 2 },
  { issn: '1879-0267', name: 'Injury', fallbackTier: 2 },
  { issn: '1526-9523', name: 'World J Emergency Surgery', fallbackTier: 2 },
  // Toksikoloji
  { issn: '1556-3650', name: 'Clinical Toxicology', fallbackTier: 2 },
  { issn: '1532-4117', name: 'Clinical Toxicology', fallbackTier: 2 },
  // Kardiyoloji/Nöroloji
  { issn: '0039-2499', name: 'Stroke', fallbackTier: 1 },
  { issn: '1524-4628', name: 'Stroke', fallbackTier: 1 },
  { issn: '0009-7322', name: 'Circulation', fallbackTier: 1 },
  { issn: '1524-4539', name: 'Circulation', fallbackTier: 1 },
  // Bölgesel/Niş
  { issn: '2149-9934', name: 'Eurasian J Emergency Medicine', fallbackTier: 3 },
  { issn: '2146-6858', name: 'Eurasian J Emergency Medicine', fallbackTier: 3 },
  { issn: '1998-3549', name: 'Hong Kong J Emergency Medicine', fallbackTier: 3 },
  { issn: '1024-8714', name: 'Hong Kong J Emergency Medicine', fallbackTier: 3 },
  { issn: '0974-2700', name: 'J Emergencies Trauma & Shock', fallbackTier: 3 },
  { issn: '2008-136X', name: 'Emergency (Iran)', fallbackTier: 3 },
  { issn: '1306-3111', name: 'Turkish Journal of Trauma & Emergency Surgery', fallbackTier: 3 },
  { issn: '1307-7945', name: 'Ulus Travma Acil Cerrahi Dergisi', fallbackTier: 3 },
];

// ISSN → journal bilgisi lookup (Scimago yüklendikten sonra tier eklenir)
let JOURNAL_MAP = new Map();

// Benzersiz ISSN listesi (sorgu için)
const UNIQUE_ISSNS = [...new Set(JOURNALS.map(j => j.issn))];

/** JOURNAL_MAP'i Scimago verileriyle kur */
function buildJournalMap(scimagoMap) {
  let found = 0, fallback = 0;
  JOURNAL_MAP = new Map();
  for (const j of JOURNALS) {
    const normIssn = normalizeISSN(j.issn);
    const scimago  = scimagoMap.get(normIssn);
    const tier     = scimago ? sjrToTier(scimago.sjr) : j.fallbackTier;
    const sjr      = scimago?.sjr ?? null;
    if (scimago) found++; else fallback++;
    JOURNAL_MAP.set(j.issn, { ...j, tier, sjr });
  }
  console.log(`  ✓ Dergi eşleşmesi: ${found} Scimago'dan, ${fallback} fallback'ten`);
}

// ── Yardımcı fonksiyonlar ──────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dateStr(d) {
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

/** Makale tipini belirle — editöryal guard → PubMed PT → başlık fallback */
function classifyType(ptList, title) {
  const pts = (ptList || []).map(p => p.toLowerCase());
  const t   = (title  || '').toLowerCase();

  // ─── GUARD: Editöryal yazışma kalıpları (en yüksek öncelik) ───
  // Başlıkta bu kalıplardan biri varsa, başlıktaki diğer tüm anahtar
  // kelimeleri (meta-analysis, RCT, guideline vb.) görmezden gel.
  // Örnek: "Authors' reply to Letter on '...meta-analysis'" → letter
  const EDITORIAL_PATTERNS = [
    'letter to the editor', 'reply to the letter', 'reply to the comment',
    "authors' reply", "author's reply", 'author reply', 'authors reply',
    'response to the letter', 'response to the comment',
    'comment on:', 'comments on:', 'correspondence on',
    'in response to', 'regarding the article',
    'erratum', 'corrigendum', 'correction to', 'retraction of',
    'retraction note', 'retraction:',
  ];
  if (EDITORIAL_PATTERNS.some(pat => t.includes(pat))) {
    return 'letter';
  }

  // ─── PubMed PT + başlık birlikte kontrol ───
  if (pts.some(p => p.includes('meta-analysis')) ||
      t.includes('meta-analysis') || t.includes('meta analysis')) return 'meta-analysis';

  if (pts.some(p => p.includes('systematic review')) ||
      t.includes('systematic review') || t.includes('systematic literature review') ||
      t.includes('scoping review')) return 'systematic-review';

  if (pts.some(p => p.includes('randomized controlled')) ||
      t.includes('randomized controlled') || t.includes('randomised controlled') ||
      t.includes(': a randomized') || t.includes(': a randomised')) return 'rct';

  if (pts.some(p => p.includes('practice guideline') || p.includes('guideline')) ||
      t.includes('guideline') || t.includes('consensus statement') ||
      t.includes('position statement') || t.includes('expert panel')) return 'guideline';

  if (pts.some(p => p.includes('clinical trial')) ||
      t.includes('clinical trial')) return 'clinical-trial';

  // Genel review — spesifik tipler elenince
  if (pts.some(p => p.includes('review')) ||
      t.includes('narrative review') || t.includes(': a review') ||
      t.includes('review of the literature') || t.includes('review of literature')) return 'review';

  if (pts.some(p => p.includes('case report')) ||
      t.includes('case report') || t.includes('a case of')) return 'case-report';

  if (pts.some(p => p.includes('editorial'))) return 'editorial';
  if (pts.some(p => p.includes('letter')))    return 'letter';
  if (pts.some(p => p.includes('comment')))   return 'comment';

  return 'original';
}

/** Tip bazlı bonus skor */
function typeBonus(type) {
  switch (type) {
    case 'meta-analysis':     return 25;
    case 'systematic-review': return 22;
    case 'guideline':         return 30;
    case 'rct':               return 20;
    case 'clinical-trial':    return 15;
    case 'review':            return 10;
    case 'original':          return 8;
    case 'case-report':       return 3;
    case 'editorial':         return 2;
    case 'letter':            return 1;
    case 'comment':           return 1;
    default:                  return 5;
  }
}

/** Tier bazlı skor */
function tierScore(tier) {
  switch (tier) {
    case 1: return 30;
    case 2: return 18;
    case 3: return 8;
    default: return 5;
  }
}

/** Güncellik skoru (bugün=10, dün=8, ..., 7 gün=2) */
function recencyScore(pubDateStr) {
  if (!pubDateStr) return 3;
  const pub = new Date(pubDateStr);
  const now = new Date();
  const daysAgo = Math.floor((now - pub) / 86400000);
  return Math.max(2, 10 - daysAgo);
}

/** Toplam etki skoru hesapla */
function computeImpactScore(article) {
  const ts = tierScore(article.journalTier);
  const tb = typeBonus(article.articleType);
  const rs = recencyScore(article.pubDate);
  // Ek: anahtar kelime bonus (acilci için önemli terimler)
  let keywordBonus = 0;
  const titleLow = (article.title || '').toLowerCase();
  const highImpactTerms = [
    'cardiac arrest', 'sepsis', 'stroke', 'trauma', 'intubation',
    'resuscitation', 'airway', 'chest pain', 'pneumothorax',
    'pulmonary embolism', 'mortality', 'survival', 'guideline',
    'emergency department', 'critical care', 'point-of-care',
    'ultrasound', 'ecmo', 'mechanical ventilation', 'cpap',
    'hemorrhage', 'shock', 'anaphylaxis', 'triage'
  ];
  for (const term of highImpactTerms) {
    if (titleLow.includes(term)) { keywordBonus += 5; break; }
  }

  return ts + tb + rs + keywordBonus;
}

// ── PubMed API çağrıları ───────────────────────────────────────────────────

/** ISSN grubu için son N günün PMID'lerini çek */
async function searchPMIDs(issns, daysBack) {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - daysBack);

  // ISSN'leri OR ile birleştir
  const issnQuery = issns.map(i => `${i}[issn]`).join(' OR ');
  const dateRange = `${dateStr(from)}:${dateStr(now)}[edat]`;
  const query = `(${issnQuery}) AND ${dateRange}`;

  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=9999&retmode=json`;

  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`esearch failed: ${res.status}`);
  const data = await res.json();
  return data.esearchresult?.idlist ?? [];
}

/** PMID listesinden makale detaylarını çek (XML parse) */
async function fetchArticleDetails(pmids) {
  const articles = [];

  for (let i = 0; i < pmids.length; i += BATCH_SIZE) {
    const batch = pmids.slice(i, i + BATCH_SIZE);
    await sleep(DELAY_MS);

    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${batch.join(',')}&retmode=xml`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) {
      console.error(`  efetch batch ${i} failed: ${res.status}`);
      continue;
    }
    const xml = await res.text();

    // Her makaleyi parse et
    const chunks = xml.split('<PubmedArticle>').slice(1);
    for (const chunk of chunks) {
      try {
        const article = parseArticleXML(chunk);
        if (article) articles.push(article);
      } catch (e) {
        // skip
      }
    }

    process.stdout.write(`\r  ${Math.min(i + BATCH_SIZE, pmids.length)}/${pmids.length} makale işlendi...`);
  }
  console.log('');
  return articles;
}

/** Tek makale XML'ini parse et */
function parseArticleXML(xml) {
  const pmid = xml.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1];
  if (!pmid) return null;

  // Başlık
  let title = xml.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/)?.[1] || '';
  title = title.replace(/<[^>]+>/g, '').trim();
  if (!title) return null;

  // ISSN
  const issn = xml.match(/<ISSN[^>]*>([^<]+)<\/ISSN>/)?.[1];
  const journal = JOURNAL_MAP.get(issn);
  const journalTitle = xml.match(/<Title>([^<]+)<\/Title>/)?.[1] || journal?.name || 'Unknown';

  // Yayın tarihi
  let pubDate = null;
  const epubMatch = xml.match(/<PubMedPubDate PubStatus="epublish">[\s\S]*?<Year>(\d+)<\/Year>[\s\S]*?<Month>(\d+)<\/Month>[\s\S]*?<Day>(\d+)<\/Day>/);
  const entrezMatch = xml.match(/<PubMedPubDate PubStatus="entrez">[\s\S]*?<Year>(\d+)<\/Year>[\s\S]*?<Month>(\d+)<\/Month>[\s\S]*?<Day>(\d+)<\/Day>/);
  const dateMatch = epubMatch || entrezMatch;
  if (dateMatch) {
    pubDate = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
  }

  // Yazarlar
  const authorMatches = [...xml.matchAll(/<Author[\s\S]*?<LastName>([^<]+)<\/LastName>[\s\S]*?<Initials>([^<]*)<\/Initials>/g)];
  const authors = authorMatches.slice(0, 5).map(m => `${m[1]} ${m[2]}`);
  if (authorMatches.length > 5) authors.push('et al.');

  // Özet
  let abstract = '';
  const absMatch = xml.match(/<Abstract>([\s\S]*?)<\/Abstract>/);
  if (absMatch) {
    abstract = absMatch[1]
      .replace(/<AbstractText[^>]*Label="([^"]+)"[^>]*>/g, '$1: ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
  }

  // Makale tipi
  const ptMatches = [...xml.matchAll(/<PublicationType[^>]*>([^<]+)<\/PublicationType>/g)];
  const pubTypes = ptMatches.map(m => m[1]);
  const articleType = classifyType(pubTypes, title);

  // DOI
  const doi = xml.match(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/)?.[1];

  // Anahtar kelimeler
  const kwMatches = [...xml.matchAll(/<Keyword[^>]*>([^<]+)<\/Keyword>/g)];
  const keywords = kwMatches.slice(0, 8).map(m => m[1]);

  // MeSH terimleri
  const meshMatches = [...xml.matchAll(/<DescriptorName[^>]*>([^<]+)<\/DescriptorName>/g)];
  const meshTerms = meshMatches.slice(0, 6).map(m => m[1]);

  const tier = journal?.tier ?? 3;
  const sjr  = journal?.sjr  ?? null;

  const article = {
    pmid,
    title,
    authors,
    journal: journalTitle,
    journalTier: tier,
    journalSJR: sjr,
    articleType,
    pubDate,
    abstract,
    doi,
    keywords,
    meshTerms,
    pubTypes,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
  };

  article.impactScore = computeImpactScore(article);
  return article;
}

// ── Zirvedekiler arşivi ──────────────────────────────────────────────────

/**
 * Günün 1. sırasını history.json'a ekle.
 * Aynı gün zaten kayıtlıysa güncelle, yoksa yeni giriş ekle.
 * Çıktı formatı: ardışık günlerde aynı makale varsa tarih aralığı olarak birleştirilir.
 */
async function recordHistory(topArticle) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Mevcut geçmişi oku
  let history = [];
  try {
    history = JSON.parse(await fs.readFile(HIST_FILE, 'utf-8'));
  } catch { /* ilk çalışma veya dosya yok */ }

  // Bugün zaten kayıtlı mı?
  const todayIdx = history.findIndex(h => h.date === today);
  const entry = {
    date: today,
    pmid: topArticle.pmid,
    title: topArticle.title,
    journal: topArticle.journal,
    score: topArticle.impactScore,
    articleType: topArticle.articleType,
    doi: topArticle.doi || null,
    url: topArticle.url,
  };

  if (todayIdx > -1) {
    history[todayIdx] = entry; // güncelle
  } else {
    history.push(entry);       // yeni gün
  }

  // Tarihe göre sırala (eskiden yeniye)
  history.sort((a, b) => a.date.localeCompare(b.date));

  // Ardışık günlerde aynı makaleyi birleştir → streaks dizisi
  const streaks = [];
  for (const h of history) {
    const last = streaks[streaks.length - 1];
    if (last && last.pmid === h.pmid && isConsecutiveDay(last.endDate, h.date)) {
      // Aynı makale, ardışık gün → streak uzat
      last.endDate = h.date;
      last.days++;
      last.score = Math.max(last.score, h.score); // en yüksek skoru tut
    } else {
      // Yeni streak
      streaks.push({
        pmid: h.pmid,
        title: h.title,
        journal: h.journal,
        articleType: h.articleType,
        doi: h.doi,
        url: h.url,
        score: h.score,
        startDate: h.date,
        endDate: h.date,
        days: 1,
      });
    }
  }

  // Her ikisini de kaydet: ham veri (history) + birleştirilmiş (streaks)
  const output = {
    updatedAt: new Date().toISOString(),
    totalDays: history.length,
    raw: history,
    streaks: streaks.reverse(), // yeniden eskiye
  };

  await fs.writeFile(HIST_FILE, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`  📜 Zirvedekiler: ${history.length} gün kaydı, ${streaks.length} farklı makale`);
}

/** İki tarihin ardışık gün olup olmadığını kontrol et */
function isConsecutiveDay(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1);
  const d2 = new Date(dateStr2);
  const diff = (d2 - d1) / 86400000; // ms → gün
  return diff === 1;
}

// ── Ana akış ───────────────────────────────────────────────────────────────

async function main() {
  const force = process.argv.includes('--force');
  console.log(`\n🔴 EM Pulse — Acil Tıp Makale Radarı`);
  console.log(`   Son ${DAYS_BACK} gün · ${UNIQUE_ISSNS.length} benzersiz ISSN\n`);

  // Data klasörünü oluştur
  await fs.mkdir(DATA_DIR, { recursive: true });

  // 0. Scimago CSV'yi yükle, JOURNAL_MAP'i kur
  console.log('  📊 Scimago verileri yükleniyor...');
  const scimagoMap = await loadScimago();
  buildJournalMap(scimagoMap);
  console.log('');

  // Son güncelleme kontrolü
  if (!force) {
    try {
      const meta = JSON.parse(await fs.readFile(META_FILE, 'utf-8'));
      const lastUpdate = new Date(meta.lastUpdate);
      const hoursSince = (Date.now() - lastUpdate) / 3600000;
      if (hoursSince < 20) {
        console.log(`  ⏭ Son güncelleme ${hoursSince.toFixed(1)} saat önce. --force ile zorla.\n`);
        return;
      }
    } catch { /* ilk çalışma */ }
  }

  // 1. PMID'leri çek
  console.log('  📡 PubMed\'den PMID\'ler çekiliyor...');

  // ISSN'leri gruplara böl (URL uzunluk limiti)
  const GROUP_SIZE = 15;
  let allPMIDs = [];
  for (let i = 0; i < UNIQUE_ISSNS.length; i += GROUP_SIZE) {
    const group = UNIQUE_ISSNS.slice(i, i + GROUP_SIZE);
    await sleep(DELAY_MS);
    try {
      const ids = await searchPMIDs(group, DAYS_BACK);
      allPMIDs.push(...ids);
    } catch (e) {
      console.error(`  Grup ${i} hatası: ${e.message}`);
    }
  }

  // Tekrarları temizle
  allPMIDs = [...new Set(allPMIDs)];
  console.log(`  ✓ ${allPMIDs.length} benzersiz makale bulundu\n`);

  if (allPMIDs.length === 0) {
    console.log('  ⚠ Makale bulunamadı. Çıkılıyor.\n');
    return;
  }

  // 2. Detayları çek
  console.log('  📄 Makale detayları çekiliyor...');
  const articles = await fetchArticleDetails(allPMIDs);
  console.log(`  ✓ ${articles.length} makale parse edildi\n`);

  // 3. Skorla ve sırala
  articles.sort((a, b) => b.impactScore - a.impactScore);

  // İstatistikler
  const stats = {
    total: articles.length,
    byType: {},
    byTier: { 1: 0, 2: 0, 3: 0 },
    topScore: articles[0]?.impactScore || 0,
    avgScore: articles.length
      ? Math.round(articles.reduce((s, a) => s + a.impactScore, 0) / articles.length)
      : 0,
  };
  articles.forEach(a => {
    stats.byType[a.articleType] = (stats.byType[a.articleType] || 0) + 1;
    stats.byTier[a.journalTier] = (stats.byTier[a.journalTier] || 0) + 1;
  });

  // "Haftanın makalesi" — en yüksek skorlu
  const articleOfWeek = articles[0] || null;

  // 4. JSON olarak kaydet
  const output = {
    generatedAt: new Date().toISOString(),
    daysBack: DAYS_BACK,
    journalCount: UNIQUE_ISSNS.length,
    stats,
    articleOfWeek: articleOfWeek ? articleOfWeek.pmid : null,
    articles,
  };

  await fs.writeFile(OUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
  await fs.writeFile(META_FILE, JSON.stringify({
    lastUpdate: new Date().toISOString(),
    articleCount: articles.length,
    topScore: stats.topScore,
  }, null, 2), 'utf-8');

  // 5. Zirvedekiler arşivi — günün 1. sırasını kaydet
  if (articleOfWeek) {
    await recordHistory(articleOfWeek);
  }

  console.log(`  📊 İstatistikler:`);
  console.log(`     Toplam: ${stats.total} makale`);
  console.log(`     Tier 1: ${stats.byTier[1]} · Tier 2: ${stats.byTier[2]} · Tier 3: ${stats.byTier[3]}`);
  console.log(`     En yüksek skor: ${stats.topScore} · Ortalama: ${stats.avgScore}`);
  console.log(`     Tipler: ${JSON.stringify(stats.byType)}`);
  if (articleOfWeek) {
    console.log(`\n  🏆 Haftanın makalesi: "${articleOfWeek.title.slice(0, 80)}..."`);
    console.log(`     ${articleOfWeek.journal} · Skor: ${articleOfWeek.impactScore}`);
  }
  console.log(`\n  ✅ ${OUT_FILE} kaydedildi.\n`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
