# n8n-prospector

Motor de prospecção automatizada de leads B2B. Coleta, enriquece, analisa e qualifica leads de qualquer segmento via configuração JSON — sem alterar código.

## Stack

- **Node.js / Express** — API do scraper (porta 3099)
- **n8n** — Orquestração de workflows (porta 5678)
- **Evolution API** — Integração WhatsApp (porta 8080)
- **Claude Haiku** — Qualificação por IA (opcional, fallback por regras)
- **Docker Compose** — Orquestração dos 3 serviços

---

## Como funciona o pipeline

O prospector executa 5 fases sequenciais. Cada fase pode rodar individualmente via API ou em sequência pelo endpoint `/api/v2/pipeline`.

### Fase 1 — Discovery (coleta de leads)

Busca estabelecimentos em **5 fontes simultâneas**, deduplicando automaticamente:

| Fonte | O que faz | Limite free |
|---|---|---|
| **Google Maps Nearby** | Gera grid geográfico sobre a cidade e busca por raio em cada ponto, alternando keywords. Usa `googlePlaceType` do config (ex: `hair_care`, `pet_store`) | ~$200/mês crédito gratuito |
| **Foursquare Places** | Busca complementar por categoria + query do config | 200 req/dia |
| **Google Custom Search** | Busca orgânica — descobre negócios com site que não aparecem no Maps | 100 buscas/dia |
| **Receita Federal (CNAE)** | Busca empresas ativas por código CNAE + município via APIs públicas (cnpjs.rocks, MinhaReceita) | Sem limite claro |
| **Instagram Search** | Scraping de hashtags do segmento + cidade, e geração de handles prováveis | ~100 perfis/execução |

**Deduplicação** usa 3 critérios: `place_id` do Google > similaridade de nome (Dice coefficient > 0.75) + proximidade geográfica (< 300m) > similaridade de endereço. Leads encontrados em múltiplas fontes são mergeados, preservando o dado mais completo de cada fonte.

### Fase 2 — Pre-filter (limpeza)

Remove ruído antes de gastar recursos com enrichment:

- Estabelecimentos fechados permanentemente
- Menos de N avaliações (default: 5) — **exceto** leads da Receita Federal, Google Search e Instagram que não têm avaliações
- Rating abaixo do mínimo configurado

### Fase 3 — Enrichment (enriquecimento)

Para cada lead, busca dados adicionais em até 4 fontes:

1. **Google Place Details** — telefone, website, horários de funcionamento, 3 reviews mais recentes, status. Extrai WhatsApp do número de telefone
2. **Website Analyzer** — faz GET no site e detecta:
   - Concorrentes instalados (regex do config — Booksy, Trinks, Fresha, etc.)
   - Links de WhatsApp, telefones, emails, redes sociais
   - Se tem agendamento online, formulário, chat
   - Maturidade digital (score 0-10)
3. **Instagram Checker** — verifica perfil público, extrai bio, seguidores, posts, links. Keywords de verificação vêm do config (`instagramBioKeywords`)
4. **CNPJ via BrasilAPI** — para leads da Receita Federal: razão social, endereço completo, telefones, email, porte (MEI/ME/EPP), data de abertura

### Fase 4 — Deep Analysis (análise)

Duas análises paralelas sobre os dados enriquecidos:

**Análise de Reviews** — sistema inteligente de análise de sentimento:
- Detecção de dor com **verificação de negação** ("sem fila" não conta como reclamação de fila)
- **Ponderação por recência** — reviews do último mês pesam 3x mais que reviews de 1 ano atrás
- **Análise de respostas do dono** — detecta quando o dono diz "ligue pra marcar" (agendamento manual = sinal de ouro)
- **Velocidade de reviews** — calcula se o negócio está crescendo (mais reviews recentes que a média)
- **Distribuição bimodal** — detecta quando há muitas notas 5 E muitas notas 1-2 (ótimo serviço + caos operacional)
- **Detecção de no-show** — "marquei e não atenderam", "horário errado", "cancelou meu horário"

**Análise de Marketing** — classifica maturidade digital em **5 níveis**:
- Nível 0 "Invisível" — só Google Maps
- Nível 1 "Básico" — ficha + talvez Instagram pequeno
- Nível 2 "Ativo" — site + Instagram com seguidores (sweet spot pra venda)
- Nível 3 "Engajado" — WhatsApp Business, posta regularmente
- Nível 4 "Sofisticado" — usa analytics, ads, concorrente

Também detecta **fragmentação de canais** (vários canais sem integração = dor de gestão).

### Fase 5 — Qualify (qualificação)

Dois caminhos possíveis:

**Caminho IA** (se `ANTHROPIC_API_KEY` configurada):
- Pré-qualifica por regras — só chama IA para leads com score >= 55 (35 para fontes alternativas)
- Envia contexto enriquecido: reviews negativos completos, respostas do dono, maturidade digital, estimativa de staff
- Recebe score, classificação, mensagens personalizadas, plano recomendado

**Caminho regras** (fallback ou pré-score baixo):

**Hard disqualifiers** — antes de qualquer scoring, descarta automaticamente:
- Estabelecimento fechado (permanente ou temporariamente)
- CNPJ baixado ou inapto
- Rating < 3.0 com 20+ avaliações (negócio com problemas graves)

Score ponderado em **5 eixos**:

| Eixo | Peso | Sinais usados |
|---|---|---|
| **Oportunidade** | 35% | Sem site, sem agendamento, dores em reviews, marketing abandonado, Instagram sem agenda, CNPJ sem digital, CMS pago (Wix/Squarespace = aceita SaaS), **concorrente forte penaliza -30**, **IG com agendamento penaliza -25**, **site com agenda+chat penaliza -40**, **sinal combinado WhatsApp+sem agenda +25** |
| **Alcançabilidade** | 25% | WhatsApp (45pts), Instagram (25pts), email (15pts), telefone, Google Maps URL, **zero contato penaliza -50** |
| **Tamanho** | 15% | Avaliações Google > seguidores IG > porte CNPJ > anos de existência, **sweet spot 50-200 reviews (+15 bonus)**, **rating 4.0-4.7 > 5.0** |
| **Urgência** | 10% | Dores ponderadas por recência, **dono faz agendamento manual (+30)**, **review velocity alta (+20)**, **distribuição bimodal (+15)**, **no-show (+20)**, **canais fragmentados (+10)**, concorrente fraco, zero digital |
| **Confiança** | 15% | Quantidade de fontes, place_id, CNPJ, contato, coordenadas, reviews, **dono responde avaliações (+10)**, **investe em analytics (+10)** |

**Classificação final:**
- **QUENTE** (>= 65) — prioridade máxima de abordagem
- **MORNO** (40-64) — vale abordar
- **FRIO** (< 40) — baixa prioridade

Para cada lead qualificado, gera automaticamente:
- Mensagem WhatsApp personalizada pela dor principal
- Mensagem Instagram e follow-up
- Argumento principal de venda
- Plano recomendado (baseado em avaliações, seguidores, porte CNPJ, velocidade)
- Melhor horário de contato + sazonalidade (Jan/Mar/Jul = alta, Dez = baixa)
- Nível de risco e motivo
- **Tags de qualificação**: `SWEET_SPOT_SIZE`, `CRESCIMENTO_RAPIDO`, `AGENDA_MANUAL`, `BIMODAL_REVIEWS`, `NO_SHOW_PAIN`, `RISCO_BUDGET`, `DESCARTADO`

**Detecção de tech stack do site:**
- CMS (WordPress, Wix, Squarespace, Shopify, Webflow, GoDaddy)
- Analytics (Google Analytics, Facebook Pixel, TikTok Pixel, Hotjar)
- Pagamento (PagSeguro, Mercado Pago, Stripe, PayPal, PicPay)
- Responsividade mobile

### Output

- **JSON** em `/home/node/exports/leads-data.json` — alimenta o dashboard web
- **Excel** com 3 abas: Leads Qualificados (ordenados por score, coloridos por classificação), Mensagens (prontas para copiar), Resumo

---

## Assertividade por tipo de fonte

A qualidade do lead varia conforme a fonte de dados. O sistema compensa isso com o eixo de **Confiança** no scoring:

| Fonte | Dados disponíveis | Confiança típica | Quando é mais útil |
|---|---|---|---|
| **Google Maps** | Nome, endereço, telefone, website, rating, avaliações, reviews, horários, coordenadas | Alta (60-80) | Fonte principal — dados mais completos e confiáveis |
| **Foursquare** | Nome, endereço, telefone, coordenadas, categorias | Média (30-40) | Complementa Google Maps com negócios que não têm ficha no Maps |
| **Google Custom Search** | Nome, website, telefone (do snippet), endereço parcial | Média (25-35) | Descobre negócios com site que não aparecem no Maps |
| **Receita Federal** | CNPJ, razão social, nome fantasia, endereço, telefone, email, porte, data de abertura | Média-alta (40-50) | Pega negócios que não têm presença digital nenhuma |
| **Instagram Search** | Handle, bio, seguidores, posts, link externo, conta business | Baixa-média (15-30) | Descobre negócios digitalmente ativos sem ficha no Google |

**Lead encontrado em múltiplas fontes** — confiança sobe significativamente (ex: Google Maps + Receita Federal + Instagram = confiança 60+). O merge preserva o melhor dado de cada fonte.

**Leads com confiança < 30** recebem tag `DADOS_LIMITADOS` e risco automático "alto", sinalizando que precisam de validação manual antes da abordagem.

---

## API

### Endpoints principais

```
GET  /health                        → Status + segmento ativo
GET  /api/segments                  → Lista segmentos disponíveis
POST /api/v2/pipeline               → Pipeline completo (5 fases)
POST /api/v2/discover               → Fase 1: coleta
POST /api/v2/prefilter              → Fase 2: filtro
POST /api/v2/enrich                 → Fase 3: enriquecimento
POST /api/v2/analyze                → Fase 4: análise
POST /api/v2/qualify                → Fase 5: qualificação
POST /api/v2/pipeline-from-file     → Pipeline a partir de discovery salvo
POST /api/v2/pipeline-from-enriched → Pipeline a partir de enriched salvo
```

### Exemplo: pipeline completo

```bash
curl -X POST http://localhost:3099/api/v2/pipeline \
  -H "Content-Type: application/json" \
  -d '{
    "cities": [{"city": "Goiânia", "state": "GO"}],
    "segmentId": "barbearias",
    "minReviews": 5,
    "radiusKm": 5
  }'
```

O `segmentId` pode ser passado no body de qualquer endpoint. Se omitido, usa a env var `SEGMENT_ID` (default: `barbearias`).

### WhatsApp

```
GET  /api/whatsapp/status     → Status da conexão
GET  /api/whatsapp/connect    → Gera QR code para conectar
POST /api/whatsapp/send       → Envia mensagem individual
POST /api/whatsapp/send-batch → Envio em lote com delay
```

---

## Variáveis de ambiente

```env
# Obrigatória
GOOGLE_MAPS_API_KEY=            # Google Maps Platform

# Opcionais (fontes extras)
FOURSQUARE_API_KEY=             # Foursquare Places API v3
GOOGLE_SEARCH_API_KEY=          # Google Custom Search API
GOOGLE_SEARCH_ENGINE_ID=        # ID do Custom Search Engine (cse.google.com)
ANTHROPIC_API_KEY=              # Claude AI (qualificação por IA)

# WhatsApp
EVOLUTION_API_KEY=              # Evolution API key
EVOLUTION_INSTANCE=bookou       # Nome da instância WhatsApp

# Segmento
SEGMENT_ID=barbearias           # ID do segmento (default)
```

---

## Como criar um novo segmento

Para prospectar um novo tipo de negócio, basta criar um arquivo JSON em `scraper/src/configs/`. Zero código.

### 1. Criar o arquivo

```
scraper/src/configs/meu-segmento.json
```

O nome do arquivo (sem `.json`) é o `id` do segmento.

### 2. Estrutura do JSON

```jsonc
{
  // ═══ IDENTIFICAÇÃO ═══
  "id": "meu-segmento",           // Deve bater com o nome do arquivo
  "nome": "Meu Segmento",         // Nome de exibição

  // ═══ PRODUTO ═══
  "produto": {
    "nome": "Bookou",
    "descricao": "agendamento, financeiro, comissões, lembretes WhatsApp",
    "planos": [
      { "nome": "Start", "preco": "R$79,90/mês" },
      { "nome": "Profissional", "preco": "R$149,90/mês" }
    ],
    "trial": "14 dias grátis"
  },

  // ═══ BUSCA — como encontrar os estabelecimentos ═══
  "busca": {
    // OBRIGATÓRIOS
    "queries": ["termo 1", "termo 2"],       // Queries do Google Maps Text Search
    "nearbyKeywords": ["keyword1", "kw2"],   // Keywords do Nearby Search (alternadas entre pontos)
    "googlePlaceType": "hair_care",          // Tipo Google Places (ver lista abaixo)

    // OPCIONAIS — se ausente, a fonte é ignorada
    "foursquareQuery": "barbearia",          // Query do Foursquare
    "foursquareCategory": "11057",           // Categoria Foursquare (ver docs)
    "cnaes": ["9602501"],                    // Códigos CNAE para busca na Receita Federal
    "instagramHashtags": ["tag1", "tag2"],   // Hashtags para buscar no Instagram
    "instagramBioKeywords": ["kw1", "kw2"],  // Keywords para validar se perfil é do segmento
    "instagramHandlePrefixes": ["prefix1"]   // Prefixos para gerar handles prováveis
  },

  // ═══ ANÁLISE — o que procurar nos dados coletados ═══
  "analise": {
    // Regex de dores em reviews (string → compilada para RegExp pelo config-loader)
    "painKeywords": {
      "fila": "\\b(fila|espera|demorou|demora)\\b",
      "agendamento": "\\b(agenda|marca|horário)\\b"
      // Adicione quantas dores fizerem sentido para o segmento
    },
    // Regex de elogios ao agendamento (sinal de que já resolveram)
    "positiveKeywords": "\\b(agend.*fácil|app.*bom|sistema.*bom)\\b",
    // Quais chaves de painKeywords contam para "dor de agendamento"
    "schedulingPainKeys": ["fila", "agendamento"],
    // Concorrentes de agendamento (regex string → compilada)
    "competitors": {
      "nome_concorrente": "regex_do_concorrente"
    }
  },

  // ═══ QUALIFICAÇÃO — como avaliar e abordar ═══
  "qualificacao": {
    // Contexto para o prompt da IA
    "promptContexto": "Consultor B2B SaaS para [segmento]. Produto: Bookou (...). Start R$79,90/mês.",

    // Templates de dores (usados na qualificação por regras)
    "doresTemplates": {
      "sem_site": "Sem presença digital — clientes não conseguem agendar",
      "sem_agendamento": "Tem site mas sem agendamento online",
      "reclama_fila": "Clientes reclamam de espera nas avaliações",
      "alto_volume": "Alto volume — gestão manual é insustentável",
      "muitos_dias": "Abre 6+ dias — precisa otimizar agenda",
      "usa_concorrente": "Usa {concorrentes} — pode estar insatisfeito",
      "marketing_abandonado": "Marketing abandonado",
      "desorganizacao": "Reviews mencionam desorganização",
      "default": ["Gestão manual de agenda"]      // Fallback se nenhuma dor detectada
    },

    // Templates de mensagens — variáveis: {nome}, {nomeSimples}, {produto}, {segmento}, {avaliacoes}, {trial}
    "mensagensTemplates": {
      "fila": "Oi! Vi que a {nome} tem bastante movimento! Sou da {produto}...",
      "sem_site": "Oi! Vi a {nome} no Google! Sou da {produto} pra {segmento}...",
      "concorrente": "Oi! Sei que a {nome} já usa sistema. Sou da {produto}...",
      "alto_volume": "Oi! A {nome} é referência com {avaliacoes} avaliações! Sou da {produto}...",
      "default": "Oi! Conheci a {nome}! Sou da {produto} pra {segmento}...",
      "instagram": "Oi! Curti o trabalho da {nomeSimples}! Posso te mostrar a {produto}?",
      "followup": "Oi de novo! Temos {trial} pra testar, sem compromisso!"
    },

    // Argumentos de venda por contexto
    "argumentos": {
      "fila": "Agendamento online elimina espera",
      "sem_site": "Página de agendamento pronta — clientes agendam sem ligar",
      "concorrente": "{produto} é mais completo e com suporte brasileiro",
      "alto_volume": "Gestão completa: agenda + financeiro + lembretes",
      "default": "Agendamento online + gestão financeira em um só lugar"
    },

    // Labels de perfil por tamanho — variáveis: {segmentoSingular}, {genero}
    "perfilLabels": {
      "grande": "{segmentoSingular} grande e estabelecid{genero}",
      "popular": "{segmentoSingular} popular",
      "crescimento": "{segmentoSingular} em crescimento",
      "bairro": "{segmentoSingular} de bairro",
      "pequeno": "{segmentoSingular} pequen{genero}/nov{genero}"
    },

    // Gramática do segmento
    "segmentoSingular": "Pet Shop",    // Usado nos labels de perfil
    "segmentoPlural": "pet shops",     // Usado nas mensagens ({segmento})
    "genero": "o"                      // "o" ou "a" — afeta "estabelecido/a", "pequeno/a"
  }
}
```

### 3. Usar

```bash
# Via env var (default para todas as requests)
SEGMENT_ID=meu-segmento docker compose up

# Via API (por request)
curl -X POST http://localhost:3099/api/v2/pipeline \
  -d '{"cities": [{"city": "São Paulo", "state": "SP"}], "segmentId": "meu-segmento"}'
```

### 4. Referência rápida

**Google Place Types** comuns: `hair_care`, `beauty_salon`, `pet_store`, `veterinary_care`, `dentist`, `gym`, `spa`, `car_repair`, `car_wash`, `restaurant`, `cafe`, `bakery`, `bar`, `night_club`, `laundry`, `physiotherapist`.

Lista completa: [Google Places Types](https://developers.google.com/maps/documentation/places/web-service/supported_types)

**CNAEs** comuns:
| Segmento | CNAE |
|---|---|
| Cabeleireiros / Barbearias | 9602-5/01 |
| Atividades de estética | 9602-5/02 |
| Pet shops | 4789-0/04 |
| Clínicas veterinárias | 7500-1/00 |
| Academias | 9313-1/00 |
| Clínicas odontológicas | 8630-5/04 |
| Restaurantes | 5611-2/01 |
| Lavanderias | 9601-7/01 |
| Oficinas mecânicas | 4520-0/01 |

Consultar: [CNAE IBGE](https://cnae.ibge.gov.br/)

**Categorias Foursquare** — consultar: [Foursquare Categories](https://location.foursquare.com/places/docs/categories)
