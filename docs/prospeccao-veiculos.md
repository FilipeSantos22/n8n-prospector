# Prospecção — Locadoras e Revendas de Veículos (Goiás)

> Mapeamento do nicho **locação e venda de veículos** para o `n8n-prospector`.
> Case de referência: **velozcar.com.br** (locadora premium em Palmas/TO — catálogo de
> frota, reserva online e botão de WhatsApp).
> Data: 23/09/2026. Estado: **implementado, falta a 1ª rodada real** — ver seção 8.
>
> Decisões de 23/09/2026: mensagem assinada por **Filipe, da WinClick**; abertura mostra o
> **site da Veloz Car**; **concessionárias de montadora ficam fora**; **motos entram**.

---

## 1. O que estamos vendendo

Dois problemas, um pacote:

| Dor do lead | O que resolve | Prova |
|---|---|---|
| Não tem site próprio — o estoque/frota vive no Instagram, OLX ou Webmotors | Site com catálogo de veículos e reserva/contato | Velozcar |
| Atende WhatsApp na mão — pergunta de preço, disponibilidade e documentação se repete o dia inteiro, e contato fora do horário se perde | Atendente com IA no WhatsApp (Automação IA) | Plataforma em produção |

Isso muda a lógica em relação aos outros segmentos: **aqui, "sem site" é oportunidade, não
desqualificador** (ao contrário de `arquitetura-engenharia`, que usa `modeloOportunidade:
"atendimento"` e penaliza quem não tem site). O modelo padrão `agendamento` do scorer já
trata "sem site" como a maior oportunidade — é o que vamos usar.

---

## 2. Dois segmentos, não um

Locadora e revenda são encontradas por buscas diferentes, têm dores diferentes e precisam
de mensagens diferentes. Misturar num config só faria a mensagem falar de "reserva" para quem
vende seminovo.

| | `locadoras-veiculos` | `revendas-veiculos` |
|---|---|---|
| `googlePlaceType` | `null` (ver abaixo) | `null` (ver abaixo) |
| CNAEs | `7711000` (automóveis), `7719599` (outros, inclui moto) | `4511102` (carro usado), `4512902` (consignação), `4541204` (moto usada) |
| Keywords do grid | locadora de veículos, locadora de motos | revenda de veículos, loja de motos |
| Queries | + aluguel de carros, aluguel para aplicativo, locadora para uber, aluguel de motos, rent a car | + seminovos, garagem, multimarcas, compra e venda, motos seminovas |
| Excluir | Localiza, Movida, Unidas, Hertz, Avis, Budget, Foco, Alamo, Kovi, Mottu… | concessionária, marca de montadora no nome (Toyota, Honda, Yamaha…), Localiza/Movida/Unidas Seminovos, Kavak |
| Dor típica em avaliação | "reservei e não tinha carro", "ninguém responde", "caução/cobrança não informada" | "anúncio desatualizado, carro já vendido", "não responde WhatsApp", "preço diferente do anúncio" |

**Por que `googlePlaceType: null`** (testado em Goiânia, 23/09/2026): sem filtro, as buscas
de carro já voltam 75-100% do tipo certo. Com filtro, loja de moto cai pela metade
(`car_dealer`: 20 → 11) e locadora de moto some (vem como `service`). Não existe tipo de
moto na Places API (New).

**Por que só 2 keywords no grid:** o grid faz 1 busca por ponto e alterna as keywords entre
os pontos. Com 4 keywords, cada uma cobriria 1 ponto em 4.

**Locação para motorista de aplicativo** é um sub-nicho grande em Goiânia, com atendimento
100% por WhatsApp e perguntas muito repetitivas (valor semanal, caução, documentação). É
provavelmente o melhor ICP de locadora — vale query própria.

---

## 3. Como classificar — QUENTE, MORNO, FRIO

O score continua 0-100 com os 5 eixos do scorer. Os cortes reais do código são
**QUENTE ≥ 58, MORNO 38-57, FRIO < 38**. O que cada faixa deve significar neste nicho:

### 🔥 QUENTE — abordar primeiro

Precisa ter **todos**:

- **Celular com WhatsApp** (telefone fixo não serve: o Automação IA marca como `INVALIDO`)
- **Opera de verdade**: 15-300 avaliações no Google, ou Instagram ativo com estoque postado
- **Oportunidade clara**: sem site próprio (só Instagram/OLX/Linktree), **ou** site sem
  catálogo e sem chat/chatbot

E ganha prioridade se tiver **dor pública**: avaliação recente reclamando de demora para
responder, anúncio desatualizado ou reserva que falhou.

### 🟡 MORNO — vale abordar depois dos quentes

- Alcançável, mas **já tem site razoável** sem automação de atendimento
- Ou **muito pequeno/novo** (< 15 avaliações, poucos seguidores)
- Ou **dados limitados** (achado só por uma fonte, confiança < 30)

### ❄️ FRIO — não abordar (ou só em campanha separada)

- Sem celular (só fixo ou sem contato)
- Nota < 3,0 com 20+ avaliações (problema operacional, não de atendimento)

Já ter **chat/chatbot no site** (Blip, Zenvia, Huggy, Octadesk, ManyChat, Tawk etc.) zera o
eixo Oportunidade, mas uma loja grande ainda fecha em MORNO pelos outros eixos — e recebe a
mensagem de "comparar", não a de "você não tem site". Simulado: revenda com estoque + Huggy
no site, 120 avaliações → **MORNO 41**.

### Descartado automaticamente (antes do score)

- Rede/franquia nacional (lista `excluirNomes` do config)
- Fechado permanente ou temporariamente
- CNPJ baixado ou inapto

### ⚠️ Limite do que dá pra saber antes do contato

**"Não tem automação de WhatsApp" não é detectável por scraping.** O que dá pra ver é
widget de chat no site. Um bot que roda só no WhatsApp aparece apenas quando alguém manda
mensagem. Na prática: se a abordagem voltar com menu automático ("digite 1 para…"), o lead
deve ser rebaixado — o Automação IA já tem os status para isso (`SEM_INTERESSE`/`DESCARTADO`).

---

## 4. Cobertura geográfica — Goiás

`radiusKm: 3` em todas as fases (no workflow). Raio 5 trunca resultado (estudo principal,
seção 6); raio 2 na capital dobraria o custo de busca — só vale se a 1ª rodada mostrar
pontos batendo no teto de 40 resultados.

| Fase | Cidades | Bounds no grid? |
|---|---|---|
| **1 — Grande Goiânia** | Goiânia, Aparecida de Goiânia, Senador Canedo, Trindade, Goianira | Goiânia e Aparecida sim; demais via viewport do geocoding |
| **2 — Polos do interior** | Anápolis, Rio Verde, Jataí, Itumbiara, Catalão | Anápolis sim; demais via geocoding |
| **3 — Turismo** (bom p/ locadora) | Caldas Novas, Rio Quente, Pirenópolis, Alto Paraíso | via geocoding |
| **4 — Entorno do DF** | Luziânia, Valparaíso de Goiás, Águas Lindas, Formosa, Novo Gama | via geocoding |
| **5 — Demais** | Goianésia, Inhumas, Mineiros, Porangatu, Quirinópolis… | via geocoding |

Cidade sem bounds cadastrado usa o viewport devolvido pelo geocoding
([index.js:229-240](../scraper/src/index.js#L229-L240)) — funciona, custa 1 chamada de
Geocoding a mais. Depois de Goiás: DF e Tocantins (onde a Velozcar é vizinha e serve de
prova local).

---

## 5. Custo de API (limite rígido: tier gratuito)

Na Places API (New) a franquia gratuita é **por SKU, por mês**, e o SKU é decidido pelo
`X-Goog-FieldMask`. As duas máscaras do prospector pedem campos de faixa alta (`rating`/
`userRatingCount` na busca; `reviews` no Details), então **conte com a franquia menor —
na ordem de ~1.000 chamadas/mês por SKU**. Confirmar o número exato no console antes de rodar.

Estimativa por rodada da Fase 1, por segmento:

- Busca (só o grid chama o Google; Foursquare/Custom Search estão sem chave e são pulados):
  Goiânia com raio 3 = 30 pontos × até 2 páginas ≤ **60 chamadas**; Aparecida 12 pontos;
  as outras 3 cidades via geocoding, poucos pontos cada → **~125 chamadas por segmento**
- Details: 1 por lead que passar do pre-filter (≥3 avaliações) — **estimativa 100-300**
- Geocoding: 3 chamadas (Senador Canedo, Trindade, Goianira)

Ou seja: **Fase 1 dos dois segmentos cabe no gratuito; o estado inteiro num mês só, não.**

**Trava de custo no código.** A conta roda **sem cap de quota no console** (decisão de
23/09/2026), então a trava é o [google-budget.js](../scraper/src/utils/google-budget.js):
conta cada chamada por SKU no mês, grava em `exports/.google-uso.json` e **bloqueia** ao
atingir o teto (`GOOGLE_LIMITE_MENSAL_*`, default 900 busca / 900 detalhes / 500 geocoding).
O consumo do mês aparece em `GET /health` → `googleUsoMensal`. O contador só vê o que este
serviço chama — se a chave for usada em outro sistema, baixe os tetos.
Rodar uma fase por semana, com `newOnly: true`, e olhar o consumo no console depois de cada uma.

---

## 6. Correções feitas no código

Todas valem para os outros segmentos também — eram defeitos gerais que este nicho expôs.

| # | Problema | Correção |
|---|---|---|
| 1 | **Instagram/Facebook/Linktree/wa.me/OLX no campo "site" da ficha contava como site** — o melhor lead do nicho tirava nota de quem tem site | `utils/website.js` classifica o link; se não é site próprio, `website` vira `null`, o link vai para `linkSemSite` e o handle/número são aproveitados |
| 2 | **IA do Groq nunca funcionou**: `gpt-oss-120b` gastava os 400 tokens raciocinando (398 medidos) e devolvia vazio — toda qualificação caía em regras, sem aviso | `reasoning_effort: 'low'`, `max_tokens: 1500`, `response_format: json_object` |
| 3 | IA dava classificação que contradizia o próprio score (68 → "MORNO") | classificação sempre recalculada pela régua do sistema (`classificarPorScore`) |
| 4 | IA inventava fato sobre o lead e esquecia o link do case | `qualificacao.mensagemDoTemplate: true` — IA ajusta score e gancho, o texto enviado é o template |
| 5 | **Mensagem sem frase de saída** é recusada pelo Automação IA e o lead fica parado em `NOVO` | `qualificacao.fraseSaida` — garantida no fim de toda mensagem, da IA ou do template |
| 6 | Mensagem de "dor em avaliação" só era escolhida se o texto da dor tivesse a palavra "fila" (barbearia) | `temDorDeReview()` compara com o template do próprio segmento |
| 7 | "agend" + "horário" no HTML = "tem agendamento online" (falso positivo em revenda) | `analise.sinaisAgendamentoOnline` por segmento: reserva (locadora) / catálogo de estoque (revenda) |
| 8 | Prompt da IA dizia "EQUIPE: 1-2 barbeiros" para qualquer nicho | rótulo neutro ("pessoas") |
| 9 | Planilha só tinha o WhatsApp como link `wa.me` | colunas novas no fim da aba principal: `WHATSAPP NÚMERO` e `CHAVE EXTERNA` |

Continua de pé: os workflows antigos (`workflow-lead-prospector`, `workflow-juriai-prospector`)
disparam WhatsApp pela Evolution. **Não use os dois para veículos** — use
`workflow-veiculos-goias.json`, que não envia nada.

---

## 7. Integração com o Automação IA

O Automação IA **não tem upload de planilha hoje**. Ele recebe leads por
`POST /integracao/prospects/importar` (header `X-API-Key`, JSON, até 1000 leads por chamada)
— ver `apps/backend/src/modules/prospects/prospect-integracao-routes.ts` naquele repositório.
O upload de planilha ficou registrado no roadmap de lá como item futuro.

Mapeamento de campos (vale para a API agora e para a planilha depois):

| Prospector | Automação IA | Obrigatório |
|---|---|---|
| `whatsapp` (número puro, `5562…`) | `telefone` | sim |
| `nome` | `nome` | sim |
| `placeId` ou `cnpj` | `chaveExterna` | recomendado (dedup) |
| `cidade`, `email` | `cidade`, `email` | — |
| `instagram.url` | `instagram` | — |
| `qualification.score` / `.classificacao` | `score` / `classificacao` | — |
| `qualification.argumento_principal` | `gancho` | — |
| `qualification.mensagem_whatsapp` | `mensagem` | **sim, na prática** — sem ela não dispara |

Lá dentro o fluxo é: lead entra `NOVO` → você aprova na tela Leads → "Iniciar disparo" na
Fila de hoje → sai sozinho (15/dia por padrão, 12-24 min de intervalo, 9h-18h em dia útil),
por texto livre na instância de WhatsApp do tenant.

**Pré-requisito que não é de código:** quem prospecta é a própria agência, então ela precisa
existir como **tenant no Automação IA**, com:

- número de WhatsApp próprio conectado (não o de um cliente);
- recurso `prospeccao` ativo;
- assistente com persona e base de conhecimento de **vendas** (o que é o site, o que é o
  atendente, o case Velozcar, preço) — é ele que responde quando o lead retornar.

---

## 8. O que falta — checklist

### Chaves e decisões

- [x] `GOOGLE_MAPS_API_KEY` no `.env` — testada em Places API (New) e Geocoding (23/09/2026)
- [x] `GROQ_API_KEY` no `.env` — testada
- [x] Trava de custo no código (`google-budget.js`) — sem cap no console, por decisão
- [x] Remetente, oferta, concessionárias, motos — ver topo do documento
- [ ] Número de WhatsApp que vai prospectar e o tenant dele no Automação IA

### Prospector

- [x] Configs `locadoras-veiculos.json` e `revendas-veiculos.json`
- [x] Correções da seção 6
- [x] `workflow-veiculos-goias.json` — fases da seção 4, um segmento por vez, sem envio
- [ ] 1ª rodada real (Fase 1) e conferência do consumo no console

### Travas contra gasto à toa (1ª rodada, 23/09/2026)

| O que aconteceu | Trava |
|---|---|
| Corpo da requisição com encoding quebrado ("Goi�nia") → sem bounds → geocoding devolveu área de um estado → grid de **30.800 pontos**. Parado em 38 buscas | `GRID_MAX_PONTOS_POR_CIDADE` (default 250): cidade com grid anormal é pulada |
| Pipeline desistia do discovery aos 10 min e as **76 buscas** já feitas se perdiam | discovery salvo em `exports/<tenant>/temp/discovery-<segmento>.json`; `retomarDiscovery: true` segue dali sem Google; etapas com `PIPELINE_ETAPA_TIMEOUT_MS` (4 h) |
| Sem cap no console | `GOOGLE_LIMITE_MENSAL_*` (seção 5) |

Ao chamar o scraper fora do n8n no Windows, mande o corpo de um **arquivo UTF-8**
(`curl --data-binary @body.json`), não como argumento do shell.

### Como rodar

```bash
docker compose up -d --build        # na raiz do n8n-prospector
# n8n em http://localhost:5678 (usuário admin, senha no .env)
# Importar workflow-veiculos-goias.json → ajustar FASE no nó "Configuração" → executar
# Planilhas em ./exports/leads-<segmento>-v2-<data>.xlsx
```

### Depois, no Automação IA

- [ ] Upload de planilha (ou chamada direta da API pelo n8n)
- [ ] Tenant da agência configurado para prospecção
