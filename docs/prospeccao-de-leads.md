# Prospecção de Leads — Estudo do Sistema

> Documento de estudo do `n8n-prospector`: o que existe, como funciona de verdade
> (conforme o código, não o README), onde estão os gargalos e quais são as alavancas
> para **aumentar volume e qualidade de leads novos**.
>
> Base: commit `a1be863`. Data do estudo: 18/08/2026.

---

## 1. Sumário executivo

O `n8n-prospector` é um motor de prospecção B2B outbound multi-segmento. Ele descobre
estabelecimentos em 5 fontes, enriquece com dados públicos, analisa sinais de dor e
qualifica cada lead com score 0-100 — gerando mensagem pronta de WhatsApp. A ativação
(envio, chatbot de resposta, follow-up, ingestão no CRM) é orquestrada por n8n.

**Novos segmentos custam zero código** — basta um JSON em `scraper/src/configs/`.
Essa é a maior força do sistema hoje: 3 segmentos já configurados, e o 4º sai em ~1h.

**O gargalo não é o motor de qualificação — é o funil de entrada.** Na configuração
atual (Goiânia, `radiusKm=5`), o grid gera apenas **12 pontos de busca**, e cada ponto
usa **1 única keyword**. O teto teórico de descoberta por rodada fica na casa de poucas
centenas de estabelecimentos, e boa parte é truncada pelo limite do Google. Reduzir o
raio e varrer todas as keywords por ponto multiplica o volume por ~6-12x sem tocar em
mais nada.

**Sinais valiosos de qualificação estão mortos por bugs de nomenclatura.** Cinco dos
sinais mais discriminantes (dono agenda manualmente, no-show, velocidade de reviews,
dono responde avaliações, dor ponderada por recência) são produzidos com um nome em
[reviews.js](../scraper/src/analysis/reviews.js) e lidos com **outro nome** em
[ai-qualifier.js](../scraper/src/ai-qualifier.js) — nunca disparam. Ver seção 9.

---

## 2. Arquitetura e stack

```
┌─────────────┐   HTTP    ┌──────────────────┐   HTTP   ┌────────────────┐
│     n8n     │──────────▶│  scraper (Node)  │─────────▶│ Evolution API  │
│ :5678       │           │  :3099           │          │ WhatsApp       │
│ orquestração│◀──────────│  pipeline + API  │◀─────────│ webhook        │
└─────────────┘           └──────────────────┘          └────────────────┘
                                   │
                                   ├──▶ Google Maps / Foursquare / Custom Search
                                   ├──▶ Receita Federal (CNAE) / BrasilAPI
                                   ├──▶ Instagram (scraping)
                                   ├──▶ Groq (Llama 3.3 70B) ou Claude Haiku
                                   └──▶ CRM externo (POST /api/v1/crm/leads/ingest)
```

| Componente | Porta | Onde |
|---|---|---|
| n8n (orquestração) | 5678 | [docker-compose.yml](../docker-compose.yml) |
| scraper (API + pipeline) | 3099 | [scraper/src/index.js](../scraper/src/index.js) — 1413 linhas |
| Evolution API (WhatsApp) | 8080 | **externa** — `EVOLUTION_API_URL`, default `http://187.77.54.141:8080` |

Dependências do scraper são mínimas: `axios`, `express`, `cors`, `exceljs`. Sem banco,
sem fila, sem browser headless. Estado em disco, em `./exports` (bind mount).

**Persistência (`STORAGE_BACKEND`)** — só `file` está implementado.
[storage/index.js](../scraper/src/storage/index.js) tem `postgres` e `mongo`
**comentados**; existe `schema.sql` e `migrations.sql` completos em
[storage/postgres/](../scraper/src/storage/postgres/), mas definir
`STORAGE_BACKEND=postgres` cai silenciosamente no `FileStorage`. Idem `CACHE_BACKEND=redis`.
O módulo [queue/](../scraper/src/queue/) existe e não é usado por ninguém.

---

## 3. O pipeline de 5 fases

Endpoint completo: `POST /api/v2/pipeline`. Cada fase também roda isolada
(`/api/v2/discover`, `/prefilter`, `/enrich`, `/analyze`, `/qualify`). O pipeline chama
as próprias fases via HTTP em `localhost` — simples, mas cada hop serializa e
deserializa o array inteiro de leads.

### Fase 1 — Discovery

Para cada cidade: gera grid geográfico → Nearby Search em cada ponto → soma Foursquare,
Google Custom Search, CNAE/Receita e Instagram Search → deduplica.

**Deduplicação** ([utils/dedup.js](../scraper/src/utils/dedup.js)) em 3 níveis:

1. `place_id` idêntico → merge
2. Similaridade de nome > 0.75 (Dice com bigrams, após remover as palavras do segmento)
   **+** distância < 300 m (Haversine)
3. Sem coordenadas → similaridade de endereço > 0.7

O merge preserva o dado mais completo de cada fonte e acumula `sources[]` — que depois
alimenta o eixo de Confiança no scoring.

**Modo incremental**: `newOnly: true` filtra contra o
[seen-registry](../scraper/src/discovery/seen-registry.js), que indexa por
`place_id`, `cnpj`, `@handle` e `nome:cidade` normalizado. O workflow JuriAI já usa
`newOnly: true` — a cada rodada só traz o que nunca foi visto.

> ⚠️ `markSeen` só é chamado no `/api/v2/pipeline`. Rodar `/discover` avulso **não**
> registra os leads como vistos.

### Fase 2 — Pre-filter

Remove: `businessStatus === 'CLOSED_PERMANENTLY'`, `totalAvaliacoes < minReviews`
(default 5) e `rating < minRating`. Leads de `receita_federal`, `google_search` e
`instagram_search` são **isentos** do filtro de avaliações (não têm reviews).

### Fase 3 — Enrichment

Roda em paralelo com `pMap`, concorrência `ENRICH_CONCURRENCY` (default 3). Cada lead
passa por até 4 etapas, todas com cache:

| Etapa | Fonte | Namespace de cache | Traz |
|---|---|---|---|
| 1 | Google Place Details | `place-details` | telefone, site, horários, **3 reviews**, status, URL do Maps |
| 2 | [website-analyzer](../scraper/src/sources/website-analyzer.js) | `website-analysis` | concorrentes, WhatsApp/email/social, CMS, GA/Pixel, gateway, mobile, chat, agendamento |
| 3 | [instagram](../scraper/src/sources/instagram.js) | `instagram-profile` | bio, seguidores, posts, link externo, is_business, agendamento na bio |
| 4 | BrasilAPI (CNPJ) | `cnpj` | razão social, endereço, telefones, email, porte, data de abertura |

O WhatsApp é extraído em cascata ([utils/phone.js](../scraper/src/utils/phone.js)):
telefone do Google → telefone internacional → links `wa.me` do site → bio do Instagram.
Normaliza para E.164 sem `+` (13 dígitos) e valida se é celular pelo 9.

### Fase 4 — Deep Analysis

Duas análises puras, sem I/O:

- **[reviews.js](../scraper/src/analysis/reviews.js)** — dores por regex do segmento, com
  **verificação de negação** (janela de 5 palavras antes do match, para "sem fila" não
  contar como reclamação) e **peso de recência** (≤1 mês = 3x, ≤3 meses = 2x, depois
  decai). Mais: distribuição bimodal, velocidade de reviews, respostas do dono, no-show.
- **[marketing.js](../scraper/src/analysis/marketing.js)** — score 0-100 de presença
  digital → 5 níveis de maturidade (Invisível → Básico → Ativo → Engajado → Sofisticado)
  \+ detecção de **fragmentação de canais** (≥2 canais sem nenhum sinal de integração).

### Fase 5 — Qualify

Ver seção 5. Ao final: exporta Excel de 3 abas, salva `leads-data.json` para o painel
web, e o workflow n8n empurra QUENTE/MORNO para o CRM.

---

## 4. As 5 fontes de descoberta — estado real

| Fonte | Arquivo | Estado | Observação crítica |
|---|---|---|---|
| **Google Places (New)** | [google-maps.js](../scraper/src/sources/google-maps.js) | ✅ principal | Migrado em 18/08/2026 para `places.googleapis.com/v1` via `searchText`. A API legada foi fechada pelo Google para projetos novos — ver seção 12 |
| **Foursquare** | [foursquare.js](../scraper/src/sources/foursquare.js) | ⚠️ verificar | Chama `api.foursquare.com/v3` com header `Authorization: <key>` cru. A FSQ migrou para `places-api.foursquare.com` com Bearer. **Validar se ainda responde** |
| **Google Custom Search** | [google-search.js](../scraper/src/sources/google-search.js) | ✅ | Limitado a **3 queries × 10 resultados = 30/cidade** por conta da cota de 100/dia. Blocklist de diretórios (iFood, Yelp, guias) |
| **Receita Federal (CNAE)** | [cnpj-receita.js](../scraper/src/sources/cnpj-receita.js) | ⚠️ frágil | Depende de `api.cnpjs.rocks` (não-oficial) com fallback `minhareceita.org/search`. Ambos são terceiros sem SLA. **É a fonte com maior potencial de volume e a menos confiável** |
| **Instagram Search** | [instagram-search.js](../scraper/src/sources/instagram-search.js) | ⚠️ instável | Scraping de `/explore/tags/` + `web_profile_info`. Rotaciona User-Agent, 2-3 s entre requests. Instagram bloqueia sem sessão — retorno frequentemente vazio |

**Assertividade por fonte** (o sistema compensa via eixo Confiança):

| Fonte | Confiança típica | Papel estratégico |
|---|---|---|
| Google Maps | 60-80 | Espinha dorsal — dados completos |
| Receita Federal | 40-50 | Alcança quem **não tem presença digital nenhuma** |
| Foursquare | 30-40 | Complemento marginal |
| Google Search | 25-35 | Descobre quem tem site mas não tem ficha no Maps |
| Instagram | 15-30 | Descobre quem é digital-first sem Google |

Lead confirmado em ≥3 fontes ganha tag `MULTI_FONTE` e +35 no eixo de Confiança.
Confiança < 30 → tag `DADOS_LIMITADOS` e risco "alto" automático.

---

## 5. Motor de qualificação

Dois caminhos, em [ai-qualifier.js](../scraper/src/ai-qualifier.js):

### 5.1 Caminho IA (opcional)

Só entra se `GROQ_API_KEY` ou `ANTHROPIC_API_KEY` existir. **Groq tem precedência**
(Llama 3.3 70B, gratuito, 2,5 s de espera forçada entre chamadas); Anthropic usa
`claude-haiku-4-5`.

Antes de gastar token, o sistema **pré-qualifica por regras** e só chama a IA se:

- não caiu em hard disqualifier, **e**
- `score >= 55` (fontes normais) ou `score >= 35` (fontes alternativas).

O prompt é comprimido em flags de uma linha (`SEM_SITE CONCORRENTE:booksy IG:3200 MAT:2/4 …`)
com `max_tokens: 400`. Falha de parse ou de rede → cai em regras.

### 5.2 Caminho regras (o que roda na prática)

**Hard disqualifiers** (score 0, tag `DESCARTADO`):

- `business_status` fechado permanente/temporário — ⚠️ *ver seção 9: campo errado, nunca dispara*
- CNPJ baixado/inapto — ⚠️ *idem*
- `rating < 3.0` **e** `totalAvaliacoes >= 20` — ✅ *funciona*

**Score ponderado em 5 eixos:**

| Eixo | Peso | Sinais principais |
|---|---|---|
| **Oportunidade** | 35% | sem site +35 · site sem agenda +25 · dor de agendamento +25 · elogio a agendamento **-25** · concorrente forte (Booksy/Fresha/Mindbody) **-30** · IG com agendamento **-25** · site com agenda + chat **-40** · WhatsApp sem concorrente e sem agenda em canal nenhum **+25** · maturidade nível 2-3 +10 · nível 0-1 **-5** |
| **Alcançabilidade** | 25% | WhatsApp +45 · Instagram +25 · telefone +20 · email +15 · URL do Maps +10 · **zero contato -50** |
| **Tamanho** | 15% | avaliações > seguidores IG > porte CNPJ > anos de existência. **Sweet spot 50-200 avaliações: +15.** Rating 4,0-4,7 com 10+ avaliações: +10 |
| **Urgência** | 10% | 12 sinais somados — dor em reviews, alto volume sem agendamento, IG abandonado, concorrente fraco, empresa antiga sem digital |
| **Confiança** | 15% | nº de fontes, place_id, CNPJ, contatos, coordenadas, analytics |

**Classificação (valores reais do código):**

| Classe | Faixa **no código** | Faixa **no README** |
|---|---|---|
| 🔥 QUENTE | **≥ 58** | ≥ 65 ❌ |
| 🟡 MORNO | **38-57** | 40-64 ❌ |
| ❄️ FRIO | **< 38** | < 40 ❌ |

O README está desatualizado. Os thresholds reais são mais permissivos — **mais leads
entram como QUENTE do que a documentação sugere**, e QUENTE é justamente o que dispara
envio automático (`onlyQuente: true` no `send-batch`).

**Saídas por lead**: score + 5 sub-scores, classificação, até 15 tags, perfil, até 4
dores, argumento, plano recomendado, 3 mensagens (WhatsApp/Instagram/follow-up), melhor
horário + sazonalidade (Jan/Mar/Jul alta, Dez baixa), risco + motivo.

---

## 6. Cobertura geográfica — o gargalo principal

[utils/grid.js](../scraper/src/utils/grid.js) tem **16 cidades com bounds pré-configurados**.
O grid cobre o retângulo com espaçamento de `radiusKm × 1,5` km entre pontos.

**Pontos de busca gerados por cidade × raio:**

| Cidade | 5 km (atual) | 3 km | 2 km | 1,5 km |
|---|---|---|---|---|
| Goiânia/GO | **12** | 30 | 72 | 120 |
| São Paulo/SP | 42 | 99 | 208 | 357 |
| Brasília/DF | 24 | 70 | 150 | 266 |
| Belo Horizonte/MG | 16 | 36 | 72 | 132 |
| Campinas/SP | 16 | 36 | 81 | 144 |
| Aparecida de Goiânia/GO | 4 | 12 | 25 | 42 |
| Anápolis/GO | 4 | 9 | 16 | 25 |
| Uberlândia/MG | 4 | 9 | 20 | 30 |
| **Ribeirão Preto/SP** | *sem bounds* | — | — | — |

Três problemas concretos:

1. **Truncamento silencioso.** Cada ponto retorna no máximo 40 estabelecimentos
   (2 páginas × 20). Num raio de 5 km em área urbana densa há muito mais que isso —
   o excedente **some sem aviso**. Goiânia inteira tem teto de 12 × 40 = 480 slots hoje,
   e o Google ordena por relevância, não por cobertura.

2. **1 keyword por ponto.** `keywords[pointIndex % keywords.length]` — com
   `nearbyKeywords: ["barbearia", "barber"]`, metade dos pontos nunca busca "barber".
   Cada keyword adicional no config **reduz** a cobertura de cada uma das outras.

3. **Cidade sem bounds vira 1 ponto só.** O fallback em
   [index.js:225-238](../scraper/src/index.js#L225-L238) faz geocoding, mas chama
   `generateGrid` de novo com a mesma cidade (que continua sem bounds) e acaba em
   `points = [centro]` com raio de 10 km. **Ribeirão Preto, no workflow JuriAI, cai
   exatamente nesse caso**: 1 busca, ≤40 resultados, para a cidade inteira. O `viewport`
   que o geocoding já retornou é descartado.

> ⏱️ **O workflow JuriAI já está travado na última fase.** `START_DATE = 2026-04-22` e
> hoje é 18/08/2026 → ~17 semanas → `faseIdx` fixo em 4 = **BH + Campinas**. As fases de
> Goiânia/GO já foram consumidas. Sem novas fases, o cron repete a mesma cidade todo dia.

---

## 7. Segmentos configurados

| ID | Produto | Place type | CNAEs | Preço de entrada |
|---|---|---|---|---|
| `barbearias` | Bookou | `hair_care` | 9602501 | R$80/mês |
| `clinicas-esteticas` | Bookou | `beauty_salon` | 9602502, 8650002 | R$80/mês |
| `escritorios-advocacia` | **JuriAI** | `lawyer` | 6911301/02, 6912500 | R$97/mês |

Um config tem 4 blocos obrigatórios: `produto`, `busca`, `analise`, `qualificacao` —
validados por [configs/schema.js](../scraper/src/configs/schema.js). Os campos de regex
vêm como string JSON e são compilados para `RegExp` no
[config-loader](../scraper/src/config-loader.js).

Os 3 configs também têm um bloco **`respostas`** (12 templates do chatbot) que **não está
no schema nem documentado no README** — é o que alimenta o flow-engine e os follow-ups.
Um segmento novo sem `respostas` cai nos defaults hardcoded, que falam de barbearia.

**Divergência de preço**: `promptContexto` diz "Start R$79,90 / Profissional R$149,90"
enquanto `produto.planos` diz "R$80 / R$115". A IA recebe o preço errado.

**Para criar um segmento novo**: copiar um JSON existente, trocar `queries`,
`nearbyKeywords`, `googlePlaceType`, `cnaes`, hashtags e keywords do Instagram,
`painKeywords` com o vocabulário do segmento, `competitors`, e todos os textos de
`qualificacao` + `respostas`. Nome do arquivo = `id` = valor de `SEGMENT_ID` / `segmentId`.

---

## 8. Ativação — do lead à conversa

### 8.1 Envio (`POST /api/whatsapp/send-batch`)

Filtra `classificacao === 'QUENTE'` (a menos que `onlyQuente: false`) **e** tem WhatsApp
**e** não está na blocklist. Responde imediatamente e envia em background.

**Anti-ban** ([rate-limiter.js](../scraper/src/chatbot/rate-limiter.js)):

| Regra | Valor |
|---|---|
| Warm-up | dias 1-7: 5/dia · 8-14: 8/dia · depois: `DAILY_SEND_LIMIT` (default 10) |
| Janela | 9h-18h, seg-sex; sábado só até 13h; domingo bloqueado |
| Delay entre envios | aleatório 45-90 s |
| Delay de resposta do bot | 2-5 s aleatório |

> 📉 **Esse é o teto real de ativação: ~10 leads/dia, ~200/mês.** Descobrir 5.000 leads
> não adianta se só 200 podem ser contatados. Escalar exige mais instâncias/chips —
> não mais scraping.

### 8.2 Chatbot ([flow-engine.js](../scraper/src/chatbot/flow-engine.js))

Máquina de estados por regex de intenção, sem IA:

```
contacted → engaged → interested → human
                ↘ objection ↗  (2 rodadas de objeção → escala para humano)

opt_out e human têm prioridade absoluta em qualquer estágio
```

Intenções detectadas: `opt_out`, `human`, `interest`, `price_objection`, `doubt`,
`greeting`, `unknown`. Opt-out adiciona à blocklist permanentemente. Estados
`human`/`opted_out`/`won`/`lost` silenciam o bot. O handoff notifica por WhatsApp
(`HANDOFF_PHONE`) e/ou webhook.

### 8.3 Follow-up

`GET /api/followups/pending` — cadência **D+1, D+3, D+7**, máximo 3, só para conversas
ainda em `contacted` (ou seja: quem nunca respondeu). Usa os templates `followup_1/2/3`
do config. O workflow
[workflow-followup-scheduler.json](../workflow-followup-scheduler.json) roda às 10h, seg-sáb.

### 8.4 CRM

Ramo dedicado nos dois workflows de prospecção: filtra por `CRM_INGEST_CLASSES`
(default `QUENTE,MORNO`), mapeia o payload e faz
`POST {CRM_API_URL}/api/v1/crm/leads/ingest` com `x-api-key` + `x-tenant-id`.
Idempotente por telefone.

---

## 9. Achados — divergências e código morto

Ordenados por impacto sobre a qualidade dos leads.

### 🔴 A. Cinco sinais de review nunca disparam (nome de campo divergente)

[reviews.js](../scraper/src/analysis/reviews.js) **produz** um nome,
[ai-qualifier.js](../scraper/src/ai-qualifier.js) **lê** outro:

| Produzido em reviews.js | Lido em ai-qualifier.js | Onde impacta |
|---|---|---|
| `ownerMentionsManualScheduling` | `ownerMentionsScheduling` | Urgência **+30** (chamado de "sinal de ouro"), tag `AGENDA_MANUAL`, dor, flag da IA |
| `hasNoshowChaos` | `noShowPain` | Urgência +20, tag `NO_SHOW_PAIN`, dor |
| `velocityRatio` / `growingFast` | `reviewVelocity` | Urgência +20, tag `CRESCIMENTO_RAPIDO`, plano recomendado, estimativa de equipe |
| `ownerRespondsToReviews` | `ownerResponds` | Confiança +10 |
| `schedulingPainWeighted` | `weightedPainCount` | Toda a ponderação por recência é ignorada — cai na contagem bruta |

Consequência: as tags `AGENDA_MANUAL`, `NO_SHOW_PAIN` e `CRESCIMENTO_RAPIDO` **nunca
aparecem em lead nenhum**, e o eixo Urgência perde até 70 dos seus pontos possíveis.
`bimodalDistribution` é o único desses sinais que funciona (o nome bate).

### 🔴 B. A análise de resposta do dono não tem fonte de dados

Mesmo corrigindo o nome do item A, `analyzeOwnerResponses` lê `review.ownerResponse` —
e **nenhuma fonte popula esse campo**. O Place Details legado não retorna respostas do
proprietário. O "sinal de ouro" precisa de outra origem (Places API New ou scraping)
antes de valer alguma coisa.

### 🟠 C. Dois hard disqualifiers estão mortos

- `checkHardDisqualifiers` lê `lead.business_status`; o parser grava `businessStatus`
  ([google-maps.js:245](../scraper/src/sources/google-maps.js#L245)). O pre-filter pega
  `CLOSED_PERMANENTLY`, mas **`CLOSED_TEMPORARILY` passa direto** e vira lead.
- Lê `lead.cnpjStatus`; o enrichment grava `situacao` e nem copia para o lead. **CNPJ
  baixado ou inapto nunca é descartado.**

### 🟠 D. Estatística de review sobre amostra pequena — *parcialmente resolvido*

O código legado cortava os reviews em 3 (`slice(0, 3)`). Sobre 3 reviews:

- `hasSchedulingPain` exige ≥2 ocorrências — precisava de 2 dos 3 reviews reclamando;
- "distribuição bimodal" (≥50% cinco estrelas **e** ≥15% uma-duas) era ruído estatístico;
- "velocidade de reviews" era inferida de 3 timestamps relativos.

✅ **A migração da seção 12 subiu para 5 reviews** (o teto da API) — +67% de amostra, sem
custo adicional. Continua sendo uma amostra pequena para as conclusões estatísticas
acima; os limiares de `hasSchedulingPain` e de bimodalidade merecem recalibragem.

🆕 A Places API (New) devolve `publishTime` — **timestamp absoluto** — além do texto
relativo. O parser já grava isso em `publicadoEm`. A ponderação por recência em
[reviews.js](../scraper/src/analysis/reviews.js), que hoje adivinha meses a partir de
strings como "3 anos atrás", pode passar a usar a data real.

### 🟡 E. README × código

| Item | README diz | Código faz |
|---|---|---|
| Threshold QUENTE | ≥ 65 | **≥ 58** |
| Threshold MORNO | 40-64 | **38-57** |
| IA de qualificação | "Claude Haiku" | **Groq tem precedência.** O modelo `llama-3.3-70b-versatile` saiu do ar; hoje é `openai/gpt-oss-120b`, com override por `GROQ_MODEL` |
| Google Maps free tier | "$200/mês de crédito" | modelo descontinuado pelo Google em 03/2025. **O projeto opera sob restrição de custo zero** — ver seção 12 |
| Bloco `respostas` do config | não documentado | usado por chatbot e follow-up |

### 🟡 F. Outros

- `STORAGE_BACKEND=postgres` cai silenciosamente em arquivo (schema pronto, driver não).
- `queue/` não é usado por nada.
- `estimateStaff()` fala em "barbeiros" hardcoded — vaza para advocacia e estética.
- Espaçamento do grid (`raio × 1,5`) deixa **lacunas nas diagonais**: para cobertura real,
  o espaçamento máximo é `raio × 1,41`.
- A API do scraper sem `SCRAPER_API_KEY` fica aberta; o webhook do WhatsApp não valida origem.

---

## 10. Alavancas para prospectar mais leads

Ordenado por (impacto ÷ esforço).

### Faixa 1 — multiplicam volume, custam quase nada

| # | Alavanca | Impacto estimado | Onde mexer |
|---|---|---|---|
| 1 | **Baixar `radiusKm` de 5 → 2** | Goiânia: 12 → **72 pontos** (6x). SP: 42 → 208 | parâmetro do request; sem código |
| 2 | **Varrer todas as `nearbyKeywords` em cada ponto** | ×N keywords. Medido em campo: no mesmo ponto, "barbearia" trouxe **35** leads e "barber" trouxe **4** — a rotação atual entrega metade dos pontos à keyword fraca | `nearbySearchGrid` em [google-maps.js](../scraper/src/sources/google-maps.js) |
| 3 | **3ª página do `searchText`** (`maxPages: 2` → `3`) | +20 por ponto, até o teto de 60 da API | `nearbySearchGrid` em [google-maps.js](../scraper/src/sources/google-maps.js) |
| 4 | **Usar o viewport do geocoding** para cidades sem bounds | Ribeirão Preto e qualquer cidade nova saem de 1 ponto para grid completo | [index.js:225-238](../scraper/src/index.js#L225-L238) |
| 5 | **Ampliar `queries`/`nearbyKeywords` por segmento** | Advocacia tem 3 keywords hoje; cabem "advocacia trabalhista", "advogado previdenciário", "advogado de família"… | JSONs em [configs/](../scraper/src/configs/) |

> Combinando 1+2+3, o teto de descoberta em Goiânia sai de ~480 para ~**12.000** slots
> brutos. Atenção ao custo de API — ver seção 11.

### Faixa 2 — abrem mercado novo

| # | Alavanca | Por quê |
|---|---|---|
| 6 | **Cadastrar bounds das cidades-alvo** | São 16 hoje. GO/DF/Triângulo cobertos; falta o interior de SP, Sul e Nordeste |
| 7 | **Novas fases no workflow JuriAI** | Já travado na fase 5 — sem novas fases, o cron repete BH+Campinas |
| 8 | **Segmentos novos (zero código)** | Odontologia (8630-5/04), veterinária (7500-1/00), academias (9313-1/00), pet shop (4789-0/04) — todos com `googlePlaceType` e CNAE já mapeados no README |
| 9 | **Corrigir/confirmar a fonte Receita Federal** | É a única que alcança quem **não tem digital nenhum** — e são os leads de maior Oportunidade. Hoje depende de API não-oficial |

### Faixa 3 — melhoram a qualidade (não o volume)

| # | Alavanca | Ganho |
|---|---|---|
| 10 | **Corrigir os 5 nomes de campo (achado A)** | Destrava até 70 pontos do eixo Urgência e 3 tags de priorização. ~15 min de trabalho |
| 11 | **`slice(0,3)` → `slice(0,5)` nos reviews** | +67% de amostra para toda a análise de dor |
| 12 | **Corrigir `businessStatus` e `cnpjStatus` (achado C)** | Para de queimar envio em negócio fechado ou CNPJ baixado |
| 13 | **Alinhar thresholds README × código** | Decidir conscientemente onde fica o corte de QUENTE — é ele que dispara o envio automático |
| 14 | **Corrigir preços no `promptContexto`** | A IA hoje cita preço que não existe mais |

### Faixa 4 — destravam a ativação (o teto real)

| # | Alavanca | Nota |
|---|---|---|
| 15 | **Mais instâncias Evolution / chips** | O limite de ~10 envios/dia é por instância. Volume de leads sem canal de saída é estoque parado |
| 16 | **Canais além do WhatsApp** | Email já é coletado (site + Receita) e não é usado para nada. Instagram DM idem |
| 17 | **Postgres de verdade** | Schema pronto. Arquivo JSON não aguenta multi-tenant nem histórico grande |

---

## 11. Decisões em aberto

1. **Orçamento de API.** Multiplicar o grid por 6 multiplica as chamadas ao Google.
   O modelo de free tier mudou em 2025 — antes de escalar o raio, medir o custo real de
   uma rodada (Nearby + Details) e definir teto mensal.

2. **Volume vs. ativação.** Vale descobrir 5.000 leads/mês com capacidade de contatar 200?
   Se a resposta for não, a prioridade é a Faixa 4, não a Faixa 1.

3. ~~**Migrar para Places API (New)?**~~ ✅ **Resolvido em 18/08/2026** — não era opcional:
   a API legada respondeu `REQUEST_DENIED` no projeto. Ver seção 12.

4. **Próximo segmento.** Odontologia e veterinária têm o mesmo padrão de dor
   (agenda + no-show) que barbearia e estética, e reaproveitam quase tudo do Bookou.

5. **Onde entram os leads sem contato?** Hoje `SEM_CONTATO` leva -50 em Alcançabilidade e
   é praticamente descartado — mas são justamente os que ninguém prospecta.
   Vale um fluxo de enriquecimento manual/telefônico para esse balde?

---

## 12. Migração para a Places API (New) — 18/08/2026

### Por que foi obrigatória

Ao testar a chave do projeto Google `205477870572`, a API legada devolveu:

> *"You're calling a legacy API, which is not enabled for your project. To get newer
> features and more functionality, switch to the Places API (New)"*

Não é uma escolha de modernização: o Google fechou os endpoints `/maps/api/place/*` para
projetos criados após 03/2025, e **não há como ativá-los**. Todo o discovery e o
enrichment dependiam deles.

### `searchText`, não `searchNearby`

A `searchNearby` da API nova **perdeu o parâmetro de keyword** — aceita só
`includedTypes`. Teste no mesmo ponto de Goiânia com `includedTypes: ["hair_care"]`
devolveu Espaçolaser, spa e salão de beleza. A `searchText` mantém o alvo por termo,
aceita `includedType` junto **e** tem paginação (`nextPageToken`).

Consequência boa: os campos `queries` e `nearbyKeywords` que já existem nos configs de
segmento continuam valendo, e a paginação não se perdeu.

Detalhe de implementação: `searchText` só aceita **retângulo** em `locationRestriction`
(círculo existe apenas em `locationBias`, que é sugestão e deixa vazar resultado de fora
da célula). O helper `circleToRectangle()` converte cada ponto do grid.

### 🔴 Regra de custo — o FieldMask é o controle de gasto

**O projeto opera exclusivamente no tier gratuito. Isso é limite rígido, não meta.**

Na Places API (New), o header `X-Goog-FieldMask` **determina o SKU cobrado**
(Essentials → Pro → Enterprise, do mais generoso ao mais apertado em franquia mensal).
Pedir um campo a mais não encarece um pouco: **promove a chamada inteira** para a faixa
de menor franquia.

Duas máscaras fixas em [google-maps.js](../scraper/src/sources/google-maps.js):

| Máscara | Onde | Campos |
|---|---|---|
| `DISCOVERY_FIELD_MASK` | grid, 1 chamada cobre até 20 lugares | id, displayName, formattedAddress, location, businessStatus, rating, userRatingCount |
| `DETAILS_FIELD_MASK` | 1 chamada **por lead** | telefones, websiteUri, regularOpeningHours, googleMapsUri, businessStatus, reviews |

**Por que `rating`/`userRatingCount` ficaram no discovery**, mesmo sendo campos de faixa
cara: uma chamada de busca cobre até 20 lugares, enquanto Details custa 1 chamada por
lead. Sem esses dois campos o pre-filter não roda e teríamos de enriquecer **tudo**.
Medido no teste real: de 39 leads descobertos, 26 passariam no filtro de ≥5 avaliações —
ou seja, o filtro evita ~1/3 das chamadas caras de Details. Incluir os campos no
discovery se paga.

> ⚠️ **Não adicione campo a nenhuma das duas máscaras sem medir o impacto na cota.**

Salvaguardas recomendadas antes de qualquer rodada em escala:

1. **Cap de quota diária** no Google Cloud Console (APIs & Services → Quotas). É a única
   garantia mecânica — disciplina de código não segura estouro.
2. **Chave dedicada** ao prospector. A chave em uso hoje chama-se `sistema-crm` e é
   compartilhada com outro sistema; a franquia é do projeto, então o consumo soma e
   fica impossível atribuir.
3. **Medir uma rodada pequena** e conferir o consumo no console antes de escalar.

### O que a migração entregou de brinde

- **5 reviews por lead** em vez de 3 (teto da API) — ver achado D
- **`publishTime` absoluto** nos reviews, além do texto relativo
- O parser mantém exatamente o mesmo shape de saída, então dedup, pre-filter,
  enrichment, análise e scoring não precisaram de nenhuma alteração

### O que **não** melhorou

O achado B continua de pé: a Places API (New) também **não retorna respostas do dono**
nos reviews. O "sinal de ouro" (`ownerMentionsManualScheduling`) segue sem fonte de dados.

### Validação em campo

Teste com 2 pontos do grid de Goiânia (raio 2 km, config `barbearias`):

```
39 leads únicos · 26 passariam no pre-filter (≥5 avaliações)
Place Details: telefone, WhatsApp normalizado, horários (7 dias), 5 reviews, URL do Maps
Ex.: Celso's Barbearia (70 av) → (62) 98582-5224 → whatsapp 5562985825224 ✅
```

---

## Referência rápida de endpoints

```
GET  /health                        → status + segmento + cache + seen
GET  /api/segments                  → lista segmentos disponíveis
POST /api/v2/pipeline               → pipeline completo (5 fases)
POST /api/v2/discover|prefilter|enrich|analyze|qualify   → fases isoladas
POST /api/v2/pipeline-from-file     → retoma de um discovery salvo
POST /api/v2/pipeline-from-enriched → retoma de um enriched salvo

GET  /api/leads                     → dados do painel web
GET  /api/whatsapp/status|connect   → status / QR code
POST /api/whatsapp/send|send-batch  → envio individual / em lote
POST /api/whatsapp/webhook          → recebe mensagens (Evolution)
GET  /api/conversations[/:phone]    → conversas + stats + blocklist
GET  /api/followups/pending         → follow-ups devidos (D+1/D+3/D+7)
POST /api/followups/send            → dispara follow-up
GET  /api/rate-limit                → warm-up, enviados hoje, limite
GET  /api/cache/stats · DELETE /api/cache · GET /api/seen/stats
```

Exemplo — pipeline com grid denso e modo incremental:

```bash
curl -X POST http://localhost:3099/api/v2/pipeline \
  -H "Content-Type: application/json" \
  -d '{
    "cities": [{"city": "Goiânia", "state": "GO"}],
    "segmentId": "escritorios-advocacia",
    "minReviews": 3,
    "radiusKm": 2,
    "newOnly": true
  }'
```
