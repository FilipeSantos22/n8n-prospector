---
name: n8n-chatbot-leads
description: >
  Especialista em n8n para criar chatbots de envio de mensagens e interação com leads via WhatsApp
  (Evolution API, Z-API) e Instagram DM. Use esta skill sempre que o usuário mencionar n8n, automação
  de mensagens, chatbot de leads, fluxo de atendimento, disparo em massa, follow-up automático,
  integração com WhatsApp ou Instagram no n8n, qualificação de leads via bot, ou qualquer combinação
  de CRM + mensageria + automação. Mesmo que o usuário não use a palavra "skill" ou "n8n", se ele
  descrever um fluxo de envio/resposta automática de mensagens para leads, esta skill deve ser ativada.
---

# n8n Chatbot para Leads — Guia Especialista

## Visão Geral

Esta skill guia a criação de chatbots no n8n para:
- **Disparo ativo** de mensagens para leads (prospecção, follow-up, reengajamento)
- **Interação bidirecional** (responder leads que retornam, qualificar via perguntas, passar para humano)
- **Canais suportados**: WhatsApp via Evolution API ou Z-API, Instagram DM via Graph API

---

## 1. Arquitetura Padrão de um Chatbot de Leads no n8n

```
[Trigger de entrada]
       ↓
[Identificar lead / canal]
       ↓
[Verificar estado da conversa] ← (Redis, Airtable, Planilha, ou DB)
       ↓
[Lógica de fluxo / Switch de intenção]
       ↓
[Enviar mensagem (texto/mídia/botões)]
       ↓
[Salvar novo estado]
       ↓
[Opcional: notificar time humano]
```

---

## 2. Canais e Integrações

### 2.1 WhatsApp — Evolution API (self-hosted, recomendado)

**Webhook de entrada** (recebe mensagens do lead):
- Trigger: `Webhook` node no n8n
- URL configurada na Evolution API: `https://seu-n8n.com/webhook/whatsapp`
- Payload relevante:
```json
{
  "data": {
    "key": { "remoteJid": "5562999999999@s.whatsapp.net" },
    "message": { "conversation": "texto da mensagem" },
    "pushName": "Nome do Lead"
  }
}
```

**Extrair dados do webhook Evolution API:**
```javascript
// No node "Code" ou "Set"
const body = $json.body ?? $json;
const phone = body.data?.key?.remoteJid?.replace('@s.whatsapp.net', '');
const text = body.data?.message?.conversation 
          ?? body.data?.message?.extendedTextMessage?.text 
          ?? '';
const name = body.data?.pushName ?? 'Lead';
return { phone, text, name };
```

**Enviar mensagem (HTTP Request):**
```
POST https://evolution-api.seudominio.com/message/sendText/{instanceName}
Headers:
  apikey: SUA_API_KEY
  Content-Type: application/json

Body:
{
  "number": "5562999999999",
  "text": "Olá {{name}}, tudo bem? 👋"
}
```

**Enviar com botões (lista):**
```json
{
  "number": "5562999999999",
  "buttonMessage": {
    "text": "Como posso te ajudar?",
    "buttons": [
      { "buttonId": "op1", "buttonText": { "displayText": "Quero uma proposta" } },
      { "buttonId": "op2", "buttonText": { "displayText": "Tirar dúvidas" } },
      { "buttonId": "op3", "buttonText": { "displayText": "Falar com humano" } }
    ]
  }
}
```

---

### 2.2 WhatsApp — Z-API

**Webhook de entrada:**
- Payload relevante:
```json
{
  "phone": "5562999999999",
  "text": { "message": "Olá" },
  "senderName": "Nome do Lead"
}
```

**Extrair dados Z-API:**
```javascript
const phone = $json.body.phone;
const text = $json.body.text?.message ?? $json.body.text ?? '';
const name = $json.body.senderName ?? 'Lead';
return { phone, text, name };
```

**Enviar mensagem:**
```
POST https://api.z-api.io/instances/{instanceId}/token/{token}/send-text
Body: { "phone": "5562999999999", "message": "Olá!" }
```

---

### 2.3 Instagram DM — Meta Graph API

**Configuração necessária:**
- App no Meta for Developers com permissões: `instagram_manage_messages`, `pages_messaging`
- Webhook configurado para evento `messages`

**Webhook de entrada (payload):**
```json
{
  "entry": [{
    "messaging": [{
      "sender": { "id": "INSTAGRAM_USER_ID" },
      "message": { "text": "mensagem do lead" }
    }]
  }]
}
```

**Extrair dados Instagram:**
```javascript
const entry = $json.body.entry[0];
const messaging = entry.messaging[0];
const senderId = messaging.sender.id;
const text = messaging.message?.text ?? '';
return { senderId, text };
```

**Enviar mensagem:**
```
POST https://graph.facebook.com/v18.0/me/messages
Headers: Authorization: Bearer PAGE_ACCESS_TOKEN
Body:
{
  "recipient": { "id": "INSTAGRAM_USER_ID" },
  "message": { "text": "Olá! Vi que você nos contactou 😊" }
}
```

---

## 3. Gerenciamento de Estado da Conversa

O estado controla em qual etapa do fluxo o lead está. Opções por complexidade:

### Simples — Google Sheets / Airtable
- Colunas: `phone`, `stage`, `last_message`, `updated_at`
- Usar node nativo do n8n (Google Sheets ou Airtable)
- Ler estado: buscar por `phone` → retorna `stage`
- Atualizar: upsert com novo `stage`

### Intermediário — Redis (recomendado para volume)
```javascript
// Salvar estado (node Redis SET)
key: `lead:${phone}:stage`
value: "awaiting_name"
TTL: 86400 // 24h

// Ler estado (node Redis GET)
key: `lead:${phone}:stage`
```

### Avançado — Supabase / PostgreSQL
- Tabela `conversations`: `id`, `channel`, `external_id`, `stage`, `data (jsonb)`, `updated_at`
- Permite histórico completo e relatórios

---

## 4. Fluxo de Qualificação de Leads (Template)

```
Mensagem recebida
      ↓
[Switch: stage do lead]
  ├── "novo" → Enviar boas-vindas + perguntar nome → stage: "awaiting_name"
  ├── "awaiting_name" → Salvar nome + perguntar interesse → stage: "awaiting_interest"  
  ├── "awaiting_interest" → Classificar interesse (Switch/IF) → stage: "qualified" ou "unqualified"
  ├── "qualified" → Oferecer proposta / agendar → notificar vendedor
  ├── "human" → Ignorar bot / notificar time
  └── default → Menu de opções novamente
```

**Node Switch para estágios:**
- Tipo: `Switch`
- Mode: `Rules`
- Regra 1: `{{ $json.stage }}` equals `novo`
- Regra 2: `{{ $json.stage }}` equals `awaiting_name`
- etc.

---

## 5. Disparo Ativo (Prospecção / Follow-up)

### Disparo em massa com delay (anti-spam):
```
[Schedule Trigger ou Manual]
        ↓
[Ler lista de leads] (Sheets/Airtable/DB)
        ↓
[Filter: não contatados nas últimas 24h]
        ↓
[Loop Over Items]
        ↓
[Enviar mensagem] → [Wait: 3-5 segundos] → próximo
        ↓
[Atualizar status: "contatado"]
```

**Node Wait entre envios:**
- Tipo: `Wait`
- Resume: `After time interval`
- Valor: 3-5 segundos (evita bloqueio)

### Sequência de follow-up (drip):
```
Dia 0: Primeiro contato
Dia 1: Follow-up 1 (se sem resposta)
Dia 3: Follow-up 2 com valor/benefício
Dia 7: Última tentativa + oferta especial
```
Implementar com Schedule Trigger diário + filtro por `last_contact_date`.

---

## 6. Handoff para Humano

Quando o lead pede para falar com humano ou está qualificado:

```javascript
// Detectar intenção de falar com humano
const triggers = ['humano', 'atendente', 'pessoa', 'falar com alguém', 'vendedor'];
const wantsHuman = triggers.some(t => text.toLowerCase().includes(t));
```

**Notificação para time:**
- Slack: node nativo Slack → `#leads-quentes`
- Email: node Send Email
- CRM: HTTP Request para HubSpot/RD Station/Pipedrive API
- Mensagem interna WhatsApp do vendedor

---

## 7. Boas Práticas e Armadilhas Comuns

### ✅ Fazer sempre:
- Adicionar `try/catch` equivalente via node `Error Trigger` no workflow
- Validar se webhook body não está vazio antes de processar
- Usar variáveis de ambiente (`n8n credentials` ou `$env`) para API keys, nunca hardcoded
- Limitar disparo em massa a 1 msg/3-5s para evitar ban
- Sempre salvar estado ANTES de enviar mensagem (evita loop em caso de falha)
- Adicionar node `Respond to Webhook` com `200 OK` imediatamente ao receber webhook (antes de processar)

### ❌ Evitar:
- Processar mensagens do próprio bot (filtrar `fromMe: true` na Evolution API)
- Loops infinitos: sempre verificar stage antes de responder
- Disparo sem opt-in: risco de ban no WhatsApp Business
- Armazenar estado apenas em variáveis do workflow (perdem-se ao reiniciar)

---

## 8. Estrutura de Workflow Recomendada no n8n

Dividir em **workflows separados**:

| Workflow | Função |
|---|---|
| `wpp-webhook-receiver` | Recebe webhooks, extrai dados, chama sub-workflow |
| `chatbot-flow-engine` | Lógica de estados e respostas |
| `lead-broadcaster` | Disparo ativo em massa |
| `followup-scheduler` | Sequências de follow-up agendadas |
| `human-handoff` | Notificações para time de vendas |

Usar **Execute Workflow** node para chamar sub-workflows e manter cada um focado.

---

## 9. Referências Adicionais

- Para configuração detalhada da Evolution API → ver `references/evolution-api.md`
- Para estrutura de dados de leads e CRM → ver `references/lead-data-model.md`
- Para templates de mensagens e copywriting → ver `references/message-templates.md`

---

## Checklist de Implementação

- [ ] Instância WhatsApp conectada (Evolution API ou Z-API)
- [ ] App Instagram configurado no Meta for Developers
- [ ] Webhook URL do n8n acessível publicamente (ngrok, cloudflare tunnel, ou VPS)
- [ ] Storage de estado configurado (Sheets, Redis, ou Supabase)
- [ ] Variáveis de ambiente/credenciais salvas no n8n
- [ ] Filtro `fromMe` ativo para não responder próprias mensagens
- [ ] Workflow de erro configurado
- [ ] Teste com número pessoal antes de disparar para leads reais
