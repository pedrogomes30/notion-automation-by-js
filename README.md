# notion-automation-by-js
provide js automation to manipulate notion database

## Calendar Overlay dinamico (tabela X sobre calendario da tabela Y)

A extensao agora suporta sobrepor eventos de uma database fonte (X) em uma visualizacao de calendario (semanal/mensal) de outra database (Y), com:

- badge colorido no dia
- contador de itens no badge
- hover nativo (`title`) com os objetivos daquele dia

### Como funciona

- Arquivo isolado da feature: `calendar-overlay.js`
- O script e carregado como content script separado, sem acoplar ao painel principal.
- A feature le regras dinamicas de `chrome.storage.local` na chave:
	- `na_calendar_overlay_rules`
- Agora tambem existe editor visual no popup para criar/editar/excluir/ativar regras sem editar storage manualmente.

### Onde configurar visualmente

- Abra o painel da extensao no Notion.
- Na tela principal, use a secao **Overlay de Calendario**.
- Clique em **+ Nova Regra** para mapear:
	- Database fonte (Tabela X)
	- Database alvo (Tabela Y)
	- Propriedade de data
	- Propriedade de label (hover)
	- Propriedade de cor
	- Filtro JSON opcional

### Estrutura da regra

```json
[
	{
		"id": "objetivos-conteudo",
		"enabled": true,
		"sourceDatabaseId": "ID_DA_TABELA_OBJETIVOS_X",
		"targetDatabaseId": "ID_DA_TABELA_CALENDARIO_Y",
		"sourceDateProperty": "Data",
		"sourceLabelProperty": "Objetivo",
		"sourceColorProperty": "Status",
		"filter": {
			"property": "Status",
			"status": { "does_not_equal": "Concluido" }
		}
	}
]
```

### Campos da regra

- `enabled`: ativa/desativa sem remover configuracao.
- `sourceDatabaseId`: database que contem os objetivos/eventos (X).
- `targetDatabaseId`: database onde o calendario esta aberto (Y).
	- se vazio, tenta sobrepor em qualquer calendario aberto.
- `sourceDateProperty`: propriedade `date` usada para mapear o dia.
- `sourceLabelProperty`: texto mostrado no hover.
- `sourceColorProperty`: propriedade do tipo `select`/`status` para colorir badge.
- `filter`: filtro opcional da API do Notion para reduzir eventos.

### Observacoes

- O badge mostra a quantidade de itens daquele dia.
- O hover lista os titulos/labels dos itens vinculados ao dia.
- O cache da busca e curto (60s) para manter o comportamento dinamico sem sobrecarregar a API.
