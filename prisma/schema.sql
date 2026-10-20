-- Central de Infraestrutura — motor de chamados próprio (sem TomTicket)
--
-- Usa o node:sqlite embutido no próprio Node.js (>= 22.5) em vez de um ORM
-- (tentamos o Prisma primeiro, mas ele precisa baixar um binário nativo na
-- primeira execução — em ambientes com rede restrita/corporativa isso pode
-- falhar; SQL puro + node:sqlite não depende de baixar nada além do próprio
-- Node). Rodar db.js aplica este arquivo inteiro pela primeira vez; nas
-- próximas vezes ele só confere se as tabelas já existem e não faz nada.
--
-- Migração futura pro Postgres (quando sair da fase "só Infra"): a maior
-- parte dessas instruções é SQL padrão; os ajustes ficam em AUTOINCREMENT
-- (vira SERIAL/IDENTITY no Postgres) e nos tipos DATETIME/BOOLEAN (SQLite
-- não tem tipo nativo pra eles — guarda como TEXT ISO-8601 e INTEGER 0/1).

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Referência / cadastro
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS departamentos (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nome      TEXT NOT NULL UNIQUE,
  ativo     INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS categorias (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  nome            TEXT NOT NULL,
  departamento_id INTEGER NOT NULL REFERENCES departamentos(id),
  ativo           INTEGER NOT NULL DEFAULT 1,
  criado_em       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (nome, departamento_id)
);

-- Subcategoria (2026-09-03) — refinamento opcional de categoria. Só passa a
-- ser obrigatória na abertura de um chamado quando a categoria escolhida já
-- tem pelo menos uma subcategoria ativa cadastrada (ver criarChamado em
-- src/routes/chamados.js) — assim categorias que ainda não foram detalhadas
-- não travam ninguém.
CREATE TABLE IF NOT EXISTS subcategorias (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  nome         TEXT NOT NULL,
  categoria_id INTEGER NOT NULL REFERENCES categorias(id),
  ativo        INTEGER NOT NULL DEFAULT 1,
  criado_em    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (nome, categoria_id)
);

CREATE TABLE IF NOT EXISTS atendentes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  nome            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  departamento_id INTEGER REFERENCES departamentos(id), -- "departamento de casa" da pessoa
  -- 'operador' (colaborador comum — só os próprios chamados) |
  -- 'atendente' (atende os chamados do departamento_id acima) |
  -- 'lider' (supervisiona departamento_id + o que estiver em
  --   atendente_departamentos_liderados, ver abaixo) | 'gestor' (tudo, sem
  -- restrição). Ver src/lib/auth.js (exigirPapel, departamentosVisiveisPor).
  papel           TEXT NOT NULL DEFAULT 'atendente',
  -- Permissão administrativa TOTAL, ORTOGONAL ao papel (2026-09-18) — papel
  -- é a posição da pessoa (usada pra escopo de departamento em Chamados);
  -- admin_total é quem pode mexer em Cadastros/Onboarding de acessos etc.,
  -- independente do papel. Ver src/lib/auth.js (exigirPapel,
  -- departamentosVisiveisPor) — motivo: a migração de papel original tinha
  -- misturado as duas coisas (classificou os 3 atendentes que já existiam
  -- como 'gestor' só pra não travar ninguém, mesmo quem na empresa é
  -- Atendente de verdade).
  admin_total     INTEGER NOT NULL DEFAULT 0,
  ativo           INTEGER NOT NULL DEFAULT 1,
  -- Formato "saltHex:hashHex" (scrypt do próprio Node, ver src/lib/auth.js).
  -- NULL = atendente ainda não tem senha definida (não consegue logar até
  -- alguém rodar scripts/definir-senha.js pra ele). De propósito não existe
  -- nenhuma senha padrão de fábrica em lugar nenhum do projeto.
  senha_hash      TEXT,
  criado_em       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Departamentos extras que um Líder supervisiona, além do próprio
-- departamento_id (que continua sendo o "de casa" dele). Só populada pra
-- quem é papel='lider' — ver departamentosVisiveisPor em src/lib/auth.js.
CREATE TABLE IF NOT EXISTS atendente_departamentos_liderados (
  atendente_id    INTEGER NOT NULL REFERENCES atendentes(id),
  departamento_id INTEGER NOT NULL REFERENCES departamentos(id),
  PRIMARY KEY (atendente_id, departamento_id)
);

-- Sessão de login — token opaco (não é JWT: não guarda nada dentro dele,
-- só é uma chave pra essa tabela; assim dá pra "deslogar de verdade"
-- apagando a linha, coisa que JWT sozinho não permite fazer sem
-- infraestrutura extra de blocklist).
CREATE TABLE IF NOT EXISTS sessoes (
  token        TEXT PRIMARY KEY,
  atendente_id INTEGER NOT NULL REFERENCES atendentes(id),
  criado_em    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expira_em    TEXT NOT NULL
);

-- Quem abre o chamado (funcionário da empresa). Separado do atendente de
-- propósito. Por enquanto cadastro simples; dá pra popular a partir do
-- mesmo AD que a Central de Infraestrutura já lê, mais pra frente.
CREATE TABLE IF NOT EXISTS solicitantes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nome      TEXT NOT NULL,
  email     TEXT NOT NULL UNIQUE,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Política de prazo de SLA. Resolvida por categoria; se a categoria não tiver
-- uma política própria, cai pra política do departamento (categoria_id NULL);
-- se nenhuma existir, o chamado fica sem prazo definido (mesmo
-- comportamento de "sem SLA definido" que a integração com o TomTicket já
-- tinha).
-- Feriados (2026-09-08) — calendário mantido pelo Gestor em Cadastros, usado
-- pra "dia útil" não contar feriado como falta (checklist do CPD) nem
-- disparar lembrete/resumo automático nesse dia. Sem exclusão real
-- protegida por FK em outro lugar — dá pra apagar de verdade se cadastrar
-- errado (ver DELETE /feriados em src/routes/referencia.js).
CREATE TABLE IF NOT EXISTS feriados (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  data      TEXT NOT NULL UNIQUE, -- 'AAAA-MM-DD'
  nome      TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sla_politicas (
  id                                INTEGER PRIMARY KEY AUTOINCREMENT,
  departamento_id                   INTEGER NOT NULL REFERENCES departamentos(id),
  categoria_id                      INTEGER REFERENCES categorias(id),
  prioridade                        TEXT NOT NULL, -- 'baixa' | 'normal' | 'alta' | 'urgente'
  prazo_primeira_resposta_minutos   INTEGER NOT NULL,
  prazo_resolucao_minutos           INTEGER NOT NULL,
  criado_em                         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (departamento_id, categoria_id, prioridade)
);

-- ---------------------------------------------------------------------------
-- Chamados
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chamados (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  protocolo TEXT NOT NULL UNIQUE, -- ex.: "2026-000123"

  assunto    TEXT NOT NULL,
  descricao  TEXT NOT NULL,
  prioridade TEXT NOT NULL DEFAULT 'normal', -- 'baixa' | 'normal' | 'alta' | 'urgente'
  status     TEXT NOT NULL DEFAULT 'aberto', -- 'aberto' | 'em_atendimento' | 'aguardando_cliente' | 'finalizado' | 'cancelado'

  departamento_id INTEGER NOT NULL REFERENCES departamentos(id),
  categoria_id     INTEGER NOT NULL REFERENCES categorias(id),
  subcategoria_id  INTEGER REFERENCES subcategorias(id), -- NULL = categoria sem subcategoria cadastrada ainda
  solicitante_id   INTEGER NOT NULL REFERENCES solicitantes(id),
  atendente_id     INTEGER REFERENCES atendentes(id),

  criado_em            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primeira_resposta_em TEXT,
  finalizado_em        TEXT,

  -- Prazos calculados na criação, a partir da sla_politicas resolvida.
  -- Congelados aqui pra não mudar retroativamente se a política for
  -- editada depois.
  sla_prazo_primeira_resposta   TEXT,
  sla_prazo_resolucao           TEXT,
  sla_primeira_resposta_cumprida INTEGER, -- NULL = ainda não chegou lá; 0/1 depois
  sla_resolucao_cumprida         INTEGER  -- NULL = ainda não finalizado ou sem SLA
);

CREATE INDEX IF NOT EXISTS idx_chamados_status ON chamados(status);
CREATE INDEX IF NOT EXISTS idx_chamados_departamento ON chamados(departamento_id);
CREATE INDEX IF NOT EXISTS idx_chamados_criado_em ON chamados(criado_em);

CREATE TABLE IF NOT EXISTS chamado_historico_status (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chamado_id      INTEGER NOT NULL REFERENCES chamados(id),
  status_anterior TEXT,
  status_novo     TEXT NOT NULL,
  atendente_id    INTEGER REFERENCES atendentes(id), -- NULL = automático/sistema
  criado_em       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_historico_chamado ON chamado_historico_status(chamado_id);

CREATE TABLE IF NOT EXISTS comentarios (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chamado_id   INTEGER NOT NULL REFERENCES chamados(id),
  atendente_id INTEGER REFERENCES atendentes(id), -- preenchido quando quem comentou foi atendente
  autor_nome   TEXT NOT NULL,
  texto        TEXT NOT NULL,
  interno      INTEGER NOT NULL DEFAULT 0, -- 1 = só a equipe vê
  editado_em   TEXT, -- NULL = nunca editado (2026-09-03)
  apagado_em   TEXT, -- soft delete, mesmo espírito do ativo=0 de departamentos/categorias (2026-09-03)
  criado_em    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_comentarios_chamado ON comentarios(chamado_id);

-- Anexo de arquivo, tanto na abertura do chamado (comentario_id NULL)
-- quanto num comentário específico (2026-09-03). Tabela própria em vez de
-- coluna solta porque pode haver vários anexos por chamado/comentário.
CREATE TABLE IF NOT EXISTS chamado_anexos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chamado_id    INTEGER NOT NULL REFERENCES chamados(id),
  comentario_id INTEGER REFERENCES comentarios(id),
  atendente_id  INTEGER REFERENCES atendentes(id), -- quem anexou (todo mundo logado tem linha em atendentes, inclusive Operador)
  nome_original TEXT NOT NULL,
  arquivo       TEXT NOT NULL, -- nome gerado em disco, dados/chamados-anexos/ — nunca o nome_original
  tipo          TEXT,          -- mime type
  tamanho       INTEGER,       -- bytes
  criado_em     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_chamado_anexos_chamado ON chamado_anexos(chamado_id);

-- Avaliação de satisfação por chamado (2026-09-03: substituiu o modelo de
-- estrela 1-5 por 5 níveis nomeados — ver "satisfacao" abaixo). UNIQUE em
-- chamado_id continua valendo mesmo com reabertura automática por
-- insatisfação: cada nova avaliação faz UPSERT na mesma linha (ver POST
-- /chamados/:id/avaliacao em src/routes/chamados.js) — "pendente de
-- avaliar de novo" é decidido comparando avaliacoes.criado_em com
-- chamados.finalizado_em, não pela existência da linha.
CREATE TABLE IF NOT EXISTS avaliacoes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chamado_id INTEGER NOT NULL UNIQUE REFERENCES chamados(id),
  -- Legado (era o modelo original, estrela 1-5) — mantido só pra satisfazer
  -- essa CHECK/NOT NULL sem precisar reconstruir a tabela (SQLite não
  -- altera constraint via ALTER TABLE); preenchido automaticamente a partir
  -- de "satisfacao" (mapa 5..1), a API e a tela não usam mais este campo.
  nota       INTEGER NOT NULL CHECK (nota BETWEEN 1 AND 5),
  -- 'muito_satisfeito' | 'satisfeito' | 'regular' | 'insatisfeito' | 'muito_insatisfeito'
  satisfacao TEXT,
  comentario TEXT,
  criado_em  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- Estoque — migrado do Controle-de-Estoque.html/Central-de-Infraestrutura.html
-- (ferramenta antiga, arquivo local .json via File System Access API). As 7
-- "abas" de lá viram 7 tabelas aqui. IDs continuam TEXT (ex.: "r421") em vez
-- de INTEGER AUTOINCREMENT de propósito — são os mesmos IDs que já existiam
-- no .json antigo, preservados por scripts/importar-estoque.js pra manter
-- rastreabilidade com o histórico que já existia (movimentações antigas,
-- etc.) em vez de gerar tudo de novo do zero.
-- ---------------------------------------------------------------------------

-- Catálogo de itens de estoque. "saldo" e "status" (OK/COMPRAR) NÃO são
-- colunas aqui — são calculados na hora, a partir de estoque_movimentacoes,
-- exatamente como a ferramenta antiga fazia (ver computeStock/statusFor no
-- Central-de-Infraestrutura.html) — assim o saldo nunca fica desatualizado
-- em relação ao histórico de movimentações.
CREATE TABLE IF NOT EXISTS estoque_itens (
  id            TEXT PRIMARY KEY,
  item          TEXT NOT NULL,
  minimo        INTEGER NOT NULL DEFAULT 0,
  status_manual TEXT,    -- NULL = automático (por saldo); senão um texto livre tipo "Fora de mercado"
  auto          INTEGER NOT NULL DEFAULT 0, -- 1 = item criado automaticamente (apareceu numa movimentação sem cadastro prévio)
  criado_em     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Itens usados/danificados/condenados — registro separado do catálogo
-- principal, não entra no cálculo de saldo.
CREATE TABLE IF NOT EXISTS estoque_usados (
  id         TEXT PRIMARY KEY,
  item       TEXT NOT NULL,
  quantidade INTEGER NOT NULL DEFAULT 0,
  estado     TEXT,    -- ex.: "USADO"
  detalhes   TEXT,    -- ex.: "CONDENADO", "DANIFICADO"
  criado_em  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Ledger único de tudo que movimenta equipamento — entrada/saída genérica
-- de estoque, entrega a um colaborador e devolução de um colaborador. Antes
-- eram duas tabelas (estoque_movimentacoes + estoque_entregas, cada uma com
-- sua própria aba); foram fundidas numa só a pedido do usuário, porque as
-- duas eram conceitualmente a mesma coisa (um evento de movimento de
-- equipamento) só que registradas em lugares diferentes. "tipo" agora tem
-- 4 valores possíveis (mais o legado 'DEVOLUÇÃO' com acento, ver abaixo):
--   'ENTRADA'              — entrou pro estoque (compra etc.), sem pessoa.
--   'SAIDA'                — saiu do estoque, sem pessoa (descarte etc.).
--   'ENTREGA'              — equipamento entregue a um colaborador (usuario
--                             preenchido). Não soma nem subtrai do saldo —
--                             mesmo comportamento que a antiga aba Entregas
--                             sempre teve (entrega não é "saída de estoque"
--                             pra fins de saldo neste sistema, de propósito,
--                             herdado da ferramenta antiga).
--   'DEVOLUCAO_COLABORADOR' — equipamento devolvido POR um colaborador
--                             (fecha uma linha 'ENTREGA' em aberto, por ID —
--                             ver devolvido_em/devolvido_movimentacao_id
--                             abaixo). ENTRA no saldo (mesmo efeito que uma
--                             ENTRADA), porque é isso que a antiga aba
--                             Entregas já fazia no botão "Registrar
--                             devolução" (criava uma ENTRADA de verdade).
-- 'DEVOLUÇÃO' (com acento, sem pessoa) é o valor legado da época em que só
-- existia a ideia de "devolução genérica pro estoque" (ex.: devolução pra
-- um fornecedor) — continua existindo em linhas antigas, não soma nem
-- subtrai do saldo, mas o formulário não cria mais linhas novas com esse
-- valor (o caso de uso dele foi substituído por 'DEVOLUCAO_COLABORADOR').
--
-- usuario/host/departamento/modelo/st/termo só fazem sentido pra 'ENTREGA'
-- e 'DEVOLUCAO_COLABORADOR' (NULL nas demais). "termo" = 1 quando existe
-- termo de responsabilidade assinado pra aquela entrega.
--
-- devolvido_em/devolvido_movimentacao_id fecham o ciclo de uma linha
-- 'ENTREGA': quando o equipamento volta, a tela tem uma ação "Registrar
-- devolução" que cria a linha 'DEVOLUCAO_COLABORADOR' correspondente e
-- marca essas duas colunas AQUI, na linha 'ENTREGA' original (vínculo
-- sempre por ID, nunca por nome digitado — ver POST
-- /estoque/movimentacoes/:id/devolver em src/routes/estoque.js). Uma
-- 'ENTREGA' com devolvido_em NULL = equipamento ainda em posse dessa
-- pessoa; é essa condição que define "Equipamentos por usuário" (ver
-- src/lib/estoqueUsuarios.js).
CREATE TABLE IF NOT EXISTS estoque_movimentacoes (
  id           TEXT PRIMARY KEY,
  data         TEXT NOT NULL, -- data informada (AAAA-MM-DD), não necessariamente igual a criado_em
  tipo         TEXT NOT NULL, -- 'ENTRADA' | 'SAIDA' | 'ENTREGA' | 'DEVOLUCAO_COLABORADOR' | 'EMPRESTIMO' (home office, não mexe no saldo) | 'DEVOLUÇÃO' (legado)
  descricao    TEXT,
  equipamento  TEXT NOT NULL, -- nome do item (casa com estoque_itens.item, comparado sem acento/maiúscula)
  quantidade   INTEGER NOT NULL,
  usuario      TEXT,    -- só em ENTREGA/DEVOLUCAO_COLABORADOR
  host         TEXT,
  departamento TEXT,
  modelo       TEXT,    -- ex.: "Dell Pro 14" (equipamento = "Notebook") — usado na tabela do termo
  st           TEXT,    -- service tag / número de série
  termo        INTEGER NOT NULL DEFAULT 0, -- 1 = termo de responsabilidade assinado (só ENTREGA)
  devolvido_em              TEXT, -- só ENTREGA: NULL = ainda com a pessoa; preenchido ao registrar devolução
  devolvido_movimentacao_id TEXT REFERENCES estoque_movimentacoes(id), -- só ENTREGA: aponta pra linha DEVOLUCAO_COLABORADOR que a fechou
  -- 0 = ENTREGA "histórica" (2026-10-05): equipamento que JÁ estava com a pessoa
  -- antes de entrar na plataforma (termo assinado importado/enviado por nós) —
  -- aparece em "Equipamentos por usuário" e nos termos, mas NÃO desconta do
  -- saldo da prateleira (ele já estava fora do estoque contado). A devolução
  -- dele depois soma normalmente no saldo (volta pra prateleira).
  afeta_saldo  INTEGER NOT NULL DEFAULT 1,
  criado_em    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_estoque_mov_equipamento ON estoque_movimentacoes(equipamento);
-- idx_estoque_mov_usuario NÃO fica aqui de propósito: num banco que já
-- existia antes da fusão Movimentações+Entregas, a coluna "usuario" só é
-- criada pelo ALTER TABLE em src/lib/db.js (migrarColunasNovas), que roda
-- DEPOIS deste schema.sql — um CREATE INDEX aqui, na mesma passada,
-- quebraria com "no such column: usuario" nesses bancos. O índice é criado
-- em src/lib/db.js, depois da coluna existir garantidamente (fresh install
-- ou migrado).

-- Tabela antiga "Entregas", substituída pelo ledger único acima (fundida
-- pra dentro de estoque_movimentacoes, tipo 'ENTREGA'/'DEVOLUCAO_COLABORADOR').
-- Não é mais criada em instalações novas; em bancos existentes os dados
-- antigos continuam aqui intactos (já migrados pra estoque_movimentacoes
-- por src/lib/db.js), só não é mais lida por nenhuma rota/tela.

-- Dados de identidade de colaboradores/consultores usados para gerar o
-- Termo de Responsabilidade (CPF, nacionalidade etc. não existem em
-- nenhuma outra tabela — não são coletados pelo mapeamento de AD). "usuario"
-- é opcional e serve só pra ligar automaticamente com o nome usado em
-- Entregas na hora de montar a tabela de equipamentos do termo.
CREATE TABLE IF NOT EXISTS estoque_colaboradores (
  id            TEXT PRIMARY KEY,
  nome          TEXT NOT NULL,
  usuario       TEXT,    -- ex.: "aline.amorim" (bate com estoque_entregas.usuario)
  cpf           TEXT,
  rg            TEXT,
  telefone      TEXT,
  nacionalidade TEXT,
  estado_civil  TEXT,
  endereco      TEXT,
  cargo         TEXT,
  departamento  TEXT,
  origem        TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'sharepoint' (importado de um termo já assinado) | 'auto' (criado sozinho ao registrar uma entrega pra um usuário sem cadastro ainda)
  -- 1 = ativo (bate com alguém no AD); 0 = "arquivo morto" — tem termo na
  -- base mas não existe mais no AD (2026-09-22, ver
  -- src/lib/estoqueColaboradores.js). Não é apagado nem escondido de
  -- verdade, só sai da lista normal de Termos e vai pra aba própria.
  ativo         INTEGER NOT NULL DEFAULT 1,
  criado_em     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Um termo gerado (ou importado) por colaborador. "itens_snapshot" guarda a
-- lista de equipamentos EXATAMENTE como estava na hora de gerar (JSON) —
-- não referencia estoque_entregas ao vivo, porque um termo já
-- gerado/assinado não pode mudar retroativamente se as entregas mudarem
-- depois. "arquivo" é o .docx gerado, salvo em dados/termos/ (mesmo padrão
-- de dados/cpd-fotos/: nome gerado, nunca o nome original).
-- "tipo" distingue os dois modelos que a empresa usa: 'responsabilidade'
-- (entrega de equipamento — o de sempre) e 'devolucao' (Termo de Devolução
-- de Equipamentos, usado no desligamento — texto e campos diferentes, ver
-- src/lib/termoDocx.js). Gerar um termo de devolução pela tela também marca
-- como devolvidas todas as entregas em aberto daquele colaborador (mesmo
-- efeito do botão "Registrar devolução" da aba Entregas, só que pra tudo de
-- uma vez).
CREATE TABLE IF NOT EXISTS estoque_termos (
  id              TEXT PRIMARY KEY,
  colaborador_id  TEXT NOT NULL REFERENCES estoque_colaboradores(id),
  tipo            TEXT NOT NULL DEFAULT 'responsabilidade', -- 'responsabilidade' | 'devolucao'
  itens_snapshot  TEXT NOT NULL, -- JSON: [{equipamento, modelo, st, quantidade}, ...]
  arquivo         TEXT,          -- nome do .docx em dados/termos/ (NULL se só importado sem baixar o arquivo)
  origem          TEXT NOT NULL DEFAULT 'gerado', -- 'gerado' (pelo site) | 'sharepoint' (importado) | 'upload' (assinado, enviado pronto)
  -- Data real de assinatura, extraída do documento (2026-09-22, import em
  -- massa da base de PDFs) — ISO, nullable. Diferente de gerado_em: pra um
  -- termo IMPORTADO, gerado_em é só o momento do import, sem significado;
  -- data_assinatura é a data de verdade escrita/assinada no papel, usada
  -- pra decidir qual termo é o mais recente de uma pessoa (e por
  -- consequência qual CPF/endereço/estado civil prevalece no cadastro).
  -- NULL pra termo gerado pela própria plataforma (nesse caso gerado_em
  -- já É a data que interessa).
  data_assinatura TEXT,
  gerado_em       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_estoque_termos_colaborador ON estoque_termos(colaborador_id);

-- Consultores externos (celular/tablet corporativo emprestado).
CREATE TABLE IF NOT EXISTS estoque_consultores (
  id              TEXT PRIMARY KEY,
  usuario         TEXT,
  departamento    TEXT,
  numero_celular  TEXT,
  numero_tablet   TEXT,
  gmail           TEXT,
  imei            TEXT,
  iccid           TEXT,
  criado_em       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Celulares/linhas corporativas por departamento (não ligadas a uma pessoa).
CREATE TABLE IF NOT EXISTS estoque_corporativos (
  id           TEXT PRIMARY KEY,
  item         TEXT NOT NULL,
  departamento TEXT,
  numero       TEXT,
  st           TEXT,
  gmail        TEXT,
  imei         TEXT,
  criado_em    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- Checklist do CPD — inspeção física diária (meta: todo dia útil), migrado
-- do formulário Microsoft Forms "Checklist CPD" que a equipe já usava.
-- Guarda histórico de cada rodada (uma linha em cpd_checklist_execucoes por
-- vez que alguém preenche o checklist inteiro), não só o estado atual —
-- pedido explícito, pra dar pra consultar rodadas passadas.
-- ---------------------------------------------------------------------------

-- Catálogo dos servidores que aparecem na pergunta "Servidores" do
-- checklist — "só criar, sem excluir" (mesmo padrão de departamentos/
-- categorias) pra não quebrar o histórico de rodadas antigas que já
-- referenciam um servidor.
CREATE TABLE IF NOT EXISTS cpd_servidores (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nome      TEXT NOT NULL UNIQUE,
  ativo     INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Aba "Atualizações" (2026-09-23) — IP/host da iDRAC desse servidor físico
  -- Dell, pra checagem automática de firmware. NULL = ainda não cadastrado
  -- (servidor fica de fora da checagem até alguém preencher pela tela
  -- Servidores/Receptoras). idrac_ultima_checagem/idrac_ultimo_erro
  -- refletem a última tentativa (sucesso ou falha) — ver src/lib/idrac.js.
  idrac_host             TEXT,
  idrac_ultima_checagem  TEXT,
  idrac_ultimo_erro      TEXT,
  -- Segunda fonte de checagem (2026-10-02) — pros servidores SEM iDRAC
  -- (ex.: máquinas Windows comuns, não PowerEdge com controladora própria):
  -- IP/host de onde dá pra conectar via SSH (Servidor OpenSSH do Windows)
  -- e rodar o Dell Command Update (dcu-cli.exe /scan), que lê atualização
  -- de driver/firmware de DENTRO do Windows — ver src/lib/dellCommandUpdate.js.
  -- idrac_ultima_checagem/idrac_ultimo_erro são reaproveitados pra essa
  -- fonte também (significado continua "última tentativa", independente
  -- de qual dos dois métodos foi usado) — um servidor só tem UM dos dois
  -- campos preenchido (idrac_host OU dcu_host), nunca os dois.
  dcu_host                TEXT
);

-- Mesmo padrão de cpd_servidores, pro catálogo de receptoras (2026-09-23 —
-- antes receptoras era só uma pergunta Sim/Não genérica, sem lista de itens).
CREATE TABLE IF NOT EXISTS cpd_receptoras (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nome      TEXT NOT NULL UNIQUE,
  ativo     INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Uma linha por rodada de checklist preenchida. Espelha as 3 perguntas
-- Sim/Não + comentário do formulário original (servidores, receptoras,
-- ar-condicionado), a data escolhida por quem preenche (pode não ser hoje,
-- ex.: preenchendo com atraso) e a foto obrigatória (arquivo salvo em
-- dados/cpd-fotos/, nome gerado — nunca o nome original do upload, ver
-- src/routes/cpd.js). Quem preencheu é sempre o atendente da sessão
-- (nunca um campo vindo do cliente), mesmo padrão já usado em
-- comentários/mudança de status de chamados.
CREATE TABLE IF NOT EXISTS cpd_checklist_execucoes (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  atendente_id                INTEGER NOT NULL REFERENCES atendentes(id),
  data_registro                TEXT NOT NULL, -- AAAA-MM-DD

  -- servidores_verificado/receptoras_verificado (2026-09-23, sentido
  -- preservado): "a seção foi mexida" — 1 se pelo menos um item da tabela
  -- de junção foi marcado naquele dia, 0 senão. Deixaram de ser a pergunta
  -- Sim/Não em si (isso virou item-a-item, ver cpd_checklist_servidores_
  -- verificados.comentario e cpd_checklist_receptoras_verificadas) — quem
  -- decide se teve problema agora é ter comentário preenchido num item, não
  -- essa coluna. Ficam gravadas só pra manter NOT NULL e pra registro
  -- migrado do Forms antigo continuar exibível como estava.
  servidores_verificado        INTEGER NOT NULL, -- 1/0 — registro antigo: "Verificou ruídos, LEDs ou temperatura fora do comum nos servidores?"; registro novo: "teve algum item de servidor marcado?"
  servidores_comentario        TEXT, -- só preenchido em registro antigo (migrado) — registro novo usa comentário por item

  receptoras_verificado        INTEGER NOT NULL, -- 1/0 — registro antigo: "Verificou ruídos, LEDs, mensagens fora do comum nas receptoras?"; registro novo: "teve algum item de receptora marcado?"
  receptoras_comentario        TEXT, -- só preenchido em registro antigo (migrado)

  ar_condicionado_verificado   INTEGER NOT NULL, -- 1/0 — "Verificou funcionamento dos dois equipamentos de ar condicionado e se a temperatura está entre 18° e 23°?" (pergunta antiga, mantida só pra registro migrado)
  ar_condicionado_comentario   TEXT, -- só preenchido em registro antigo (migrado) — registro novo usa ar_condicionado_problema/ar_condicionado_problema_comentario
  -- Pergunta reformulada (2026-09-23, corrige ambiguidade: "não verificado"
  -- não é a mesma coisa que "achei um problema", mas a saúde do CPD estava
  -- tratando as duas coisas igual): "Encontrou algum problema no
  -- funcionamento dos dois aparelhos de ar-condicionado ou na temperatura,
  -- fora de 18°–23°?" — 1 = achou problema, 0 = tudo normal, NULL = registro
  -- antigo (usa ar_condicionado_verificado em vez disso).
  ar_condicionado_problema         INTEGER,
  ar_condicionado_problema_comentario TEXT,

  -- Foto é obrigatória no formulário (ver POST /api/cpd/checklist), mas a
  -- coluna em si é opcional pra caber o histórico migrado do Forms antigo,
  -- cujas fotos ficaram num SharePoint que exige login da Microsoft pra
  -- abrir — não dava pra baixar automaticamente (ver
  -- scripts/importar-checklist-cpd-historico.js). Um registro sempre tem
  -- ou foto_arquivo (upload local, servido por este site) ou
  -- foto_url_externa (link de referência pro Forms antigo), nunca os dois.
  foto_arquivo                 TEXT, -- nome do arquivo em dados/cpd-fotos/ (gerado, não confiar no nome original)
  foto_nome_original           TEXT,
  foto_tipo                    TEXT,
  foto_url_externa             TEXT, -- só em registros migrados do Forms antigo, quando não deu pra baixar a foto

  criado_em                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_cpd_execucoes_data ON cpd_checklist_execucoes(data_registro);

-- Quais servidores (do catálogo cpd_servidores) foram marcados como
-- verificados numa rodada — pergunta "Servidores" do formulário é
-- multi-seleção. "comentario" (2026-09-23) é a observação daquele item
-- específico, preenchida só quando a pessoa marca o servidor e escreve
-- algo — é isso que conta como "achou um problema" no cálculo de saúde,
-- não o simples fato de ter marcado o item.
CREATE TABLE IF NOT EXISTS cpd_checklist_servidores_verificados (
  execucao_id  INTEGER NOT NULL REFERENCES cpd_checklist_execucoes(id),
  servidor_id  INTEGER NOT NULL REFERENCES cpd_servidores(id),
  comentario   TEXT,
  PRIMARY KEY (execucao_id, servidor_id)
);

-- Mesmo padrão de cpd_checklist_servidores_verificados, pra receptoras
-- (2026-09-23).
CREATE TABLE IF NOT EXISTS cpd_checklist_receptoras_verificadas (
  execucao_id   INTEGER NOT NULL REFERENCES cpd_checklist_execucoes(id),
  receptora_id  INTEGER NOT NULL REFERENCES cpd_receptoras(id),
  comentario    TEXT,
  PRIMARY KEY (execucao_id, receptora_id)
);

-- Aba "Atualizações" (2026-09-23) — inventário de firmware por servidor,
-- lido da iDRAC (ver src/lib/idrac.js). Uma linha por componente
-- (BIOS, controladora RAID, placa de rede etc.); versao_disponivel fica
-- NULL quando não há atualização OU quando não foi possível comparar com o
-- catálogo online da Dell (checagem de inventário e checagem de
-- atualização disponível são duas chamadas separadas, uma pode falhar sem
-- derrubar a outra — ver idrac_ultimo_erro em cpd_servidores).
-- Upsert por (servidor_id, componente) a cada checagem.
CREATE TABLE IF NOT EXISTS cpd_firmware_itens (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  servidor_id       INTEGER NOT NULL REFERENCES cpd_servidores(id),
  componente        TEXT NOT NULL,
  versao_atual      TEXT,
  versao_disponivel TEXT,
  criticidade       TEXT, -- string crua devolvida pela Dell (Urgent/Recommended/Optional/...), sem normalizar
  atualizado_em     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (servidor_id, componente)
);

-- ---------------------------------------------------------------------------
-- Onboarding de acessos (aba "Colaboradores", 2026-09-18) — catálogo de
-- quais sistemas cada cargo precisa, credenciais provisionadas por
-- colaborador/sistema (senha sempre cifrada — ver src/lib/credenciaisCrypto.js)
-- e geração da Ficha de Acessos + e-mail de boas-vindas. Tabela própria,
-- separada de estoque_colaboradores de propósito (ver comentário no plano:
-- domínio diferente — credencial de sistema, não custódia de equipamento —
-- mesmo que a pessoa seja a mesma nos dois casos).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cargos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  nome             TEXT NOT NULL UNIQUE,
  -- 1 = cargo abre chamado direto no TomTicket (muda o texto do e-mail de
  -- boas-vindas e inclui o passo a passo do TomTicket como anexo); 0 = a
  -- liderança abre chamado por essa pessoa.
  acesso_tomticket INTEGER NOT NULL DEFAULT 0,
  -- 1 = cargo externo (consultor externo, técnico externo etc.) — pessoas
  -- nesse cargo NÃO recebem os sistemas "obrigatório para todos" (ex.:
  -- Usuário de rede) na ficha de acessos/credenciais, mesmo sem precisar
  -- marcar isso por colaborador (2026-09-21, pedido explícito: usuário de
  -- rede não pode existir pra consultor/técnico externo).
  externo          INTEGER NOT NULL DEFAULT 0,
  ativo            INTEGER NOT NULL DEFAULT 1,
  criado_em        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sistemas (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nome      TEXT NOT NULL UNIQUE,
  -- 1 = aparece na ficha de acessos e no cadastro de credenciais de TODO
  -- colaborador, independente do cargo (ex.: "Usuário de rede" — sem ele a
  -- pessoa nem entra no PC, então não faz sentido depender de marcar em
  -- cargo_sistemas cargo por cargo). Ordenado antes dos sistemas do cargo.
  obrigatorio_para_todos INTEGER NOT NULL DEFAULT 0,
  -- 1 = aparece automaticamente na ficha/credenciais de todo colaborador de
  -- cargo EXTERNO (cargos.externo=1), sem precisar marcar em cargo_sistemas
  -- cargo por cargo (2026-09-21 — ex.: Celular, Conta Microsoft, Tablet,
  -- Telehelp Web, VPN). Não afeta cargo normal (continua dependendo de
  -- cargo_sistemas, igual antes).
  obrigatorio_externo INTEGER NOT NULL DEFAULT 0,
  ativo     INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS cargo_sistemas (
  cargo_id   INTEGER NOT NULL REFERENCES cargos(id),
  sistema_id INTEGER NOT NULL REFERENCES sistemas(id),
  PRIMARY KEY (cargo_id, sistema_id)
);

CREATE TABLE IF NOT EXISTS onboarding_colaboradores (
  id        TEXT PRIMARY KEY, -- uuid, mesmo padrão de estoque_*
  nome      TEXT NOT NULL,
  cargo_id  INTEGER REFERENCES cargos(id),
  gestor    TEXT, -- nome do gestor, texto livre (igual à ficha de acessos)
  email     TEXT, -- pra onde vai o e-mail de boas-vindas
  -- sAMAccountName do AD (2026-09-21) — usado como base real pra sugerir o
  -- usuário nos demais sistemas (ver sugerirCredencial em public/app.js),
  -- em vez de só adivinhar pelo nome. Vem preenchido sozinho ao escolher o
  -- colaborador na busca do AD; editável se cadastrado à mão.
  usuario_rede TEXT,
  -- 'm' | 'f' | NULL (2026-09-18) — usado só pra "bem-vindo"/"bem-vinda" no
  -- e-mail de boas-vindas soar pessoal em vez de genérico; NULL cai na forma
  -- neutra "bem-vindo(a)".
  genero    TEXT,
  -- Área/departamento pra exibir no PREVIEW de assinatura do próprio
  -- colaborador dentro do e-mail de boas-vindas (2026-09-18) — texto curto
  -- tipo "Central de Emergência"/"Recursos Humanos", diferente do cargo
  -- (que pode ser um título de cargo bem mais longo, vindo do AD).
  departamento TEXT,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Uma linha por sistema liberado pro colaborador. senha_cifrada nunca é
-- texto puro (AES-256-GCM, formato "iv:authTag:cifrado" em hex) — nem essa
-- tabela, já restrita a papel=atendente, guarda senha legível em repouso.
CREATE TABLE IF NOT EXISTS onboarding_credenciais (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  colaborador_id TEXT NOT NULL REFERENCES onboarding_colaboradores(id),
  sistema_id     INTEGER NOT NULL REFERENCES sistemas(id),
  usuario        TEXT,
  senha_cifrada  TEXT,
  criado_em      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (colaborador_id, sistema_id)
);

-- ---------------------------------------------------------------------------
-- Aba "Segurança" (2026-09-30) — alertas do Acronis Cyber Protect
-- (proteção/antivírus dos dispositivos corporativos, não backup). Meta do
-- time é zerar os alertas ao longo do mês; ver src/lib/acronis.js.
-- ---------------------------------------------------------------------------

-- "resolvido_em" NÃO vem da API da Acronis (o campo exato de "dispensado"
-- não foi confirmado contra a API de verdade ainda) — é inferido por nós:
-- toda sincronização busca os alertas ativos agora; um alerta que estava
-- marcado como visto antes e não aparece mais na lista recebe
-- resolvido_em = agora (ver sincronizarAlertas em src/lib/acronis.js).
CREATE TABLE IF NOT EXISTS acronis_alertas (
  id                    TEXT PRIMARY KEY,   -- id da Acronis (já é único, UUID)
  tipo                  TEXT,
  categoria             TEXT,
  severidade            TEXT,               -- cru da Acronis (warning/critical/...)
  titulo                TEXT,
  descricao             TEXT,
  detalhes_json         TEXT,               -- details.fields inteiro, cru (JSON) — varia por tipo de alerta, pode conter o dispositivo afetado
  criado_em_acronis     TEXT,
  visto_pela_ultima_vez TEXT NOT NULL,
  resolvido_em          TEXT
);

-- "Arquivar mês" — substitui o print do portal do Acronis: registra um
-- retrato dos alertas ativos no momento em que alguém aperta o botão no
-- fim do mês, prova permanente e consultável na própria plataforma.
CREATE TABLE IF NOT EXISTS acronis_arquivos_mensais (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  mes              TEXT NOT NULL, -- "AAAA-MM"
  atendente_id     INTEGER NOT NULL REFERENCES atendentes(id),
  total_alertas    INTEGER NOT NULL,
  alertas_snapshot TEXT NOT NULL, -- JSON com a lista completa de alertas ativos nesse momento
  gerado_em        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
