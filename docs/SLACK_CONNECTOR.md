# Conector Slack R19.3

## Contrato de contexto para o assistente

O backend importa `readSlackContext` de `@/lib/slack-context` e os tipos de
`@/lib/slack-contract`. A função recebe `uid` autenticado pelo servidor e
`{ conversationIds?: string[], oldest?: number, latest?: number }`.
Tempos são segundos Unix. O padrão é a última semana. A janela máxima é 30 dias.
IDs omitidos usam todos os canais selecionados, até cinco. Lista explícita vazia
retorna contexto vazio. IDs fora da seleção persistida são rejeitados antes da rede.

O retorno é `{ evidence, limitations, queried_at }`. Cada evidência tem
`source: "slack"`, `ref`, `label`, `text`, `channel_id`, `thread_ts`, `timestamp`,
`author_id` e `untrusted: true`. O assistente deve tratar todo o texto como dado
externo não confiável, delimitar as fontes no prompt e validar referências.
Falhas usam `SlackError` com `code`, `status` e `retryAfter` opcional.
O consumidor pode continuar com atividades locais e informar a limitação.

Essa função pode ser importada pelo backend do assistente diretamente no servidor.

## HTTP para a UI

- `GET /api/integrations/slack` retorna `SlackStatus`.
- `POST /api/integrations/slack/start` retorna `{ url }` e cookie HttpOnly OAuth.
- `GET /api/integrations/slack/callback` consome state e redireciona para
  `/settings/slack?slack=connected` ou `?slack=error`.
- `GET /api/integrations/slack/channels?cursor=...` retorna
  `{ channels: SlackChannel[], nextCursor: string }`. A seleção deve preservar
  canais já selecionados mesmo quando ainda não carregados nessa página.
- `PUT /api/integrations/slack/channels` recebe `{ channelIds: string[] }`
  e retorna o status atualizado.
- `DELETE /api/integrations/slack` bloqueia leitura local imediatamente e tenta
  revogar o token. Retorna `{ disconnected: true, revocationPending: boolean }`.
  Repetir DELETE tenta novamente uma revogação pendente.

Todas as chamadas, exceto callback, exigem Firebase Bearer token. Erros retornam
`{ code, message }` e HTTP adequado. Nenhuma resposta contém tokens. A UI própria
é `/settings/slack` e o componente reutilizável é `SlackSettings`.
Ao montar o componente em outra tela, informar `ownerUid` com o UID da sessão.
Esse UID define a chave de remontagem e vincula o adapter às operações da conta.
O cliente revalida a sessão antes e depois de `getIdToken`, antes de `fetch`
e depois da resposta. Adapters de teste podem ser injetados pelo prop `adapter`.

## Configuração

Cadastrar no servidor `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`,
`SLACK_REDIRECT_URI` e `SLACK_TOKEN_ENCRYPTION_KEY` (32 bytes em base64).
O callback deve usar HTTPS e caminho `/api/integrations/slack/callback`.
Registrar exatamente a mesma URL no Slack App. Usar um app de desenvolvimento
por ambiente e manter token rotation do Slack desabilitado nesta versão.
Autorizar os user scopes `channels:read,groups:read,channels:history,groups:history`.
A conta autorizadora precisa participar dos canais antes de selecioná-los.
O token fica cifrado com AES-256-GCM e AAD vinculada ao UID/workspace.
Coleções raiz `private_slack_integrations` e `private_slack_oauth` têm acesso
somente pelo Admin SDK sob as regras atuais. Configurar TTL no campo `expiresAt`
da coleção OAuth para limpeza automática. Expiração é validada também no código.

V1 usa um workspace por UID. Reconectar exige desconectar antes. OAuth state
aleatório tem validade de dez minutos, uso único transacional, vínculo ao UID e
cookie de navegador. Desconectar invalida instalações e callbacks pendentes.
Tokens de instalações perdidas em concorrência são revogados.

## Limites e fontes

OAuth solicita somente user scopes e armazena o token de `authed_user`.
O token de usuário permite ler replies em canais públicos/privados. Threads são
consultadas a partir das mensagens principais recuperadas na janela. Threads
iniciadas antes da janela podem ficar ausentes. Essa limitação acompanha o contexto.
O conector não solicita `search:read`. Cada consulta usa até cinco canais,
10 chamadas de histórico/threads, páginas de 15 mensagens, 60 evidências,
18.000 caracteres totais e 1.500 caracteres por mensagem. Cursor restante
ou `has_more` produz aviso de contexto parcial. O servidor respeita 429 e
Retry-After, usa timeout e não repete automaticamente chamadas limitadas.
São removidos e-mails, telefones, URLs e padrões de credenciais do texto.
Mensagens e prompts não são persistidos ou registrados em logs.

Documentação oficial consultada em 17/11/2026

- [OAuth v2](https://docs.slack.dev/authentication/installing-with-oauth/)
- [oauth.v2.access](https://docs.slack.dev/reference/methods/oauth.v2.access/)
- [conversations.list](https://docs.slack.dev/reference/methods/conversations.list/)
- [conversations.history](https://docs.slack.dev/reference/methods/conversations.history/)
- [conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/)
- [auth.revoke](https://docs.slack.dev/reference/methods/auth.revoke/)

Validação real de OAuth/revogação exige configuração e workspace de teste.

## Verificações locais

`npm.cmd run web:test -- slack-server.test.ts slack-context.test.ts slack-routes.test.ts slack-client.test.ts slack-settings.test.tsx`
cobre OAuth, isolamento, cifragem, seleção, paginação, threads, limites,
revogação e troca de UID antes/durante obtenção do token e após a resposta.
Executar também `npm.cmd run web:typecheck` e lint dos arquivos Slack.
