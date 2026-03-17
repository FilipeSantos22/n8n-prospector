/**
 * Schema de validacao para configs de segmento
 * Valida que todos os campos obrigatorios estao presentes
 */

const REQUIRED_FIELDS = {
  root: ['id', 'nome', 'produto', 'busca', 'analise', 'qualificacao'],
  produto: ['nome', 'descricao', 'planos', 'trial'],
  busca: ['queries', 'nearbyKeywords', 'googlePlaceType'],
  analise: ['painKeywords', 'positiveKeywords', 'schedulingPainKeys', 'competitors'],
  qualificacao: [
    'promptContexto', 'doresTemplates', 'mensagensTemplates', 'argumentos',
    'perfilLabels', 'segmentoSingular', 'segmentoPlural', 'genero',
  ],
};

function validateConfig(config) {
  const errors = [];

  for (const field of REQUIRED_FIELDS.root) {
    if (!config[field]) errors.push(`Campo raiz obrigatorio ausente: "${field}"`);
  }

  if (config.produto) {
    for (const field of REQUIRED_FIELDS.produto) {
      if (config.produto[field] === undefined) errors.push(`produto.${field} ausente`);
    }
  }

  if (config.busca) {
    for (const field of REQUIRED_FIELDS.busca) {
      if (config.busca[field] === undefined) errors.push(`busca.${field} ausente`);
    }
  }

  if (config.analise) {
    for (const field of REQUIRED_FIELDS.analise) {
      if (config.analise[field] === undefined) errors.push(`analise.${field} ausente`);
    }
  }

  if (config.qualificacao) {
    for (const field of REQUIRED_FIELDS.qualificacao) {
      if (config.qualificacao[field] === undefined) errors.push(`qualificacao.${field} ausente`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Config "${config.id || '?'}" invalida:\n  - ${errors.join('\n  - ')}`);
  }

  return true;
}

module.exports = { validateConfig };
