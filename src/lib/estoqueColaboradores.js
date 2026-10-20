// Funções compartilhadas sobre estoque_colaboradores que não cabiam nem em
// estoqueUsuarios.js (que é só sobre "o que cada um tem em mãos") nem
// direto em src/routes/estoque.js (2026-09-22, criado junto com o import
// em massa da base real de Termos — ver scripts/importar-termos-pdf.js).

const { normKey } = require('./estoqueUsuarios');
const { gerarArquivoTermo } = require('./termoPdf');

// "Arquivo morto" (2026-09-22): colaborador.ativo vira 0 quando ninguém no
// AD bate com o usuario (ou, na falta dele, o nome) daquela pessoa — não
// apaga nada, só tira da lista normal de Termos e joga na aba separada.
// Chamada pelo import em massa, e também pode ser rodada solta mais pra
// frente (via SSH) conforme mais gente for saindo da empresa — não faz
// parte deste projeto deixar isso agendado sozinho.
function verificarColaboradoresAtivos(db, usuariosAd) {
  const chavesAd = new Set(usuariosAd.map((u) => normKey(u.usuario || u.nome)));
  const colaboradores = db.prepare(`SELECT id, usuario, nome, ativo FROM estoque_colaboradores`).all();
  const atualizar = db.prepare(`UPDATE estoque_colaboradores SET ativo = ? WHERE id = ?`);

  let ativados = 0;
  let arquivados = 0;
  for (const c of colaboradores) {
    const chave = normKey(c.usuario || c.nome);
    const estaNoAd = chavesAd.has(chave);
    const novoAtivo = estaNoAd ? 1 : 0;
    if (novoAtivo !== c.ativo) {
      atualizar.run(novoAtivo, c.id);
      if (novoAtivo) ativados++;
      else arquivados++;
    }
  }
  return { verificados: colaboradores.length, ativados, arquivados };
}

// Lógica de geração de termo extraída de POST /estoque/termos (2026-09-22)
// pra ser reaproveitada também pela geração automática ao registrar uma
// entrega (ver POST /estoque/movimentacoes em src/routes/estoque.js).
// Não valida nada além de "colaborador existe e tem itens" — quem chama
// decide o que fazer com colaborador não encontrado ou lista vazia.
async function gerarTermoParaColaborador(db, { colaboradorId, itens, gerarId }) {
  const colaborador = db.prepare(`SELECT * FROM estoque_colaboradores WHERE id = ?`).get(colaboradorId);
  if (!colaborador || !itens || !itens.length) return null;

  const dados = {
    nome: colaborador.nome,
    nacionalidade: colaborador.nacionalidade,
    estadoCivil: colaborador.estado_civil,
    endereco: colaborador.endereco,
    cpf: colaborador.cpf,
    rg: colaborador.rg,
    telefone: colaborador.telefone,
    cargo: colaborador.cargo,
    departamento: colaborador.departamento,
  };

  const arquivo = await gerarArquivoTermo({ dados, itens });
  const id = gerarId();
  db.prepare(`INSERT INTO estoque_termos (id, colaborador_id, tipo, itens_snapshot, arquivo, origem) VALUES (?, ?, 'responsabilidade', ?, ?, 'gerado')`)
    .run(id, colaborador.id, JSON.stringify(itens), arquivo);

  const marcarTermo = db.prepare(`UPDATE estoque_movimentacoes SET termo = 1 WHERE id = ?`);
  for (const item of itens) if (item.id) marcarTermo.run(item.id);

  return db.prepare(`SELECT * FROM estoque_termos WHERE id = ?`).get(id);
}

module.exports = { verificarColaboradoresAtivos, gerarTermoParaColaborador };
