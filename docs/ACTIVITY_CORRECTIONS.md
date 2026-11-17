# Correções assistidas de atividades

O tutor prepara uma rubrica específica da atividade, solicita uma proposta de
nota e feedback, revisa os critérios e aprova individualmente. O Gemini não
executa o projeto do aluno. Texto incompleto, apenas um link ou falta de
orientação suficiente impedem a sugestão de nota.

## Uso

Em Turmas, na área de atividades, abra as sugestões de correção. Selecione até
cinco pendências e prepare cada uma com enunciado, entrega completa e critérios.
A soma dos pontos precisa corresponder ao máximo, na precisão escolhida.
Revise a rubrica antes de gerar; o sistema não padroniza todas as notas em 10.
Depois de gerar, revise nota, justificativas e feedback e aprove cada atividade.

Atividades próprias salvam o resultado aprovado no NexusClass. A autoria da
correção assistida e a data acompanham a nota; edição posterior da entrega ou
rubrica invalida a nota anterior e devolve a atividade à fila de entrega.
Rubrica e nota fazem parte do backup das atividades próprias e da demo.

Para Kodland, a versão atual usa texto e critérios fornecidos pelo tutor:
copie da plataforma o enunciado, a rubrica e o conteúdo que você efetivamente
conferiu. A origem é mostrada como fornecida pelo tutor. A aprovação prepara
um rascunho para copiar e abrir a página oficial da correção; não confirma envio.
Não foi comprovado contrato externo para ler a entrega integral e publicar nota.

## Configuração

Servidor: GEMINI_API_KEY, GEMINI_MODEL e GEMINI_ASSISTANT_ENABLED=true.
Ative GEMINI_CORRECTIONS_ENABLED=true para disponibilizar a geração. Modelo
local selecionado: gemini-3.5-flash-lite. As mesmas quotas do assistente são
compartilhadas: 2/minuto/UID, 10/dia/UID, 50/dia global por padrão.
Cada atividade gerada consome uma reserva, inclusive em caso de erro.
Lote pausa quando atingir quota; não aumente limites sem considerar custo.
KODLAND_CORRECTION_WRITE_ENABLED não autoriza nenhum envio nesta versão.

Credenciais de servidor Firebase também são necessárias para autenticação,
isolamento, reservas de quota e persistência. O teste direto Gemini não
substitui a verificação autenticada do aplicativo.

## Privacidade e falhas

Envios ao modelo contêm apenas texto pedagógico sanitizado e referências
anônimas. Dados livres podem conter informações que padrões automáticos não
reconhecem: confira o material antes de enviá-lo. Credenciais ficam no servidor.
Texto de entrega é tratado como dado não confiável; nenhuma instrução dele
ganha permissão para executar ações ou alterar regras de avaliação.

Contexto excessivo é recusado, sem cortar silenciosamente critérios. Resposta
inválida ou truncada não altera nota. Mudança de conta descarta respostas em
andamento; conflito de revisão exige reabrir a atividade. A aprovação local usa
transação e não é substituída por apenas abrir uma página externa.

Sugestões são privadas, com expiração lógica de 30 dias no campo `expires_at`
da coleção raiz `private_correction_suggestions`. Logs de uso guardam
metadados, sem entrega, prompt, feedback ou segredo. Resultados aprovados
permanecem no histórico da própria atividade até sua remoção/reset.

## Verificação

O script scripts/test-gemini-corrections.ps1 testa a API com dados sintéticos.
Testes do backend devem verificar schema, pontuação, evidências, UID, conflito,
expiração e repetição de aprovação. A demo não consulta serviços privados.
Os testes E2E cobrem seleção, preparação, geração, revisão e fallback Kodland.
Registre separadamente evidência local, chamada real Gemini e validação
autenticada Firebase/produção; nenhuma delas comprova as demais.
