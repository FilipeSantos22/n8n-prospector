-- ════════════════════════════════════════════════════
-- n8n-prospector — Schema PostgreSQL
-- ════════════════════════════════════════════════════
-- Executar na ordem. Tudo é idempotente (IF NOT EXISTS).
--
-- Para criar o banco:
--   CREATE DATABASE prospector;
--   \c prospector
--   \i schema.sql

-- ═══ EXTENSIONS ═══
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- Similaridade de texto para dedup

-- ════════════════════════════════════════════════════
-- TENANTS
-- ════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY DEFAULT 'default',
  nome        TEXT NOT NULL,
  email       TEXT,
  plano       TEXT DEFAULT 'free',           -- free | pro | enterprise
  ativo       BOOLEAN DEFAULT true,
  config      JSONB DEFAULT '{}',            -- Configurações específicas do tenant
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Tenant padrão (uso local sem multi-tenancy)
INSERT INTO tenants (id, nome) VALUES ('default', 'Local')
ON CONFLICT (id) DO NOTHING;

-- ════════════════════════════════════════════════════
-- SEGMENTS (configs de segmento — espelho do JSON)
-- ════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS segments (
  id          TEXT PRIMARY KEY,              -- 'barbearias', 'clinicas-esteticas'
  nome        TEXT NOT NULL,
  config      JSONB NOT NULL,               -- Config completo do segmento
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ════════════════════════════════════════════════════
-- PIPELINE RUNS (execuções do pipeline)
-- ════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) DEFAULT 'default',
  segment_id    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | running | completed | failed
  cities        JSONB NOT NULL DEFAULT '[]',      -- [{city, state}]
  params        JSONB DEFAULT '{}',               -- minReviews, radiusKm, newOnly, etc.

  -- Contadores por fase
  total_discovered  INT DEFAULT 0,
  total_filtered    INT DEFAULT 0,
  total_enriched    INT DEFAULT 0,
  total_analyzed    INT DEFAULT 0,
  total_qualified   INT DEFAULT 0,

  -- Resumo final
  resumo        JSONB DEFAULT '{}',               -- quentes, mornos, frios, etc.
  excel_path    TEXT,
  error         TEXT,

  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_runs_tenant ON pipeline_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON pipeline_runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_segment ON pipeline_runs(segment_id);
CREATE INDEX IF NOT EXISTS idx_runs_created ON pipeline_runs(created_at DESC);

-- ════════════════════════════════════════════════════
-- LEADS (tabela principal)
-- ════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS leads (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) DEFAULT 'default',
  segment_id      TEXT NOT NULL,

  -- Identificadores (para dedup)
  place_id        TEXT,                     -- Google Maps place_id
  cnpj            TEXT,                     -- CNPJ (Receita Federal)
  instagram_handle TEXT,                    -- @handle

  -- Dados básicos
  nome            TEXT NOT NULL,
  razao_social    TEXT,
  endereco        TEXT,
  cidade          TEXT,
  estado          TEXT,
  cep             TEXT,
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,

  -- Contato
  telefone        TEXT,
  telefone_intl   TEXT,
  whatsapp        TEXT,
  email           TEXT,
  website         TEXT,

  -- Google Maps
  rating          REAL DEFAULT 0,
  total_avaliacoes INT DEFAULT 0,
  google_maps_url TEXT,
  horarios        TEXT[],                   -- Array de strings
  business_status TEXT DEFAULT 'OPERATIONAL',

  -- Instagram
  instagram_data  JSONB DEFAULT '{}',       -- {found, seguidores, posts, bio, isBusiness, ...}

  -- Website analysis
  website_analysis JSONB DEFAULT '{}',      -- {usaConcorrente, competitorsFound, maturidadeDigital, ...}

  -- Review analysis
  review_analysis JSONB DEFAULT '{}',       -- {painSummary, hasSchedulingPain, painCounts, ...}
  reviews_raw     JSONB DEFAULT '[]',       -- Reviews brutos [{autor, nota, texto, tempo}]

  -- Marketing analysis
  marketing_status JSONB DEFAULT '{}',      -- {digitalPresence, instagramStatus, signals}

  -- Qualificação
  qualification   JSONB DEFAULT '{}',       -- {score, classificacao, tags, dores, mensagens, ...}
  score           INT GENERATED ALWAYS AS ((qualification->>'score')::INT) STORED,
  classificacao   TEXT GENERATED ALWAYS AS (qualification->>'classificacao') STORED,

  -- CNPJ data
  porte           TEXT,                     -- MEI, ME, EPP, DEMAIS
  abertura        DATE,                     -- Data de abertura

  -- Fontes
  sources         TEXT[] DEFAULT '{}',      -- {'google_maps', 'receita_federal', ...}
  source_primary  TEXT,                     -- Fonte que descobriu primeiro

  -- Controle
  first_seen_at   TIMESTAMPTZ DEFAULT NOW(), -- Quando foi descoberto pela primeira vez
  last_seen_at    TIMESTAMPTZ DEFAULT NOW(), -- Última vez que apareceu em um discovery
  enriched_at     TIMESTAMPTZ,
  qualified_at    TIMESTAMPTZ,
  contacted_at    TIMESTAMPTZ,              -- Quando foi contatado
  contact_result  TEXT,                     -- Resultado do contato

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para dedup
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_place_id
  ON leads(tenant_id, place_id) WHERE place_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_cnpj
  ON leads(tenant_id, cnpj) WHERE cnpj IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_ig_handle
  ON leads(tenant_id, instagram_handle) WHERE instagram_handle IS NOT NULL;

-- Índices para consulta
CREATE INDEX IF NOT EXISTS idx_leads_tenant_segment ON leads(tenant_id, segment_id);
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_leads_classificacao ON leads(classificacao);
CREATE INDEX IF NOT EXISTS idx_leads_cidade ON leads(cidade);
CREATE INDEX IF NOT EXISTS idx_leads_nome_trgm ON leads USING gin(nome gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_leads_whatsapp ON leads(whatsapp) WHERE whatsapp IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_first_seen ON leads(first_seen_at DESC);

-- ════════════════════════════════════════════════════
-- LEAD_RUNS (relação N:N entre leads e pipeline runs)
-- ════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS lead_runs (
  lead_id     UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  run_id      UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  phase       TEXT NOT NULL,                -- discovered | filtered | enriched | analyzed | qualified
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (lead_id, run_id, phase)
);

CREATE INDEX IF NOT EXISTS idx_lead_runs_run ON lead_runs(run_id);

-- ════════════════════════════════════════════════════
-- SEEN_HISTORY (dedup incremental — leads já vistos)
-- ════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS seen_history (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) DEFAULT 'default',
  key_type    TEXT NOT NULL,                -- 'pid' | 'cnpj' | 'ig' | 'name'
  key_value   TEXT NOT NULL,
  first_seen  TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(tenant_id, key_type, key_value)
);

CREATE INDEX IF NOT EXISTS idx_seen_tenant ON seen_history(tenant_id);
CREATE INDEX IF NOT EXISTS idx_seen_lookup ON seen_history(tenant_id, key_type, key_value);

-- ════════════════════════════════════════════════════
-- CACHE (alternativa ao Redis para cache persistente)
-- ════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cache (
  namespace   TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);

-- ════════════════════════════════════════════════════
-- MESSAGES (histórico de mensagens enviadas)
-- ════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) DEFAULT 'default',
  lead_id     UUID REFERENCES leads(id) ON DELETE SET NULL,
  channel     TEXT NOT NULL,                -- 'whatsapp' | 'instagram' | 'email'
  destination TEXT NOT NULL,                -- Número, handle ou email
  content     TEXT NOT NULL,
  type        TEXT DEFAULT 'initial',       -- 'initial' | 'followup'
  status      TEXT DEFAULT 'pending',       -- 'pending' | 'sent' | 'delivered' | 'read' | 'failed'
  error       TEXT,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

-- ════════════════════════════════════════════════════
-- API_USAGE (rastreamento de consumo de APIs)
-- ════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS api_usage (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) DEFAULT 'default',
  api         TEXT NOT NULL,                -- 'google_maps' | 'foursquare' | 'anthropic' | ...
  endpoint    TEXT,                         -- 'nearbysearch' | 'placedetails' | 'textsearch' | ...
  requests    INT DEFAULT 1,
  cost_units  REAL DEFAULT 0,              -- Unidades de custo estimado
  run_id      UUID REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_tenant_api ON api_usage(tenant_id, api);
CREATE INDEX IF NOT EXISTS idx_usage_created ON api_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_run ON api_usage(run_id);

-- View: consumo diário por API
CREATE OR REPLACE VIEW v_api_usage_daily AS
SELECT
  tenant_id,
  api,
  DATE(created_at) AS dia,
  SUM(requests) AS total_requests,
  SUM(cost_units) AS total_cost
FROM api_usage
GROUP BY tenant_id, api, DATE(created_at)
ORDER BY dia DESC, api;

-- ════════════════════════════════════════════════════
-- VIEWS ÚTEIS
-- ════════════════════════════════════════════════════

-- Resumo de leads por tenant/segmento
CREATE OR REPLACE VIEW v_leads_resumo AS
SELECT
  tenant_id,
  segment_id,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE classificacao = 'QUENTE') AS quentes,
  COUNT(*) FILTER (WHERE classificacao = 'MORNO') AS mornos,
  COUNT(*) FILTER (WHERE classificacao = 'FRIO') AS frios,
  COUNT(*) FILTER (WHERE whatsapp IS NOT NULL) AS com_whatsapp,
  COUNT(*) FILTER (WHERE website IS NOT NULL AND website != '') AS com_site,
  COUNT(*) FILTER (WHERE website IS NULL OR website = '') AS sem_site,
  ROUND(AVG(score), 1) AS score_medio,
  MAX(first_seen_at) AS ultimo_discovery
FROM leads
GROUP BY tenant_id, segment_id;

-- Leads quentes não contatados
CREATE OR REPLACE VIEW v_leads_para_contato AS
SELECT
  l.id, l.tenant_id, l.segment_id, l.nome, l.cidade,
  l.whatsapp, l.telefone, l.email,
  l.score, l.classificacao,
  l.qualification->>'mensagem_whatsapp' AS mensagem_whatsapp,
  l.qualification->>'mensagem_instagram' AS mensagem_instagram,
  l.qualification->>'argumento_principal' AS argumento,
  l.qualification->>'melhor_horario_contato' AS melhor_horario,
  l.first_seen_at, l.qualified_at
FROM leads l
WHERE l.classificacao IN ('QUENTE', 'MORNO')
  AND l.contacted_at IS NULL
  AND (l.whatsapp IS NOT NULL OR l.telefone IS NOT NULL)
ORDER BY l.score DESC;

-- ════════════════════════════════════════════════════
-- FUNCTIONS
-- ════════════════════════════════════════════════════

-- Atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers de updated_at
DO $$ BEGIN
  CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_leads_updated BEFORE UPDATE ON leads
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_runs_updated BEFORE UPDATE ON pipeline_runs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_segments_updated BEFORE UPDATE ON segments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Função para upsert de lead (usado na dedup do banco)
CREATE OR REPLACE FUNCTION upsert_lead(
  p_tenant_id TEXT,
  p_place_id TEXT,
  p_cnpj TEXT,
  p_nome TEXT,
  p_segment_id TEXT,
  p_data JSONB
) RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  -- Tentar encontrar por place_id
  IF p_place_id IS NOT NULL THEN
    SELECT id INTO v_id FROM leads
    WHERE tenant_id = p_tenant_id AND place_id = p_place_id;
  END IF;

  -- Tentar por CNPJ
  IF v_id IS NULL AND p_cnpj IS NOT NULL THEN
    SELECT id INTO v_id FROM leads
    WHERE tenant_id = p_tenant_id AND cnpj = p_cnpj;
  END IF;

  IF v_id IS NOT NULL THEN
    -- Update: merge dados, preservar o mais completo
    UPDATE leads SET
      nome = COALESCE(NULLIF(p_data->>'nome', ''), nome),
      endereco = COALESCE(NULLIF(p_data->>'endereco', ''), endereco),
      telefone = COALESCE(NULLIF(p_data->>'telefone', ''), telefone),
      whatsapp = COALESCE(NULLIF(p_data->>'whatsapp', ''), whatsapp),
      email = COALESCE(NULLIF(p_data->>'email', ''), email),
      website = COALESCE(NULLIF(p_data->>'website', ''), website),
      rating = GREATEST(rating, COALESCE((p_data->>'rating')::REAL, 0)),
      total_avaliacoes = GREATEST(total_avaliacoes, COALESCE((p_data->>'totalAvaliacoes')::INT, 0)),
      sources = array_cat(sources, ARRAY[p_data->>'source']),
      last_seen_at = NOW(),
      updated_at = NOW()
    WHERE id = v_id;
    RETURN v_id;
  ELSE
    -- Insert novo lead
    INSERT INTO leads (
      tenant_id, segment_id, place_id, cnpj, nome,
      source_primary, sources, last_seen_at
    ) VALUES (
      p_tenant_id, p_segment_id, p_place_id, p_cnpj, p_nome,
      p_data->>'source', ARRAY[p_data->>'source'], NOW()
    ) RETURNING id INTO v_id;
    RETURN v_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Limpar cache expirado (rodar periodicamente)
CREATE OR REPLACE FUNCTION clean_expired_cache()
RETURNS INT AS $$
DECLARE
  deleted INT;
BEGIN
  DELETE FROM cache WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;

-- ════════════════════════════════════════════════════
-- SEED DATA
-- ════════════════════════════════════════════════════

-- Os segmentos são carregados dos JSON files, mas podem ser
-- sincronizados para o banco quando STORAGE_BACKEND=postgres.
-- Nenhum seed de segmento aqui — o config-loader é a fonte de verdade.
