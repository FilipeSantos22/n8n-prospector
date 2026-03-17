const axios = require('axios');

/**
 * Busca empresas por CNAE na Receita Federal via BrasilAPI + ReceitaWS
 * CNAE é o código de atividade econômica (ex: 9602501 = cabeleireiros)
 *
 * Estratégia: usa a API pública da ReceitaWS (free: 3 req/min)
 * e BrasilAPI (free, sem limite claro mas rate-limited)
 *
 * Como não existe API pública que liste CNPJs por CNAE+cidade,
 * usamos a CasaDosDados (CNPJ.ws) que permite busca por atividade+município
 */

const DEFAULT_CNAES = {
  barbearias: ['9602501'], // Cabeleireiros, manicure e pedicure
  clinicas_esteticas: ['9602502', '8650002'], // Atividades de estética, Clínicas de estética
};

/**
 * Busca empresas por CNAE e município usando API pública cnpjs.rocks
 * Alternativa: minhareceita.org
 */
async function searchByCNAE(city, state, config = null) {
  const cnaes = config?.busca?.cnaes;
  if (!cnaes || cnaes.length === 0) {
    console.log('[CNAE] Nenhum CNAE configurado para este segmento, pulando...');
    return [];
  }

  const allResults = [];

  for (const cnae of cnaes) {
    console.log(`[CNAE] Buscando CNAE ${cnae} em ${city}/${state}...`);

    try {
      // Usar a API pública cnpjs.rocks (busca por CNAE + município)
      const results = await searchCNPJsRocks(cnae, city, state);
      allResults.push(...results);
    } catch (err) {
      console.error(`[CNAE] Erro na busca por CNAE ${cnae}:`, err.message);
    }

    // Fallback: tentar ReceitaWS open CNPJ data
    if (allResults.length === 0) {
      try {
        const results = await searchMinhaReceita(cnae, city, state);
        allResults.push(...results);
      } catch (err) {
        console.error(`[CNAE] Fallback MinhaReceita falhou:`, err.message);
      }
    }

    await sleep(1000);
  }

  console.log(`[CNAE] Total: ${allResults.length} empresas encontradas em ${city}/${state}`);
  return allResults;
}

/**
 * Busca via cnpjs.rocks API (gratuita, dados abertos da Receita)
 * Endpoint: GET /cnpjs?cnae={cnae}&municipio={cidade}&uf={uf}
 */
async function searchCNPJsRocks(cnae, city, state) {
  const results = [];
  let page = 1;
  const maxPages = 5;

  while (page <= maxPages) {
    try {
      const { data } = await axios.get('https://api.cnpjs.rocks/v1/cnpjs', {
        params: {
          cnae_fiscal: cnae,
          municipio: normalizeCity(city),
          uf: state.toUpperCase(),
          situacao_cadastral: '02', // Apenas ativas
          page,
          per_page: 100,
        },
        timeout: 15000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'LeadProspector/1.0',
        },
      });

      const items = data.data || data.cnpjs || data.results || [];
      if (items.length === 0) break;

      for (const empresa of items) {
        results.push(parseCNPJResult(empresa));
      }

      console.log(`[CNAE] cnpjs.rocks página ${page}: ${items.length} resultados (total: ${results.length})`);

      if (items.length < 100) break;
      page++;
      await sleep(2000);
    } catch (err) {
      if (err.response?.status === 404 || err.response?.status === 422) break;
      throw err;
    }
  }

  return results;
}

/**
 * Fallback: busca via MinhaReceita API (dados abertos Receita Federal)
 * https://minhareceita.org
 */
async function searchMinhaReceita(cnae, city, state) {
  const results = [];

  try {
    const { data } = await axios.post('https://minhareceita.org/search', {
      cnae: [cnae],
      uf: [state.toUpperCase()],
      municipio: [normalizeCity(city)],
      situacao_cadastral: '02',
      page: 1,
    }, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LeadProspector/1.0',
      },
    });

    const items = data.data || data.results || [];
    for (const empresa of items) {
      results.push(parseCNPJResult(empresa));
    }

    console.log(`[CNAE] MinhaReceita: ${results.length} resultados`);
  } catch (err) {
    if (err.response?.status !== 404) throw err;
  }

  return results;
}

/**
 * Enriquece um CNPJ específico via BrasilAPI (3 req/min free)
 */
async function enrichCNPJ(cnpj) {
  try {
    const clean = cnpj.replace(/\D/g, '');
    const { data } = await axios.get(`https://brasilapi.com.br/api/cnpj/v1/${clean}`, {
      timeout: 10000,
    });

    return {
      cnpj: data.cnpj,
      razao_social: data.razao_social,
      nome_fantasia: data.nome_fantasia,
      situacao: data.descricao_situacao_cadastral,
      abertura: data.data_inicio_atividade,
      cnae_principal: data.cnae_fiscal_descricao,
      logradouro: data.logradouro,
      numero: data.numero,
      bairro: data.bairro,
      municipio: data.municipio,
      uf: data.uf,
      cep: data.cep,
      telefone: data.ddd_telefone_1 || '',
      telefone2: data.ddd_telefone_2 || '',
      email: data.email || '',
      porte: data.porte,
      capital_social: data.capital_social,
    };
  } catch (err) {
    console.error(`[BrasilAPI] Erro para CNPJ ${cnpj}:`, err.message);
    return null;
  }
}

/**
 * Parseia resultado de busca CNPJ para formato de lead
 */
function parseCNPJResult(empresa) {
  const nome = empresa.nome_fantasia || empresa.razao_social || empresa.name || '';
  const telefone = empresa.ddd_telefone_1 || empresa.telefone || empresa.phone || '';
  const telefone2 = empresa.ddd_telefone_2 || '';

  const endereco = [
    empresa.logradouro || empresa.street,
    empresa.numero || empresa.number,
    empresa.bairro || empresa.neighborhood,
    empresa.municipio || empresa.city,
    empresa.uf || empresa.state,
  ].filter(Boolean).join(', ');

  return {
    source: 'receita_federal',
    cnpj: empresa.cnpj || empresa.cnpj_basico || '',
    nome: nome.trim(),
    razao_social: (empresa.razao_social || '').trim(),
    endereco,
    cidade: empresa.municipio || empresa.city || '',
    estado: empresa.uf || empresa.state || '',
    cep: empresa.cep || '',
    telefone: formatPhone(telefone),
    telefone2: formatPhone(telefone2),
    email: (empresa.email || '').toLowerCase().trim(),
    cnae: empresa.cnae_fiscal || empresa.cnae || '',
    situacao: empresa.situacao_cadastral || empresa.descricao_situacao_cadastral || '',
    abertura: empresa.data_inicio_atividade || empresa.abertura || '',
    porte: empresa.porte || '',
    // Campos para compatibilidade com pipeline
    rating: 0,
    totalAvaliacoes: 0,
    lat: null,
    lng: null,
  };
}

/**
 * Formata telefone da Receita (vem como "6232001234")
 */
function formatPhone(phone) {
  if (!phone) return '';
  const clean = phone.toString().replace(/\D/g, '');
  if (clean.length === 10) return `(${clean.slice(0, 2)}) ${clean.slice(2, 6)}-${clean.slice(6)}`;
  if (clean.length === 11) return `(${clean.slice(0, 2)}) ${clean.slice(2, 7)}-${clean.slice(7)}`;
  return clean;
}

function normalizeCity(city) {
  return city
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { searchByCNAE, enrichCNPJ };
