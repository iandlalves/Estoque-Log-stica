// Camada de acesso ao banco (SQLite embutido no Node, node:sqlite).
//
// Por que node:sqlite em vez de um ORM (Prisma) ou de um driver externo
// (better-sqlite3)? Os dois precisam baixar/compilar um binário nativo na
// instalação — em rede corporativa restrita isso pode falhar (foi
// exatamente o que aconteceu tentando montar este projeto). node:sqlite já
// vem dentro do próprio Node.js a partir da versão 22.5, sem nada a mais
// pra instalar. A contrapartida: a própria Node.js ainda marca esse módulo
// como "experimental" (pode mudar em versões futuras do Node) — aceitável
// pra essa fase inicial (só Infra), mas vale reavaliar (trocar por
// better-sqlite3 ou já ir de vez pro Postgres) quando o projeto crescer
// pra além do time.

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', '..', 'dados', 'central-infraestrutura.db');
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'prisma', 'schema.sql');

// Garante que a pasta de dados existe antes de o SQLite tentar criar o arquivo.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;'); // melhor pra acesso concorrente (vários atendentes ao mesmo tempo)

// Aplica o schema.sql inteiro — todo CREATE TABLE/INDEX ali usa "IF NOT
// EXISTS", então rodar de novo em cima de um banco que já existe é seguro
// e não faz nada (não é um sistema de migração de verdade ainda; serve
// bem pra essa fase, mas quando o schema já estiver em uso com dados reais
// e precisar de ALTER TABLE, isso vai precisar virar migrações versionadas
// de verdade — não esquecer disso mais pra frente).
function aplicarSchema() {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(sql);
}

// Primeira migração de verdade (ver aviso no comentário acima): o comando
// acima só cria tabela nova (CREATE TABLE IF NOT EXISTS), não adiciona
// coluna em tabela que já existe com dados. `estoque_entregas` ganhou 3
// colunas novas (modelo/devolvido_em/devolvido_movimentacao_id, ver
// prisma/schema.sql) depois que o banco já estava em uso — então checamos
// coluna por coluna via PRAGMA table_info antes de rodar o ALTER TABLE,
// pra continuar seguro rodar isso de novo em quem já tem essas colunas.
function migrarColunasNovas() {
  // estoque_entregas só existe em bancos antigos (não está mais em
  // schema.sql — ver comentário na função de fusão mais abaixo); numa
  // instalação nova essa tabela nunca é criada, então nem tenta alterar.
  const tabelaEntregasExiste = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='estoque_entregas'`).all().length > 0;
  if (tabelaEntregasExiste) {
    const colunasExistentes = db.prepare(`PRAGMA table_info(estoque_entregas)`).all().map((c) => c.name);
    const adicionar = (coluna, definicao) => {
      if (!colunasExistentes.includes(coluna)) {
        db.exec(`ALTER TABLE estoque_entregas ADD COLUMN ${coluna} ${definicao}`);
      }
    };
    adicionar('modelo', 'TEXT');
    adicionar('devolvido_em', 'TEXT');
    adicionar('devolvido_movimentacao_id', 'TEXT REFERENCES estoque_movimentacoes(id)');
  }

  // Sistema de papéis (2026-09-02) — atendentes que já existiam antes dessa
  // coluna existir viram 'gestor' (não 'atendente', o default da coluna pra
  // cadastro novo): eram só 3 pessoas, já tinham acesso a tudo mesmo, e
  // alguém precisa nascer como Gestor pra poder promover os outros depois
  // (senão ninguém consegue gerenciar papel de ninguém a partir daí).
  const colunasAtendente = db.prepare(`PRAGMA table_info(atendentes)`).all().map((c) => c.name);
  if (!colunasAtendente.includes('papel')) {
    db.exec(`ALTER TABLE atendentes ADD COLUMN papel TEXT NOT NULL DEFAULT 'atendente'`);
    db.exec(`UPDATE atendentes SET papel = 'gestor'`);
  }

  // admin_total (2026-09-18) — separa "posição" (papel) de "permissão
  // administrativa total", que a migração acima tinha misturado (ver
  // comentário grande em prisma/schema.sql). Backfill: ninguém ganha
  // admin_total automaticamente aqui — é uma correção de dado feita à mão
  // por quem administra (UPDATE direto, não migração automática), pra não
  // promover ninguém sem intenção explícita.
  if (!colunasAtendente.includes('admin_total')) {
    db.exec(`ALTER TABLE atendentes ADD COLUMN admin_total INTEGER NOT NULL DEFAULT 0`);
  }

  // genero do colaborador de onboarding (2026-09-18) — só pra "bem-vindo"/
  // "bem-vinda" no e-mail de boas-vindas soar pessoal (ver src/routes/onboarding.js).
  const tabelaOnboardingExiste = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_colaboradores'`).all().length > 0;
  if (tabelaOnboardingExiste) {
    const colunasOnboarding = db.prepare(`PRAGMA table_info(onboarding_colaboradores)`).all().map((c) => c.name);
    if (!colunasOnboarding.includes('genero')) {
      db.exec(`ALTER TABLE onboarding_colaboradores ADD COLUMN genero TEXT`);
    }
    if (!colunasOnboarding.includes('departamento')) {
      db.exec(`ALTER TABLE onboarding_colaboradores ADD COLUMN departamento TEXT`);
    }
    if (!colunasOnboarding.includes('usuario_rede')) {
      db.exec(`ALTER TABLE onboarding_colaboradores ADD COLUMN usuario_rede TEXT`);
    }
  }

  // obrigatorio_para_todos (2026-09-21) — sistema que entra na ficha de
  // acessos/credenciais de TODO colaborador, sem precisar marcar em
  // cargo_sistemas cargo por cargo (caso de uso: "Usuário de rede", sem o
  // qual a pessoa nem entra no PC — ver src/routes/onboarding.js). Semeia
  // esse sistema uma única vez (INSERT OR IGNORE pelo nome único) se a
  // tabela já existir; se a pessoa já tiver um sistema "Usuário de rede"
  // cadastrado à mão, esse INSERT OR IGNORE não duplica, só a marcação
  // obrigatorio_para_todos abaixo precisa ser aplicada nele manualmente.
  const tabelaSistemasExiste = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sistemas'`).all().length > 0;
  if (tabelaSistemasExiste) {
    const colunasSistemas = db.prepare(`PRAGMA table_info(sistemas)`).all().map((c) => c.name);
    if (!colunasSistemas.includes('obrigatorio_para_todos')) {
      db.exec(`ALTER TABLE sistemas ADD COLUMN obrigatorio_para_todos INTEGER NOT NULL DEFAULT 0`);
    }
    db.prepare(`INSERT OR IGNORE INTO sistemas (nome, obrigatorio_para_todos) VALUES ('Usuário de rede (login do Windows)', 1)`).run();

    // obrigatorio_externo (2026-09-21) — sistemas que entram sozinhos pra
    // TODO colaborador de cargo externo (ver comentário em prisma/schema.sql).
    // Marca por nome exato (case-insensitive) os 5 sistemas que o usuário
    // pediu pra sempre vir juntos — não cria os sistemas se não existirem
    // ainda (evita duplicar o que a pessoa já cadastrou à mão com outra
    // grafia); só marca quem já existe com esse nome certinho.
    if (!colunasSistemas.includes('obrigatorio_externo')) {
      db.exec(`ALTER TABLE sistemas ADD COLUMN obrigatorio_externo INTEGER NOT NULL DEFAULT 0`);
    }
    const nomesObrigatorioExterno = ['Celular', 'Conta Microsoft', 'Tablet', 'Telehelp Web', 'VPN'];
    const marcarObrigatorioExterno = db.prepare(
      `UPDATE sistemas SET obrigatorio_externo = 1 WHERE lower(nome) = lower(?) AND obrigatorio_externo = 0`
    );
    for (const nome of nomesObrigatorioExterno) marcarObrigatorioExterno.run(nome);
  }

  // cargos.externo (2026-09-21) — cargo externo (consultor externo, técnico
  // externo) não recebe os sistemas "obrigatório para todos" (ver acima).
  // Backfill: ninguém vira externo automaticamente, é uma correção de dado
  // feita à mão em Colaboradores → Cargos pra quem já existe.
  const tabelaCargosExiste = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cargos'`).all().length > 0;
  if (tabelaCargosExiste) {
    const colunasCargos = db.prepare(`PRAGMA table_info(cargos)`).all().map((c) => c.name);
    if (!colunasCargos.includes('externo')) {
      db.exec(`ALTER TABLE cargos ADD COLUMN externo INTEGER NOT NULL DEFAULT 0`);
    }
  }

  // Base de Termos: colaborador.ativo ("arquivo morto") + termo.data_assinatura
  // (2026-09-22, import em massa de PDF da base real de termos — ver
  // scripts/importar-termos-pdf.js). Sem backfill de ativo aqui — quem já
  // existe nasce ativo=1 (default), a verificação contra o AD roda separada
  // (verificarColaboradoresAtivos, chamada pelo import e disponível pra
  // rodar solta depois).
  const tabelaEstoqueColabExiste = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='estoque_colaboradores'`).all().length > 0;
  if (tabelaEstoqueColabExiste) {
    const colunasEstoqueColab = db.prepare(`PRAGMA table_info(estoque_colaboradores)`).all().map((c) => c.name);
    if (!colunasEstoqueColab.includes('ativo')) {
      db.exec(`ALTER TABLE estoque_colaboradores ADD COLUMN ativo INTEGER NOT NULL DEFAULT 1`);
    }
  }
  const tabelaEstoqueTermosExiste = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='estoque_termos'`).all().length > 0;
  if (tabelaEstoqueTermosExiste) {
    const colunasEstoqueTermos = db.prepare(`PRAGMA table_info(estoque_termos)`).all().map((c) => c.name);
    if (!colunasEstoqueTermos.includes('data_assinatura')) {
      db.exec(`ALTER TABLE estoque_termos ADD COLUMN data_assinatura TEXT`);
    }
  }

  // Checklist do CPD — comentário por item + pergunta reformulada do
  // ar-condicionado (2026-09-23, ver comentário grande em prisma/schema.sql
  // sobre por que as colunas antigas ficam intactas em vez de reaproveitadas).
  const tabelaCpdExecucoesExiste = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cpd_checklist_execucoes'`).all().length > 0;
  if (tabelaCpdExecucoesExiste) {
    const colunasCpdExecucoes = db.prepare(`PRAGMA table_info(cpd_checklist_execucoes)`).all().map((c) => c.name);
    if (!colunasCpdExecucoes.includes('ar_condicionado_problema')) {
      db.exec(`ALTER TABLE cpd_checklist_execucoes ADD COLUMN ar_condicionado_problema INTEGER`);
    }
    if (!colunasCpdExecucoes.includes('ar_condicionado_problema_comentario')) {
      db.exec(`ALTER TABLE cpd_checklist_execucoes ADD COLUMN ar_condicionado_problema_comentario TEXT`);
    }
  }
  const tabelaCpdServidoresVerifExiste = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cpd_checklist_servidores_verificados'`).all().length > 0;
  if (tabelaCpdServidoresVerifExiste) {
    const colunasCpdServidoresVerif = db.prepare(`PRAGMA table_info(cpd_checklist_servidores_verificados)`).all().map((c) => c.name);
    if (!colunasCpdServidoresVerif.includes('comentario')) {
      db.exec(`ALTER TABLE cpd_checklist_servidores_verificados ADD COLUMN comentario TEXT`);
    }
  }
  // Aba "Atualizações" (2026-09-23) — IP da iDRAC + status da última
  // checagem, ver prisma/schema.sql.
  const tabelaCpdServidoresExiste = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cpd_servidores'`).all().length > 0;
  if (tabelaCpdServidoresExiste) {
    const colunasCpdServidores = db.prepare(`PRAGMA table_info(cpd_servidores)`).all().map((c) => c.name);
    if (!colunasCpdServidores.includes('idrac_host')) {
      db.exec(`ALTER TABLE cpd_servidores ADD COLUMN idrac_host TEXT`);
    }
    if (!colunasCpdServidores.includes('idrac_ultima_checagem')) {
      db.exec(`ALTER TABLE cpd_servidores ADD COLUMN idrac_ultima_checagem TEXT`);
    }
    if (!colunasCpdServidores.includes('idrac_ultimo_erro')) {
      db.exec(`ALTER TABLE cpd_servidores ADD COLUMN idrac_ultimo_erro TEXT`);
    }
    // Segunda fonte de checagem (2026-10-02) — SSH + Dell Command Update,
    // ver prisma/schema.sql.
    if (!colunasCpdServidores.includes('dcu_host')) {
      db.exec(`ALTER TABLE cpd_servidores ADD COLUMN dcu_host TEXT`);
    }
  }

  // Onda 1 de features de Chamados (2026-09-03): subcategoria, anexos,
  // comentário editável/apagável, avaliação de satisfação de 5 níveis.
  const colunasChamados = db.prepare(`PRAGMA table_info(chamados)`).all().map((c) => c.name);
  if (!colunasChamados.includes('subcategoria_id')) {
    db.exec(`ALTER TABLE chamados ADD COLUMN subcategoria_id INTEGER REFERENCES subcategorias(id)`);
  }

  const colunasComentarios = db.prepare(`PRAGMA table_info(comentarios)`).all().map((c) => c.name);
  if (!colunasComentarios.includes('editado_em')) db.exec(`ALTER TABLE comentarios ADD COLUMN editado_em TEXT`);
  if (!colunasComentarios.includes('apagado_em')) db.exec(`ALTER TABLE comentarios ADD COLUMN apagado_em TEXT`);

  const colunasAvaliacoes = db.prepare(`PRAGMA table_info(avaliacoes)`).all().map((c) => c.name);
  if (!colunasAvaliacoes.includes('satisfacao')) {
    db.exec(`ALTER TABLE avaliacoes ADD COLUMN satisfacao TEXT`);
    // Backfill a partir da nota-estrela que já existia, pra não perder o
    // histórico de avaliações antigas na tela nova.
    db.exec(`
      UPDATE avaliacoes SET satisfacao = CASE nota
        WHEN 5 THEN 'muito_satisfeito'
        WHEN 4 THEN 'satisfeito'
        WHEN 3 THEN 'regular'
        WHEN 2 THEN 'insatisfeito'
        WHEN 1 THEN 'muito_insatisfeito'
      END
      WHERE satisfacao IS NULL
    `);
  }

  const colunasColaborador = db.prepare(`PRAGMA table_info(estoque_colaboradores)`).all().map((c) => c.name);
  if (!colunasColaborador.includes('rg')) db.exec(`ALTER TABLE estoque_colaboradores ADD COLUMN rg TEXT`);
  if (!colunasColaborador.includes('telefone')) db.exec(`ALTER TABLE estoque_colaboradores ADD COLUMN telefone TEXT`);

  const colunasTermo = db.prepare(`PRAGMA table_info(estoque_termos)`).all().map((c) => c.name);
  if (!colunasTermo.includes('tipo')) db.exec(`ALTER TABLE estoque_termos ADD COLUMN tipo TEXT NOT NULL DEFAULT 'responsabilidade'`);

  // Fusão Movimentações + Entregas numa tabela só (ver comentário grande em
  // prisma/schema.sql, em cima de estoque_movimentacoes). estoque_movimentacoes
  // ganha as colunas que só existiam em estoque_entregas.
  const colunasMov = db.prepare(`PRAGMA table_info(estoque_movimentacoes)`).all().map((c) => c.name);
  const adicionarMov = (coluna, definicao) => {
    if (!colunasMov.includes(coluna)) db.exec(`ALTER TABLE estoque_movimentacoes ADD COLUMN ${coluna} ${definicao}`);
  };
  adicionarMov('usuario', 'TEXT');
  adicionarMov('host', 'TEXT');
  adicionarMov('departamento', 'TEXT');
  adicionarMov('modelo', 'TEXT');
  adicionarMov('st', 'TEXT');
  adicionarMov('termo', 'INTEGER NOT NULL DEFAULT 0');
  adicionarMov('devolvido_em', 'TEXT');
  adicionarMov('devolvido_movimentacao_id', 'TEXT REFERENCES estoque_movimentacoes(id)');
  adicionarMov('afeta_saldo', 'INTEGER NOT NULL DEFAULT 1');
  // Só cria o índice AQUI, depois de garantir que a coluna existe — ver
  // comentário em prisma/schema.sql explicando por que não pode estar lá.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_estoque_mov_usuario ON estoque_movimentacoes(usuario)`);
}

// Migração de dados (uma vez só, idempotente): copia cada linha que já
// existia em estoque_entregas pra dentro de estoque_movimentacoes, como
// tipo 'ENTREGA' (e 'DEVOLUCAO_COLABORADOR' pra quem já tinha sido
// devolvido). Só roda se a tabela estoque_entregas ainda existir (bancos
// antigos); em instalação nova ela nunca é criada (não está mais no
// schema.sql), então não há nada a migrar. "INSERT OR IGNORE" por id torna
// isso seguro de rodar de novo a cada boot sem duplicar linha.
function migrarEntregasParaMovimentacoes() {
  const tabelas = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='estoque_entregas'`).all();
  if (!tabelas.length) return;

  const entregas = db.prepare(`SELECT * FROM estoque_entregas`).all();
  if (!entregas.length) return;

  const inserir = db.prepare(
    `INSERT OR IGNORE INTO estoque_movimentacoes
       (id, data, tipo, descricao, equipamento, quantidade, usuario, host, departamento, modelo, st, termo, devolvido_em, devolvido_movimentacao_id, criado_em)
     VALUES (?, ?, 'ENTREGA', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const retag = db.prepare(
    `UPDATE estoque_movimentacoes SET tipo = 'DEVOLUCAO_COLABORADOR', usuario = ?, host = ?, departamento = ?, modelo = ?, st = ?
     WHERE id = ? AND tipo = 'ENTRADA'`
  );

  for (const e of entregas) {
    const data = (e.criado_em || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    inserir.run(
      e.id, data, e.equipamento, e.quantidade, e.usuario, e.host, e.departamento, e.modelo, e.st,
      e.termo, e.devolvido_em, e.devolvido_movimentacao_id, e.criado_em
    );
    if (e.devolvido_movimentacao_id) {
      retag.run(e.usuario, e.host, e.departamento, e.modelo, e.st, e.devolvido_movimentacao_id);
    }
  }
}

aplicarSchema();
migrarColunasNovas();
migrarEntregasParaMovimentacoes();

// Checkpoint explícito depois de qualquer migração de schema (2026-09-02,
// achado testando o sistema de papéis) — descoberto na prática: um
// ALTER TABLE rodando pouco antes de um VACUUM INTO (scripts/backup.js) no
// MESMO processo produzia um backup vazio, sem erro nenhum (bug real de
// interação WAL/VACUUM INTO no node:sqlite, não específico dessa migração).
// TRUNCATE força o WAL a ficar limpo/consistente logo depois de qualquer
// ALTER TABLE, então um backup automático rodando pela primeira vez depois
// de um deploy com migração nunca mais deveria sair vazio.
db.exec('PRAGMA wal_checkpoint(TRUNCATE);');

module.exports = { db };
