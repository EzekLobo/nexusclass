# Monitor local do Slack Web

No Windows, instale com `powershell -ExecutionPolicy Bypass -File .\slack-monitor\Install-Monitor.ps1` executado na pasta do repositório.

Nesta primeira versão, Configurações, sugestões e rotas de pareamento são restritas à conta proprietária do NexusClass.

O NexusClass pode consultar as menções não lidas em `brazil-tutors` e `brazil-tutors-team-3` usando um Chromium local no Windows. A sessão do Slack e a chave privada do dispositivo ficam em `%LOCALAPPDATA%\NexusClass\SlackMonitor`; a aplicação web nunca recebe a senha nem os cookies.

## Preparar o computador

1. Instale Node.js 24.
2. Execute `slack-monitor/Install-Monitor.ps1` no PowerShell. O script instala Playwright/Chromium e cria uma tarefa do Agendador do Windows para iniciar o serviço ao entrar no Windows.
3. Entre no NexusClass e abra Configurações → Integrações.
4. Cole o link de cada canal copiado do Slack Web e o nome exato que aparece na sua menção.
5. Escolha “Salvar configuração local”, depois “Abrir Slack para login” e entre manualmente na janela aberta.
6. Volte ao NexusClass e escolha “Vincular monitor”.

O navegador visível será fechado depois que a sessão for validada; consultas seguintes usam Chromium sem janela. O site consulta imediatamente ao abrir e repete a cada cinco minutos enquanto estiver visível e conectado. Com o NexusClass fechado ou o computador desligado, não há consultas. A tarefa do Windows deixa apenas o serviço local ativo.

## O que é consultado

O worker abre a lista de Não lidas do Slack, coleta apenas prévias que contenham uma menção de usuário correspondente ao texto configurado, filtra os dois nomes de canal e mantém um checkpoint local. Ele não abre os canais, envia mensagens, clica em ações de leitura nem processa anexos ou mensagens diretas. Cada ciclo envia até vinte mensagens ainda não processadas. Se a sessão expirar, o monitor pausa até novo login.

Cada envio é assinado com Ed25519. A Vercel armazena a chave pública do computador, valida horário e assinatura, limita o payload, impede duplicatas e aceita somente os dois canais. O Gemini processa no máximo cinquenta mensagens por dia por dispositivo. Mensagens não acionáveis são registradas como processadas localmente para não serem reenviadas.

Sugestões ficam em `users/{uid}/slack_task_suggestions`, inacessíveis diretamente pelo cliente Firebase. No quadro, “Revisar” abre o editor. Só “Aprovar e criar tarefa” salva, atualizando a sugestão e o cartão em uma transação idempotente.

## Configuração da aplicação

Na Vercel, configure `GEMINI_API_KEY` e, opcionalmente, `GEMINI_MODEL` (padrão `gemini-3.5-flash-lite`). A chave é usada somente no servidor. A disponibilidade e as cotas do modelo devem ser conferidas no AI Studio para o projeto Gemini usado.

O serviço local aceita requisições somente da origem do NexusClass e do localhost de desenvolvimento. Para outro domínio de produção ou preview, defina `NEXUSCLASS_SLACK_ALLOWED_ORIGINS` antes de iniciar o worker, com origens separadas por vírgula. A porta padrão é `49321` e pode ser alterada por `NEXUSCLASS_SLACK_MONITOR_PORT`.

Para remover a inicialização automática, execute `slack-monitor/Uninstall-Monitor.ps1`. Isso mantém a sessão e os dados locais.

## Limites conhecidos

O Slack Web não oferece contrato estável de DOM para esta leitura. Seletores podem mudar e exigir atualização do worker. A consulta preserva a lista como não lida navegando pela página de Não lidas e não acionando ações de leitura; isso precisa ser confirmado numa conta real durante a configuração inicial. O teste local usa uma página Slack simulada e não substitui essa verificação autenticada.

O Gemini Developer API no nível gratuito pode usar os conteúdos enviados para melhorar os serviços do Google. Use o recurso com as mensagens da organização somente conforme a autorização e as políticas aplicáveis à conta.
