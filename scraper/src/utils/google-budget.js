const fs = require('fs');
const path = require('path');

/**
 * Teto de chamadas ao Google, por SKU e por mês-calendário.
 *
 * A conta do Google Cloud deste projeto roda SEM cap de quota no console
 * (decisão de 23/09/2026). O tier gratuito é o limite, e a única trava que
 * existe é esta: passou do teto, o prospector para de chamar o Google e
 * segue com o que já tem — nunca gera cobrança por "só mais uma rodada".
 *
 * Por mês, e não por dia, porque a franquia gratuita da Places API (New) é
 * mensal por SKU. Os tetos default ficam abaixo da franquia das faixas
 * Enterprise (~1.000/mês), onde as duas FieldMasks do projeto caem — ver
 * DISCOVERY_FIELD_MASK / DETAILS_FIELD_MASK em sources/google-maps.js.
 *
 * O contador só enxerga chamadas feitas POR ESTE SERVIÇO. Se a mesma chave
 * for usada em outro sistema, a franquia é dividida e o teto precisa baixar.
 */

const SKUS = {
  busca: { env: 'GOOGLE_LIMITE_MENSAL_BUSCA', padrao: 900, nome: 'Text Search' },
  detalhes: { env: 'GOOGLE_LIMITE_MENSAL_DETALHES', padrao: 900, nome: 'Place Details' },
  geocoding: { env: 'GOOGLE_LIMITE_MENSAL_GEOCODING', padrao: 500, nome: 'Geocoding' },
};

const ARQUIVO = path.join(process.env.EXPORTS_DIR || '/home/node/exports', '.google-uso.json');

function mesAtual() {
  return new Date().toISOString().slice(0, 7); // AAAA-MM, UTC
}

function limite(sku) {
  const def = SKUS[sku];
  const v = parseInt(process.env[def.env] || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : def.padrao;
}

let estado = null;
const avisados = new Set();

function carregar() {
  const mes = mesAtual();
  if (estado && estado.mes === mes) return estado;
  try {
    const salvo = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    estado = salvo.mes === mes ? salvo : { mes, uso: {} };
  } catch {
    estado = { mes, uso: {} };
  }
  avisados.clear();
  return estado;
}

function salvar() {
  try {
    fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
    fs.writeFileSync(ARQUIVO, JSON.stringify(estado, null, 2));
  } catch (err) {
    // Sem persistência o contador zera no restart — melhor avisar do que fingir.
    console.error(`[GoogleBudget] Não consegui gravar ${ARQUIVO}: ${err.message}`);
  }
}

/**
 * Reserva UMA chamada do SKU. Retorna false se o teto do mês foi atingido —
 * quem chama deve pular a requisição.
 */
function consumir(sku) {
  const e = carregar();
  const usado = e.uso[sku] || 0;
  const teto = limite(sku);

  if (usado >= teto) {
    if (!avisados.has(sku)) {
      avisados.add(sku);
      console.error(`[GoogleBudget] 🛑 TETO MENSAL ATINGIDO — ${SKUS[sku].nome}: ${usado}/${teto}. Chamadas a este SKU estão bloqueadas até o próximo mês (ou ajuste ${SKUS[sku].env}).`);
    }
    return false;
  }

  e.uso[sku] = usado + 1;
  salvar();
  return true;
}

function relatorio() {
  const e = carregar();
  const out = { mes: e.mes };
  for (const sku of Object.keys(SKUS)) {
    out[sku] = { usado: e.uso[sku] || 0, teto: limite(sku) };
  }
  return out;
}

module.exports = { consumir, relatorio };
