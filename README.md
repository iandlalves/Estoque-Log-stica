# Central de Infraestrutura — plataforma própria de service desk

Plataforma própria de service desk (sem depender do TomTicket): motor de
chamados — abertura, atribuição, mudança de status com histórico,
comentários, SLA calculado internamente e avaliação do cliente ao
finalizar — com estoque completo (itens, usados, movimentações — entrada/
saída de estoque e entrega/devolução de colaborador numa aba só —,
consultores, corporativos) e uma vitrine dos dados de host/usuário que o
projeto de mapeamento de AD já mantém atualizados — tudo com um site
próprio na frente (HTML/CSS/JS puro, sem framework nem build step,
reaproveitando a identidade visual do `Central-de-Infraestrutura.html`
original).

Essa versão já cobre tudo que o `Central-de-Infraestrutura.html` original
fazia, exceto a parte de SLA/avaliação puxada da API do TomTicket — que
foi substituída pelo motor de SLA/avaliação próprio deste site (a
integração com a API do TomTicket foi removida de propósito, ver decisão
abaixo). Dá pra considerar este site como o sucessor da ferramenta antiga
pra fase "só Infra".

**Instância só Estoque (2026-10-21).** Este repositório (Estoque-Log-stica)
é a cópia usada pela instância "Estoque Logística", de outro departamento:
mesmo código, com `APP_MODULOS=estoque` no `.env` — o menu e a API mostram
só Estoque (Dashboard, Descarte, Atualizar) e Cadastros. Roda no mesmo
servidor da Central em `https://dsp-lif.local:8443`, com banco, `.env`,
porta e serviço próprios. Instalação e deploy: `DEPLOY-LINUX.md`, seção 9.
Sem `APP_MODULOS`, o comportamento é o da Central completa.

## Requisitos

- **Node.js 22.5 ou mais recente.** O banco de dados usa o módulo
  `node:sqlite`, que vem embutido no próprio Node — não precisa instalar
  Postgres, nem compilar nada nativo, nem baixar binário de lugar nenhum.
  Isso foi escolha deliberada: tentamos usar o Prisma primeiro, mas ele
  precisa baixar um binário na primeira execução, e isso falhou num
  ambiente de rede restrita — `node:sqlite` evita esse problema porque já
  vem dentro do Node.
  - Verifique sua versão com `node -v`. Se for menor que 22.5, baixe a
    versão mais recente em https://nodejs.org (a LTS já serve).
  - **Atenção:** o próprio Node.js ainda marca `node:sqlite` como
    "experimental" (aparece um aviso no console ao rodar — é esperado, não
    é erro). Funciona bem pra essa fase inicial; quando o projeto crescer
    pra além da equipe de Infra, vale reavaliar (trocar por Postgres, que
    já era o plano pra fase "empresa inteira" de qualquer forma).

## Como rodar (Windows, primeira vez)

```powershell
cd caminho\para\central-infra-app
npm install
copy .env.example .env      REM se não tiver um .env ainda
npm run seed                 REM popula departamento/categorias/SLA de exemplo
npm run dev                   REM sobe o servidor com reinício automático ao salvar
```

O servidor sobe em `http://localhost:3000` — **abra isso no navegador pra
ver o site** (lista de chamados, abrir chamado, cadastros). A API pura
fica em `http://localhost:3000/api/...`; teste rápido:
`http://localhost:3000/api/saude` deve responder `{"ok":true, ...}`.

Nas próximas vezes, só `npm run dev` (ou `npm start` pra rodar sem
reinício automático, mais parecido com produção).

## Login com Microsoft

Todo o site (menos `/api/saude` e a tela de login em si) exige sessão
autenticada. O login **não é mais por senha** — é "Entrar com Microsoft"
(OIDC/Entra ID, biblioteca oficial `@azure/msal-node`). Login por senha foi
removido de propósito (era o plano original documentado aqui desde o
início — ver decisão abaixo).

**Como funciona:** a pessoa clica "Entrar com Microsoft", loga com a conta
Microsoft 365 da empresa (senha + MFA dela, como já faz pro Outlook/Teams),
e o Entra ID confirma a identidade pro site. **Isso só autentica — não dá
acesso sozinho.** O email da conta Microsoft precisa já bater com um
atendente cadastrado em **Cadastros → Atendentes**; sem isso, o login na
Microsoft funciona, mas o site recusa a sessão com uma mensagem clara.
Ninguém novo vira atendente sozinho só por logar.

**Configuração** (ver `.env.example`) — reaproveita o mesmo App
Registration já criado pro envio de email (`GRAPH_TENANT_ID`/
`GRAPH_CLIENT_ID`/`GRAPH_CLIENT_SECRET`), só precisa mais de
`APP_BASE_URL` (a URL HTTPS pela qual o site é acessado de verdade) e de
um Redirect URI cadastrado no App Registration:

1. No [Azure Portal](https://portal.azure.com) → Microsoft Entra ID → App
   registrations → o app já usado pro email → **Authentication** → **Add a
   platform** → **Web**.
2. Redirect URI: `https://<APP_BASE_URL>/api/auth/entra/callback` (ex.:
   `https://nsp-i25/api/auth/entra/callback`) → **Configure**/**Save**.
3. Defina `APP_BASE_URL=https://<mesmo host>` no `.env`.

**Exige HTTPS de verdade** — o Entra ID só aceita Redirect URI em HTTPS pra
qualquer host que não seja `localhost` (ver seção "HTTPS com Caddy" acima;
configure isso primeiro). Sem isso, só quem acessa direto do navegador
desta máquina (via `localhost`) conseguiria completar o login — ninguém
mais na rede.

A sessão dura 7 dias (cookie `HttpOnly`, `SameSite=Lax`, `Secure` com
`COOKIE_SECURE=true`), fica guardada numa tabela própria no banco
(`sessoes`) — "Sair" invalida a sessão de verdade no servidor, não só
apaga o cookie do navegador. Esse mecanismo de sessão não mudou; só trocou
quem valida a identidade antes de criar a sessão.

## Estrutura do projeto

```
central-infra-app/
  prisma/schema.sql      Schema completo do banco (SQL puro, comentado)
  src/lib/db.js          Abre o SQLite e aplica o schema automaticamente
  src/lib/sla.js         Resolve a política de SLA e calcula os prazos
  src/lib/protocolo.js   Gera o número de protocolo (AAAA-NNNNNN)
  src/lib/auth.js         Sessão (cookie + tabela sessoes), middleware exigirLogin
  src/lib/authEntra.js    Login "Entrar com Microsoft" (OIDC/MSAL) — gera a URL de login e troca o código pela conta autenticada
  src/lib/estoqueResumo.js Cálculo de saldo/status e do resumo/dashboard de estoque (compartilhado entre a API e o envio de email)
  src/lib/email.js         Envio de email via Microsoft Graph API (OAuth2/Entra ID) — usado pelo botão do dashboard e pelo envio semanal agendado
  src/routes/auth.js       Endpoints de login com Microsoft (início/callback), logout, sondagem de sessão
  src/routes/chamados.js Endpoints do motor de chamados
  src/routes/referencia.js Endpoints de cadastro (departamento, categoria, atendente, solicitante, SLA)
  src/server.js           Liga tudo, sobe o servidor Express e serve o front-end estático
  public/index.html       Estrutura da página + CSS embutido (identidade visual da Central de Infraestrutura)
  public/app.js            Toda a lógica do front-end: chama a API, monta o HTML das telas (inclui tela de login)
  src/routes/estoque.js     Endpoints do estoque (itens, usados, movimentações — entrada/saída/entrega/devolução —, equipamentos por usuário, colaboradores, termos, consultores, corporativos)
  src/lib/estoqueUsuarios.js Cálculo de "Equipamentos por usuário" a partir das linhas ENTREGA ainda não devolvidas em Movimentações
  src/lib/termoPdf.js       Gera o PDF do Termo de Responsabilidade e do Termo de Devolução (biblioteca `pdfkit`, sem passar por .docx/LibreOffice)
  src/routes/ad.js          Lê (só leitura) o .json exportado pelo mapeamento de AD
  src/routes/cpd.js         Endpoints do Checklist do CPD (catálogo de servidores, histórico, envio com foto)
  scripts/seed.js          Popula dados de referência mínimos pra testar
  scripts/importar-estoque.js Importa o estoque-dados.json da ferramenta antiga pro banco novo (roda uma vez)
  scripts/importar-checklist-cpd-historico.js Importa o histórico do Checklist do CPD vindo do Forms antigo (roda uma vez, idempotente)
  scripts/instalar-servico-windows.ps1   Registra o app como Serviço do Windows (via NSSM)
  scripts/desinstalar-servico-windows.ps1 Remove esse serviço (não apaga dados)
  scripts/instalar-caddy-servico-windows.ps1 Registra o Caddy (HTTPS) como Serviço do Windows
  scripts/backup.js         Gera uma cópia consistente do banco (VACUUM INTO) e limpa backups antigos
  scripts/instalar-backup-agendado-windows.ps1 Agenda o backup.js pra rodar todo dia (Agendador de Tarefas)
  scripts/desinstalar-backup-agendado-windows.ps1 Remove essa tarefa agendada
  scripts/restaurar-backup-windows.ps1 Restaura o banco a partir de um arquivo de backup
  scripts/enviar-resumo-estoque.js Calcula o resumo de estoque e envia por email (mesmo código do botão do dashboard)
  scripts/instalar-resumo-estoque-agendado-windows.ps1 Agenda o envio semanal do resumo de estoque (Agendador de Tarefas)
  scripts/desinstalar-resumo-estoque-agendado-windows.ps1 Remove essa tarefa agendada
  deploy/Caddyfile         Configuração do Caddy (reverse proxy + HTTPS automático)
  dados/                   Onde o arquivo .db fica (criado automaticamente, não versionar no Git)
  dados/backups/            Backups gerados por scripts/backup.js (local, por padrão)
  dados/cpd-fotos/          Fotos enviadas no Checklist do CPD (nome gerado, não o original)
  logs/                    Logs dos serviços do Windows (criado pelos scripts de instalação)
```

## O front-end

Uma página só (`public/index.html` + `public/app.js`), sem React/Vue nem
build step — o mesmo estilo do `Central-de-Infraestrutura.html` original,
só que em vez de ler arquivo local via File System Access API, ele
conversa com a API por `fetch()`. O próprio servidor Express serve esses
arquivos estáticos (`express.static`), então front e back sobem juntos, na
mesma porta — não tem CORS pra configurar nem processo separado pra
gerenciar.

Telas disponíveis: **Chamados** (lista com filtro por status/departamento/
categoria/atendente/busca, paginação), **Abrir chamado** (formulário),
**detalhe do chamado** (clique numa linha da lista — histórico de status,
comentários, atribuir atendente, mudar status, avaliar depois de
finalizado, badges de SLA cumprido/violado/atrasado), **Estoque** (8
sub-abas — ver seção própria abaixo), **Usuários & Hosts** (dados do AD,
só leitura — ver seção própria abaixo), e **Cadastros** (departamento,
categoria, atendente, política de SLA — só criar, sem excluir, pra nunca
quebrar um chamado antigo que já referencia esses dados).

Testado de ponta a ponta com Playwright/Chromium na versão original (login
por senha): o fluxo completo pela interface (login → abrir → atribuir →
atender → comentar → finalizar → avaliar → conferir na lista → sair), os
filtros, o estoque (todas as 7 sub-abas navegadas, item novo criado
automaticamente ao registrar uma movimentação, saldo calculado conferido
contra o valor esperado), a tela de Usuários & Hosts (filtro por
departamento), e testes específicos de texto com aspas/apóstrofo/tentativa
de injeção de HTML (no assunto/descrição do chamado E no nome de item de
estoque, pra não repetir o mesmo tipo de bug que já mordeu o app antigo) —
tudo renderizou como texto puro, sem quebrar a página e sem executar nada,
zero erro inesperado no console. O login foi trocado depois pra "Entrar
com Microsoft" (ver seção "Login com Microsoft") — esse fluxo específico
foi validado manualmente (não dá pra automatizar com Playwright sem expor
credencial real da Microsoft), o resto da interface não foi afetado.

## Rotas da API (resumo)

| Método | Rota | O que faz |
|---|---|---|
| GET | `/api/saude` | Ping — confirma que o servidor está de pé (não exige login) |
| GET | `/api/auth/entra/login` | Redireciona pro login da Microsoft (não exige login) |
| GET | `/api/auth/entra/callback` | Volta do login da Microsoft — grava sessão, define cookie (não exige login) |
| POST | `/api/auth/logout` | Sair — invalida a sessão no servidor e limpa o cookie |
| GET | `/api/auth/eu` | Sonda se há sessão válida — sempre 200, `{logado:false}` ou `{logado:true,...}` (não exige login) |
| GET/POST | `/api/departamentos` | Listar / criar departamento |
| GET/POST | `/api/categorias` | Listar (filtra por `?departamentoId=`) / criar categoria |
| GET/POST | `/api/atendentes` | Listar / criar atendente |
| GET/POST | `/api/solicitantes` | Listar / criar (ou reaproveitar por email) solicitante |
| GET/POST | `/api/sla-politicas` | Listar / criar política de prazo de SLA |
| POST | `/api/chamados` | Abrir chamado |
| GET | `/api/chamados` | Listar/filtrar (status, departamentoId, categoriaId, atendenteId, de, ate, busca, page, pageSize) |
| GET | `/api/chamados/:id` | Ver um chamado completo (com histórico, comentários, avaliação) |
| PATCH | `/api/chamados/:id/atribuir` | Atribuir/trocar atendente responsável |
| PATCH | `/api/chamados/:id/status` | Mudar status (grava no histórico, calcula marcos de SLA) |
| POST | `/api/chamados/:id/comentarios` | Adicionar comentário |
| POST | `/api/chamados/:id/avaliacao` | Registrar avaliação (só chamado finalizado, uma por chamado) |
| GET/POST/PATCH/DELETE | `/api/estoque/itens` (`/:id`) | Catálogo de itens — GET devolve saldo/status já calculados |
| GET/POST/DELETE | `/api/estoque/usados` (`/:id`) | Itens usados/danificados/condenados |
| GET/POST/DELETE | `/api/estoque/movimentacoes` (`/:id`) | Ledger único: entrada/saída de estoque + entrega/devolução de colaborador (`tipo`: ENTRADA/SAIDA/ENTREGA/DEVOLUCAO_COLABORADOR) |
| POST | `/api/estoque/movimentacoes/:id/devolver` | Fecha uma linha ENTREGA específica (por ID): marca devolvida e já cria a linha DEVOLUCAO_COLABORADOR correspondente |
| GET | `/api/estoque/equipamentos-por-usuario` | O que cada pessoa tem em mãos agora (linhas ENTREGA ainda não devolvidas, agrupadas) |
| GET/POST/PATCH/DELETE | `/api/estoque/colaboradores` (`/:id`) | Dados de identidade (CPF, nacionalidade etc.) usados pra gerar o Termo |
| GET/POST/DELETE | `/api/estoque/termos` (`/:id`) | Gera/lista termos de responsabilidade (PDF) |
| GET | `/api/estoque/termos/:id/arquivo` | Baixa o arquivo de um termo já gerado (PDF nos novos; .docx nos gerados antes da migração) |
| GET/POST/DELETE | `/api/estoque/consultores` (`/:id`) | Celular/tablet corporativo de consultores externos |
| GET/POST/DELETE | `/api/estoque/corporativos` (`/:id`) | Linha/aparelho corporativo por departamento |
| GET | `/api/ad/usuarios` | Só leitura — lê o .json que o mapeamento de AD já exporta (ver seção própria) |
| GET | `/api/cpd/servidores` | Catálogo de servidores marcáveis no checklist |
| GET | `/api/cpd/resumo` | Dashboard — % da meta cumprida no mês, alertas, comentários recentes |
| GET | `/api/cpd/checklist` | Histórico de rodadas do Checklist do CPD |
| GET | `/api/cpd/checklist/hoje` | Sondagem — checklist de hoje já foi feito? |
| GET | `/api/cpd/checklist/:id` | Detalhe de uma rodada (comentários, servidores marcados) |
| POST | `/api/cpd/checklist` | Registra uma rodada (`multipart/form-data`, foto obrigatória) |
| GET | `/api/cpd/checklist/:id/foto` | Serve a foto de uma rodada (404 se for registro migrado sem arquivo local) |

Todos os corpos de requisição são JSON, exceto o `POST /api/cpd/checklist`
(envia a foto, então é `multipart/form-data`). Exemplo de abertura de
chamado:

```json
POST /api/chamados
{
  "assunto": "Notebook não liga",
  "descricao": "Notebook do usuário João não liga desde ontem.",
  "departamentoId": 1,
  "categoriaId": 2,
  "prioridade": "alta",
  "solicitante": { "nome": "João da Silva", "email": "joao.silva@empresa.local" }
}
```

Fluxo de status: `aberto` → `em_atendimento` ⇄ `aguardando_cliente` →
`finalizado` ou `cancelado`. `finalizado`/`cancelado` são estados finais —
depois disso não dá mais pra mudar o status daquele chamado (abra um novo
se precisar reabrir).

Todas as rotas acima (menos as três de `/api/auth` e `/api/saude`) exigem
cookie de sessão válido — sem ele, respondem `401`. Quem fez o comentário
ou mudou o status é sempre o atendente da sessão autenticada, nunca um
campo que vem do corpo da requisição (evita alguém se passar por outra
pessoa mandando um `atendenteId` diferente do seu).

## Estoque

Migrado da ferramenta antiga (`Central-de-Infraestrutura.html` /
`Controle-de-Estoque.html`, que guardava tudo num arquivo `.json` local
via File System Access API). Abas atuais (reorganizadas em 2026-10-05):
**Dashboard** (cards + uma tabela única com todos os itens do catálogo, com
saldo e status "OK"/"Comprar" calculados a partir do histórico de
movimentações, como a ferramenta antiga fazia — item novo numa movimentação
entra sozinho no catálogo; linha amarela = itens-chave: headset, notebook,
desktop, monitor, teclado, mouse, celular, tablet, câmera 4K; substitui as
antigas abas Itens e as tabelas "Itens importantes"/"precisando comprar"),
**Descarte** (ex-Usados: danificados/condenados), **Atualizar**
(ex-Movimentações: ledger único de entrada/saída de estoque,
entrega/devolução de colaborador e empréstimo "home office", ver abaixo),
**Termos** (busca de colaborador → equipamentos em mãos + termos da pessoa,
geração do Termo de Responsabilidade/Devolução, botão "Enviar termo
assinado" (reconhece o colaborador pelo nome do arquivo, ou já vem escolhido
quando clicado no cartão do colaborador; depois pergunta quais equipamentos
o papel cobre — responsabilidade marca o ✓ de termo, devolução dá baixa nos
equipamentos marcados; com Tesseract instalado no servidor — ver
DEPLOY-LINUX.md, seção 8 — ele ainda lê o documento e sugere tipo, pessoa e
equipamentos), lista de
"Colaboradores sem termo assinado" e um "Histórico" pesquisável com os termos
de quem está em arquivo morto + os gerados pela plataforma — nada é listado
sem pesquisa) e **Equipamentos móveis** (ex-Consultores + Corporativos:
colaboradores externos e, abaixo, as linhas/aparelhos corporativos).

**Movimentações — entrada/saída de estoque e entrega/devolução de
colaborador.** Uma linha `tipo: 'ENTRADA'` ou `'SAIDA'` é um movimento
genérico de estoque, sem pessoa. Uma linha `tipo: 'ENTREGA'` é um
equipamento entregue a um colaborador — tem `usuario`, `host`,
`departamento`, `modelo` (ex.: "Dell Pro 14"), `st` (service tag/nº de
série) e `termo`; os três primeiros alimentam a tabela do Termo de
Responsabilidade. Quando o equipamento volta pra empresa, use o botão
**"Registrar devolução"** na própria linha da entrega (em vez de excluir a
linha ou lançar uma movimentação solta): isso marca aquela entrega
específica como devolvida E já cria a linha `tipo: 'DEVOLUCAO_COLABORADOR'`
correspondente, na mesma ação — o vínculo é sempre por ID, nunca por nome
digitado (ver POST `/api/estoque/movimentacoes/:id/devolver` em
`src/routes/estoque.js`). "Devolução de colaborador" não é um tipo
escolhível no formulário de propósito, só criado por esse botão. O tipo
legado `'DEVOLUÇÃO'` (com acento, sem pessoa) continua existindo em linhas
antigas, mas o formulário não cria mais linhas novas com esse valor.

**Equipamentos por usuário** substituiu a antiga aba Hosts (que tinha
virado uma cópia da tela "Usuários & Hosts", redundante). Agrupa por
pessoa todas as linhas ENTREGA ainda **não devolvidas** — soma sozinho
quando uma entrega nova é registrada, subtrai sozinho quando alguém clica
"Registrar devolução". Ver `src/lib/estoqueUsuarios.js`.

**Termos.** Gera o Termo de Responsabilidade (PDF, único modelo — o mesmo
enviado pela empresa) pra um colaborador, preenchendo automaticamente a
tabela de equipamentos a partir de Equipamentos por usuário; ou o Termo de
Devolução de Equipamentos (PDF, modelo diferente, usado no desligamento —
fecha em lote todas as entregas em aberto do colaborador). Como CPF,
nacionalidade, estado civil, endereço e cargo não existem em nenhuma outra
tabela do site (não são coletados pelo mapeamento de AD), cadastre isso
uma vez por colaborador nesta mesma aba — fica salvo e é reaproveitado em
termos futuros da mesma pessoa (ex.: reposição de equipamento). Cada termo
gerado fica disponível pra baixar (PDF) e guarda um retrato dos
equipamentos daquele momento (`itens_snapshot`), que não muda
retroativamente se as entregas mudarem depois. Ver `src/lib/termoPdf.js`
(usa a biblioteca `pdfkit`, sem depender de LibreOffice/conversão externa;
a logo real da empresa fica em `src/lib/assets/telehelp-logo.png`).

**Trazendo os dados que já existiam.** Se você já usava a ferramenta
antiga, importe o `estoque-dados.json` que ela exporta pro banco novo
(idempotente — pode rodar de novo sem duplicar nada):
```powershell
node scripts/importar-estoque.js "C:\caminho\para\estoque-dados.json"
```
Depois disso o estoque passa a viver só neste site — pode aposentar a
aba de estoque da ferramenta antiga.

**Dashboard.** Primeira aba de Estoque — totais (itens no catálogo,
movimentações no mês, entregas, usados, consultores, corporativos) e a
lista de itens com saldo abaixo do mínimo ("precisando comprar"), com um
botão pra disparar o email de resumo na hora. Ver "Email do estoque"
abaixo.

**Itens é só leitura.** A aba **Itens** mostra saldo/status calculados a
partir das movimentações, mas não dá pra criar/editar/excluir item por
ali — itens aparecem sozinhos quando usados numa movimentação pela
primeira vez (mesmo comportamento de sempre, `auto: true`). Pra ajustar o
**mínimo** de um item (usado no cálculo "Comprar") ou aplicar um
**status manual** (ex.: "Fora de mercado"), use a tela **Cadastros** —
tem uma tabela própria pra isso lá embaixo.

**Filtro por coluna.** As sub-abas de Estoque em formato de tabela têm uma linha de filtro
abaixo do cabeçalho — filtra por texto em cada coluna, 100% no navegador
(sem nova chamada à API a cada tecla digitada).

## Email do estoque

O dashboard de Estoque tem um botão **"Enviar resumo por email agora"** —
manda um email (texto e HTML, pra `MAIL_TO`) com os totais, os itens
importantes (acompanhamento permanente) e a lista de itens abaixo do
mínimo.

Além do botão manual, existem **dois envios automáticos** (Tarefa Agendada
do Windows, um para cada script):
- **Resumo de estoque** (`scripts/enviar-resumo-estoque.js`) — toda
  sexta-feira e todo fim útil de mês, às 17h, pra `rodrigo.orsoni@telehelp.com.br`
  com `suporte@telehelp.com.br` em cópia (endereços padrão do script;
  configuráveis via `RESUMO_ESTOQUE_TO`/`RESUMO_ESTOQUE_CC` no `.env`).
- **Lembrete de bater o estoque** (`scripts/enviar-lembrete-estoque.js`) —
  toda sexta-feira de manhã (8h), um email simples só pra
  `ian.alves@telehelp.com.br` e `lauan.silva@telehelp.com.br` (padrão;
  configurável via `LEMBRETE_ESTOQUE_TO`), lembrando de bater o estoque
  antes do resumo da tarde sair.

O Agendador de Tarefas do Windows não tem um gatilho nativo de "último dia
útil do mês" — por isso as duas tarefas rodam **todo dia** (no horário
configurado) e é o próprio script que decide se hoje é dia de enviar (ver
`src/lib/diasUteis.js`); nos outros dias ele roda e não faz nada.

**Por que Microsoft Graph API em vez de SMTP.** O tenant Microsoft 365
desta empresa não libera "senha de app" pra contas (Conditional
Access/Security Defaults bloqueiam autenticação legada — confirmado: a
tela "Adicionar um método de entrada" em
[mysignins.microsoft.com/security-info](https://mysignins.microsoft.com/security-info)
nem mostra a opção). Então SMTP AUTH com usuário/senha não é viável aqui.
O envio usa a Graph API com OAuth2 (client credentials) — autentica com
um `client_id`/`client_secret` de um **App Registration** no Entra ID, sem
senha de mailbox nenhuma envolvida.

**Criar o App Registration** (precisa de alguém com permissão de
administrador no Azure/Entra ID — mesma exigência já anotada mais abaixo
pra SSO):
1. [portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID** →
   **App registrations** → **New registration**. Nome (ex.: "Central
   Infraestrutura - Envio de Email"), tipo de conta "Single tenant". Criar.
2. Na página **Overview** que abre, copie **Application (client) ID** e
   **Directory (tenant) ID** — vão virar `GRAPH_CLIENT_ID` e
   `GRAPH_TENANT_ID`.
3. **Certificates & secrets** → **New client secret** → dê uma descrição e
   escolha uma validade → **Add**. Copie o **Value** na hora (some depois
   de sair da página) — vira `GRAPH_CLIENT_SECRET`.
4. **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Application permissions** (não "Delegated") → busque `Mail.Send` →
   **Add permissions**.
5. Ainda em API permissions, clique **Grant admin consent for
   [nome da empresa]** (só um Global Admin ou Privileged Role
   Administrator consegue clicar isso) — sem esse consentimento o envio
   falha com erro de permissão.

Preencha no `.env` (exemplo em `.env.example`):
```
MAIL_TO=suporte@telehelp.com.br
MAIL_FROM=caixa-que-envia@empresa.com
GRAPH_TENANT_ID=...
GRAPH_CLIENT_ID=...
GRAPH_CLIENT_SECRET=...
```
`MAIL_FROM` precisa ser uma caixa de email real do tenant (a Graph API
envia "como" essa caixa) — `MAIL_TO` aceita mais de um email, separados
por vírgula.

**Sobre o alcance da permissão:** `Mail.Send` (aplicativo) por padrão deixa
esse App Registration mandar email como *qualquer* caixa do tenant, não só
a de `MAIL_FROM` — pra restringir isso a uma caixa específica, um admin
pode criar uma [Application Access
Policy](https://learn.microsoft.com/pt-br/graph/auth-limit-mailbox-access)
no Exchange Online (`New-ApplicationAccessPolicy`, via PowerShell). Não é
obrigatório pra funcionar, mas é uma boa prática de segurança — fica como
melhoria futura, na mesma linha do que já é feito no time.

Testar manualmente — por padrão os dois scripts só enviam de fato no dia
certo (sexta-feira / fim útil de mês); pra forçar o envio na hora
independente do dia (útil pra testar), use `--forcar`:
```powershell
npm run resumo-estoque -- --forcar
npm run lembrete-estoque -- --forcar
```
Sem `GRAPH_TENANT_ID`/`GRAPH_CLIENT_ID`/`GRAPH_CLIENT_SECRET`/`MAIL_FROM`
configurados, tanto o botão do dashboard quanto esses comandos falham com
uma mensagem clara dizendo o que falta — não travam nem mandam nada pela
metade.

Agendar os dois envios automáticos (Agendador de Tarefas do Windows, igual
ao backup — nada externo pra baixar):
```powershell
# Abra o PowerShell como Administrador
cd caminho\para\central-infra-app
.\scripts\instalar-resumo-estoque-agendado-windows.ps1
.\scripts\instalar-lembrete-estoque-agendado-windows.ps1
# ou escolhendo outro horário:
.\scripts\instalar-resumo-estoque-agendado-windows.ps1 -Horario "17:00"
.\scripts\instalar-lembrete-estoque-agendado-windows.ps1 -Horario "08:00"
```
Pra remover uma das duas: `.\scripts\desinstalar-resumo-estoque-agendado-windows.ps1 -NomeTarefa "<nome da tarefa>"`
(nomes padrão: "CentralInfraestrutura - Resumo semanal de estoque" e
"CentralInfraestrutura - Lembrete de bater o estoque").

## Colaboradores — dados do AD (sub-aba "Usuários & Hosts")

Essa sub-aba é **só leitura**, de propósito. Quem *grava* host, service
tag, IP, sistema operacional e último login de cada usuário é o projeto
separado de mapeamento de AD (GPO + script de logon, gravando em
`msDS-cloudExtensionAttribute1-5` nas propriedades do usuário no AD) —
esse projeto continua rodando em produção, cobrindo o domínio inteiro.

Até 2026-09-17 este site lia um `Mapeamento-AD-Dados.json` que esse
projeto exportava periodicamente — funcionava no Windows, mas deixava o
servidor Linux de produção dependente daquele PC específico estar de pé
gerando o arquivo (e nada garantia isso). Trocado (2026-09-18) por
**consulta LDAP direta** ao Active Directory (`src/lib/ldap.js`) — o
servidor passa a ler os mesmos atributos direto da fonte, sem depender de
nenhuma outra máquina, só do controlador de domínio (infraestrutura
central, não um PC de alguém).

Configure no `.env` (conta de bind **só leitura** — nunca de escrita):
```
LDAP_URL=ldap://dc01.telehelp.local
LDAP_BIND_DN=CN=svc-central-infra,OU=ServiceAccounts,DC=telehelp,DC=local
LDAP_BIND_PASSWORD=...
LDAP_BASE_DN=DC=telehelp,DC=local
```
Sem essas variáveis, a tela mostra um aviso claro (501) em vez de quebrar.
Mapeamento assumido pros 5 atributos customizados, na mesma ordem que já
valia no `.json` antigo — **confira contra um usuário real** na primeira
consulta, e ajuste `ATRIBUTOS`/os índices em `src/lib/ldap.js` se a ordem
não bater:
`cloudExtensionAttribute1`→host, `2`→service tag, `3`→IP, `4`→SO,
`5`→último login.

## Colaboradores — Onboarding de acessos

Sub-abas "Cargos", "Sistemas" e "Onboarding de acessos" (2026-09-18) —
**só papel `atendente`** vê/usa (nem Líder nem Gestor, decisão explícita:
é o dado mais sensível da plataforma). Catálogo de quais sistemas cada
cargo precisa, credenciais provisionadas por colaborador (senha sempre
**cifrada em repouso**, nunca em texto puro — ver
`src/lib/credenciaisCrypto.js`), geração da Ficha de Acessos em PDF e
botão de e-mail de boas-vindas (ficha + os dois passo a passo — assinatura
sempre, TomTicket só quando o cargo tiver acesso direto marcado).

Precisa de `CREDENCIAIS_ENC_KEY` no `.env` — 32 bytes em hex, gerada uma
vez com:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
**Guarde essa chave em lugar seguro** — perdê-la ou trocá-la sem migrar as
linhas já salvas torna toda senha já cadastrada irrecuperável.

Os dois documentos anexados ao e-mail (passo a passo de assinatura e de
TomTicket) não vêm com o deploy — sobem pela própria tela ("Colaboradores
→ Onboarding de acessos → Enviar/substituir"), ficam salvos em
`dados/onboarding-docs/` no servidor.

## Checklist do CPD

Inspeção física diária do CPD (sala de servidores) — migrado de um
formulário Microsoft Forms que a equipe já usava. **Meta: todo dia útil**
(combinado com o time). Diferente do Estoque (que guarda "estado atual"),
aqui **cada envio vira um registro novo no histórico** — dá pra consultar
rodadas passadas, não só a mais recente.

Tela tem três abas:
- **Dashboard** — quanto da meta "todo dia útil" foi cumprida no mês
  selecionado (seletor de mês no topo — padrão o corrente, mas dá pra ver
  qualquer mês passado com a mesma visão agregada; dias úteis com checklist
  ÷ dias úteis do período, calculado seg-sex, sem calendário de feriados),
  quais dias úteis ficaram sem checklist, contagem de respostas "Não" no
  mês, e um feed dos **comentários mais recentes** (de qualquer mês, não só
  o selecionado) — na prática é ali que mora o sinal de verdade sobre a
  saúde do CPD (ex.: "temperatura elevada no rack", anotado mesmo quando a
  pergunta em si foi respondida "Sim"), mais do que o Sim/Não sozinho.
- **Novo checklist** — formulário com as 3 perguntas Sim/Não do formulário
  original (servidores, receptoras, ar-condicionado — cada uma com campo
  de comentário livre), a lista de servidores marcáveis (catálogo em
  `cpd_servidores`, ver abaixo), data do registro e **foto obrigatória**.
  Mostra um aviso se o checklist de hoje ainda não foi feito.
- **Histórico** — todas as rodadas já registradas (lista enxuta: data,
  quem fez, Sim/Não de cada pergunta), com filtro por coluna (mesmo
  mecanismo do Estoque). Clique numa linha pra ver o detalhe completo
  (comentários, servidores marcados, foto em tamanho real) — cada categoria
  tem um botão **"Abrir chamado na T1"**, que manda um email pro Targetway
  (`TARGETWAY_EMAIL_TO` no `.env`) na aposta de que isso cria um chamado lá
  (não confirmado ainda que funcione — o botão sempre oferece o link do
  portal em seguida, pra conferir manualmente).

**Lembrete automático.** `scripts/enviar-lembrete-cpd.js`, agendado todo dia
às 17h (mesmo esquema do lembrete de estoque — ver "Email do estoque"
abaixo) — só envia de fato se hoje for dia útil E o checklist do dia ainda
não tiver sido feito. Destinatário padrão embutido no script
(`LEMBRETE_CPD_TO` no `.env` pra trocar sem editar código).

A foto fica salva em `dados/cpd-fotos/`, com um nome gerado (nunca o nome
original do upload) — só aceita imagem (JPEG/PNG/WEBP/GIF/HEIC), até 15MB.
Quem preencheu é sempre o atendente da sessão logada, nunca um campo vindo
do formulário (mesmo cuidado já usado em comentário/mudança de status de
chamado).

**Catálogo de servidores** (`cpd_servidores`, "só criar" como
departamento/categoria) ainda não tem tela própria em Cadastros — hoje é
populado pelo `scripts/seed.js` (lista inicial) e cresce sozinho quando o
histórico antigo é importado (servidor com nome novo vira uma linha
inativa automaticamente, ver abaixo). Servidor `ativo = 0` não aparece na
lista de "Novo checklist", mas continua valendo pra registros antigos que
já o referenciam.

**Importando o histórico do Forms antigo.** Se a equipe já preenchia isso
num Microsoft Forms, dá pra trazer as respostas antigas pro histórico
daqui:
1. No Forms, abra as respostas → **Abrir no Excel** (baixa um `.xlsx`).
2. Converta esse `.xlsx` num `.json` limpo — não existe um script pronto
   pra isso no projeto (evita adicionar uma dependência só pra um import
   de uma vez só); foi feito manualmente lendo o `.xlsx` com uma
   biblioteca à parte e escrevendo um array de objetos com os campos que
   `importar-checklist-cpd-historico.js` espera (`dataRegistro`,
   `criadoEm`, `servidoresVerificado`, `servidoresComentario`,
   `servidoresLista`, `receptorasVerificado`, `receptorasComentario`,
   `arCondicionadoVerificado`, `arCondicionadoComentario`,
   `fotoUrlExterna`).
3. `node scripts/importar-checklist-cpd-historico.js caminho\pro\historico.json "email@do-atendente"`
   — idempotente (pula datas que já existem pra aquele atendente, não
   duplica se rodar de novo). Servidor mencionado no histórico que ainda
   não está no catálogo entra automaticamente como inativo.

**Sobre as fotos do histórico importado:** o Forms antigo guarda o upload
num SharePoint (`*.sharepoint.com`) que exige login da Microsoft pra
abrir — não dá pra baixar em lote sem essa autenticação. Por isso
`foto_arquivo` é opcional no banco (só a foto tirada aqui pelo site fica
local); um registro migrado guarda o link original em `foto_url_externa`,
e a tela mostra um botão "Abrir foto original no SharePoint" em vez da
imagem embutida.

## Integração com Teams

Abrir chamado direto do Microsoft Teams — pedido explícito (2026-09-01),
testando primeiro a via mais simples: **Power Automate**, sem bot próprio
no Teams (isso ficaria pra uma segunda fase, se essa via não bastar — bot
de verdade via Bot Framework + Azure Bot Service, mais trabalho de
configurar). Também **não** depende do TomTicket — os chamados criados por
aqui vão direto pro motor de chamados desta própria plataforma (que já foi
construído justamente pra não depender dele, ver comentário no topo de
`src/routes/chamados.js`).

**Como funciona:** um Fluxo do Power Automate no tenant da empresa mostra
um Cartão Adaptável no Teams pra quem quer abrir um chamado, e — quando a
pessoa preenche e envia — chama a API desta plataforma (uma ação HTTP no
próprio Fluxo) pra criar o chamado de verdade.

### 1. No servidor: gerar e configurar a chave de API

A rota que o Power Automate chama (`POST /api/integracoes/teams/chamados`)
fica **fora do login normal** (não tem sessão de navegador vinda do Teams)
— protegida por uma chave própria, simples de trocar se vazar (não mexe em
login de ninguém). Gere uma chave forte e configure no `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

```
TEAMS_INTEGRACAO_API_KEY=<chave gerada>
```

Reinicie o serviço depois de definir. Sem essa variável, a rota responde
`503` (desligada de propósito, não um "aceita qualquer coisa").

### 2. Descobrir os IDs de departamento/categoria

O Cartão Adaptável (abaixo) tem os IDs de departamento/categoria fixos nas
opções — confira quais existem no seu banco antes de montar o Fluxo:

```powershell
# Exemplo local — no servidor, troque o caminho do banco se for diferente
node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('dados/central-infraestrutura.db',{readOnly:true}); console.log(db.prepare('SELECT id,nome FROM departamentos').all()); console.log(db.prepare('SELECT id,nome,departamento_id FROM categorias').all());"
```

### 3. Montar o Fluxo no Power Automate

Passo a passo confirmado na documentação oficial da Microsoft ([Create
flows that post adaptive cards to Microsoft
Teams](https://learn.microsoft.com/en-us/power-automate/create-adaptive-cards))
— **não existe gatilho de "comando de barra" pronto** pra isso (isso exige
registrar um app de verdade no Teams, é o caminho do bot, ver "Se isso não
bastar" no fim desta seção). O caminho simples usa **"Acionado
manualmente"** + a ação de cartão:

1. [make.powerautomate.com](https://make.powerautomate.com) → **Meus
   fluxos** → **Novo fluxo** → **Fluxo de nuvem instantâneo**.
2. Dê um nome, escolha o gatilho **"Acionar um fluxo manualmente"**
   ("Manually trigger a flow") → **Criar**.
3. **Nova etapa** → procure **Microsoft Teams** → escolha a ação **"Postar
   um cartão adaptável num canal do Teams e aguardar por uma resposta"**
   ("Post an adaptive card to a Teams channel and wait for a response").
4. Escolha a **Equipe** e o **Canal** onde o cartão vai aparecer (é ali que
   as pessoas vão clicar pra abrir um chamado — precisa do app
   **Workflows** instalado nesse Teams, geralmente já vem por padrão).
5. Em **Cartão Adaptável**, cole o JSON abaixo (troque os `"value"` dos
   departamentos/categorias pelos IDs reais do passo 2):

```json
{
  "type": "AdaptiveCard",
  "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
  "version": "1.4",
  "body": [
    { "type": "TextBlock", "text": "Abrir chamado — Central de Infraestrutura", "weight": "bolder", "size": "medium" },
    { "type": "Input.Text", "id": "assunto", "label": "Assunto", "isRequired": true, "errorMessage": "Informe o assunto" },
    { "type": "Input.Text", "id": "descricao", "label": "Descrição", "isMultiline": true, "isRequired": true, "errorMessage": "Informe a descrição" },
    {
      "type": "Input.ChoiceSet", "id": "departamentoId", "label": "Departamento", "isRequired": true, "errorMessage": "Escolha um departamento",
      "choices": [
        { "title": "Infraestrutura", "value": "1" }
      ]
    },
    {
      "type": "Input.ChoiceSet", "id": "categoriaId", "label": "Categoria", "isRequired": true, "errorMessage": "Escolha uma categoria",
      "choices": [
        { "title": "Acessos e Senhas", "value": "1" },
        { "title": "Configuração de equipamento", "value": "2" },
        { "title": "Internet e Navegação", "value": "4" },
        { "title": "Mudança de layout", "value": "6" },
        { "title": "Projetos", "value": "7" },
        { "title": "Solicitação de equipamento", "value": "8" },
        { "title": "Admissão", "value": "9" },
        { "title": "Envio de computador para Home Office", "value": "10" },
        { "title": "Sistemas e Programas", "value": "11" },
        { "title": "Telefonia", "value": "12" }
      ]
    },
    {
      "type": "Input.ChoiceSet", "id": "prioridade", "label": "Prioridade", "value": "normal",
      "choices": [
        { "title": "Baixa", "value": "baixa" },
        { "title": "Normal", "value": "normal" },
        { "title": "Alta", "value": "alta" },
        { "title": "Urgente", "value": "urgente" }
      ]
    }
  ],
  "actions": [
    { "type": "Action.Submit", "title": "Abrir chamado" }
  ]
}
```

6. Adicione uma ação **HTTP** (built-in, não precisa de conector especial):
   - **Método**: `POST`
   - **URI**: `https://dsp-lif.local/api/integracoes/teams/chamados` (troque
     pelo hostname/IP real do servidor)
   - **Cabeçalhos**: `Content-Type: application/json` e
     `X-Api-Key: <a mesma chave do passo 1>`
   - **Corpo** (use "Conteúdo Dinâmico" do Power Automate pra puxar cada
     campo da resposta do cartão, e as duas últimas linhas pra identificar
     quem está pedindo — variam conforme o gatilho escolhido; com
     "Acionado manualmente" dá pra pedir nome/email como parâmetros do
     próprio gatilho):
     ```json
     {
       "assunto": "@{outputs('Cart_o_Adapt_vel')?['body/data/assunto']}",
       "descricao": "@{outputs('Cart_o_Adapt_vel')?['body/data/descricao']}",
       "departamentoId": "@{outputs('Cart_o_Adapt_vel')?['body/data/departamentoId']}",
       "categoriaId": "@{outputs('Cart_o_Adapt_vel')?['body/data/categoriaId']}",
       "prioridade": "@{outputs('Cart_o_Adapt_vel')?['body/data/prioridade']}",
       "solicitanteNome": "@{triggerOutputs()?['body/from/name']}",
       "solicitanteEmail": "@{triggerOutputs()?['body/from/email']}"
     }
     ```
7. (Opcional) Adicione uma ação **Teams → "Postar uma mensagem num chat ou
   canal"** depois da HTTP, respondendo com o protocolo criado
   (`@{body('HTTP')?['protocolo']}`), pra quem abriu já ver a confirmação
   ali mesmo no Teams.

### Se isso não bastar

Um bot de verdade no Teams (comando de barra nativo, formulário dentro do
chat sem precisar do Power Automate no meio) precisa de um **Azure Bot**
registrado (tem custo pequeno) e do Bot Framework SDK integrado no
backend — mais infraestrutura, mas experiência melhor. Avalia depois de
testar o Power Automate — se atender, não vale a complexidade extra.

## O que já está pronto

- Motor de chamados completo (abertura, atribuição, mudança de status,
  comentários) com histórico de status gravado em cada mudança.
- SLA calculado internamente: política configurável por
  departamento+prioridade (ou departamento+categoria+prioridade, mais
  específica), prazo calculado no momento da abertura, e marcação
  automática de "cumpriu/não cumpriu" tanto pra primeira resposta quanto
  pra resolução.
- Avaliação do cliente (nota 1–5 + comentário opcional), só liberada depois
  do chamado finalizado.
- Front-end completo (lista/filtro, abrir chamado, detalhe com todas as
  ações, cadastros) — um site só, sem depender de arquivo local.
- **Login com Microsoft** (OIDC/Entra ID, via `@azure/msal-node`) — sem
  senha própria nenhuma no site. Sessão em cookie `HttpOnly`/`Secure`
  guardada no banco (tabela `sessoes`, pra "Sair" invalidar de verdade).
  Só quem já é atendente cadastrado (email batendo com a conta Microsoft)
  consegue entrar — login Microsoft não cria atendente novo sozinho. Todo
  o site e toda a API (menos login/saúde) exigem sessão válida; ações como
  comentário e mudança de status sempre usam o atendente da sessão, nunca
  um valor vindo do cliente. Ver seção "Login com Microsoft" acima.
- Testado de ponta a ponta pela API e pela interface (login → criar →
  atribuir → atender → comentar → finalizar → avaliar → conferir na lista
  → sair), incluindo os casos de erro (avaliar duas vezes, avaliar sem
  finalizar, mudar status de chamado já finalizado, acessar sem sessão) e
  um teste de texto com aspas/apóstrofo/tentativa de injeção de HTML.
- **Roda como Serviço do Windows** (via NSSM) — sobrevive a reinício da
  máquina e não precisa de ninguém logado. Ver seção abaixo.
- **HTTPS com Caddy** (obrigatório pro login Microsoft funcionar fora
  desta máquina) — configurado e rodando (`deploy/Caddyfile` +
  `scripts/instalar-caddy-servico-windows.ps1`), cookie de sessão com
  `Secure` ligado (`COOKIE_SECURE=true`). Ver seção "HTTPS com Caddy"
  abaixo.
- **Backup automático** do banco (`VACUUM INTO`, cópia consistente mesmo
  com o servidor rodando), agendável via Agendador de Tarefas do Windows,
  com retenção e restauração testável. Ver seção "Backup automático"
  abaixo.
- **Estoque completo** (itens com saldo/status calculado, usados,
  movimentações — entrada/saída de estoque e entrega/devolução de
  colaborador numa aba só —, equipamentos por usuário, termos de
  responsabilidade/devolução em PDF, consultores, corporativos), migrado
  da ferramenta antiga com script de importação. Ver seção "Estoque" acima.
- **Usuários & Hosts** — vitrine só leitura dos dados que o projeto de
  mapeamento de AD já mantém atualizados a cada 15 min. Ver seção
  "Usuários & Hosts (dados do AD)" acima.
- **Checklist do CPD** — inspeção física diária com histórico de cada
  rodada, migrado de um formulário Microsoft Forms. Ver seção "Checklist
  do CPD" acima.

## Rodar como Serviço do Windows

Rodar com `npm run dev`/`npm start` funciona pra testar, mas depende de
alguém deixar aquele PowerShell aberto. Um Serviço do Windows continua de
pé depois de reiniciar a máquina, sem sessão aberta — é o jeito certo pra
produção.

Passo a passo:

1. **Baixe o NSSM** (Non-Sucking Service Manager — ferramenta padrão pra
   isso, de terceiros, então baixe você mesmo em vez de deixar um script
   baixar sozinho): https://nssm.cc/download → baixe o `.zip`, extraia, e
   copie o `nssm.exe` (pasta `win64`) pra algum lugar fixo, tipo
   `C:\ferramentas\nssm.exe`.
2. **Rode `npm install` nesta pasta pelo menos uma vez** (se ainda não
   rodou).
3. **Abra um PowerShell como Administrador** (botão direito no ícone →
   "Executar como administrador") e rode:
   ```powershell
   cd caminho\para\central-infra-app
   .\scripts\instalar-servico-windows.ps1 -NssmPath "C:\ferramentas\nssm.exe"
   ```
   Isso registra o serviço `CentralInfraestrutura`, configura início
   automático, redireciona os logs pra `logs\servidor.log` e
   `logs\servidor-erro.log` (com rotação em 10MB), e já inicia o serviço.
4. Confirme abrindo `http://localhost:3000` no navegador.

Comandos úteis depois de instalado: `Get-Service CentralInfraestrutura`
(status), `nssm stop/start/restart CentralInfraestrutura`, ou pra remover
o serviço (sem apagar o banco nem os arquivos do projeto):
```powershell
.\scripts\desinstalar-servico-windows.ps1 -NssmPath "C:\ferramentas\nssm.exe"
```

## HTTPS com Caddy

**Já configurado e rodando nesta máquina** — o site é acessado em
`https://nsp-i25` (hostname da máquina, sem DNS interno configurado). O
Caddy fica na frente do Node, servindo HTTPS com certificado próprio
(gerado e renovado automaticamente por ele mesmo — não precisa de domínio
público nem de porta liberada pra internet). Isso passou de "melhoria
futura" pra obrigatório quando o login virou "Entrar com Microsoft" (ver
seção "Login com Microsoft" acima) — o Entra ID só aceita Redirect URI em
HTTPS pra qualquer host que não seja `localhost`.

Passo a passo (pra reinstalar nesta máquina ou configurar em outra):

1. **Baixe o Caddy**: https://caddyserver.com/download → escolha
   Windows/amd64 (não precisa marcar nenhum plugin extra), baixe o
   `caddy.exe` e copie pra um lugar fixo, tipo `C:\ferramentas\caddy.exe`.
2. **Edite `deploy\Caddyfile`** — primeira linha do bloco é o nome que sua
   equipe vai usar pra acessar o site (hoje `nsp-i25`, o hostname da
   própria máquina — `hostname` no PowerShell). Duas opções:
   - **Nome interno de DNS**: se sua empresa tem DNS interno (provável,
     já que vocês usam AD), peça pra criar um registro apontando esse
     nome pro IP desta máquina, e troque o hostname pelo nome de DNS.
   - **Sem mexer em DNS** (o que está configurado hoje): usa o hostname
     da própria máquina — cada pessoa acessa por `https://nsp-i25`. Só
     funciona bem numa rede onde a resolução de nome NetBIOS/mDNS já
     funciona entre as máquinas (normalmente funciona numa rede
     corporativa comum).
   - **Atenção com espaço no caminho**: se o `output file` do bloco `log`
     apontar pra um caminho com espaço (ex.: esta pasta,
     `...\Documents\Claude Code\logs\...`), precisa estar entre aspas —
     sem aspas o Caddy nem inicia (`wrong argument count` no log de erro).
3. **Abra um PowerShell como Administrador** e rode:
   ```powershell
   cd caminho\para\central-infra-app
   .\scripts\instalar-caddy-servico-windows.ps1 -CaddyPath "C:\ferramentas\caddy.exe" -NssmPath "C:\ferramentas\nssm.exe"
   ```
   Isso registra um segundo serviço (`CentralInfraestruturaCaddy`),
   apontando pro `deploy\Caddyfile`.
4. **Acesse `https://<o nome que você escolheu>`** — o Caddy usa uma CA
   própria (gerada localmente, não é Let's Encrypt), então o navegador vai
   mostrar um aviso de certificado não confiável no primeiro acesso de
   cada máquina. Pra não aparecer mais esse aviso pra ninguém da equipe,
   exporte o certificado raiz do Caddy (fica em
   `%LOCALAPPDATA%\Caddy\pki\authorities\local\root.crt` na máquina onde o
   Caddy roda) e importe ele em "Autoridades de Certificação Raiz
   Confiáveis" (`certmgr.msc`) em cada computador que for acessar o site —
   ou distribua via GPO, se a empresa já usa isso pra outras coisas.
5. **Só depois de confirmar que o HTTPS está funcionando**, ligue o
   `Secure` no cookie de sessão: edite o `.env` (crie a partir do
   `.env.example` se ainda não tiver), defina `COOKIE_SECURE=true`, e
   reinicie o serviço do site: `nssm restart CentralInfraestrutura`.
   **Não faça isso antes do passo 4** — sem HTTPS de verdade, o navegador
   ignora um cookie `Secure` e ninguém mais consegue logar.

Depois disso, o fluxo de acesso passa a ser `https://<nome>` (porta 443,
nem precisa aparecer na URL) em vez de `http://localhost:3000` — o Node
continua ouvindo só na 3000, agora só acessível pelo próprio Caddy.

## Backup automático

O banco inteiro é um arquivo só (`dados/central-infraestrutura.db`, mais
os arquivos `-wal`/`-shm` de apoio enquanto o servidor está rodando).
`scripts/backup.js` gera uma cópia consistente desse banco usando
`VACUUM INTO` do próprio SQLite — funciona com o site rodando, sem
precisar parar nada, e sem risco do tipo "copiei o arquivo no meio de uma
escrita e ele veio corrompido" (que é o problema de simplesmente copiar o
`.db` com o Explorador de Arquivos ou um `copy` enquanto o servidor está
de pé). O mesmo script já apaga sozinho os backups mais velhos que a
retenção configurada (30 dias por padrão).

Testar manualmente:
```powershell
npm run backup
# ou apontando pra outro lugar e outra retenção:
node scripts/backup.js "D:\Backups\CentralInfraestrutura" 60
```

Agendar pra rodar todo dia sozinho (Agendador de Tarefas do Windows, nada
externo pra baixar dessa vez):
```powershell
# Abra o PowerShell como Administrador
cd caminho\para\central-infra-app
.\scripts\instalar-backup-agendado-windows.ps1 -Horario "02:00"
```
Por padrão os backups ficam em `dados\backups`, **no mesmo disco do banco
original** — protege contra o banco corromper, mas não contra perda do
disco/máquina inteira. Se der, use `-BackupDir "D:\Backups\..."` (outro
disco, ou um compartilhamento de rede que já tenha backup próprio) — veja
`Get-Help .\scripts\instalar-backup-agendado-windows.ps1 -Full` pros
detalhes de cada parâmetro. Pra remover a tarefa:
`.\scripts\desinstalar-backup-agendado-windows.ps1`.

**Teste a restauração de vez em quando** — um backup que nunca foi
restaurado não é um backup em que dá pra confiar. Pra restaurar (para o
serviço, guarda uma cópia do banco atual por segurança, troca pelo
backup escolhido, reinicia o serviço):
```powershell
.\scripts\restaurar-backup-windows.ps1 -BackupFile "dados\backups\central-infraestrutura-20260826-020000.db" -NssmPath "C:\ferramentas\nssm.exe"
```

## Fase "só Infra": está tudo pronto

Todo o roadmap original da fase "só Infra" está feito: motor de chamados,
SLA e avaliação próprios, autenticação (login com Microsoft), estoque,
vitrine dos dados de AD, Serviço do Windows, HTTPS e backup automático. O
que resta é decisão de quando/como escalar pra fora da equipe de Infra —
ver abaixo.

## Mais pra frente (fase "empresa inteira") — decisões que faltam tomar

Este item ficou de fora **de propósito**: não é coisa que dá pra
simplesmente "codar até o fim" sem decisão e trabalho de migração que só
quem administra o banco/infra da empresa consegue planejar direito — não
é algo que se resolve de dentro deste projeto sozinho.

1. **Migrar SQLite → Postgres.** Só faz sentido quando o uso realmente
   crescer além da equipe de Infra (mais escrita concorrente do que o
   SQLite aguenta bem) — fazer essa migração agora, sem necessidade, é
   trabalho e risco à toa. O `schema.sql` já foi escrito pensando nisso
   (a maior parte é SQL padrão; os ajustes ficam em `AUTOINCREMENT` →
   `SERIAL`/`IDENTITY`, e `node:sqlite` → um driver de Postgres tipo
   `pg`). Quando esse dia chegar, é um projeto próprio de migração
   (script de ETL dos dados existentes + trocar `src/lib/db.js`), não uma
   troca de uma linha.

Isso segue exatamente a lista de "o que será necessário" que a gente
desenhou antes de começar a codar — a fase "só Infra" está com tudo
pronto; o item acima só entra quando a empresa decidir escalar pra fora
do departamento. O outro item dessa lista original (SSO com Entra ID) já
saiu do "mais pra frente" — está feito, ver seção "Login com Microsoft".
