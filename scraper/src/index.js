const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

// Config
const { getConfig, listSegments } = require('./config-loader');

// Sources
const { searchGoogleMaps, nearbySearchGrid, combinedSearch, getPlaceDetails } = require('./sources/google-maps');
const { sendWhatsApp, getWhatsAppStatus, connectWhatsApp } = require('./sources/whatsapp');
const { searchFoursquare } = require('./sources/foursquare');
const { checkInstagram } = require('./sources/instagram');
const { analyzeWebsite } = require('./sources/website-analyzer');
const { searchGoogleCustom } = require('./sources/google-search');
const { searchByCNAE, enrichCNPJ } = require('./sources/cnpj-receita');
const { searchInstagram } = require('./sources/instagram-search');

// Analysis
const { analyzeReviews } = require('./analysis/reviews');
const { analyzeMarketingStatus } = require('./analysis/marketing');

// Utils
const { generateGrid, geocodeCity } = require('./utils/grid');
const { extractWhatsApp } = require('./utils/phone');
const { deduplicateLeads } = require('./utils/dedup');

// Qualifier
const { qualifyWithAI } = require('./ai-qualifier');

// Chatbot
const conversationStore = require('./chatbot/conversation-store');
const flowEngine = require('./chatbot/flow-engine');
const rateLimiter = require('./chatbot/rate-limiter');
const { notifyHumanHandoff } = require('./chatbot/handoff');

// Infrastructure
const { getStorage } = require('./storage');
const { getCache } = require('./cache');
const { getSeenRegistry } = require('./discovery/seen-registry');
const { pMap } = require('./utils/concurrency');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Autenticação por API key (se configurada)
app.use((req, res, next) => {
  if (!API_KEY) return next(); // sem key = sem auth (dev mode)
  if (req.path === '/health') return next(); // health sempre aberto
  const provided = req.headers['x-api-key'] || req.query.apiKey;
  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'API key inválida ou ausente. Envie header x-api-key.' });
  }
  next();
});

const PORT = process.env.PORT || 3099;
const EXPORTS_DIR = process.env.EXPORTS_DIR || '/home/node/exports';
const LEADS_FILE = path.join(EXPORTS_DIR, 'leads-data.json');
const ENRICH_CONCURRENCY = parseInt(process.env.ENRICH_CONCURRENCY || '3');
const API_KEY = process.env.SCRAPER_API_KEY || '';

// ════════════════════════════════════════════════════
// SEGMENTOS — Listar configs disponíveis
// ════════════════════════════════════════════════════
app.get('/api/segments', (req, res) => {
  try {
    const segments = listSegments();
    res.json({ segments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// PAINEL WEB — Dados dos leads
// ════════════════════════════════════════════════════
app.get('/api/leads', (req, res) => {
  try {
    const tenantId = req.query.tenantId || 'default';
    const data = getStorage().getLatestLeads(tenantId);
    res.json(data);
  } catch (err) {
    res.json({ leads: [], resumo: {}, meta: {}, error: err.message });
  }
});

// ════════════════════════════════════════════════════
// IMPORTAR DADOS DO EXCEL EXISTENTE
// ════════════════════════════════════════════════════
app.get('/api/import-excel', async (req, res) => {
  try {
    const files = fs.readdirSync(EXPORTS_DIR).filter(f => f.endsWith('.xlsx') && !f.startsWith('.~'));
    if (files.length === 0) {
      return res.status(404).json({ error: 'Nenhum Excel encontrado' });
    }

    const latestFile = files.sort().reverse()[0];
    const filePath = path.join(EXPORTS_DIR, latestFile);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const ws = workbook.getWorksheet('Leads Qualificados');

    if (!ws) {
      return res.status(404).json({ error: 'Aba "Leads Qualificados" não encontrada' });
    }

    const leads = [];
    const headers = [];
    ws.getRow(1).eachCell((cell, colNumber) => { headers[colNumber] = cell.value; });

    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const data = {};
      row.eachCell((cell, colNumber) => { data[headers[colNumber]] = cell.value; });

      const whatsappUrl = data['WHATSAPP'] || '';
      const whatsappNum = whatsappUrl.toString().replace('https://wa.me/', '');

      leads.push({
        nome: data['NOME'] || '',
        cidade: data['CIDADE'] || '',
        endereco: data['ENDEREÇO'] || '',
        telefone: data['TELEFONE'] || '',
        whatsapp: whatsappNum || '',
        website: data['WEBSITE'] === 'NÃO TEM' ? '' : (data['WEBSITE'] || ''),
        instagram: { url: data['INSTAGRAM'] || '', found: !!(data['INSTAGRAM']) },
        email: data['EMAIL'] || '',
        rating: parseFloat(data['RATING']) || 0,
        totalAvaliacoes: parseInt(data['AVALIAÇÕES']) || 0,
        horarios: (data['HORÁRIOS'] || '').toString().split('\n').filter(Boolean),
        googleMapsUrl: data['GOOGLE MAPS'] || '',
        websiteAnalysis: {
          usaConcorrente: data['USA CONCORRENTE'] !== 'Não' && !!data['USA CONCORRENTE'],
          competitorsFound: data['USA CONCORRENTE'] !== 'Não' ? (data['USA CONCORRENTE'] || '').toString().split(', ').filter(Boolean) : [],
        },
        qualification: {
          score: parseInt(data['SCORE']) || 0,
          classificacao: data['CLASSIFICAÇÃO'] || 'FRIO',
          perfil: data['PERFIL'] || '',
          dores_provaveis: (data['DORES'] || '').toString().split('; ').filter(Boolean),
          argumento_principal: data['ARGUMENTO'] || '',
          plano_recomendado: data['PLANO RECOMENDADO'] || '',
          mensagem_whatsapp: data['MENSAGEM WHATSAPP'] || '',
          mensagem_instagram: data['MENSAGEM INSTAGRAM'] || '',
          mensagem_followup: data['MENSAGEM FOLLOW-UP'] || '',
          melhor_horario_contato: data['MELHOR HORÁRIO'] || '',
          risco: data['RISCO'] || '',
        },
      });
    });

    leads.sort((a, b) => (b.qualification?.score || 0) - (a.qualification?.score || 0));

    const leadsData = {
      leads,
      resumo: buildResumo(leads),
      meta: { cities: 'Importado', date: new Date().toISOString(), total: leads.length, importedFrom: latestFile },
    };

    if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leadsData, null, 2));

    res.json({ message: `Importados ${leads.length} leads de ${latestFile}`, ...leadsData.resumo });
  } catch (err) {
    console.error('[Import Excel] Erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  const config = getConfig();
  const cache = getCache();
  const seenRegistry = getSeenRegistry();
  res.json({
    status: 'ok',
    version: '2.1.0',
    segment: config.id,
    apis: {
      google_maps: !!process.env.GOOGLE_MAPS_API_KEY,
      foursquare: !!process.env.FOURSQUARE_API_KEY,
      google_search: !!process.env.GOOGLE_SEARCH_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
    },
    cache: cache.stats(),
    seen: seenRegistry.stats(),
    enrichConcurrency: ENRICH_CONCURRENCY,
  });
});

// ════════════════════════════════════════════════════════════
//  V2 ENDPOINTS
// ════════════════════════════════════════════════════════════

// ── FASE 1: DISCOVERY (grid geográfico + text search) ──
app.post('/api/v2/discover', async (req, res) => {
  try {
    const { cities, segmentId, newOnly = false, tenantId = 'default' } = req.body;
    if (!cities || !Array.isArray(cities)) {
      return res.status(400).json({ error: 'cities é obrigatório (array de {city, state})' });
    }

    const config = getConfig(segmentId);
    const seenRegistry = getSeenRegistry();
    const googleKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!googleKey) {
      return res.status(400).json({ error: 'GOOGLE_MAPS_API_KEY não configurada' });
    }

    const allLeads = [];

    for (const { city, state, radiusKm } of cities) {
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`DISCOVERY: ${city}/${state} [${config.nome}]`);
      console.log('═'.repeat(60));

      // Gerar grid
      let grid = generateGrid(city, state, radiusKm || 3);

      // Se não tem bounds pré-configurados, fazer geocoding
      if (grid.needsGeocoding) {
        console.log(`[Discovery] Geocoding para ${city}/${state}...`);
        const geo = await geocodeCity(city, state, googleKey);
        if (geo) {
          grid = generateGrid(city, state, radiusKm || 3);
          if (grid.needsGeocoding) {
            grid.points = [geo.center];
            grid.radiusMeters = 10000;
          }
        }
      }

      // Busca combinada: Nearby (grid) + Text Search
      const results = await combinedSearch(city, state, grid.points, grid.radiusMeters, googleKey, config);

      // Foursquare (se configurado)
      const fsqKey = process.env.FOURSQUARE_API_KEY;
      const fsqResults = await searchFoursquare(city, state, fsqKey, config);

      // Google Custom Search (se configurado)
      const gcsResults = await searchGoogleCustom(city, state, config);

      // CNAE / Receita Federal (se CNAEs configurados)
      const cnaeResults = await searchByCNAE(city, state, config);

      // Instagram Search (scraping de hashtags)
      const igResults = await searchInstagram(city, state, config);

      // Merge de todas as fontes e dedup
      const allForCity = [
        ...results,
        ...fsqResults.map(l => ({ ...l, rating: 0, totalAvaliacoes: 0 })),
        ...gcsResults,
        ...cnaeResults,
        ...igResults,
      ];
      const deduped = deduplicateLeads(allForCity, config);

      const sourceCounts = {
        google_maps: results.length,
        foursquare: fsqResults.length,
        google_search: gcsResults.length,
        receita_federal: cnaeResults.length,
        instagram: igResults.length,
      };
      console.log(`[Discovery] ${city}/${state}: ${deduped.length} leads únicos`, sourceCounts);
      allLeads.push(...deduped.map(l => ({ ...l, cidade: city, estado: state })));
    }

    // Filtrar leads já conhecidos (incremental discovery)
    let finalLeads = allLeads;
    let skippedKnown = 0;
    if (newOnly) {
      finalLeads = seenRegistry.filterNew(allLeads, tenantId);
      skippedKnown = allLeads.length - finalLeads.length;
      if (skippedKnown > 0) {
        console.log(`[Discovery] Incremental: ${skippedKnown} leads já conhecidos removidos, ${finalLeads.length} novos`);
      }
    }

    res.json({ total: finalLeads.length, leads: finalLeads, skippedKnown });
  } catch (err) {
    console.error('[Discovery] Erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── FASE 2: PRE-FILTER ──
app.post('/api/v2/prefilter', async (req, res) => {
  try {
    const { leads, minReviews = 5, minRating = 0 } = req.body;
    if (!leads || !Array.isArray(leads)) {
      return res.status(400).json({ error: 'leads é obrigatório (array)' });
    }

    const before = leads.length;
    const filtered = leads.filter(lead => {
      if (lead.businessStatus === 'CLOSED_PERMANENTLY') return false;
      // Leads da Receita Federal e Instagram não têm avaliações — não filtrar por reviews
      const fromAltSource = ['receita_federal', 'google_search', 'instagram_search'].includes(lead.source);
      if (!fromAltSource && lead.totalAvaliacoes < minReviews) return false;
      if (lead.rating > 0 && lead.rating < minRating) return false;
      return true;
    });

    console.log(`[PreFilter] ${before} → ${filtered.length} leads (removidos: ${before - filtered.length})`);
    res.json({ total: filtered.length, removed: before - filtered.length, leads: filtered });
  } catch (err) {
    console.error('[PreFilter] Erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── FASE 3: ENRICHMENT ──
app.post('/api/v2/enrich', async (req, res) => {
  try {
    const { leads, segmentId, concurrency, tenantId = 'default' } = req.body;
    if (!leads || !Array.isArray(leads)) {
      return res.status(400).json({ error: 'leads é obrigatório (array)' });
    }

    const config = getConfig(segmentId);
    const googleKey = process.env.GOOGLE_MAPS_API_KEY;
    const cache = getCache();
    const storage = getStorage();
    const enrichConcurrency = concurrency || ENRICH_CONCURRENCY;
    let completed = 0;

    async function enrichOne(lead) {
      completed++;
      console.log(`[Enrich] ${completed}/${leads.length}: ${lead.nome}`);

      let enrichedLead = { ...lead };

      // 1. Google Place Details (com cache)
      if (lead.place_id && googleKey) {
        let details = cache.get('place-details', lead.place_id);
        if (!details) {
          details = await getPlaceDetails(lead.place_id, googleKey);
          if (details) cache.set('place-details', lead.place_id, details);
          await sleep(200);
        } else {
          console.log(`  [Cache] Place Details hit: ${lead.place_id}`);
        }

        if (details) {
          enrichedLead = {
            ...enrichedLead,
            telefone: details.telefone,
            telefoneInternacional: details.telefoneInternacional,
            website: details.website,
            horarios: details.horarios,
            googleMapsUrl: details.googleMapsUrl,
            status: details.status,
            reviews: details.reviews,
          };

          enrichedLead.whatsapp = extractWhatsApp({
            phone: details.telefone,
            phoneInternational: details.telefoneInternacional,
          });
        }
      }

      // 2. Análise do website (com cache)
      if (enrichedLead.website) {
        let wsAnalysis = cache.get('website-analysis', enrichedLead.website);
        if (!wsAnalysis) {
          console.log(`  [Website] Analisando ${enrichedLead.website}`);
          wsAnalysis = await analyzeWebsite(enrichedLead.website, config);
          if (wsAnalysis.analyzed) cache.set('website-analysis', enrichedLead.website, wsAnalysis);
        } else {
          console.log(`  [Cache] Website hit: ${enrichedLead.website}`);
        }
        enrichedLead.websiteAnalysis = wsAnalysis;

        if (wsAnalysis.whatsappLinks?.length > 0 && !enrichedLead.whatsapp) {
          enrichedLead.whatsapp = wsAnalysis.whatsappLinks[0];
        }
        if (wsAnalysis.emails?.length > 0) {
          enrichedLead.email = enrichedLead.email || wsAnalysis.emails[0];
        }
        if (wsAnalysis.socialMedia?.instagram) {
          enrichedLead.instagramHandle = enrichedLead.instagramHandle || wsAnalysis.socialMedia.instagram;
        }
      }

      // 3. Instagram (com cache)
      if (enrichedLead.instagramHandle) {
        let igResult = cache.get('instagram-profile', enrichedLead.instagramHandle);
        if (!igResult) {
          console.log(`  [Instagram] Verificando @${enrichedLead.instagramHandle}...`);
          igResult = await checkInstagram(enrichedLead.nome, enrichedLead.instagramHandle, config);
          if (igResult.found) cache.set('instagram-profile', enrichedLead.instagramHandle, igResult);
        } else {
          console.log(`  [Cache] Instagram hit: @${enrichedLead.instagramHandle}`);
        }
        enrichedLead.instagram = igResult;

        if (igResult.found && !enrichedLead.whatsapp) {
          const waFromIg = extractWhatsApp({
            instagramBio: igResult.bio,
            instagramLink: igResult.linkExterno,
          });
          if (waFromIg) enrichedLead.whatsapp = waFromIg;
        }
      } else if (!enrichedLead.instagram?.found) {
        enrichedLead.instagram = { found: false, handle: null };
      }

      // 4. CNPJ enrichment (com cache)
      if (enrichedLead.cnpj && enrichedLead.source === 'receita_federal') {
        let cnpjData = cache.get('cnpj', enrichedLead.cnpj);
        if (!cnpjData) {
          console.log(`  [CNPJ] Enriquecendo ${enrichedLead.cnpj}...`);
          cnpjData = await enrichCNPJ(enrichedLead.cnpj);
          if (cnpjData) cache.set('cnpj', enrichedLead.cnpj, cnpjData);
          await sleep(1500); // BrasilAPI rate limit
        } else {
          console.log(`  [Cache] CNPJ hit: ${enrichedLead.cnpj}`);
        }

        if (cnpjData) {
          enrichedLead.razao_social = cnpjData.razao_social;
          enrichedLead.nome = enrichedLead.nome || cnpjData.nome_fantasia || cnpjData.razao_social;
          enrichedLead.endereco = enrichedLead.endereco || `${cnpjData.logradouro}, ${cnpjData.numero} - ${cnpjData.bairro}`;
          enrichedLead.telefone = enrichedLead.telefone || cnpjData.telefone;
          enrichedLead.email = enrichedLead.email || cnpjData.email;
          enrichedLead.porte = cnpjData.porte;
          enrichedLead.abertura = cnpjData.abertura;

          if (!enrichedLead.whatsapp && cnpjData.telefone) {
            enrichedLead.whatsapp = extractWhatsApp({ phone: cnpjData.telefone });
          }
          if (!enrichedLead.whatsapp && cnpjData.telefone2) {
            enrichedLead.whatsapp = extractWhatsApp({ phone: cnpjData.telefone2 });
          }
        }
      }

      return enrichedLead;
    }

    // Enriquecimento paralelo
    console.log(`[Enrich] Processando ${leads.length} leads (concurrency: ${enrichConcurrency})...`);
    const enriched = await pMap(leads, enrichOne, enrichConcurrency);

    // Salvar progresso
    storage.saveTempData('enriched-result', { total: enriched.length, leads: enriched }, tenantId);
    console.log(`[Enrich] ${enriched.length} leads enriquecidos`);

    res.json({ total: enriched.length, leads: enriched });
  } catch (err) {
    console.error('[Enrich] Erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── FASE 4: DEEP ANALYSIS ──
app.post('/api/v2/analyze', async (req, res) => {
  try {
    const { leads, segmentId } = req.body;
    if (!leads || !Array.isArray(leads)) {
      return res.status(400).json({ error: 'leads é obrigatório (array)' });
    }

    const config = getConfig(segmentId);

    const analyzed = leads.map(lead => {
      const reviewAnalysis = analyzeReviews(lead.reviews, config);
      const marketingStatus = analyzeMarketingStatus(lead.instagram, lead.websiteAnalysis, {
        hasGoogleMaps: !!lead.place_id,
        hasWhatsapp: !!lead.whatsapp,
        hasFacebook: !!lead.websiteAnalysis?.socialMedia?.facebook,
        hasEmail: !!lead.email,
      });

      return {
        ...lead,
        reviewAnalysis,
        marketingStatus,
      };
    });

    const stats = {
      withSchedulingPain: analyzed.filter(l => l.reviewAnalysis?.hasSchedulingPain).length,
      withOrganizationIssues: analyzed.filter(l => l.reviewAnalysis?.hasOrganizationIssues).length,
      withAbandonedMarketing: analyzed.filter(l => l.marketingStatus?.instagramStatus === 'abandonado').length,
      highDigitalPresence: analyzed.filter(l => l.marketingStatus?.digitalPresence === 'alta').length,
      lowDigitalPresence: analyzed.filter(l => l.marketingStatus?.digitalPresence === 'baixa').length,
    };

    console.log(`[Analyze] ${analyzed.length} leads analisados:`, stats);
    res.json({ total: analyzed.length, stats, leads: analyzed });
  } catch (err) {
    console.error('[Analyze] Erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── FASE 5: QUALIFY ──
app.post('/api/v2/qualify', async (req, res) => {
  try {
    const { leads, segmentId } = req.body;
    if (!leads || !Array.isArray(leads)) {
      return res.status(400).json({ error: 'leads é obrigatório (array)' });
    }

    const config = getConfig(segmentId);
    const qualified = [];
    let processed = 0;

    for (const lead of leads) {
      processed++;
      console.log(`[Qualify] ${processed}/${leads.length}: ${lead.nome}`);

      const qualification = await qualifyWithAI(lead, config);
      qualified.push({ ...lead, qualification });
      await sleep(100);
    }

    qualified.sort((a, b) => (b.qualification?.score || 0) - (a.qualification?.score || 0));

    const resumo = buildResumo(qualified);

    res.json({ total: qualified.length, resumo, leads: qualified });
  } catch (err) {
    console.error('[Qualify] Erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// V2 PIPELINE COMPLETO
// ════════════════════════════════════════════════════
app.post('/api/v2/pipeline', async (req, res) => {
  try {
    const { cities, minReviews = 5, minRating = 0, radiusKm = 5, segmentId, newOnly = false, tenantId = 'default' } = req.body;

    const config = getConfig(segmentId);
    const storage = getStorage();

    console.log('\n' + '█'.repeat(60));
    console.log(`█  ${config.produto.nome.toUpperCase()} LEAD PROSPECTOR v2 — PIPELINE [${config.nome}]`);
    if (newOnly) console.log('█  MODO: Incremental (somente leads novos)');
    console.log('█'.repeat(60));

    const citiesWithRadius = cities.map(c => ({ ...c, radiusKm }));

    // FASE 1: DISCOVERY
    console.log('\n🔍 FASE 1: Discovery (grid geográfico)...');
    const discoverRes = await axios.post(`http://localhost:${PORT}/api/v2/discover`, { cities: citiesWithRadius, segmentId: config.id, newOnly, tenantId }, { timeout: 600000 });
    console.log(`✅ ${discoverRes.data.total} leads encontrados${discoverRes.data.skippedKnown ? ` (${discoverRes.data.skippedKnown} já conhecidos)` : ''}`);

    // FASE 2: PRE-FILTER
    console.log('\n🔽 FASE 2: Pre-filter...');
    const filterRes = await axios.post(`http://localhost:${PORT}/api/v2/prefilter`, {
      leads: discoverRes.data.leads, minReviews, minRating,
    }, { timeout: 60000 });
    console.log(`✅ ${filterRes.data.total} leads após filtro (removidos: ${filterRes.data.removed})`);

    // FASE 3: ENRICHMENT
    console.log('\n📊 FASE 3: Enrichment...');
    const enrichRes = await axios.post(`http://localhost:${PORT}/api/v2/enrich`, { leads: filterRes.data.leads, segmentId: config.id, tenantId }, { timeout: 600000 });
    console.log(`✅ ${enrichRes.data.total} leads enriquecidos`);

    // FASE 4: DEEP ANALYSIS
    console.log('\n🧠 FASE 4: Deep Analysis...');
    const analyzeRes = await axios.post(`http://localhost:${PORT}/api/v2/analyze`, { leads: enrichRes.data.leads, segmentId: config.id }, { timeout: 60000 });
    console.log(`✅ ${analyzeRes.data.total} leads analisados`);

    // FASE 5: QUALIFY
    console.log('\n🎯 FASE 5: Qualify...');
    const qualifyRes = await axios.post(`http://localhost:${PORT}/api/v2/qualify`, { leads: analyzeRes.data.leads, segmentId: config.id }, { timeout: 600000 });
    console.log(`✅ ${qualifyRes.data.total} leads qualificados`);

    // Marcar leads como vistos (para incremental discovery futuro)
    const seenRegistry = getSeenRegistry();
    const marked = seenRegistry.markSeen(qualifyRes.data.leads, tenantId);
    console.log(`[SeenRegistry] ${marked} novos leads registrados`);

    // EXPORT EXCEL
    console.log('\n📄 Exportando Excel...');
    const excelPath = await exportToExcel(qualifyRes.data.leads, cities, config);
    console.log(`✅ ${excelPath}`);

    // SAVE via storage
    console.log('\n💾 Salvando dashboard...');
    const meta = {
      cities: cities.map(c => `${c.city}/${c.state}`).join(', '),
      date: new Date().toISOString(),
      total: qualifyRes.data.total,
      version: 'v2',
      segment: config.id,
    };
    storage.saveLeads('latest', qualifyRes.data.leads, { ...meta, resumo: qualifyRes.data.resumo }, tenantId);

    // RESUMO
    const r = qualifyRes.data.resumo;
    console.log('\n' + '█'.repeat(60));
    console.log('█  PIPELINE v2 CONCLUÍDO');
    console.log(`█  Segmento: ${config.nome}`);
    console.log(`█  Total: ${qualifyRes.data.total} leads`);
    console.log(`█  🔥 Quentes: ${r.quentes}`);
    console.log(`█  🟡 Mornos: ${r.mornos}`);
    console.log(`█  ❄️  Frios: ${r.frios}`);
    console.log(`█  📱 WhatsApp: ${r.comWhatsapp}`);
    console.log(`█  📸 Instagram: ${r.comInstagram}`);
    console.log(`█  🌐 Sem site: ${r.semSite}`);
    console.log(`█  ⚔️  Concorrente: ${r.usaConcorrente}`);
    if (r.comDorAgendamento) console.log(`█  🚨 Reclamam fila: ${r.comDorAgendamento}`);
    console.log('█'.repeat(60));

    res.json({ ...qualifyRes.data, excelPath });
  } catch (err) {
    console.error('[Pipeline v2] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// PIPELINE A PARTIR DE DISCOVERY JÁ SALVO
// ════════════════════════════════════════════════════
app.post('/api/v2/pipeline-from-file', async (req, res) => {
  try {
    const { file = '/tmp/discover-result.json', minReviews = 5, segmentId, cities: inputCities } = req.body;

    const config = getConfig(segmentId);

    console.log('\n' + '█'.repeat(60));
    console.log(`█  PIPELINE v2 — A PARTIR DE DISCOVERY SALVO [${config.nome}]`);
    console.log('█'.repeat(60));

    if (!fs.existsSync(file)) {
      return res.status(404).json({ error: `Arquivo não encontrado: ${file}` });
    }
    const discoverData = JSON.parse(fs.readFileSync(file, 'utf-8'));
    console.log(`✅ Loaded ${discoverData.total} leads do arquivo`);

    // Detectar cidades dos dados ou usar as fornecidas
    const cities = inputCities || extractCities(discoverData.leads);

    // PRE-FILTER
    console.log('\n🔽 FASE 2: Pre-filter...');
    const filtered = discoverData.leads.filter(l => {
      if (l.businessStatus === 'CLOSED_PERMANENTLY') return false;
      const fromAltSource = ['receita_federal', 'google_search', 'instagram_search'].includes(l.source);
      if (!fromAltSource && l.totalAvaliacoes < minReviews) return false;
      return true;
    });
    console.log(`✅ ${filtered.length} leads após filtro (removidos: ${discoverData.total - filtered.length})`);

    // ENRICHMENT
    console.log('\n📊 FASE 3: Enrichment...');
    const enrichRes = await axios.post(`http://localhost:${PORT}/api/v2/enrich`, { leads: filtered, segmentId: config.id }, { timeout: 600000 });
    console.log(`✅ ${enrichRes.data.total} leads enriquecidos`);

    // DEEP ANALYSIS
    console.log('\n🧠 FASE 4: Deep Analysis...');
    const analyzeRes = await axios.post(`http://localhost:${PORT}/api/v2/analyze`, { leads: enrichRes.data.leads, segmentId: config.id }, { timeout: 60000 });
    console.log(`✅ ${analyzeRes.data.total} leads analisados`);

    // QUALIFY
    console.log('\n🎯 FASE 5: Qualify...');
    const qualifyRes = await axios.post(`http://localhost:${PORT}/api/v2/qualify`, { leads: analyzeRes.data.leads, segmentId: config.id }, { timeout: 600000 });
    console.log(`✅ ${qualifyRes.data.total} leads qualificados`);

    // EXPORT
    console.log('\n📄 Exportando...');
    const excelPath = await exportToExcel(qualifyRes.data.leads, cities, config);

    // SAVE JSON
    const citiesStr = cities.map(c => `${c.city}/${c.state}`).join(', ');
    const leadsData = {
      leads: qualifyRes.data.leads,
      resumo: qualifyRes.data.resumo,
      meta: { cities: citiesStr, date: new Date().toISOString(), total: qualifyRes.data.total, version: 'v2', segment: config.id },
    };
    if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leadsData, null, 2));

    const r = qualifyRes.data.resumo;
    console.log('\n' + '█'.repeat(60));
    console.log('█  PIPELINE v2 CONCLUÍDO');
    console.log(`█  Total: ${qualifyRes.data.total} | 🔥${r.quentes} 🟡${r.mornos} ❄️${r.frios}`);
    console.log(`█  📱WhatsApp: ${r.comWhatsapp} | 🌐Sem site: ${r.semSite} | ⚔️Concorrente: ${r.usaConcorrente}`);
    if (r.comDorAgendamento) console.log(`█  🚨Reclamam fila: ${r.comDorAgendamento}`);
    console.log('█'.repeat(60));

    res.json({ ...qualifyRes.data, excelPath });
  } catch (err) {
    console.error('[Pipeline from file] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// PIPELINE A PARTIR DE ENRICHED DATA (arquivo)
// ════════════════════════════════════════════════════
app.post('/api/v2/pipeline-from-enriched', async (req, res) => {
  try {
    const { file = '/tmp/enriched-result.json', segmentId, cities: inputCities } = req.body;

    const config = getConfig(segmentId);

    if (!fs.existsSync(file)) {
      return res.status(404).json({ error: `Arquivo não encontrado: ${file}` });
    }

    const enrichData = JSON.parse(fs.readFileSync(file, 'utf-8'));
    console.log(`\n✅ Loaded ${enrichData.total || enrichData.leads?.length} leads enriquecidos [${config.nome}]`);

    // Detectar cidades dos dados ou usar as fornecidas
    const cities = inputCities || extractCities(enrichData.leads);

    // ANALYZE
    console.log('\n🧠 FASE 4: Deep Analysis...');
    const analyzeRes = await axios.post(`http://localhost:${PORT}/api/v2/analyze`, { leads: enrichData.leads, segmentId: config.id }, { timeout: 60000 });
    console.log(`✅ ${analyzeRes.data.total} leads analisados`);

    // QUALIFY
    console.log('\n🎯 FASE 5: Qualify...');
    const qualifyRes = await axios.post(`http://localhost:${PORT}/api/v2/qualify`, { leads: analyzeRes.data.leads, segmentId: config.id }, { timeout: 600000 });
    console.log(`✅ ${qualifyRes.data.total} leads qualificados`);

    // EXPORT + SAVE
    console.log('\n📄 Exportando...');
    const excelPath = await exportToExcel(qualifyRes.data.leads, cities, config);
    const citiesStr = cities.map(c => `${c.city}/${c.state}`).join(', ');
    const leadsData = {
      leads: qualifyRes.data.leads,
      resumo: qualifyRes.data.resumo,
      meta: { cities: citiesStr, date: new Date().toISOString(), total: qualifyRes.data.total, version: 'v2', segment: config.id },
    };
    if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leadsData, null, 2));

    const r = qualifyRes.data.resumo;
    console.log('\n' + '█'.repeat(60));
    console.log(`█  CONCLUÍDO: ${qualifyRes.data.total} leads | 🔥${r.quentes} 🟡${r.mornos} ❄️${r.frios}`);
    console.log('█'.repeat(60));

    res.json({ ...qualifyRes.data, excelPath });
  } catch (err) {
    console.error('[Pipeline from enriched] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// V1 ENDPOINTS (compatibilidade)
// ════════════════════════════════════════════════════

app.post('/api/search', async (req, res) => {
  try {
    const { cities, queries } = req.body;
    if (!cities || !Array.isArray(cities)) {
      return res.status(400).json({ error: 'cities é obrigatório' });
    }
    const googleKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!googleKey) return res.status(400).json({ error: 'GOOGLE_MAPS_API_KEY não configurada' });

    const config = getConfig();
    const allLeads = [];
    for (const { city, state } of cities) {
      const gmResults = await searchGoogleMaps(city, state, googleKey, { queries }, config);
      const fsqKey = process.env.FOURSQUARE_API_KEY;
      const fsqResults = await searchFoursquare(city, state, fsqKey, config);
      const merged = deduplicateLeads([...gmResults, ...fsqResults.map(l => ({ ...l, rating: 0, totalAvaliacoes: 0 }))], config);
      allLeads.push(...merged.map(l => ({ ...l, cidade: city, estado: state })));
    }
    res.json({ total: allLeads.length, leads: allLeads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pipeline', async (req, res) => {
  console.log('[Pipeline v1] Redirecionando para v2...');
  try {
    const response = await axios.post(`http://localhost:${PORT}/api/v2/pipeline`, req.body, { timeout: 600000 });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// EXPORT EXCEL
// ════════════════════════════════════════════════════
async function exportToExcel(leads, cities, config = null) {
  if (!config) config = getConfig();

  const workbook = new ExcelJS.Workbook();
  workbook.creator = `${config.produto.nome} Lead Prospector v2`;

  const headerStyle = {
    font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a1a' } },
    alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
    border: { bottom: { style: 'thin', color: { argb: 'FFd4af37' } } },
  };

  // ── ABA 1: LEADS QUALIFICADOS ──
  const ws = workbook.addWorksheet('Leads Qualificados');
  ws.columns = [
    { header: '#', key: 'prioridade', width: 5 },
    { header: 'SCORE', key: 'score', width: 8 },
    { header: 'CLASSIFICAÇÃO', key: 'classificacao', width: 15 },
    { header: 'TAGS', key: 'tags', width: 25 },
    { header: 'NOME', key: 'nome', width: 30 },
    { header: 'CIDADE', key: 'cidade', width: 18 },
    { header: 'ENDEREÇO', key: 'endereco', width: 35 },
    { header: 'TELEFONE', key: 'telefone', width: 18 },
    { header: 'WHATSAPP', key: 'whatsapp', width: 18 },
    { header: 'WEBSITE', key: 'website', width: 25 },
    { header: 'INSTAGRAM', key: 'instagram', width: 25 },
    { header: 'EMAIL', key: 'email', width: 25 },
    { header: 'RATING', key: 'rating', width: 8 },
    { header: 'AVALIAÇÕES', key: 'avaliacoes', width: 12 },
    { header: 'HORÁRIOS', key: 'horarios', width: 35 },
    { header: 'USA CONCORRENTE', key: 'usaConcorrente', width: 18 },
    { header: 'DORES REVIEWS', key: 'doresReviews', width: 25 },
    { header: 'PERFIL', key: 'perfil', width: 30 },
    { header: 'DORES', key: 'dores', width: 40 },
    { header: 'ARGUMENTO', key: 'argumento', width: 35 },
    { header: 'PLANO', key: 'plano', width: 12 },
    { header: 'MSG WHATSAPP', key: 'msgWhatsapp', width: 50 },
    { header: 'MSG INSTAGRAM', key: 'msgInstagram', width: 40 },
    { header: 'MSG FOLLOW-UP', key: 'msgFollowup', width: 40 },
    { header: 'MELHOR HORÁRIO', key: 'melhorHorario', width: 20 },
    { header: 'RISCO', key: 'risco', width: 10 },
    { header: 'GOOGLE MAPS', key: 'googleMaps', width: 30 },
    { header: 'CONTATO', key: 'contatoFeito', width: 10 },
    { header: 'RESULTADO', key: 'resultado', width: 20 },
    { header: 'OBS', key: 'obs', width: 30 },
  ];

  ws.getRow(1).eachCell(cell => { Object.assign(cell, headerStyle); });
  ws.getRow(1).height = 25;

  let prioridade = 1;
  for (const lead of leads) {
    const q = lead.qualification || {};
    const row = ws.addRow({
      prioridade,
      score: q.score || 0,
      classificacao: q.classificacao || 'N/A',
      tags: (q.tags || []).join(', '),
      nome: lead.nome,
      cidade: lead.cidade || '',
      endereco: lead.endereco,
      telefone: lead.telefone || '',
      whatsapp: lead.whatsapp ? `https://wa.me/${lead.whatsapp}` : '',
      website: lead.website || 'NÃO TEM',
      instagram: lead.instagram?.url || '',
      email: lead.email || '',
      rating: lead.rating,
      avaliacoes: lead.totalAvaliacoes,
      horarios: (lead.horarios || []).join('\n'),
      usaConcorrente: lead.websiteAnalysis?.usaConcorrente
        ? lead.websiteAnalysis.competitorsFound.join(', ') : 'Não',
      doresReviews: lead.reviewAnalysis?.painSummary || '',
      perfil: q.perfil || '',
      dores: (q.dores_provaveis || []).join('; '),
      argumento: q.argumento_principal || '',
      plano: q.plano_recomendado || '',
      msgWhatsapp: q.mensagem_whatsapp || '',
      msgInstagram: q.mensagem_instagram || '',
      msgFollowup: q.mensagem_followup || '',
      melhorHorario: q.melhor_horario_contato || '',
      risco: q.risco || '',
      googleMaps: lead.googleMapsUrl || '',
      contatoFeito: 'Não',
      resultado: '',
      obs: '',
    });

    const colors = { 'QUENTE': 'FFFFE0E0', 'MORNO': 'FFFFF3CD', 'FRIO': 'FFE0E8FF' };
    const bgColor = colors[q.classificacao] || 'FFFFFFFF';
    row.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
      cell.alignment = { vertical: 'top', wrapText: true };
    });
    prioridade++;
  }

  ws.autoFilter = { from: 'A1', to: `AD${leads.length + 1}` };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // ── ABA 2: MENSAGENS ──
  const wsMsgs = workbook.addWorksheet('Mensagens');
  wsMsgs.columns = [
    { header: config.nome.toUpperCase(), key: 'nome', width: 25 },
    { header: 'WHATSAPP', key: 'whatsapp', width: 20 },
    { header: 'MENSAGEM INICIAL', key: 'msg1', width: 60 },
    { header: 'FOLLOW-UP', key: 'msg2', width: 50 },
    { header: 'STATUS', key: 'status', width: 15 },
  ];
  wsMsgs.getRow(1).eachCell(cell => { Object.assign(cell, headerStyle); });

  for (const lead of leads.filter(l => l.whatsapp || l.telefone)) {
    const q = lead.qualification || {};
    wsMsgs.addRow({
      nome: lead.nome,
      whatsapp: lead.whatsapp ? `https://wa.me/${lead.whatsapp}` : lead.telefone,
      msg1: q.mensagem_whatsapp || '',
      msg2: q.mensagem_followup || '',
      status: 'Pendente',
    });
  }

  // ── ABA 3: RESUMO ──
  const wsResumo = workbook.addWorksheet('Resumo');
  const cidadesStr = cities.map(c => `${c.city}/${c.state}`).join(', ');
  const data = new Date().toLocaleDateString('pt-BR');

  wsResumo.addRow([`${config.produto.nome.toUpperCase()} LEAD PROSPECTOR v2 — RELATÓRIO`]);
  wsResumo.addRow([`Data: ${data}`]);
  wsResumo.addRow([`Cidades: ${cidadesStr}`]);
  wsResumo.addRow([`Segmento: ${config.nome}`]);
  wsResumo.addRow([]);
  wsResumo.addRow(['RESUMO']);
  wsResumo.addRow(['Total de leads', leads.length]);
  wsResumo.addRow(['Quentes', leads.filter(l => l.qualification?.classificacao === 'QUENTE').length]);
  wsResumo.addRow(['Mornos', leads.filter(l => l.qualification?.classificacao === 'MORNO').length]);
  wsResumo.addRow(['Frios', leads.filter(l => l.qualification?.classificacao === 'FRIO').length]);
  wsResumo.addRow([]);
  wsResumo.addRow(['CONTATOS']);
  wsResumo.addRow(['Com WhatsApp', leads.filter(l => l.whatsapp).length]);
  wsResumo.addRow(['Com Instagram', leads.filter(l => l.instagram?.found).length]);
  wsResumo.addRow(['Com email', leads.filter(l => l.email).length]);
  wsResumo.addRow([]);
  wsResumo.addRow(['OPORTUNIDADES']);
  wsResumo.addRow(['Sem website', leads.filter(l => !l.website).length]);
  wsResumo.addRow(['Reclamam de fila/espera', leads.filter(l => l.reviewAnalysis?.hasSchedulingPain).length]);
  wsResumo.addRow(['Usa concorrente', leads.filter(l => l.websiteAnalysis?.usaConcorrente).length]);
  wsResumo.addRow(['Marketing abandonado', leads.filter(l => l.marketingStatus?.instagramStatus === 'abandonado').length]);

  wsResumo.getColumn(1).width = 30;
  wsResumo.getColumn(2).width = 15;
  wsResumo.getRow(1).font = { bold: true, size: 14 };
  wsResumo.getRow(6).font = { bold: true, size: 12 };

  const filename = `leads-${config.id}-v2-${new Date().toISOString().slice(0, 10)}.xlsx`;
  const filepath = path.join(EXPORTS_DIR, filename);
  if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  await workbook.xlsx.writeFile(filepath);

  return filepath;
}

// ════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════

/**
 * Extrai cidades únicas dos leads (para pipelines from-file/from-enriched)
 */
function extractCities(leads) {
  const seen = new Set();
  const cities = [];
  for (const lead of (leads || [])) {
    const city = lead.cidade || lead.city || '';
    const state = lead.estado || lead.state || '';
    if (city && state) {
      const key = `${city}|${state}`;
      if (!seen.has(key)) {
        seen.add(key);
        cities.push({ city, state });
      }
    }
  }
  return cities.length > 0 ? cities : [{ city: 'Desconhecida', state: '??' }];
}

function buildResumo(leads) {
  return {
    quentes: leads.filter(l => l.qualification?.classificacao === 'QUENTE').length,
    mornos: leads.filter(l => l.qualification?.classificacao === 'MORNO').length,
    frios: leads.filter(l => l.qualification?.classificacao === 'FRIO').length,
    comWhatsapp: leads.filter(l => l.whatsapp).length,
    comInstagram: leads.filter(l => l.instagram?.found).length,
    semSite: leads.filter(l => !l.website).length,
    usaConcorrente: leads.filter(l => l.websiteAnalysis?.usaConcorrente).length,
    comDorAgendamento: leads.filter(l => l.reviewAnalysis?.hasSchedulingPain).length,
    marketingAbandonado: leads.filter(l => l.marketingStatus?.instagramStatus === 'abandonado').length,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ════════════════════════════════════════════════════
// WHATSAPP
// ════════════════════════════════════════════════════

app.get('/api/whatsapp/status', async (req, res) => {
  try {
    const status = await getWhatsAppStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/whatsapp/connect', async (req, res) => {
  try {
    const result = await connectWhatsApp();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const { number, message } = req.body;
    if (!number || !message) {
      return res.status(400).json({ error: 'number e message são obrigatórios' });
    }
    const result = await sendWhatsApp(number, message);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/send-batch', async (req, res) => {
  try {
    const { leads, onlyQuente = true, maxSends = 5 } = req.body;
    if (!leads || !Array.isArray(leads)) {
      return res.status(400).json({ error: 'leads é obrigatório (array)' });
    }

    // Rate limit check
    const rateCheck = rateLimiter.canSendNow();
    if (!rateCheck.allowed) {
      return res.status(429).json({ error: rateCheck.reason, rateLimit: rateLimiter.getStats() });
    }

    // Filtrar e limitar pelo rate-limiter
    const effectiveMax = Math.min(maxSends, rateCheck.remaining);
    const targets = (onlyQuente
      ? leads.filter(l => l.qualification?.classificacao === 'QUENTE' && l.whatsapp)
      : leads.filter(l => l.whatsapp)
    )
      .filter(l => !conversationStore.isBlocked(l.whatsapp?.replace(/\D/g, '')))
      .slice(0, effectiveMax);

    if (targets.length === 0) {
      return res.json({ sent: 0, message: 'Nenhum lead elegível para envio' });
    }

    const status = await getWhatsAppStatus();
    if (!status.connected) {
      return res.status(503).json({ error: 'WhatsApp não conectado. Acesse /api/whatsapp/connect para gerar QR code.' });
    }

    const totalElegiveis = onlyQuente
      ? leads.filter(l => l.qualification?.classificacao === 'QUENTE' && l.whatsapp).length
      : leads.filter(l => l.whatsapp).length;

    res.json({
      queued: targets.length,
      limitado: totalElegiveis > effectiveMax,
      total_elegiveis: totalElegiveis,
      rateLimit: rateLimiter.getStats(),
      message: `Enviando para ${targets.length} leads (limite diário: ${rateCheck.remaining} restantes)`,
    });

    (async () => {
      let sent = 0;
      let failed = 0;
      for (const lead of targets) {
        const message = lead.qualification?.mensagem_whatsapp;
        if (!message) { failed++; continue; }

        // Re-check rate limit antes de cada envio
        if (!rateLimiter.canSendNow().allowed) {
          console.warn('[WhatsApp] Limite diário atingido durante batch, parando.');
          break;
        }

        const phone = lead.whatsapp.replace(/\D/g, '');
        try {
          await sendWhatsApp(phone, message);
          rateLimiter.incrementSent();
          sent++;

          // Criar conversa para rastrear estado
          conversationStore.createConversation(phone, {
            leadName: lead.nome,
            segment: lead.segmento || process.env.SEGMENT_ID,
            leadId: lead.place_id || lead.id,
            qualificationData: lead.qualification || {},
          });
          conversationStore.addMessage(phone, {
            direction: 'out',
            text: message,
            timestamp: new Date().toISOString(),
          });

          console.log(`[WhatsApp] Enviado para ${lead.nome} (${phone}) — ${sent}/${targets.length}`);
        } catch (err) {
          failed++;
          console.error(`[WhatsApp] Falhou para ${lead.nome}: ${err.message}`);
        }

        if (sent + failed < targets.length) {
          await sleep(rateLimiter.getRandomDelay());
        }
      }
      console.log(`[WhatsApp] Batch concluído: ${sent} enviados, ${failed} falhas`);
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// WHATSAPP WEBHOOK (recebe mensagens dos leads)
// ════════════════════════════════════════════════════

app.post('/api/whatsapp/webhook', async (req, res) => {
  // Responder 200 imediatamente (crítico para Evolution API)
  res.status(200).json({ received: true });

  // Forward para Inspector CRM (se configurado)
  const inspectorUrl = process.env.INSPECTOR_API_URL;
  if (inspectorUrl) {
    axios.post(`${inspectorUrl}/v1/webhooks/evolution`, req.body, {
      headers: { 'apikey': process.env.EVOLUTION_API_KEY || '', 'Content-Type': 'application/json' },
      timeout: 5000,
    }).catch(() => {}); // fire-and-forget
  }

  try {
    const body = req.body;

    // Só processar mensagens recebidas
    if (body.event !== 'messages.upsert') return;

    const key = body.data?.key;
    // Ignorar mensagens próprias
    if (key?.fromMe) return;
    // Ignorar grupos
    if (key?.remoteJid?.includes('@g.us')) return;

    const phone = key?.remoteJid?.replace('@s.whatsapp.net', '');
    const text = body.data?.message?.conversation
      ?? body.data?.message?.extendedTextMessage?.text
      ?? '';
    const pushName = body.data?.pushName ?? '';

    if (!text || !phone) return;

    // Blocklist check
    if (conversationStore.isBlocked(phone)) return;

    // Buscar ou criar conversa
    let convo = conversationStore.getConversation(phone);
    if (!convo) {
      // Lead respondeu sem ter sido contatado pelo sistema — criar conversa nova
      convo = conversationStore.createConversation(phone, { leadName: pushName });
    }

    // Registrar mensagem recebida
    conversationStore.addMessage(phone, {
      direction: 'in',
      text,
      timestamp: new Date().toISOString(),
    });

    // Recarregar conversa após addMessage
    convo = conversationStore.getConversation(phone);

    // Processar no flow engine
    const result = flowEngine.process(phone, text, convo, pushName);

    // Atualizar estado ANTES de enviar (salvar primeiro, como recomendado)
    conversationStore.updateStage(phone, result.newStage);

    // Processar ações
    for (const action of result.actions) {
      if (action === 'blocklist') {
        conversationStore.addToBlocklist(phone);
      }
      if (action === 'increment_objection') {
        const c = conversationStore.getConversation(phone);
        if (c) {
          c.objectionRounds = (c.objectionRounds || 0) + 1;
          conversationStore.saveConversation(phone, c);
        }
      }
    }

    // Enviar resposta (se houver)
    if (result.response) {
      // Delay 2-5s para parecer humano
      await sleep(2000 + Math.random() * 3000);
      await sendWhatsApp(phone, result.response);
      conversationStore.addMessage(phone, {
        direction: 'out',
        text: result.response,
        timestamp: new Date().toISOString(),
      });
    }

    // Notificar humano se necessário
    if (result.actions.includes('notify_human')) {
      const updatedConvo = conversationStore.getConversation(phone);
      await notifyHumanHandoff(phone, updatedConvo);
    }

    console.log(`[Webhook] ${phone} (${pushName}): "${text.substring(0, 50)}" → ${result.newStage}${result.response ? ' [respondido]' : ''}`);
  } catch (err) {
    console.error('[Webhook] Erro ao processar:', err.message);
  }
});

// ════════════════════════════════════════════════════
// CONVERSAS — APIs de gerenciamento
// ════════════════════════════════════════════════════

app.get('/api/conversations', (req, res) => {
  const { stage } = req.query;
  const convos = conversationStore.getAllConversations(stage || null);
  res.json({ total: convos.length, conversations: convos, stats: conversationStore.getStats() });
});

app.get('/api/conversations/stats', (req, res) => {
  res.json(conversationStore.getStats());
});

app.get('/api/conversations/blocklist', (req, res) => {
  res.json({ blocklist: conversationStore.getBlocklist() });
});

app.get('/api/conversations/:phone', (req, res) => {
  const convo = conversationStore.getConversation(req.params.phone);
  if (!convo) return res.status(404).json({ error: 'Conversa não encontrada' });
  res.json(convo);
});

app.post('/api/conversations/:phone/stage', (req, res) => {
  const { stage } = req.body;
  if (!stage) return res.status(400).json({ error: 'stage é obrigatório' });
  const convo = conversationStore.updateStage(req.params.phone, stage);
  if (!convo) return res.status(404).json({ error: 'Conversa não encontrada' });
  res.json({ message: `Estágio atualizado para "${stage}"`, conversation: convo });
});

// ════════════════════════════════════════════════════
// FOLLOW-UPS — Agendamento de follow-up
// ════════════════════════════════════════════════════

app.get('/api/followups/pending', (req, res) => {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const followupSchedule = [1, 3, 7]; // dias após primeiro contato

  const contacted = conversationStore.getByStage('contacted');
  const pending = [];

  for (const entry of contacted) {
    const convo = conversationStore.getConversation(entry.phone);
    if (!convo || convo.optedOut) continue;

    const daysSinceContact = Math.floor((now - new Date(convo.firstContactAt).getTime()) / DAY_MS);
    const nextFollowupDay = followupSchedule[convo.followupsSent || 0];

    if (nextFollowupDay && daysSinceContact >= nextFollowupDay && (convo.followupsSent || 0) < 3) {
      pending.push({
        phone: entry.phone,
        leadName: convo.leadName,
        daysSinceContact,
        followupNumber: (convo.followupsSent || 0) + 1,
        segment: convo.segment,
      });
    }
  }

  res.json({ total: pending.length, pending, rateLimit: rateLimiter.getStats() });
});

app.post('/api/followups/send', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });

  const rateCheck = rateLimiter.canSendNow();
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: rateCheck.reason });
  }

  const convo = conversationStore.getConversation(phone);
  if (!convo) return res.status(404).json({ error: 'Conversa não encontrada' });
  if (convo.optedOut) return res.status(400).json({ error: 'Lead optou por sair' });
  if (conversationStore.isBlocked(phone)) return res.status(400).json({ error: 'Número bloqueado' });

  const followupNum = (convo.followupsSent || 0) + 1;
  if (followupNum > 3) return res.status(400).json({ error: 'Máximo de 3 follow-ups atingido' });

  // Buscar template de follow-up do config
  try {
    const config = getConfig(convo.segment);
    const respostas = config?.respostas || {};
    const templateKey = `followup_${followupNum}`;
    let message = respostas[templateKey] || `Oi! Só passando pra ver se viu minha mensagem sobre o ${config?.produto?.nome || 'nosso produto'}. Posso ajudar?`;

    // Interpolar variáveis
    const vars = {
      nome: convo.leadName || 'amigo',
      nomeSimples: (convo.leadName || 'amigo').split(' ')[0],
      produto: config?.produto?.nome || 'Bookou',
      trial: config?.produto?.trial || '7 dias grátis',
      argumento: convo.qualificationData?.argumento_principal || '',
    };
    message = message.replace(/\{(\w+)\}/g, (_, key) => vars[key] || '');

    await sendWhatsApp(phone, message);
    rateLimiter.incrementSent();

    conversationStore.addMessage(phone, {
      direction: 'out',
      text: message,
      timestamp: new Date().toISOString(),
      type: `followup_${followupNum}`,
    });
    conversationStore.incrementFollowups(phone);

    res.json({ success: true, followupNumber: followupNum, phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// RATE LIMIT — Stats
// ════════════════════════════════════════════════════

app.get('/api/rate-limit', (req, res) => {
  res.json(rateLimiter.getStats());
});

// ════════════════════════════════════════════════════
// CACHE & SEEN REGISTRY ENDPOINTS
// ════════════════════════════════════════════════════
app.get('/api/cache/stats', (req, res) => {
  res.json(getCache().stats());
});

app.delete('/api/cache', (req, res) => {
  const { namespace } = req.query;
  getCache().clear(namespace || null);
  res.json({ message: namespace ? `Cache "${namespace}" limpo` : 'Cache inteiro limpo' });
});

app.get('/api/seen/stats', (req, res) => {
  const tenantId = req.query.tenantId || 'default';
  res.json(getSeenRegistry().stats(tenantId));
});

app.get('/api/pipeline/runs', (req, res) => {
  const tenantId = req.query.tenantId || 'default';
  res.json(getStorage().listPipelineRuns(tenantId));
});

// ════════════════════════════════════════════════════
// START + GRACEFUL SHUTDOWN
// ════════════════════════════════════════════════════
app.listen(PORT, () => {
  const config = getConfig();
  console.log(`\n🔍 ${config.produto.nome} Lead Prospector v2.1 rodando em http://localhost:${PORT}`);
  console.log(`   Segmento: ${config.nome} (${config.id})`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Segmentos: http://localhost:${PORT}/api/segments`);
  console.log(`   APIs:`);
  console.log(`   - Google Maps: ${process.env.GOOGLE_MAPS_API_KEY ? '✅' : '❌'}`);
  console.log(`   - Foursquare:  ${process.env.FOURSQUARE_API_KEY ? '✅' : '❌ (opcional)'}`);
  console.log(`   - Claude AI:   ${process.env.ANTHROPIC_API_KEY ? '✅' : '❌ (usa regras v2)'}`);
  console.log(`   - Evolution:   ${process.env.EVOLUTION_API_URL || 'http://evolution:8080'}`);
  console.log(`   WhatsApp:`);
  console.log(`     Conectar: http://localhost:${PORT}/api/whatsapp/connect`);
  console.log(`     Status:   http://localhost:${PORT}/api/whatsapp/status`);
  console.log(`   Infra:`);
  console.log(`   - Cache:     ${process.env.CACHE_BACKEND || 'memory'}`);
  console.log(`   - Storage:   ${process.env.STORAGE_BACKEND || 'file'}`);
  console.log(`   - Enrich:    ${ENRICH_CONCURRENCY}x paralelo`);
  console.log('');
});

// Graceful shutdown — persistir cache no disco
process.on('SIGTERM', () => {
  console.log('[Shutdown] Persistindo cache...');
  getCache().destroy();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[Shutdown] Persistindo cache...');
  getCache().destroy();
  process.exit(0);
});
