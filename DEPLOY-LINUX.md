# Deploy em servidor Linux

Guia de instalação num servidor Linux (Debian/Ubuntu — ajuste os comandos
de pacote se for outra distro). Complementa o `README.md`; leia lá as
seções "Email do estoque", "HTTPS com Caddy" e "Login com Microsoft" antes
de seguir os passos abaixo — a configuração de `.env` é a mesma nos dois
sistemas operacionais, só muda como o processo é mantido rodando.

O app em si não tem nenhuma dependência de Windows (sem chamada a API do
Windows, sem caminho hardcoded, sem binário nativo — `node:sqlite`,
`pdfkit` e a Graph API foram escolhidos justamente por isso). O que muda
de verdade é a camada de infraestrutura: quem mantém o processo rodando
(NSSM → systemd), quem dispara os envios agendados (Agendador de Tarefas →
cron) e alguns caminhos no `.env`.

## 1. Pré-requisitos

- **Node.js ≥ 22.5** (usa `node:sqlite`, embutido no próprio Node — sem
  compilar nada). O Node dos repositórios padrão do Debian/Ubuntu costuma
  ser mais antigo — instale pelo repositório oficial da NodeSource:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  node -v   # confirme >= 22.5
  ```
- **git** (ou outra forma de transferir o código pro servidor).

## 2. Usuário e diretório do app

Um usuário de sistema dedicado, sem shell de login, dono só dos arquivos
do projeto — evita rodar o Node como root:

```bash
sudo useradd --system --create-home --home-dir /opt/central-infraestrutura --shell /usr/sbin/nologin central-infra
sudo mkdir -p /opt/central-infraestrutura
sudo chown central-infra:central-infra /opt/central-infraestrutura
```

Copie o projeto pra lá (via `git clone`, `rsync`, ou copiando o `.zip`) e
instale as dependências como esse usuário:

```bash
sudo -u central-infra git clone <url-do-repo> /opt/central-infraestrutura
# ou: sudo rsync -a --exclude node_modules --exclude dados/*.db* ./ central-infra@servidor:/opt/central-infraestrutura/

cd /opt/central-infraestrutura
sudo -u central-infra npm install --omit=dev
sudo -u central-infra mkdir -p dados logs
```

## 3. Trazer os dados existentes (se estiver migrando do Windows)

O banco é um arquivo único SQLite — pare o serviço Windows antes de copiar
pra garantir uma cópia consistente (ou use `npm run backup`, que já faz
uma cópia "a quente" com `VACUUM INTO`, sem precisar parar nada):

```powershell
# no Windows, gera uma cópia consistente mesmo com o serviço rodando
cd caminho\para\central-infra-app
node scripts/backup.js "C:\temp\migracao"
```

Copie o `.db` gerado (`central-infraestrutura-AAAAMMDD-HHMMSS.db`) pro
Linux como `dados/central-infraestrutura.db`, e copie também as pastas com
arquivo gerado por upload/geração (termos em PDF, fotos de CPD — confira
os caminhos configurados no `.env`, ex. `dados/termos/`, `dados/cpd-fotos/`).

```bash
sudo -u central-infra chown -R central-infra:central-infra /opt/central-infraestrutura/dados
```

## 4. `.env`

Copie `.env.example` pra `.env` e preencha — na prática só dois valores
mudam de formato em relação ao Windows (caminho de arquivo vira caminho
Linux):

```bash
cd /opt/central-infraestrutura
sudo -u central-infra cp .env.example .env
sudo -u central-infra nano .env
```

- `AD_DADOS_JSON_PATH` — era um caminho tipo `C:\Users\...\Mapeamento-AD-
  Dados.json`. Esse arquivo é gerado por um projeto **à parte, que só roda
  em Windows** (GPO + script de logon escrevendo atributos no AD) — ele
  não migra. O app Linux só precisa **enxergar** o JSON gerado por aquele
  projeto Windows. Três formas de fazer isso, da mais simples à mais
  robusta:
  1. Montar o compartilhamento de rede onde esse JSON já é publicado via
     CIFS (`mount -t cifs //servidor-windows/pasta /mnt/ad-dados ...`, ou
     uma entrada em `/etc/fstab`) e apontar `AD_DADOS_JSON_PATH` pra
     dentro desse mount.
  2. Um `rsync`/`scp` agendado (cron, no lado Linux ou no Windows) copiando
     o arquivo periodicamente pra um caminho local.
  3. Se nenhuma automação de rede for viável, um pequeno endpoint HTTP
     interno do lado Windows servindo o JSON, e trocar a leitura por um
     `fetch` — isso já seria uma mudança de código, não só de config;
     avise se for esse o caminho e ajusto `src/routes/*` (procure por
     `AD_DADOS_JSON_PATH` pra ver onde é lido hoje).
  Sem esse arquivo acessível, a tela "Usuários & Hosts" simplesmente fica
  vazia (não trava o resto do site).
- `DATABASE_PATH` — normalmente nem precisa setar (o padrão já é o caminho
  relativo `dados/central-infraestrutura.db` dentro do projeto, que
  funciona igual nos dois sistemas). Só defina se quiser o banco em outro
  lugar.
- `APP_BASE_URL` — a URL pela qual o site vai ser acessado (ex.:
  `https://central-infra.empresa.local`). Se o hostname mudar em relação
  ao Windows, atualize também o **Redirect URI** cadastrado no App
  Registration do Entra ID (login Microsoft) pra bater com a URL nova.
- O resto (`MAIL_TO`, `GRAPH_*`, `RESUMO_ESTOQUE_TO`/`CC`,
  `LEMBRETE_ESTOQUE_TO`) não depende de sistema operacional — copie do
  `.env` do Windows como está.

## 5. Serviço (systemd)

Substitui o serviço Windows criado via NSSM. Unit pronta em
[`deploy/central-infraestrutura.service`](deploy/central-infraestrutura.service)
(edite se o projeto não estiver em `/opt/central-infraestrutura` ou se
quiser rodar em outra porta):

```bash
sudo cp deploy/central-infraestrutura.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now central-infraestrutura
systemctl status central-infraestrutura
journalctl -u central-infraestrutura -f   # logs em tempo real (Ctrl+C pra sair)
```

Comandos do dia a dia:
```bash
sudo systemctl restart central-infraestrutura
sudo systemctl stop central-infraestrutura
```

### Atualizando o código (deploy)

`scripts/deploy.sh` (2026-09-17) — roda **no Windows** (Git Bash), na raiz
do projeto:
```bash
bash scripts/deploy.sh
```
Empacota `src/`, `public/`, `prisma/`, `scripts/`, `deploy/` e os arquivos
de projeto na raiz (nunca `dados/`, `.env`, `node_modules/` — preservados
no servidor), manda pro servidor, faz backup do código atual, aplica,
roda `npm install`, reinicia o serviço e confere `/api/saude` — se a
checagem falhar, restaura o backup sozinho e devolve o serviço ao estado
anterior. Pede a senha do SSH/sudo interativamente, como qualquer acesso
manual. Backups ficam em `/opt/central-infraestrutura-backups/<timestamp>/`
no servidor (mantém só os 5 mais recentes).

Substitui a sequência manual de `scp` arquivo por arquivo usada antes —
evita o tipo de erro que já aconteceu uma vez (dois arquivos de mesmo
nome, pastas diferentes, colidindo numa pasta flat de `scp`).

## 6. HTTPS (Caddy)

Mesma abordagem do Windows (`deploy/Caddyfile`): Caddy na frente, HTTP
puro na 3000 só acessível localmente, TLS interno (CA própria do Caddy —
sem depender de domínio público nem Let's Encrypt). Versão Linux em
[`deploy/Caddyfile.linux`](deploy/Caddyfile.linux) — **edite o hostname**
antes de instalar.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

O pacote já instala o Caddy como serviço systemd próprio (`caddy.service`,
já habilitado). Só aponte ele pro Caddyfile deste projeto:

```bash
sudo cp deploy/Caddyfile.linux /etc/caddy/Caddyfile
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
sudo systemctl reload caddy
```

**Sobre o nome do site**: no Windows, "nsp-i25" resolvia sozinho pra quem
está na rede via NetBIOS. Isso não existe por padrão no Linux — ou
cadastre um registro DNS interno de verdade apontando pro IP do servidor
(mais simples de manter), ou instale Avahi (`apt install avahi-daemon`)
pra um nome `algo.local` via mDNS (só funciona bem em rede local plana).

Depois de confirmar que `https://<hostname escolhido>` abre com cadeado
(mesmo que o navegador avise que o certificado não é confiável — é
esperado, é uma CA local, mesma explicação do README pro Windows), defina
`COOKIE_SECURE=true` no `.env` e reinicie o serviço do app:
```bash
sudo -u central-infra sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=true/' .env
sudo systemctl restart central-infraestrutura
```

## 7. Envios agendados e backup (cron)

Substitui as três Tarefas Agendadas do Windows (resumo de estoque,
lembrete de bater o estoque, backup diário). Arquivo pronto em
[`deploy/crontab-central-infraestrutura`](deploy/crontab-central-infraestrutura)
— confira o caminho `PROJETO=` lá dentro antes de instalar:

```bash
sudo -u central-infra crontab deploy/crontab-central-infraestrutura
sudo -u central-infra crontab -l   # confirma o que ficou instalado
```

Os scripts (`enviar-resumo-estoque.js`, `enviar-lembrete-estoque.js`)
rodam **todo dia** e decidem sozinhos se hoje é dia de enviar de verdade
(sexta-feira / último dia útil do mês) — mesmo motivo de rodarem assim no
Windows: nem o Agendador de Tarefas nem o cron têm um gatilho nativo de
"último dia útil do mês". Pra testar um envio na hora, independente do
dia:
```bash
sudo -u central-infra bash -c "cd /opt/central-infraestrutura && node scripts/enviar-resumo-estoque.js --forcar"
```

## 8. Checklist final

- [ ] `systemctl status central-infraestrutura` → `active (running)`
- [ ] Site abre em `https://<hostname>` com o cadeado (Caddy)
- [ ] Login funciona (senha local e/ou "Entrar com Microsoft", se
      configurado)
- [ ] Aba Estoque mostra os itens/saldo esperados (confirma que o `.db`
      migrado está correto)
- [ ] `sudo -u central-infra crontab -l` mostra as 3 linhas agendadas
- [ ] `AD_DADOS_JSON_PATH` acessível (aba "Usuários & Hosts" populada) —
      ou aceito ficar vazio por enquanto, se a integração de rede ainda
      não estiver pronta
- [ ] `COOKIE_SECURE=true` só depois de confirmar HTTPS funcionando

## 8. Leitura automática de termo escaneado (OCR) — opcional

Ao enviar um termo assinado (Estoque > Termos), a plataforma pode ler o
documento sozinha e sugerir o tipo (responsabilidade/devolução), o
colaborador e os equipamentos da tabela. Roda **dentro do servidor** com o
Tesseract — nenhum documento sai da empresa. Sempre pede confirmação antes de
gravar, porque OCR erra letra (principalmente o nº de série).

Instalar (uma vez, como root/sudo; o deploy não instala pacotes do sistema):

```bash
sudo apt update
sudo apt install -y tesseract-ocr tesseract-ocr-por poppler-utils
tesseract --list-langs | grep por      # tem que listar "por"
```

Sem esses pacotes a plataforma continua funcionando normalmente: o quadro de
envio só mostra "Leitura automática indisponível" e tudo fica à mão. Os
arquivos temporários da leitura ficam em `dados/ocr-tmp/` (apagados na hora).
Variáveis opcionais no `.env`: `OCR_TESSERACT_BIN`, `OCR_PDFTOPPM_BIN`,
`OCR_IDIOMA` (padrão `por`), `OCR_DPI` (padrão `300`).

## 9. Instâncias de Estoque (Logística, Reversa, Dimps, ATOP)

Mesmo código da Central, com um interruptor de módulos no `.env`
(`APP_MODULOS=estoque`, ver `src/lib/modulos.js`): o menu e a API mostram
só **Estoque** (Dashboard, Descarte, Atualizar) e **Cadastros** (atendentes,
departamentos, feriados, mínimo dos itens). Chamados, CPD, Atualizações,
Segurança, Colaboradores, Termos e Equipamentos móveis não aparecem e as
rotas deles respondem 404. Entrega a colaborador continua existindo em
Atualizar, mas não gera termo.

Cada instância roda no **mesmo servidor** da Central, com tudo próprio —
pasta, usuário, banco (`dados/`), `.env`, porta, serviço, site no Caddy,
cookie de sessão e agendamentos. A lista mora em
[`deploy/instancias.conf`](deploy/instancias.conf):

| Instância | Endereço | Endereço antigo (só redireciona) | Porta interna | Pasta / serviço | Usuário |
|---|---|---|---|---|---|
| Estoque Logística | `https://estoque-logistica.telehelp.local` | `https://192.168.62.194:8443` | 3001 | `estoque-logistica` | `estoque-log` |
| Estoque Reversa | `https://estoque-reversa.telehelp.local` | `https://192.168.62.194:8444` | 3002 | `estoque-reversa` | `estoque-reversa` |
| Estoque Dimps | `https://estoque-dimps.telehelp.local` | `https://192.168.62.194:8445` | 3003 | `estoque-dimps` | `estoque-dimps` |
| Estoque ATOP | `https://estoque-atop.telehelp.local` | `https://192.168.62.194:8446` | 3004 | `estoque-atop` | `estoque-atop` |

(Pasta = `/opt/<nome>`; Central continua em `https://192.168.62.194`, porta
3000, `/opt/central-infraestrutura` — **cada repositório atualiza só as
suas instâncias**.) Todas as instâncias ficam na porta 443 do mesmo Caddy da
Central — ele escolhe o site pelo nome digitado no navegador.

Pra criar uma instância nova: acrescente uma linha no `instancias.conf`
(porta, porta HTTPS antiga, minuto do backup e nome DNS que ninguém mais
usa) e siga 9.1–9.3.

**Cookie de sessão:** o navegador separa cookie por nome de host (não por
porta). Com um nome por instância isso já fica separado; mesmo assim cada
instância usa um nome de cookie próprio (`COOKIE_NOME=sessao_<instância>`
no `.env`), pra não derrubar a sessão da Central se alguém acessar pelo IP.

### 9.1. DNS e Azure (uma vez por instância, ANTES de instalar)

**DNS interno** — pedir a quem administra o DNS do Active Directory, na zona
`telehelp.local`, um registro **A** por instância, todos apontando pro IP do
servidor (o mesmo da Central):

| Nome | Tipo | Valor |
|---|---|---|
| `estoque-logistica` | A | `192.168.62.194` |
| `estoque-reversa` | A | `192.168.62.194` |
| `estoque-dimps` | A | `192.168.62.194` |
| `estoque-atop` | A | `192.168.62.194` |

Conferir de um PC da rede (`nslookup estoque-reversa.telehelp.local`) e do
próprio servidor (`getent hosts estoque-reversa.telehelp.local`) — os dois
têm que devolver `192.168.62.194`. O instalador se recusa a seguir se o
servidor não resolver o nome (o endereço antigo passaria a redirecionar pra
um nome inexistente); pra instalar antes, numa instância que ninguém usa
ainda: `SEM_DNS=1 bash .../instalar-instancia-estoque.sh ...`.

**Azure** — no App Registration da Central (Entra ID → App registrations →
o app → Authentication → Web → Adicionar URI), um Redirect URI por
instância:

```
https://estoque-logistica.telehelp.local/api/auth/entra/callback
https://estoque-reversa.telehelp.local/api/auth/entra/callback
https://estoque-dimps.telehelp.local/api/auth/entra/callback
https://estoque-atop.telehelp.local/api/auth/entra/callback
```

Os antigos com `192.168.62.194:8443` podem ser removidos depois que a
Logística estiver no nome novo (o login sempre usa o `APP_BASE_URL`, que
passa a ser o nome DNS).

### 9.2. Instalar (no servidor, sem git)

No Windows (PowerShell, na raiz deste repositório), gere e mande o pacote:

```powershell
tar -czf "$env:TEMP\estoque.tar.gz" src public prisma scripts deploy package.json package-lock.json README.md DEPLOY-LINUX.md .env.example
scp "$env:TEMP\estoque.tar.gz" suporte@192.168.62.194:/tmp/estoque.tar.gz
```

No servidor (`ssh suporte@192.168.62.194`):

```bash
rm -rf /tmp/estoque-src && mkdir -p /tmp/estoque-src && tar -xzf /tmp/estoque.tar.gz -C /tmp/estoque-src
bash /tmp/estoque-src/scripts/instalar-instancia-estoque.sh reversa "email.do.gestor@telehelp.com.br" "Nome do Gestor" "quem.recebe.resumo@telehelp.com.br"
```

Troque `reversa` por `dimps`, `atop` ou `logistica`. O script
([`scripts/instalar-instancia-estoque.sh`](scripts/instalar-instancia-estoque.sh)):
cria usuário e pasta, copia o código, instala dependências (ou copia as da
Central, se o servidor não alcançar o npm), gera o `.env` (GRAPH_* e
MAIL_FROM copiados do `.env` da Central), cadastra o primeiro gestor, cria
o serviço systemd, acrescenta o site no Caddy (arquivo
`/etc/caddy/estoque-<instância>.caddy` + uma linha `import` no Caddyfile da
Central, com cópia de segurança antes), libera a porta no ufw (se ativo) e
instala a crontab.

Pode rodar de novo: não sobrescreve o `.env` nem o banco. Rodar de novo na
Logística (instalada antes desta versão) acrescenta o `COOKIE_NOME` que
faltava, troca o `APP_BASE_URL` pro nome DNS e passa o endereço antigo
(`:8443`) a redirecionar pro nome novo — banco e usuários continuam.

**Atenção:** se alguém reinstalar o Caddyfile da Central com o
`cp deploy/Caddyfile.linux /etc/caddy/Caddyfile` da seção 6, as linhas
`import` somem e as instâncias de Estoque ficam fora do ar — rode o
instalador de cada uma de novo.

### 9.3. Primeiro acesso e equipe

Sem o módulo Chamados, o login com Microsoft **não cria conta sozinho** — só
entra quem está em Cadastros → Atendentes daquela instância. O instalador
cadastra o primeiro gestor; pra outro gestor depois:

```bash
sudo -u estoque-reversa bash -c 'cd /opt/estoque-reversa && node scripts/criar-gestor.js "email@telehelp.com.br" "Nome"'
```

O gestor cadastra o resto da equipe pela tela: **Atendente** usa o estoque;
**Líder/Gestor** também corrigem e excluem lançamentos; **Gestor** ou
**Administrador total** acessa Cadastros.

### 9.4. Atualizando depois (deploy)

Do Windows (Git Bash), na raiz deste repositório:

```bash
bash scripts/deploy.sh reversa        # uma
bash scripts/deploy.sh dimps atop     # várias
bash scripts/deploy.sh todas          # todas do instancias.conf
```

Um pacote e uma conexão SSH; cada instância tem backup do código em
`/opt/estoque-<instância>-backups/` e volta sozinha à versão anterior se o
`/api/saude` não responder depois do restart.

### 9.5. Backup, envios e monitor

Cada instância tem a própria crontab (`sudo -u <usuário> crontab -l`):
resumo de estoque (sexta / último dia útil, 17h), lembrete (sexta, 8h),
backup (2h15/2h20/2h25/2h30) e monitor (a cada 5 min). Backups em
`/opt/estoque-<instância>/dados/backups/estoque-<instância>-*.db`.
Destinatários vêm do `.env` da instância (`RESUMO_ESTOQUE_TO/CC`,
`LEMBRETE_ESTOQUE_TO`, senão `MAIL_TO`) — nunca os padrões da Central.

Backup manual:
`sudo -u estoque-reversa bash -c 'cd /opt/estoque-reversa && node scripts/backup.js'`.

### 9.6. Checklist (por instância)

- [ ] `systemctl status estoque-<instância>` → `active (running)`
- [ ] `curl -s http://localhost:<porta>/api/config` → nome certo e `"modulos":["estoque"]`
- [ ] `https://<nome_dns>` abre com cadeado; o endereço antigo `https://192.168.62.194:<porta_https>` redireciona pra ele; a Central continua igual
- [ ] Login funciona com o gestor; conta não cadastrada é recusada
- [ ] Entrar numa instância não desloga da Central nem das outras
- [ ] `sudo -u <usuário> crontab -l` mostra as 4 linhas
