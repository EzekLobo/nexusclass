# Backend do assistente

`POST /api/assistant/ask` exige Bearer Firebase validado com revogação. O corpo
aceita exclusivamente os campos de `frontend/src/lib/assistant-contract.ts`.
O limite é 8 KiB UTF-8 e a pergunta tem até 2.000 caracteres. IDs funcionam como
filtros de registros do UID autenticado. Evidências enviadas pelo cliente são
recusadas. Respostas e erros HTTP usam `Cache-Control: no-store`.

## Configuração

Configure `GEMINI_API_KEY`, `GEMINI_MODEL` explicitamente e
`GEMINI_ASSISTANT_ENABLED=true` apenas no servidor. O padrão é desabilitado.
O modelo precisa aceitar `generateContent` e JSON Schema. O cliente usa REST,
sem pacote novo, com chave no header, timeout de 15 segundos, uma candidata,
20.000 bytes de contexto e até 1.024 tokens de saída. Não há ferramentas.
A chave real exposta anteriormente precisa ser substituída no provedor.
A implementação e os testes usam somente valores sintéticos.

Os padrões de quota são 2 requisições por minuto e 10 por dia por UID,
com teto global de 50 por dia UTC. As variáveis correspondentes estão no
`.env.example`. Limites superiores fechados evitam configurações ilimitadas.
As reservas transacionais antecedem a leitura de contexto e permanecem
consumidas em falha, timeout ou insuficiência. Repetir `request_id` no mesmo UID
retorna 409. Para uma nova tentativa, gere outro identificador.

`private_assistant_usage` e `ai_usage_logs` são coleções raiz acessíveis pelo
Admin SDK. As regras atuais não concedem leitura ou escrita aos clientes.
Configure TTL no campo `expires_at` para retenção de 30 dias. Sem TTL a limpeza
não é automática. A validade das quotas depende da data do contador, não do TTL.
Logs guardam modelo, status, duração, contagem e código fixo. Não guardam
pergunta, resposta, mensagem ou token.

## Fontes e limitações

A política `app_settings/kodland_sync.storage` precisa ser exatamente `firebase`
para habilitar leitura Kodland. Política ausente ou `browser` ignora todas as
coleções Kodland do Firestore, inclusive snapshots antigos. O servidor declara
que o conteúdo do navegador está indisponível. Não busca credenciais Kodland.
Atividades próprias continuam disponíveis nas coleções `manual_*` do UID.

O leitor projeta campos permitidos, limita cada coleção a 100 registros e
valida vínculos de turma, aluno e ocorrência. Até 40 atividades entram no
contexto. Listas truncadas geram limitação explícita. Filtros sem atividade
correspondente recebem 403 quando a política permite avaliar a fonte no servidor.
Com fonte Kodland local, a ausência gera insuficiência sem afirmar autorização
ou inexistência de registros locais. Dados sem vínculos válidos são omitidos.

Identidades das fontes são pseudonimizadas por consulta. Nomes digitados em
perguntas livres podem permanecer no texto. Perguntas baseadas apenas em nome
podem exigir seleção de filtros. `unknown` e `not_graded` mantêm seus estados.
`pending` próprio com entrega é aguardando correção. Sem evidência de entrega
permanece desconhecido. Texto de entrega e URLs servem somente para essa
classificação local e não são enviados ao provedor.

`include_slack=true` usa `readSlackContext` com UID validado e seleção de canais
revalidada pelo conector. Referências são aliases `slack_1` por consulta, sem
IDs de workspace ou canal no catálogo enviado ao modelo. A etiqueta devolvida
inclui canal e timestamp da mensagem, com destino interno `/settings/slack`.
Canais não autorizados são recusados. Indisponibilidade
gera limitação explícita e preserva o contexto de atividades. O contexto combinado
também passa pelo teto de bytes. Consulte `docs/SLACK_CONNECTOR.md` para OAuth.

Pergunta e títulos passam por redação de e-mails, telefones, URLs e padrões de
credenciais, incluindo `AQ.`. Redação por padrões não identifica todo dado
pessoal possível em texto livre. Instruções fixas ficam separadas dos dados
nativos e Slack, que permanecem não confiáveis. JSON Schema e validação local
recusam saída truncada, campos extras, links gerados e referências inexistentes.
Rótulos e caminhos das citações são definidos pelo servidor. A validação não
prova a veracidade semântica de toda frase produzida pelo modelo.

## Verificação local

Execute no workspace `frontend` os comandos `npm.cmd run typecheck`,
`npm.cmd run lint` e `npm.cmd run test -- src/lib/assistant-validation.test.ts
src/lib/assistant-activities.test.ts src/lib/assistant-gemini.test.ts
src/lib/assistant-usage.test.ts src/lib/assistant-slack.test.ts
src/app/api/assistant/ask/route.test.ts`.
Os testes substituem Firebase e Gemini por fixtures sintéticas. Validação real
de modelo, credenciais, transações e TTL requer ambiente de teste configurado.

Fontes oficiais consultadas em 17/11/2026

- [Generate content REST](https://ai.google.dev/api/generate-content)
- [Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
- [Transações Firestore](https://firebase.google.com/docs/firestore/manage-data/transactions)
