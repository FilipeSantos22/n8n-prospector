const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

// Sources
const { searchGoogleMaps, nearbySearchGrid, combinedSearch, getPlaceDetails } = require('./sources/google-maps');
const { sendWhatsApp, getWhatsAppStatus, connectWhatsApp } = require('./sources/whatsapp');
const { searchFoursquare } = require('./sources/foursquare');
const { checkInstagram } = require('./sources/instagram');
const { analyzeWebsite } = require('./sources/website-analyzer');

// Analysis
const { analyzeReviews } = require('./analysis/reviews');
const { analyzeMarketingStatus } = require('./analysis/marketing');

// Utils
const { generateGrid, geocodeCity } = require('./utils/grid');
const { extractWhatsApp } = require('./utils/phone');
const { deduplicateLeads } = require('./utils/dedup');

// Qualifier
const { qualifyWithAI } = require('./ai-qualifier');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3099;
const LEADS_FILE = '/home/node/exports/leads-data.json';
const EXPORTS_DIR = '/home/node/exports';

// ════════════════════════════════════════════════════
// PAINEL WEB — Dados dos leads
// ════════════════════════════════════════════════════
app.get('/api/leads', (req, res) => {
  try {
    if (fs.existsSync(LEADS_FILE)) {
      const data = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8'));
      return res.json(data);
    }
    res.json({ leads: [], resumo: {}, meta: {} });
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
  res.json({
    status: 'ok',
    version: '2.0.0',
    apis: {
      google_maps: !!process.env.GOOGLE_MAPS_API_KEY,
      foursquare: !!process.env.FOURSQUARE_API_KEY,
      google_search: !!process.env.GOOGLE_SEARCH_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
    }
  });
});

// ════════════════════════════════════════════════════════════
//  V2 ENDPOINTS
// ════════════════════════════════════════════════════════════

// ── FASE 1: DISCOVERY (grid geográfico + text search) ──
app.post('/api/v2/discover', async (req, res) => {
  try {
    const { cities } = req.body;
    if (!cities || !Array.isArray(cities)) {
      return res.status(400).json({ error: 'cities é obrigatório (array de {city, state})' });
    }

    const googleKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!googleKey) {
      return res.status(400).json({ error: 'GOOGLE_MAPS_API_KEY não configurada' });
    }

    const allLeads = [];

    for (const { city, state, radiusKm } of cities) {
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`DISCOVERY: ${city}/${state}`);
      console.log('═'.repeat(60));

      // Gerar grid
      let grid = generateGrid(city, state, radiusKm || 3);

      // Se não tem bounds pré-configurados, fazer geocoding
      if (grid.needsGeocoding) {
        console.log(`[Discovery] Geocoding para ${city}/${state}...`);
        const geo = await geocodeCity(city, state, googleKey);
        if (geo) {
          grid = generateGrid(city, state, radiusKm || 3);
          // Se ainda não tem, usar o geocoding result
          if (grid.needsGeocoding) {
            grid.points = [geo.center];
            grid.radiusMeters = 10000; // 10km de raio
          }
        }
      }

      // Busca combinada: Nearby (grid) + Text Search
      const results = await combinedSearch(city, state, grid.points, grid.radiusMeters, googleKey);

      // Foursquare (se configurado)
      const fsqKey = process.env.FOURSQUARE_API_KEY;
      const fsqResults = await searchFoursquare(city, state, fsqKey);

      // Merge de todas as fontes e dedup
      const allForCity = [...results, ...fsqResults.map(l => ({ ...l, rating: 0, totalAvaliacoes: 0 }))];
      const deduped = deduplicateLeads(allForCity);

      console.log(`[Discovery] ${city}/${state}: ${deduped.length} leads únicos`);
      allLeads.push(...deduped.map(l => ({ ...l, cidade: city, estado: state })));
    }

    res.json({ total: allLeads.length, leads: allLeads });
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
      // Descarta fechados permanentemente
      if (lead.businessStatus === 'CLOSED_PERMANENTLY') return false;
      // Mínimo de reviews
      if (lead.totalAvaliacoes < minReviews) return false;
      // Rating mínimo (se tem rating)
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
    const { leads } = req.body;
    if (!leads || !Array.isArray(leads)) {
      return res.status(400).json({ error: 'leads é obrigatório (array)' });
    }

    const googleKey = process.env.GOOGLE_MAPS_API_KEY;
    const enriched = [];
    let processed = 0;

    for (const lead of leads) {
      processed++;
      console.log(`[Enrich] ${processed}/${leads.length}: ${lead.nome}`);

      let enrichedLead = { ...lead };

      // 1. Google Place Details
      if (lead.place_id && googleKey) {
        const details = await getPlaceDetails(lead.place_id, googleKey);
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

          // Extrair WhatsApp
          enrichedLead.whatsapp = extractWhatsApp({
            phone: details.telefone,
            phoneInternational: details.telefoneInternacional,
          });
        }
        await sleep(200);
      }

      // 2. Análise do website
      if (enrichedLead.website) {
        console.log(`  [Website] Analisando ${enrichedLead.website}`);
        enrichedLead.websiteAnalysis = await analyzeWebsite(enrichedLead.website);

        // Extrair contatos extras do site
        if (enrichedLead.websiteAnalysis.whatsappLinks?.length > 0 && !enrichedLead.whatsapp) {
          enrichedLead.whatsapp = enrichedLead.websiteAnalysis.whatsappLinks[0];
        }
        if (enrichedLead.websiteAnalysis.emails?.length > 0) {
          enrichedLead.email = enrichedLead.websiteAnalysis.emails[0];
        }
        if (enrichedLead.websiteAnalysis.socialMedia?.instagram) {
          enrichedLead.instagramHandle = enrichedLead.websiteAnalysis.socialMedia.instagram;
        }

        // WhatsApp do site
        if (!enrichedLead.whatsapp && enrichedLead.websiteAnalysis.whatsappLinks?.length > 0) {
          enrichedLead.whatsapp = enrichedLead.websiteAnalysis.whatsappLinks[0];
        }
      }

      // 3. Instagram (só se já temos o handle do site — evita scraping lento)
      if (enrichedLead.instagramHandle) {
        console.log(`  [Instagram] Verificando @${enrichedLead.instagramHandle}...`);
        const igResult = await checkInstagram(enrichedLead.nome, enrichedLead.instagramHandle);
        enrichedLead.instagram = igResult;

        if (igResult.found && !enrichedLead.whatsapp) {
          const waFromIg = extractWhatsApp({
            instagramBio: igResult.bio,
            instagramLink: igResult.linkExterno,
          });
          if (waFromIg) enrichedLead.whatsapp = waFromIg;
        }
      } else {
        enrichedLead.instagram = { found: false, handle: null };
      }

      enriched.push(enrichedLead);

      // Salvar progresso a cada 50 leads
      if (enriched.length % 50 === 0) {
        const tmpFile = '/tmp/enriched-result.json';
        fs.writeFileSync(tmpFile, JSON.stringify({ total: enriched.length, leads: enriched }));
        console.log(`  [Backup] ${enriched.length} leads salvos em ${tmpFile}`);
      }

      await sleep(300);
    }

    // Salvar resultado final
    const tmpFile = '/tmp/enriched-result.json';
    fs.writeFileSync(tmpFile, JSON.stringify({ total: enriched.length, leads: enriched }));
    console.log(`[Enrich] Resultado salvo em ${tmpFile}`);

    res.json({ total: enriched.length, leads: enriched });
  } catch (err) {
    console.error('[Enrich] Erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── FASE 4: DEEP ANALYSIS ──
app.post('/api/v2/analyze', async (req, res) => {
  try {
    const { leads } = req.body;
    if (!leads || !Array.isArray(leads)) {
      return res.status(400).json({ error: 'leads é obrigatório (array)' });
    }

    const analyzed = leads.map(lead => {
      // Análise de reviews
      const reviewAnalysis = analyzeReviews(lead.reviews);

      // Análise de marketing
      const marketingStatus = analyzeMarketingStatus(lead.instagram, lead.websiteAnalysis);

      return {
        ...lead,
        reviewAnalysis,
        marketingStatus,
      };
    });

    // Estatísticas da análise
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
    const { leads } = req.body;
    if (!leads || !Array.isArray(leads)) {
      return res.status(400).json({ error: 'leads é obrigatório (array)' });
    }

    const qualified = [];
    let processed = 0;

    for (const lead of leads) {
      processed++;
      console.log(`[Qualify] ${processed}/${leads.length}: ${lead.nome}`);

      const qualification = await qualifyWithAI(lead);
      qualified.push({ ...lead, qualification });
      await sleep(100);
    }

    // Ordenar por score
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
    const { cities, minReviews = 5, minRating = 0, radiusKm = 5 } = req.body;

    console.log('\n' + '█'.repeat(60));
    console.log('█  BOOKOU LEAD PROSPECTOR v2 — PIPELINE');
    console.log('█'.repeat(60));

    const citiesWithRadius = cities.map(c => ({ ...c, radiusKm }));

    // FASE 1: DISCOVERY
    console.log('\n🔍 FASE 1: Discovery (grid geográfico)...');
    const discoverRes = await axios.post(`http://localhost:${PORT}/api/v2/discover`, { cities: citiesWithRadius }, { timeout: 600000 });
    console.log(`✅ ${discoverRes.data.total} leads encontrados`);

    // FASE 2: PRE-FILTER
    console.log('\n🔽 FASE 2: Pre-filter...');
    const filterRes = await axios.post(`http://localhost:${PORT}/api/v2/prefilter`, {
      leads: discoverRes.data.leads, minReviews, minRating,
    }, { timeout: 60000 });
    console.log(`✅ ${filterRes.data.total} leads após filtro (removidos: ${filterRes.data.removed})`);

    // FASE 3: ENRICHMENT
    console.log('\n📊 FASE 3: Enrichment...');
    const enrichRes = await axios.post(`http://localhost:${PORT}/api/v2/enrich`, { leads: filterRes.data.leads }, { timeout: 600000 });
    console.log(`✅ ${enrichRes.data.total} leads enriquecidos`);

    // FASE 4: DEEP ANALYSIS
    console.log('\n🧠 FASE 4: Deep Analysis...');
    const analyzeRes = await axios.post(`http://localhost:${PORT}/api/v2/analyze`, { leads: enrichRes.data.leads }, { timeout: 60000 });
    console.log(`✅ ${analyzeRes.data.total} leads analisados`);

    // FASE 5: QUALIFY
    console.log('\n🎯 FASE 5: Qualify...');
    const qualifyRes = await axios.post(`http://localhost:${PORT}/api/v2/qualify`, { leads: analyzeRes.data.leads }, { timeout: 600000 });
    console.log(`✅ ${qualifyRes.data.total} leads qualificados`);

    // EXPORT EXCEL
    console.log('\n📄 Exportando Excel...');
    const excelPath = await exportToExcel(qualifyRes.data.leads, cities);
    console.log(`✅ ${excelPath}`);

    // SAVE JSON
    console.log('\n💾 Salvando dashboard...');
    const leadsData = {
      leads: qualifyRes.data.leads,
      resumo: qualifyRes.data.resumo,
      meta: {
        cities: cities.map(c => `${c.city}/${c.state}`).join(', '),
        date: new Date().toISOString(),
        total: qualifyRes.data.total,
        version: 'v2',
      },
    };
    if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leadsData, null, 2));

    // RESUMO
    const r = qualifyRes.data.resumo;
    console.log('\n' + '█'.repeat(60));
    console.log('█  PIPELINE v2 CONCLUÍDO');
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
    const { file = '/tmp/discover-result.json', minReviews = 5 } = req.body;

    console.log('\n' + '█'.repeat(60));
    console.log('█  PIPELINE v2 — A PARTIR DE DISCOVERY SALVO');
    console.log('█'.repeat(60));

    // Ler discovery do arquivo
    if (!fs.existsSync(file)) {
      return res.status(404).json({ error: `Arquivo não encontrado: ${file}` });
    }
    const discoverData = JSON.parse(fs.readFileSync(file, 'utf-8'));
    console.log(`✅ Loaded ${discoverData.total} leads do arquivo`);

    // PRE-FILTER
    console.log('\n🔽 FASE 2: Pre-filter...');
    const filtered = discoverData.leads.filter(l => {
      if (l.businessStatus === 'CLOSED_PERMANENTLY') return false;
      if (l.totalAvaliacoes < minReviews) return false;
      return true;
    });
    console.log(`✅ ${filtered.length} leads após filtro (removidos: ${discoverData.total - filtered.length})`);

    // ENRICHMENT
    console.log('\n📊 FASE 3: Enrichment...');
    const enrichRes = await axios.post(`http://localhost:${PORT}/api/v2/enrich`, { leads: filtered }, { timeout: 600000 });
    console.log(`✅ ${enrichRes.data.total} leads enriquecidos`);

    // DEEP ANALYSIS
    console.log('\n🧠 FASE 4: Deep Analysis...');
    const analyzeRes = await axios.post(`http://localhost:${PORT}/api/v2/analyze`, { leads: enrichRes.data.leads }, { timeout: 60000 });
    console.log(`✅ ${analyzeRes.data.total} leads analisados`);

    // QUALIFY
    console.log('\n🎯 FASE 5: Qualify...');
    const qualifyRes = await axios.post(`http://localhost:${PORT}/api/v2/qualify`, { leads: analyzeRes.data.leads }, { timeout: 600000 });
    console.log(`✅ ${qualifyRes.data.total} leads qualificados`);

    // EXPORT
    console.log('\n📄 Exportando...');
    const cities = [{ city: 'Goiânia', state: 'GO' }];
    const excelPath = await exportToExcel(qualifyRes.data.leads, cities);

    // SAVE JSON
    const leadsData = {
      leads: qualifyRes.data.leads,
      resumo: qualifyRes.data.resumo,
      meta: { cities: 'Goiânia/GO', date: new Date().toISOString(), total: qualifyRes.data.total, version: 'v2' },
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
    const { file = '/tmp/enriched-result.json' } = req.body;

    if (!fs.existsSync(file)) {
      return res.status(404).json({ error: `Arquivo não encontrado: ${file}` });
    }

    const enrichData = JSON.parse(fs.readFileSync(file, 'utf-8'));
    console.log(`\n✅ Loaded ${enrichData.total || enrichData.leads?.length} leads enriquecidos`);

    // ANALYZE
    console.log('\n🧠 FASE 4: Deep Analysis...');
    const analyzeRes = await axios.post(`http://localhost:${PORT}/api/v2/analyze`, { leads: enrichData.leads }, { timeout: 60000 });
    console.log(`✅ ${analyzeRes.data.total} leads analisados`);

    // QUALIFY
    console.log('\n🎯 FASE 5: Qualify...');
    const qualifyRes = await axios.post(`http://localhost:${PORT}/api/v2/qualify`, { leads: analyzeRes.data.leads }, { timeout: 600000 });
    console.log(`✅ ${qualifyRes.data.total} leads qualificados`);

    // EXPORT + SAVE
    console.log('\n📄 Exportando...');
    const cities = [{ city: 'Goiânia', state: 'GO' }];
    const excelPath = await exportToExcel(qualifyRes.data.leads, cities);
    const leadsData = {
      leads: qualifyRes.data.leads,
      resumo: qualifyRes.data.resumo,
      meta: { cities: 'Goiânia/GO', date: new Date().toISOString(), total: qualifyRes.data.total, version: 'v2' },
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

    const allLeads = [];
    for (const { city, state } of cities) {
      const gmResults = await searchGoogleMaps(city, state, googleKey, { queries });
      const fsqKey = process.env.FOURSQUARE_API_KEY;
      const fsqResults = await searchFoursquare(city, state, fsqKey);
      const merged = deduplicateLeads([...gmResults, ...fsqResults.map(l => ({ ...l, rating: 0, totalAvaliacoes: 0 }))]);
      allLeads.push(...merged.map(l => ({ ...l, cidade: city, estado: state })));
    }
    res.json({ total: allLeads.length, leads: allLeads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pipeline', async (req, res) => {
  // Redireciona para v2
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
async function exportToExcel(leads, cities) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Bookou Lead Prospector v2';

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
    { header: 'BARBEARIA', key: 'nome', width: 25 },
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

  wsResumo.addRow(['BOOKOU LEAD PROSPECTOR v2 — RELATÓRIO']);
  wsResumo.addRow([`Data: ${data}`]);
  wsResumo.addRow([`Cidades: ${cidadesStr}`]);
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
  wsResumo.getRow(5).font = { bold: true, size: 12 };

  const filename = `leads-v2-${new Date().toISOString().slice(0, 10)}.xlsx`;
  const filepath = path.join(EXPORTS_DIR, filename);
  if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  await workbook.xlsx.writeFile(filepath);

  return filepath;
}

// ════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════

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

// Enviar mensagem para um lead
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

// Enviar mensagens em lote para lista de leads (com delay entre envios)
app.post('/api/whatsapp/send-batch', async (req, res) => {
  try {
    const { leads, delayMs = 20000, onlyQuente = true, maxSends = 2 } = req.body;
    if (!leads || !Array.isArray(leads)) {
      return res.status(400).json({ error: 'leads é obrigatório (array)' });
    }

    const targets = (onlyQuente
      ? leads.filter(l => l.qualification?.classificacao === 'QUENTE' && l.whatsapp)
      : leads.filter(l => l.whatsapp)
    ).slice(0, maxSends);

    if (targets.length === 0) {
      return res.json({ sent: 0, message: 'Nenhum lead elegível para envio' });
    }

    // Verificar se WhatsApp está conectado antes de iniciar
    const status = await getWhatsAppStatus();
    if (!status.connected) {
      return res.status(503).json({ error: 'WhatsApp não conectado. Acesse /api/whatsapp/connect para gerar QR code.' });
    }

    const totalElegiveis = onlyQuente
      ? leads.filter(l => l.qualification?.classificacao === 'QUENTE' && l.whatsapp).length
      : leads.filter(l => l.whatsapp).length;

    res.json({
      queued: targets.length,
      limitado: totalElegiveis > maxSends,
      total_elegiveis: totalElegiveis,
      message: `Enviando para ${targets.length} de ${totalElegiveis} leads elegíveis (limite: ${maxSends})`,
    });

    // Envio em background com delay
    (async () => {
      let sent = 0;
      let failed = 0;
      for (const lead of targets) {
        const message = lead.qualification?.mensagem_whatsapp;
        if (!message) { failed++; continue; }

        try {
          await sendWhatsApp(lead.whatsapp, message);
          sent++;
          console.log(`[WhatsApp] ✅ Enviado para ${lead.nome} (${lead.whatsapp}) — ${sent}/${targets.length}`);
        } catch (err) {
          failed++;
          console.error(`[WhatsApp] ❌ Falhou para ${lead.nome}: ${err.message}`);
        }

        if (sent + failed < targets.length) {
          await sleep(delayMs);
        }
      }
      console.log(`[WhatsApp] Batch concluído: ${sent} enviados, ${failed} falhas`);
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🔍 Bookou Lead Prospector v2 rodando em http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   APIs:`);
  console.log(`   - Google Maps: ${process.env.GOOGLE_MAPS_API_KEY ? '✅' : '❌'}`);
  console.log(`   - Foursquare:  ${process.env.FOURSQUARE_API_KEY ? '✅' : '❌ (opcional)'}`);
  console.log(`   - Claude AI:   ${process.env.ANTHROPIC_API_KEY ? '✅' : '❌ (usa regras v2)'}`);
  console.log(`   - Evolution:   ${process.env.EVOLUTION_API_URL || 'http://evolution:8080'}`);
  console.log(`   WhatsApp:`);
  console.log(`     Conectar: http://localhost:${PORT}/api/whatsapp/connect`);
  console.log(`     Status:   http://localhost:${PORT}/api/whatsapp/status`);
  console.log('');
});
