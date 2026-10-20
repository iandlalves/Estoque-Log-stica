// Unificação de cadastros duplicados de colaborador (2026-10-16).
//
// Como a duplicata nasce: a plataforma liga equipamento e pessoa pelo TEXTO do
// campo "usuario" da entrega (normalizado). Quando esse texto não bate com
// nenhum cadastro (ex.: "mirian.souza" x cadastro importado "Mirian Ligia de
// Souza"), ela cria um cadastro mínimo novo (origem 'auto'); o import de termos
// também pode gerar duas grafias do mesmo nome. Resultado: a mesma pessoa em 2
// ou 3 cadastros, cada um com uma parte dos termos e dos equipamentos.
//
// unificarColaboradores(principal, duplicados):
//  - termos dos duplicados passam pro cadastro principal;
//  - as entregas/empréstimos ligados a qualquer dos cadastros (pelo texto do
//    usuário) passam a apontar pro texto do cadastro principal, pra
//    "Equipamentos em mãos" juntar tudo;
//  - dados em branco do principal são preenchidos com os dos duplicados;
//  - os duplicados são apagados. Backup completo do banco antes (VACUUM INTO).

const fs = require('node:fs');
const path = require('node:path');
const { normKey } = require('./estoqueUsuarios');
const { chave, padronizarServiceTag } = require('./padronizacaoEquipamentos');

const LIGACAO = new Set(['DE', 'DA', 'DO', 'DOS', 'DAS', 'E']);
const CAMPOS_PREENCHIVEIS = ['usuario', 'cpf', 'rg', 'telefone', 'nacionalidade', 'estado_civil', 'endereco', 'cargo', 'departamento'];

function tokens(s) {
  return normKey(s).split(/[^A-Z0-9]+/).filter((t) => t.length > 1 && !LIGACAO.has(t));
}

const contido = (a, b) => a.length >= 2 && a.every((t) => b.includes(t));
const chaveDoCadastro = (c) => normKey(c.usuario || c.nome);

function contarDe(db, c) {
  const termos = db.prepare(`SELECT COUNT(*) AS n FROM estoque_termos WHERE colaborador_id = ?`).get(c.id).n;
  const chaveC = chaveDoCadastro(c);
  const abertos = db
    .prepare(`SELECT usuario FROM estoque_movimentacoes WHERE tipo IN ('ENTREGA', 'EMPRESTIMO') AND devolvido_em IS NULL AND usuario IS NOT NULL`)
    .all()
    .filter((m) => normKey(m.usuario) === chaveC).length;
  return { termos, equipamentosEmMaos: abertos };
}

// Cadastros que provavelmente são a mesma pessoa: mesmo nome; nome/usuário de um
// contido no nome do outro (2+ palavras — "mirian.souza" dentro de "Mirian
// Ligia de Souza"); ou mesmo usuário. É só sugestão: quem decide é a pessoa
// na tela.
function encontrarPossiveisDuplicados(db, colaboradorId) {
  const alvo = db.prepare(`SELECT * FROM estoque_colaboradores WHERE id = ?`).get(colaboradorId);
  if (!alvo) return [];
  const tAlvo = tokens(alvo.nome);
  const tUsuAlvo = tokens(alvo.usuario || '');
  const resultado = [];
  for (const c of db.prepare(`SELECT * FROM estoque_colaboradores WHERE id != ? ORDER BY nome COLLATE NOCASE`).all(colaboradorId)) {
    const tNome = tokens(c.nome);
    const tUsu = tokens(c.usuario || '');
    const mesmoUsuario = !!alvo.usuario && !!c.usuario && normKey(alvo.usuario) === normKey(c.usuario);
    const mesmoNome = normKey(alvo.nome) === normKey(c.nome);
    const compativel = contido(tNome, tAlvo) || contido(tAlvo, tNome) || contido(tUsu, tAlvo) || contido(tUsuAlvo, tNome);
    if (mesmoUsuario || mesmoNome || compativel) {
      resultado.push({
        id: c.id, nome: c.nome, usuario: c.usuario, origem: c.origem, ativo: c.ativo,
        ...contarDe(db, c),
      });
    }
  }
  return resultado;
}

function fazerBackup(db) {
  const arquivoDb = db.prepare('PRAGMA database_list').all().find((d) => d.name === 'main').file;
  const pasta = path.join(path.dirname(arquivoDb), 'backups-inventario');
  fs.mkdirSync(pasta, { recursive: true });
  const destino = path.join(pasta, `pre-unificacao-colaboradores-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  if (!fs.existsSync(destino) || fs.statSync(destino).size === 0) throw new Error('Não consegui gerar o backup antes de unificar — nada foi alterado.');
  return destino;
}

const pareceUsuario = (nome) => !/\s/.test(String(nome || '').trim());

function unificarColaboradores(db, principalId, duplicadoIds, { backup = true } = {}) {
  const ids = [...new Set(duplicadoIds || [])].filter((id) => id !== principalId);
  if (!ids.length) throw new Error('Escolha pelo menos um cadastro pra unificar.');
  const principal = db.prepare(`SELECT * FROM estoque_colaboradores WHERE id = ?`).get(principalId);
  if (!principal) throw new Error('Cadastro principal não encontrado.');
  const duplicados = ids.map((id) => db.prepare(`SELECT * FROM estoque_colaboradores WHERE id = ?`).get(id));
  if (duplicados.some((d) => !d)) throw new Error('Algum dos cadastros escolhidos não existe mais — recarregue a tela.');

  const arquivoBackup = backup ? fazerBackup(db) : null;

  // Fontes pros campos em branco: quem tem mais termos primeiro.
  const fontes = duplicados
    .map((d) => ({ d, termos: db.prepare(`SELECT COUNT(*) AS n FROM estoque_termos WHERE colaborador_id = ?`).get(d.id).n }))
    .sort((a, b) => b.termos - a.termos)
    .map((x) => x.d);

  const novo = { ...principal };
  const preenchidos = [];
  for (const campo of CAMPOS_PREENCHIVEIS) {
    if (novo[campo] && String(novo[campo]).trim()) continue;
    const fonte = fontes.find((d) => d[campo] && String(d[campo]).trim());
    if (fonte) { novo[campo] = fonte[campo]; preenchidos.push(campo); }
  }
  // Nome: se o principal só tem um "usuário" no lugar do nome (sem espaço) e
  // algum duplicado tem o nome completo, fica com o nome mais completo.
  if (pareceUsuario(principal.nome)) {
    const melhor = [...duplicados].filter((d) => !pareceUsuario(d.nome)).sort((a, b) => b.nome.length - a.nome.length)[0];
    if (melhor) { novo.nome = melhor.nome; preenchidos.push('nome'); }
  }

  const chavesAntigas = new Set([principal, ...duplicados].map(chaveDoCadastro));
  const chaveFinal = novo.usuario && String(novo.usuario).trim() ? novo.usuario.trim() : novo.nome;

  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE estoque_colaboradores SET nome = ?, usuario = ?, cpf = ?, rg = ?, telefone = ?, nacionalidade = ?, estado_civil = ?, endereco = ?, cargo = ?, departamento = ? WHERE id = ?`
    ).run(novo.nome, novo.usuario || null, novo.cpf || null, novo.rg || null, novo.telefone || null, novo.nacionalidade || null, novo.estado_civil || null, novo.endereco || null, novo.cargo || null, novo.departamento || null, principalId);

    let termosMovidos = 0;
    const moverTermos = db.prepare(`UPDATE estoque_termos SET colaborador_id = ? WHERE colaborador_id = ?`);
    for (const d of duplicados) termosMovidos += Number(moverTermos.run(principalId, d.id).changes);

    let movimentacoesAjustadas = 0;
    const religar = db.prepare(`UPDATE estoque_movimentacoes SET usuario = ? WHERE id = ?`);
    for (const m of db.prepare(`SELECT id, usuario FROM estoque_movimentacoes WHERE usuario IS NOT NULL AND TRIM(usuario) != ''`).all()) {
      if (chavesAntigas.has(normKey(m.usuario)) && m.usuario !== chaveFinal) {
        religar.run(chaveFinal, m.id);
        movimentacoesAjustadas += 1;
      }
    }

    const apagar = db.prepare(`DELETE FROM estoque_colaboradores WHERE id = ?`);
    for (const d of duplicados) apagar.run(d.id);
    db.exec('COMMIT');

    // Equipamentos que ficaram repetidos em mãos depois da união (mesma service
    // tag, ou mesmo equipamento+modelo quando não há ST) — só aviso.
    const abertos = db
      .prepare(`SELECT equipamento, modelo, st, usuario FROM estoque_movimentacoes WHERE tipo IN ('ENTREGA', 'EMPRESTIMO') AND devolvido_em IS NULL AND usuario IS NOT NULL`)
      .all()
      .filter((m) => normKey(m.usuario) === normKey(chaveFinal));
    const contagem = new Map();
    for (const m of abertos) {
      const st = padronizarServiceTag(m.st);
      const k = st ? `ST:${st}` : `EM:${chave(m.equipamento)}|${chave(m.modelo)}`;
      const atual = contagem.get(k) || { equipamento: m.equipamento, modelo: m.modelo, st: st || null, n: 0 };
      atual.n += 1;
      contagem.set(k, atual);
    }
    const repetidos = [...contagem.values()].filter((x) => x.n > 1);

    return { principalId, nome: novo.nome, unificados: duplicados.length, termosMovidos, movimentacoesAjustadas, camposPreenchidos: preenchidos, repetidos, backup: arquivoBackup };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { encontrarPossiveisDuplicados, unificarColaboradores };
