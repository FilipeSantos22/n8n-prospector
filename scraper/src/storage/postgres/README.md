# PostgreSQL — Guia de integração

## Setup rápido

```bash
# 1. Subir Postgres (adicionar ao docker-compose.yml)
docker run -d --name prospector-db \
  -e POSTGRES_DB=prospector \
  -e POSTGRES_USER=prospector \
  -e POSTGRES_PASSWORD=sua_senha \
  -p 5432:5432 \
  postgres:16-alpine

# 2. Executar schema
psql -h localhost -U prospector -d prospector -f schema.sql

# 3. Executar migrations
psql -h localhost -U prospector -d prospector -f migrations.sql

# 4. Configurar env
STORAGE_BACKEND=postgres
DATABASE_URL=postgresql://prospector:sua_senha@localhost:5432/prospector
```

## Docker Compose (adicionar)

```yaml
  postgres:
    image: postgres:16-alpine
    container_name: prospector-db
    restart: unless-stopped
    ports:
      - "5432:5432"
    environment:
      - POSTGRES_DB=prospector
      - POSTGRES_USER=prospector
      - POSTGRES_PASSWORD=${DB_PASSWORD:-prospector123}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./scraper/src/storage/postgres/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql
      - ./scraper/src/storage/postgres/migrations.sql:/docker-entrypoint-initdb.d/02-migrations.sql
```

## Implementação pendente

Criar `scraper/src/storage/postgres/pg-storage.js` implementando a mesma interface do `file-storage.js`:

- `saveLeads(runId, leads, meta, tenantId)` → INSERT/upsert na tabela leads
- `getLeads(runId, tenantId)` → SELECT com JOIN lead_runs
- `savePipelineRun(run, tenantId)` → INSERT/UPDATE em pipeline_runs
- `markSeen(identifiers, tenantId)` → INSERT em seen_history
- `isKnown(identifier, tenantId)` → SELECT em seen_history

Depois registrar no factory `src/storage/index.js`:
```js
case 'postgres':
  const { PgStorage } = require('./postgres/pg-storage');
  return new PgStorage(options);
```

## Queries úteis

```sql
-- Leads quentes não contatados
SELECT * FROM v_leads_para_contato WHERE tenant_id = 'default';

-- Resumo por segmento
SELECT * FROM v_leads_resumo;

-- Consumo de API hoje
SELECT * FROM v_api_usage_daily WHERE dia = CURRENT_DATE;

-- Leads novos da última semana
SELECT nome, cidade, score, classificacao, first_seen_at
FROM leads
WHERE first_seen_at > NOW() - INTERVAL '7 days'
ORDER BY score DESC;

-- Leads duplicados (mesmo nome, cidades diferentes)
SELECT nome, array_agg(DISTINCT cidade) AS cidades, COUNT(*)
FROM leads
GROUP BY nome
HAVING COUNT(*) > 1;

-- Limpar cache expirado
SELECT clean_expired_cache();
```
