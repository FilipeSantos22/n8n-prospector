-- ════════════════════════════════════════════════════
-- MIGRATIONS — executar depois do schema.sql
-- Cada migração tem um ID único. Controle manual por enquanto.
-- Quando integrar, usar algo como node-pg-migrate.
-- ════════════════════════════════════════════════════

-- Tabela de controle de migrações
CREATE TABLE IF NOT EXISTS migrations (
  id          TEXT PRIMARY KEY,
  executed_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ Migration 001: Índice geográfico ═══
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM migrations WHERE id = '001_geo_index') THEN
    -- PostGIS seria ideal, mas funciona sem:
    CREATE INDEX IF NOT EXISTS idx_leads_geo ON leads(lat, lng)
      WHERE lat IS NOT NULL AND lng IS NOT NULL;

    INSERT INTO migrations (id) VALUES ('001_geo_index');
    RAISE NOTICE 'Migration 001 applied';
  END IF;
END $$;

-- ═══ Migration 002: Full-text search em leads ═══
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM migrations WHERE id = '002_fts') THEN
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS search_vector tsvector;

    CREATE OR REPLACE FUNCTION leads_search_trigger() RETURNS trigger AS $t$
    BEGIN
      NEW.search_vector :=
        setweight(to_tsvector('portuguese', COALESCE(NEW.nome, '')), 'A') ||
        setweight(to_tsvector('portuguese', COALESCE(NEW.cidade, '')), 'B') ||
        setweight(to_tsvector('portuguese', COALESCE(NEW.endereco, '')), 'C');
      RETURN NEW;
    END;
    $t$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_leads_search ON leads;
    CREATE TRIGGER trg_leads_search BEFORE INSERT OR UPDATE OF nome, cidade, endereco
      ON leads FOR EACH ROW EXECUTE FUNCTION leads_search_trigger();

    CREATE INDEX IF NOT EXISTS idx_leads_search ON leads USING gin(search_vector);

    INSERT INTO migrations (id) VALUES ('002_fts');
    RAISE NOTICE 'Migration 002 applied';
  END IF;
END $$;

-- ═══ Migration 003: Particionamento de api_usage por mês ═══
-- (Só aplicar quando tiver volume — deixar comentado por enquanto)
-- DO $$ BEGIN
--   IF NOT EXISTS (SELECT 1 FROM migrations WHERE id = '003_usage_partition') THEN
--     -- Converter para tabela particionada requer recriar
--     -- Melhor fazer quando migrar para produção
--     INSERT INTO migrations (id) VALUES ('003_usage_partition');
--   END IF;
-- END $$;
