# Modelo de Dados de Leads

## Tabela principal: `leads`

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | UUID | Identificador único |
| `name` | string | Nome do lead |
| `phone` | string | Telefone (somente números, com DDI: 5562...) |
| `instagram_id` | string | ID do usuário no Instagram |
| `channel` | enum | `whatsapp`, `instagram` |
| `stage` | string | Estágio atual no fluxo |
| `interest` | string | Interesse identificado |
| `qualified` | boolean | Lead qualificado? |
| `assigned_to` | string | Vendedor responsável |
| `source` | string | Origem (formulário, comentário, indicação) |
| `first_contact` | datetime | Data do primeiro contato |
| `last_contact` | datetime | Data do último contato |
| `next_followup` | datetime | Data do próximo follow-up |
| `tags` | array | Tags livres |
| `metadata` | jsonb | Dados extras (respostas do bot) |

---

## Estágios padrão (`stage`)

```
novo             → Lead recém-criado, nunca contatado
contacted        → Primeiro contato realizado (aguardando resposta)
awaiting_name    → Bot aguardando nome do lead
awaiting_interest → Bot aguardando interesse do lead
awaiting_urgency → Bot aguardando nível de urgência
qualified        → Lead qualificado, pronto para vendedor
unqualified      → Lead sem fit/interesse
human            → Atendimento transferido para humano
lost             → Lead perdido/sem interesse
won              → Convertido em cliente
```

---

## Exemplo de registro no Google Sheets

Colunas sugeridas:
```
A: phone
B: name  
C: channel
D: stage
E: interest
F: qualified
G: first_contact
H: last_contact
I: next_followup
J: notes
```

---

## Exemplo de payload salvo no Redis

```json
{
  "stage": "awaiting_interest",
  "name": "João Silva",
  "phone": "5562999999999",
  "channel": "whatsapp",
  "started_at": "2024-01-15T10:30:00Z"
}
```

Key Redis: `lead:5562999999999:state`
TTL: 86400 (24h de inatividade reseta o fluxo)

---

## Integração com CRMs populares

### RD Station
```
POST https://api.rd.services/platform/contacts
Authorization: Bearer TOKEN
{
  "name": "João Silva",
  "email": "joao@email.com",
  "mobile_phone": "+5562999999999",
  "tags": ["whatsapp-bot", "qualificado"]
}
```

### HubSpot
```
POST https://api.hubapi.com/crm/v3/objects/contacts
Authorization: Bearer TOKEN
{
  "properties": {
    "firstname": "João",
    "lastname": "Silva", 
    "phone": "+5562999999999",
    "hs_lead_status": "IN_PROGRESS"
  }
}
```

### Pipedrive
```
POST https://api.pipedrive.com/v1/persons?api_token=TOKEN
{
  "name": "João Silva",
  "phone": [{ "value": "+5562999999999", "primary": true }]
}
```
