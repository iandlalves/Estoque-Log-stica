// Interruptor de módulos (2026-10-21) — o mesmo código serve a Central de
// Infraestrutura completa e instâncias menores (ex.: só Estoque, pra outro
// departamento, em outra porta do mesmo servidor, com banco/dados/.env
// próprios). Quem decide é APP_MODULOS no .env:
//   - vazio/ausente  → todos os módulos (comportamento de sempre da Central)
//   - "estoque"      → só Estoque (Dashboard, Descarte, Atualizar)
//   - "estoque,estoque-termos,estoque-moveis" → Estoque com as abas Termos e
//     Equipamentos móveis
// Atendentes, departamentos e Cadastros (itens de estoque) existem sempre —
// são a base de login/permissão, não um módulo.

const MODULOS = [
  'chamados',        // Chamados, Abrir chamado, Meus Chamados, integração Teams, categorias/SLA/feriados
  'estoque',         // Dashboard, Descarte, Atualizar
  'estoque-termos',  // aba Termos (colaboradores, termos em PDF, OCR) — termo automático na entrega
  'estoque-moveis',  // aba Equipamentos móveis (consultores + corporativos)
  'cpd',             // Checklist do CPD
  'atualizacoes',    // Atualizações de firmware (iDRAC/Dell Command Update)
  'seguranca',       // Alertas do Acronis
  'colaboradores',   // Usuários & Hosts (AD), Cargos, Sistemas, Onboarding de acessos
];

function lerModulosAtivos(valor = process.env.APP_MODULOS) {
  const texto = String(valor || '').trim();
  if (!texto) return [...MODULOS];
  const pedidos = texto.split(',').map((m) => m.trim().toLowerCase()).filter(Boolean);
  const desconhecidos = pedidos.filter((m) => !MODULOS.includes(m));
  if (desconhecidos.length) {
    // Falha alto em vez de ignorar: um erro de digitação aqui esconderia um
    // módulo inteiro sem ninguém perceber.
    throw new Error(`APP_MODULOS tem módulo desconhecido: ${desconhecidos.join(', ')}. Válidos: ${MODULOS.join(', ')}.`);
  }
  // Sub-abas do Estoque não fazem sentido sem o Estoque.
  if (pedidos.some((m) => m.startsWith('estoque-')) && !pedidos.includes('estoque')) pedidos.push('estoque');
  return MODULOS.filter((m) => pedidos.includes(m));
}

const MODULOS_ATIVOS = lerModulosAtivos();

function moduloAtivo(nome) {
  return MODULOS_ATIVOS.includes(nome);
}

// Bloqueia (404) os caminhos de um módulo desligado que moram dentro de um
// router compartilhado — ex.: /estoque/termos dentro do estoqueRouter, ou
// /categorias dentro do referenciaRouter. Módulos com router próprio são
// simplesmente não montados (ver src/server.js).
function bloquearSeDesativado(nome, prefixos) {
  return (req, res, next) => {
    if (moduloAtivo(nome)) return next();
    const bate = prefixos.some((p) => req.path === p || req.path.startsWith(p + '/'));
    if (!bate) return next();
    res.status(404).json({ erro: 'Este módulo não está habilitado nesta instância.' });
  };
}

const APP_NOME = process.env.APP_NOME || 'Central de Infraestrutura';

module.exports = { MODULOS, MODULOS_ATIVOS, lerModulosAtivos, moduloAtivo, bloquearSeDesativado, APP_NOME };
