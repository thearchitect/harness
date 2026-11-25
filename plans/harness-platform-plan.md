# План: платформа harness — узлы, hub, протокол, UI, фоновые задачи, субагенты

Делегирование реализации Claude Code — движок субагентов (раздел 12) поверх общих
механизмов платформы. Материалы плана: [`probes/`](probes/) — пробы из раздела 3,
[`fixtures/`](fixtures/) — записи реальных прогонов для будущих тестов (переезжают в тесты
своего пакета, когда он появится). Документация pi — `docs/` пакета
`@earendil-works/pi-coding-agent` в бандле; документация Claude Code — https://code.claude.com/docs/en/.

Отметки: `[ ]` — раздел с работой к выполнению, `[x]` — сделан и проверен. Раздел `##`
отмечается, когда сделаны все его `###` и его собственный текст. Разделы без отметки —
справочные (цель, решения, факты, архитектура, принципы 10.1, открытые вопросы): их
соблюдает каждая работа. Порядок выполнения задаёт раздел 17.

## 1. Цель

Harness перестаёт быть расширением, живущим внутри терминального интерфейса pi, и становится
платформой:

- headless-агенты (pi SDK + harness) работают на узлах; узлы — на любых машинах, от любых
  пользователей ОС, под systemd или внутри UI;
- hub — узел с маршрутизацией и авторизацией: клиенты с одних машин запускают и ведут сессии
  на других;
- фронтенды — TUI и приложение `app` на React Native (iOS, Android, web в браузере и в
  окне на десктопе) — получают одинаковую семантику через один протокол и одну
  клиентскую модель;
- фоновые процессы под полным контролем модели и оператора, с уведомлениями;
- Claude Code как исполнитель реализации — частный случай фоновых процессов и типизированных
  взаимодействий.

## 2. Решения

| # | Вопрос | Решение |
|---|---|---|
| A1 | Агент-процесс | Свой хост на pi SDK (`harness-agent`), протокол HAP — надмножество pi RPC. |
| A2 | Локальный десктоп | Локальный UI — тоже клиент; `InteractiveMode` pi не используется. Свой TUI собирается из публичных компонентов pi и pi-tui (композиция, не форк). |
| A3 | Удалённый доступ | WebSocket через HTTPS hub, токены устройств. |
| A4 | Уведомления задач | Все варианты: `wake` / `queue` / `none`; умолчание — настройка harness, модель переопределяет на задачу. |
| A5 | Hub на Fly | Работает постоянно. |
| A6 | Владельцы узла | Узел принадлежит одному или нескольким пользователям hub. |
| A7 | Узел и uid | Узел работает от пользователя, который его запустил; агенты — под тем же пользователем. Flake даёт сервис для любого числа узлов от любых пользователей. |
| A8 | Единый компонент | Узел, hub и бэкенд локального UI — одна библиотека (`node`) и процесс на её основе. UI встраивает библиотеку и одновременно работает с локальным и удалёнными узлами. |
| A9 | Локальный узел для UI | UI подключается к socket работающего узла в `~/.harness/sockets/`, иначе поднимает встроенный узел. |
| A10 | Данные пользователя | Всё в `~/.harness` (с `.gitignore`); sockets — там же; XDG не используется. |
| A11 | Бинарь | `harness`; `pi` из бандла уходит. |
| A12 | Telegram | Выведен из обращения: код бота и Mini App переносится в `./experiments/telegram/` для истории; телефон — приложение `app`. |
| A13 | Десктоп | Пока — web-сборка `app` в окне системного webview (`harness web-app`, один процесс с bun); нативный десктоп на RN — будущий этап, когда десктопные платформы RN созреют. |
| A14 | Приложение | `app`: Expo + React Native на примитивах RN — одна кодовая база для iOS, Android, web (`react-native-web`) и десктопа (A13); React Strict DOM не используется. Платформенные детали — файлы `*.web.tsx` / `*.ios.tsx` / `*.android.tsx` рядом с общим. Тёмный, компактный, в стиле pi (A25). |
| A15 | Шрифты | Встроены JetBrains Mono, Iosevka Term, Terminus TTF + системный моноширинный стек; отдельно для зоны интерфейса и зоны чата. |
| A16 | Настройки | В `~/.harness` узла, через который вошёл UI (у hub — на пользователя hub). |
| A17 | Среда выполнения | Всё на bun, без `node_modules`; исключение — пакет `app`: Metro требует `node_modules`, bun ставит их как пакетный менеджер. |
| A26 | Публикация | Приложение публикуем мы: App Store и Google Play; аккаунты Apple Developer и Google Play Console, ключи подписи — в cage. |
| A27 | Push | Отложены в TODO README (раздел 13.2): нативные APNs/FCM через наш ретранслятор на Fly, сквозное шифрование содержимого. До тех пор уведомления приходят, только пока приложение открыто (по протоколу); закрытое или свёрнутое на iOS/Android уведомлений не получает. |
| A28 | Вход с устройства | Пользователь hub + токен устройства; привязка нового устройства — QR-код из `harness hub device add` (адрес hub + одноразовый код обмена на токен). |
| A18 | Репозиторий | Bun workspaces в одном репозитории. |
| A19 | Качество | Качественная декомпозиция; всё покрыто тестами по правилам скилла `testing`; собственный тестовый харнесс. |
| A20 | Мультисессионность | Один UI ведёт много сессий: слева — однострочные вкладки открытых сессий, справа — сама сессия, её фоновые задачи и субагенты (раздел 10.5). |
| A21 | Herdr | Уходит из поставки целиком; «ждёт оператора» показывают вкладки и программный статус pi-tui. |
| A22 | Набор вкладок | Общий для всех UI пользователя (`ui.tabs` в настройках узла входа, синхронизация сразу); активная вкладка и выбор справа — у каждого клиента свои. |
| A23 | Паритет UI | Общие смысл, действия, раскладка и паттерны взаимодействия: TUI и `app` (web и native) — отрисовщики одной `WorkbenchModel` (включая зоны экрана) и одной карты действий; различаются только детали исполнения. Web может давать дополнительные способы вызвать то же действие, но не новые функции; исключения — возможности среды (программный статус терминала; deep links, заголовок, favicon, системные уведомления). Паритет проверяется тестом по смыслу. |
| A24 | Режим TUI | Только полноэкранный (`TuiAltScreen`); режима с историей прокрутки терминала нет. |
| A25 | Web в духе TUI | Web — не имитация терминала, а цельный web-UX по правилу «место и поток общие, исполнение своё» (раздел 10.1): та же раскладка и те же места появления (автодополнение — блоком над полем ввода, Interactions — в зоне редактора), а мышь, наведение, выделение, перетаскивание, прокрутка и качество отрисовки — по-webовски. |
| C12 | Steering субагента оператором | Из вида субагента оператор пишет в его живую сессию (движок `harness` — обычный steer, `claude` — сообщение в живой процесс); вызывающая модель видит пометку; остановленного субагента продолжает только вызывающая модель. |
| S1 | Субагент | Профиль-каталог: `SUBAGENT.md` (frontmatter — движок, модель, режим, инструменты; тело — роль для самого субагента) + `SKILL.md` (брифинг для вызывающей модели: как сформулировать задачу и что ждать). |
| S2 | Источники профилей | Проект `.harness/subagents/` (только доверенный) → пользователь `~/.harness/subagents/` → бандл; при совпадении имени побеждает более ранний. |
| S3 | Движки | `harness` (дочерний `harness-agent` на том же узле) и `claude` (Claude Code CLI, C3–C11). Codex CLI — позже по той же схеме; модели OpenAI по подписке уже доступны через `harness` (`openai-codex`). |
| S4 | Бандловые профили | `builder` — исполнитель на движке `claude`, `anthropic/opus:medium`; `explorer` — сводка по кодовой базе на движке `harness`, `openai-codex/sol:medium`, только чтение. |
| S5 | Кто запускает | Только модель инструментом `subagent` и только по явной просьбе оператора (или по переключателю implementer — для реализации); самостоятельный запуск запрещён инструкцией. Ручного запуска из UI нет. |
| S6 | Вложенность | По умолчанию субагент никого не зовёт; разрешение — `subagents: [...]` профиля; глубина не больше 2. |
| M1 | Ссылки на модели | Во всём harness модель можно указать без версии (`anthropic/opus:medium`): берётся последняя версия семейства в каталоге (раздел 6.2). |
| M2 | Модель исчезла из каталога | Сессия хранит ссылку рядом с id; при открытии раскрывает её заново и сообщает «`opus`: claude-opus-5-5 → claude-opus-5-6». |
| C1 | Включение делегирования реализации | Переключатель `implementer: self \| <профиль>` (панель TUI, настройки web), при включении — `builder`; запись в сессии, умолчание новых сессий; атрибут `implementer="<профиль>"` у селектора build/simple. |
| C2 | Субагент недоступен | Модель останавливается и сообщает оператору; сама не реализует без его слова или его выбора в диалоге ожидания лимита. |
| C3 | Согласование действий субагента | Правила harness действуют на каждое действие субагента любого движка в режиме его профиля: правки — через `authorizeChange` (PLAN отказывает, BUILD спрашивает, SIMPLE свободен в cwd, madness пропускает). |
| C4 | Правила harness для Claude | Из `prompt.yaml`: общие тексты по именам + блок `claude`; скилл `testing` через плагин Claude. |
| C5 | Лимиты подписки | Claude ждёт сам (`CLAUDE_CODE_RETRY_WATCHDOG=1`), оператор выбирает: ждать / продолжить в harness / остановить. |
| C6 | Продолжение Claude | Сессии Claude в состоянии harness; `continue: true` или `session: <id>` в любой момент. |
| C7 | Транспорт Claude | Документированный headless-режим CLI (`claude -p`, stream-json на входе и выходе). Agent SDK не используется до одобрения Anthropic. |
| C8 | Бинарь Claude | Только `claude` пользователя из PATH: пользователь ставит его официальным путём и сам входит (`claude auth login`). Harness бинарь не поставляет и учётных данных не касается. |
| C9 | Инструменты Claude | Родные (`Edit`, `Write`, `Bash`, …) плюс инструменты harness через MCP по набору профиля, всегда без `ctx_*`; `subagent` — только если профиль разрешает вложенных (S6). |
| C10 | Фоновые задачи Claude | Не запрещаются, а отражаются в Supervisor (источник задач `claude`). |
| C11 | Одобрение Anthropic | Запрашивается; после получения — переход по разделу 12.11. |
| D1 | Документация | Свои документы harness и исходники поставляются в бандле вместе с документами pi той версии, что работает; документы harness описывают только своё и ссылаются на pi точечно, без пересказа (раздел 13). |
| D2 | Язык | Документы и интерфейсы (TUI, `app`, сообщения CLI, тексты промпта) — только английский, без слоя локализации. Русские строки UI в этом плане — описание смысла, реализуются по-английски. Ответы модели — по-прежнему на языке оператора. |
| D3 | Справочник протокола | Генерируется из typebox-схем `protocol`; вручную — только поведение. |

## 3. Проверенные факты

**pi 1.6.0**
- Поддерживаемые способы встраивания: SDK (`createAgentSession`, `AgentSessionRuntime`,
  `bindExtensions({ uiContext, mode, commandContextActions, shutdownHandler })`) и stdio RPC.
  Экспериментальный стек server/client/protocol удалён в 1.2.0 (CHANGELOG).
- `InteractiveMode` (6142 строки) работает прямо с `AgentSessionRuntime` (≈100 членов сессии,
  `runtimeHost.newSession/switchSession/fork/importFromJsonl`) и владеет процессом
  (`process.exit`, обработчики сигналов) — не подходит как подключаемый клиент.
- Экспортируемые компоненты: `AssistantMessageComponent`, `UserMessageComponent`,
  `ToolExecutionComponent` (принимает `ToolRenderers` — рисует без исполнения),
  `BashExecutionComponent`, `CustomMessageComponent`, `CompactionSummaryMessageComponent`,
  `BranchSummaryMessageComponent`, `SkillInvocationMessageComponent`, `CustomEditor`,
  `FooterComponent`, окна выбора (модель, thinking, сессии, дерево, настройки, вход, темы),
  `keyHint`, `renderDiff`, `getMarkdownTheme`, `highlightCode`, `Theme`; `create*ToolDefinition()`
  встроенных инструментов с отрисовщиками; `createCodemodeExtension`, `createMcpExtension`,
  `createToolSearchExtension`; `discoverAndLoadExtensions`, `ExtensionRunner`,
  `DefaultResourceLoader`, `SessionManager`, `ModelRuntime`.
- `ExtensionUIDialogOptions.signal` закрывает диалог программно.
- События и команды RPC — документированный контракт (pi `docs/json.md`, `docs/rpc-commands.md`, типы
  `RpcCommand`, `AgentSessionEvent`, `RpcExtensionUIRequest` экспортируются).
- Тема pi (`theme/dark.json`): OKHSL, ≈60 семантических токенов + `export.pageBg/cardBg`.
- `@earendil-works/pi-ai` экспортирует faux-провайдер (`fauxProvider`, `fauxAssistantMessage`,
  `fauxToolCall`, `fauxText`, `fauxThinking`) — сценарная модель без сети.

**Под bun 1.4.2 (проба [`probes/bun-sdk.ts`](probes/bun-sdk.ts))**
- pi CLI (`--version`) и pi SDK работают.
- Загружаются без ошибок: harness (checkout), magic-context, ask-user, ollama-cloud,
  deepseek-search, pi-usage, codemode, MCP; все инструменты зарегистрированы.
- Полный ход агента на faux-провайдере: вызов `codemode` → скрипт вызывает `bash` →
  `hi-from-bash` → финальный ответ — работает (worker codemode под bun работает).
- Замечено: (1) процесс не завершается сам после `session.dispose()` — хост завершает процесс
  явно; (2) проверка промпта harness сообщает «system prompt does not open with the harness
  preamble» под SDK без лаунчера — хост обязан передать промпт так же, как CLI (фаза 0, G1).

**Claude Code** (установлен 2.1.303, подписка Pro)
- `claude -p --output-format stream-json --verbose`: `system/init` (`session_id`, `model`,
  `apiKeySource: "none"` при OAuth, `tools`, `skills`, `plugins`), `rate_limit_event`,
  `system/api_retry`, `assistant`/`user`, `result` (`is_error`, `api_error`, `permission_denials`).
- Без `CLAUDE_CODE_RETRY_WATCHDOG` исчерпанный лимит сразу даёт `usage_limit_reached`
  ([`fixtures/claude/usage-limit.jsonl`](fixtures/claude/usage-limit.jsonl)); с ним процесс ждёт
  сброса, публикуя `rate_limit_event`
  (`status: "rejected"`, `resetsAt`) и `system/api_retry` (`error: "rate_limit"`,
  `retry_delay_ms`) ([`fixtures/claude/watchdog.jsonl`](fixtures/claude/watchdog.jsonl)).
- `--resume <id>`, `--append-system-prompt` (снимок на сессию), `--plugin-dir` (манифест
  необязателен, имя = каталог), `--mcp-config` + `--strict-mcp-config`, `--settings` (JSON),
  `--input-format stream-json` (потоковый ввод), чтение `AGENTS.md` без `CLAUDE.md`.
- Права: хуки — первый шаг проверки, до правил allow/deny из настроек
  (https://code.claude.com/docs/en/permissions.md, «How permissions are evaluated»); `PreToolUse` отвечает `permissionDecision: allow | deny` с
  причиной. `--permission-prompt-tool mcp__<server>__<tool>` получает то, что дошло до вопроса;
  ответ — один текстовый блок `{"behavior":"allow"}` / `{"behavior":"deny","message":…}`
  (+ `updatedInput`), без `structuredContent` (https://code.claude.com/docs/en/errors.md). `--permission-prompts none` —
  нерешённое отклоняется.
- Фоновые задачи Claude в потоке: `task_started` (`task_id`, `tool_use_id`, `task_type`),
  `task_progress`, `task_updated`, `task_notification` (`status`, `summary`, `output_file`),
  `background_tasks_changed` (полный набор); остановка — управляющий запрос `stop_task`;
  управляющий протокол CLI (`interrupt` и др.) документирован как допускающий прямое
  использование клиентом; поддержка — по `capabilities` в `system/init`.
- Политика Anthropic (https://code.claude.com/docs/en/legal-and-compliance,
  https://code.claude.com/docs/en/agent-sdk/overview):
  - «preinstalling or running Claude Code in your products or services … requires agreeing to
    our Commercial Terms of Service» — поставка бинаря с harness исключена;
  - «Developers building products … including those using the Agent SDK, should use API key
    authentication … Anthropic does not permit third-party developers … to route requests
    through … plan credentials on behalf of their users»; «Unless previously approved, Anthropic
    does not allow third party developers to offer claude.ai login or rate limits for their
    products, including agents built on the Claude Agent SDK» — Agent SDK с подпиской в
    открытом проекте исключён до одобрения;
  - «Nor does it prevent an end user from signing in to the unmodified Claude Code binary with
    their own Claude subscription, including where a platform hosts Claude Code» — путь harness:
    немодифицированный `claude` пользователя в headless-режиме CLI.

**Модели**
- Нечёткий выбор pi (`core/model-resolver.js`, `bestFuzzyMatch`) берёт максимум строкового
  сравнения id среди недатированных — не семантика «последней» (`5-10` < `5-9`, варианты
  вроде `-fast` могут победить); поэтому своя `resolveModelRef` (раздел 6.2).
- Каталог сейчас: `anthropic/claude-opus-4-5 … claude-opus-5-5`, `openai-codex/gpt-5.6-sol …
  gpt-6.2-sol`.
- Claude Code: `--model` принимает алиас семейства (`opus`, `sonnet`, …) или полный id; алиас
  раскрывается в новейшую разрешённую версию семейства; `--effort`: `low`, `medium`, `high`,
  `xhigh`, `max`, `ultracode` (https://code.claude.com/docs/en/cli-reference.md,
  https://code.claude.com/docs/en/errors.md).

**Сборка и окно**
- Bun без `node_modules` разрешает импорты из глобального кэша по `bun.lock` корня проекта;
  кэш только для чтения работает (https://bun.com/docs/runtime/auto-install).
- `bun2nix.fetchBunDeps` строит кэш Bun в Nix из `bun.lock` (https://nix-community.github.io/bun2nix/).
- Expo SDK 58 — React Native 0.88 (https://expo.dev/changelog/sdk-58.md); сборка — Metro.
- `react-native-web`: последний релиз 0.21.4, канареечные 0.22 ежедневно (npm, 2026-11-20); сторонние
  обзоры называют его maintenance mode, Expo сделал его необязательной зависимостью (SDK 56)
  (https://heart-it.github.io/react-brain/entries/crossplatform/). Риск: web-ветка RN развивается
  медленно; наш код — на примитивах RN и переживёт смену web-движка Expo.
- Десктоп RN: `react-native-macos` 0.83 и `react-native-windows` 0.85 отстают от RN 0.88, Linux
  официально нет; Basalt (https://basaltjs.dev) — Linux/macOS/Windows на RN 0.86–0.88, «0.2.x, early
  days». Поэтому десктоп пока — web-сборка в окне (A13).
- На iOS RN `Text` не даёт выделить часть текста (только «копировать всё»); обход — read-only
  `TextInput` (https://github.com/react/react-strict-dom/issues/474).
- webview/webview 0.12.0 жив (коммит 2026-10-22), поддерживает GTK4 + WebKitGTK 6;
  `webkitgtk_6_0` в nixpkgs — 2.54.1. Electrobun — отдельные процессы и свой набор инструментов;
  `Bun.WebView` — headless-автоматизация.
- Шрифты в nixpkgs: `jetbrains-mono` 2.304, `iosevka-bin` с `variant = "SGr-IosevkaTerm"` 34.9.0,
  `terminus_font_ttf` 4.49.3 (все OFL 1.1); `python3Packages.fonttools` 4.63.0 + `brotli`.

## 4. Архитектура

```
 Фронтенды: TUI (harness) │ app (iOS · Android · web в браузере / harness web-app) │ свой UI
                │ ClientModel (packages/client, изоморфный)
                ▼
 ┌───── протокол узла / hub (каналы) — unix socket | WebSocket+TLS | в процессе ─────┐
 │ Узел (packages/node): пул агентов · сессии ~/.harness · endpoints · auth ·        │
 │   routing (роль hub) · uplinks (к hub) · раздача web-сборки app · settings    │
 └──────────────┬───────────────────────────────────────────────────────────────────┘
                │ HAP по stdio (дочерний процесс)
 ┌──────────────▼────────────────────────────────────────────────┐
 │ harness-agent (packages/agent): pi SDK runtime + uiContext +   │
 │   мост компонентов + extension harness + пакеты бандла          │
 │   extension: core (режимы, gate, промпт) · interactions · state │
 │              supervisor (задачи, claude) · tools · presentation │
 └───────────────────────────────────────────────────────────────┘
```

Топология: любой узел может держать исходящие связи с hub; hub — узел с ролью `hub`; клиент
обращается к агенту по адресу `узел/агент` и не зависит от того, подключён он к узлу напрямую
или через hub. Сессии, `auth.json` провайдеров, файлы и задачи живут на узле агента; hub их не
хранит.

## [ ] 5. Репозиторий и пакеты

```
package.json            # bun workspaces: packages/*, tests
bun.lock
packages/
  protocol/  client/  node/  agent/  extension/  tui/  app/  cli/  testkit/
experiments/telegram/   # бывший Telegram-фронтенд и Mini App — история, не собирается
tests/scenarios/        # интеграционные сценарии
nix/                    # сборка, NixOS-модуль, образ Fly, шаблон развёртывания
```

Зависимости (стрелка — «зависит от»; циклы запрещены, проверка — тест графа импортов):

```
protocol ◄── client ◄── tui, app
protocol ◄── node ◄── cli, tui (встроенный узел)
protocol ◄── extension ◄── agent ──► pi SDK
extension/presentation ◄── tui
testkit ──► все (только тесты)
```

Правила границ:
- `protocol` и `client` не импортируют Node/Bun API (проверка: сборка `app` для web и native
  включает их; тест импортов).
- `extension` не знает про узлы и транспорт — только типы `protocol` (Interactions, State).
- Отрисовщики `extension/presentation` — чистые функции переданных данных.
- Время — только `Clock`, порождение процессов — только `Spawner`, файловая система узла —
  только `NodeFs`; все три внедряются (тесты подставляют свои).

### [ ] 5.1 `protocol` (изоморфный)

- `framing.ts`: JSONL, разделитель только LF, `\r` перед ним снимается, U+2028/2029 не
  разделители (как pi).
- `hap.ts`: записи HAP (раздел 7.1) — pi RPC (`RpcCommand`, ответы, `AgentSessionEvent`,
  `extension_ui_*`) без изменений + записи `harness_*`.
- `node.ts`: записи протокола узла (раздел 7.2); `hub.ts`: каталог узлов и маршрут (7.3).
- `channel.ts`: мультиплекс каналов поверх одного соединения.
- `schemas.ts`: схемы typebox всех записей; валидация на входе каждого endpoint.
- `version.ts`: `PROTOCOL_VERSION` (целое), правила совместимости.
- `model-ref.ts`: раскрытие ссылок на модели (раздел 6.2).
- `errors.ts`: коды ошибок (`unauthorized`, `forbidden`, `not_found`, `node_offline`,
  `version_mismatch`, `session_locked`, `invalid_record`, `agent_failed`, `internal`).

### [ ] 5.2 `client` (изоморфный)

- `connection.ts`: соединение поверх транспорта (`Transport` — интерфейс; реализации:
  WebSocket в браузере и bun, unix socket в bun, в-процессе), рукопожатие, переподключение
  с `Clock`, повторное открытие каналов.
- `endpoints.ts`: набор источников клиента (локальный узел + удалённые hub/узлы).
- `model/transcript.ts`: reducer транскрипта из снимка (`entries`, частичное сообщение) и
  событий pi; ветки, compaction, очереди steer/follow-up.
- `model/interactions.ts`: очередь Interactions (открыта / отвечена / закрыта и почему).
- `model/state.ts`: HarnessState агента; `model/tasks.ts`; `model/nodes.ts` (узлы, агенты,
  сессии, присутствие); `model/settings.ts`.
- `commands.ts`: типизированные команды (prompt с режимом, steer, abort, interrupt, set,
  модель/thinking, сессии, задачи, файлы, автодополнение, настройки, ответы Interactions,
  steering Claude).
- `model/summaries.ts`: сводки агентов уровня `summary` (раздел 7.2).
- `ClientModel`: композиция; события изменений для отрисовки. Полный транскрипт
  держится только для активной вкладки и LRU-кэша из 3 последних посещённых; остальные —
  на уровне `summary`; переключение вкладки меняет уровни подписки.
- `workbench/`: `WorkbenchModel` — общая для TUI и `app` модель экрана (раздел 10.5):
  набор и порядок вкладок (из `ui.tabs`), активная вкладка, выбранный элемент правой
  полосы по вкладкам, единственный глиф строки по таблице приоритетов раздела 10.5
  (из сводок и отметок просмотра), группировка по узлам, порядок
  элементов сессии, цель ввода (редактор / ввод в задачу / ввод в субагента / диалог), пороги
  скрытия полос в колонках (web переводит в `ch`) и **зоны экрана** — что сейчас в
  каждой: `main` (транскрипт / вывод задачи / вид субагента), `aboveEditor` (автодополнение,
  очередь), `editor` (редактор | Interaction | выбор из списка), `status`, `footer`,
  `overlays` (панель `Ctrl+\`, скрытые полосы). TUI и `app` рисуют одни и те же зоны своими
  компонентами (A23, A25).
- `keymap.ts`: идентификаторы действий и привязки по умолчанию; TUI и `app` переводят клавиши
  своей среды в действия, web-способы (перетаскивание, контекстное меню, клик) —
  те же действия; для сочетаний, занятых браузером (`Ctrl+W`, `Ctrl+T`), — запасные
  привязки в web-вкладке браузера.

### [ ] 5.3 `node`

- `node.ts`: `createNode(config, deps: { clock, spawner, fs })` — роли `local`, `hub`,
  `uplink`, `frontends`.
- `pool.ts`: процессы `harness-agent` (один на сессию), лимиты, выгрузка простаивающих
  (нет клиентов, прогона, открытых Interactions, живых задач), упорядоченная остановка
  (stdin EOF → SIGTERM группе после `ABORT_GRACE`).
- `agent-link.ts`: HAP по stdio агента; нумерация записей (`seq`); снимок при подключении
  клиента; мультиплекс агента на всех подключённых клиентов.
- `sessions.ts`: каталог сессий в `~/.harness/sessions` (через `SessionManager` pi),
  блокировки `~/.harness/locks/<sessionId>.lock` (pid + время; захват атомарный; мёртвый
  pid — блокировка снимается).
- `endpoints/unix.ts` (`~/.harness/sockets/<name>.sock`, каталог 0700, проверка длины
  пути: 108 байт Linux, 104 macOS), `endpoints/ws.ts` (HTTP + WebSocket, TLS — от
  обратного прокси/Fly), `endpoints/inproc.ts`.
- `auth.ts`: пользователи hub, токены устройств (256 бит, хранятся sha-256), ключи узлов,
  список пользователей узла; локальный unix socket доверяет владельцу каталога.
- `routing.ts` (роль hub): каталог узлов, присутствие, пересылка каналов узлу без разбора HAP.
- `uplink.ts`: исходящие связи с hub, ключ узла, переподключение с отступом на `Clock`.
- `files.ts`: просмотр, загрузка, скачивание в пределах домашнего каталога пользователя узла;
  автодополнение путей и `@file`.
- `settings.ts`: настройки (раздел 6), события изменений.
- `webapp.ts`: раздача web-сборки `app` по HTTPS (hub) и на `127.0.0.1` (`harness web-app`).
- `pairing.ts`: одноразовые коды привязки устройства (A28): срок жизни по `Clock`, обмен на
  токен устройства один раз.
- `telemetry.ts`: журнал событий JSONL (`~/.harness/log/`), без текстов сообщений и секретов.

### [ ] 5.4 `agent`

- `main.ts`: `harness-agent --session-id <id> --cwd <dir>`; HAP на stdin/stdout; диагностика —
  stderr.
- `runtime.ts`: `AgentSessionRuntime` через SDK: `agentDir = ~/.harness`, `DefaultResourceLoader`
  с бандловыми расширениями (порядок как у нынешнего лаунчера: harness первым), фабрики
  `createCodemodeExtension()` и `createMcpExtension()`; `codemode` активен, `tool_search`
  исключён (как `--tools +codemode --exclude-tools tool_search`); промпт harness передаётся
  тем же механизмом `customPrompt`, что у CLI (фаза 0, G1).
- `hap-server.ts`: команды pi RPC → методы сессии и runtime (как `runRpcMode`), записи
  `harness_*`, снимок, нумерация.
- `ui-context.ts`: `ExtensionUIContext` агента: `select/confirm/input/editor` → Interaction
  `pi-dialog`; `notify/setStatus/setWidget(строки)/setTitle` → записи HAP;
  `custom()`/`setWidget(компонент)`/`setFooter`/`setHeader` → мост компонентов; `setEditorComponent`,
  `onTerminalInput`, `setWorking*`, `setTheme` — без действия (редактор и индикаторы — клиентские).
  `mode` при `bindExtensions` — `"rpc"` (агент headless; сторонние пакеты используют свои
  RPC-пути).
- `component-bridge.ts`: создаёт компонент фабрики агента; тема — выбранная клиентом;
  `render(width)` → строки по `requestRender`; ввод клиента → `handleInput`; `done` закрывает.
  Нет подключённого клиента с возможностью `component-bridge` — `custom()` сразу возвращает
  `undefined`.
- `shutdown.ts`: EOF stdin / SIGTERM → `runtime.dispose()` → явный `process.exit`.

### [ ] 5.5 `extension` (harness внутри агента)

Переносится из нынешнего корня (`index.ts`, `gate.ts`, `prompt.ts`, `prompt.yaml`, `deps.ts`,
`settings.ts`, `update.ts`, `workarounds.ts`, `lsp/`, `tool_*.ts`, `skills/`, `browser/`) и
раскладывается по модулям:

- `core/modes.ts` (PLAN/BUILD/SIMPLE, madness, implementer, селектор режима),
  `core/gate.ts` (нынешний `changeReview`, решения gate через Interaction `gate`),
  `core/prompt.ts` + `prompt.yaml` (как сейчас + блок `claude`).
- `interactions/`: `ask(kind, payload, { signal, toolCallId })` → типизированный ответ;
  реализация — через запись HAP, которую хост доставляет (агент всегда под хостом).
- `state/`: HarnessState, записи сессии, публикация снимка `harness_state` после изменения.
- `supervisor/`: процессы (раздел 9), инструменты `task_*`, источники задач `own` и `claude`;
  субагенты видны там же как задачи особого вида.
- `subagents/`: профили, инструмент `subagent`, движки `harness` и `claude` (раздел 12).
- `tools/`: `lsp/`, `project_tree`, `send_file` (файл — клиентам через узел: скачивание или «поделиться» в `app`), `ask_secret`,
  `display_file`, `ask_user` (копия pi-ask-user, на Interaction `questions`).
- `models/`: раскрытие ссылок на модели в агенте (раздел 6.2): выбор модели при старте и смене,
  запись `harness-model-ref`, перераскрытие при открытии сессии.
- `presentation/`: чистые отрисовщики всех инструментов и записей harness; TUI-компоненты
  harness (gate, секрет, вопросы, выбор, просмотр файла, панель, редактор режимов, задачи).
  Без побочных эффектов при импорте.
- `deps.ts`: манифест бандла, MCP-серверы (lightpanda, browser; playwright и chromium-devtools —
  выключенными), отчёт зависимостей (+ строка `claude`).

### [ ] 5.6 `tui`

- Только полноэкранный режим (`TuiAltScreen`); раскладка из трёх колонок на
  `HStack`/`VStack` pi-tui (раздел 10.5): вкладки сессий, основная область, элементы сессии;
  скрытие полос по ширине — `visible(viewport)`; клики — `MouseRegion`.
- Основная область из компонентов pi: транскрипт (`ScrollView` с `followEnd`, догрузка
  истории при прокрутке вверх, свой поиск), очередь, редактор (`CustomEditor` +
  `PerMessageModeEditor` harness), footer (модель · thinking · ctx% · стоимость · cwd · узел),
  окна выбора (модель, thinking, сессия, дерево, настройки, вход провайдера, тема);
  виды задачи и сессии Claude (раздел 10.5); панель `Ctrl+\` (madness, simple, implementer,
  обновление, зависимости) — overlay поверх правой полосы.
- Всё состояние экрана — из `WorkbenchModel`, действия — из `keymap.ts`; своего состояния экрана
  в `tui` нет.
- Программный статус терминала (`setProgramStatus`, OSC 7501) и заголовок: «ждёт оператора»,
  когда открыта Interaction в любой вкладке.
- Презентационный runtime: загружает пакеты бандла через загрузчик pi и берёт регистрации
  отрисовщиков (`registerTool` renderCall/renderResult, `registerToolRenderer`,
  `registerEntryRenderer`, `registerMessageRenderer`, `registerMarkdownTransformer`);
  остальные регистрации — инертны. Отрисовщики встроенных инструментов — из
  `create*ToolDefinition()`.
- Interactions рисуются компонентами `extension/presentation`; `pi-dialog` — компонентами
  выбора/ввода pi; мост компонентов — прокси-компонент в overlay.
- Возможности, требующие машины агента, — командами протокола: автодополнение путей и
  `@file`, `!`-bash оператора, вход провайдера (URL + вставка кода), экспорт.

### [ ] 5.7 `app`

Expo + React Native (раздел 10), на `client`. Цели: iOS и Android (нативные приложения,
публикуются в магазинах), web (`react-native-web`, раздаёт hub), десктоп (та же web-сборка в
окне `harness web-app`). Переносит то, что давал Telegram с телефона: файлы туда-обратно
(выбор файла, фото, «поделиться»), голосовой ввод (запись в приложении, транскрипция
`gpt-4o-transcribe` на узле, как сейчас), вход провайдера (URL + вставка кода), секреты,
журналы для админов hub.

### [ ] 5.8 Telegram (выведен)

Нынешний Telegram-фронтенд (`remote/telegram/*`), Mini App (`remote/app/`), их тесты и
поддельный Bot API переносятся `git mv` в `experiments/telegram/` с README о том, что это
история. `experiments/` не входит в workspaces, сборку, тесты и проверки языка и
документации.

### [ ] 5.9 `cli`

| Команда | Действие |
|---|---|
| `harness` | TUI (A9). |
| `harness node [--name N]` | Узел (по умолчанию `default`). |
| `harness hub [--name N]` | Узел с ролью hub; раздаёт web-сборку `app`. |
| `harness web-app` | Web-сборка `app` в нативном окне (раздел 10.6). |
| `harness remote add <name> <url>` / `remove` / `list` | Удалённые hub/узлы клиента; токен вводится скрыто, хранится в `~/.harness/remotes.json` (0600). |
| `harness hub user add/remove/list`, `harness hub device add <user> --name <d>` (печатает QR привязки, A28) / `revoke`, `harness hub node add <name> --users a,b` / `revoke` | Администрирование hub; токен устройства и ключ узла печатаются один раз. |
| `harness claude-bridge {mcp\|hook}` | Служебная, вызывается только Claude: stdio-MCP и командный хук `PreToolUse` ↔ unix socket агента (разделы 12.4–12.6). |

### [ ] 5.10 `testkit`

Раздел 16.2. Подпакеты: `stand/` (топология, процессы, сценарная модель, часы),
`control/` (управляющий сокет стенда и CLI `harness-test`), `drivers/` (`tui`, `web`, `native`,
`raw`), `capture/` (растеризатор TUI, снимки web и native, отчёт), `gallery/` (TUI и `app`), `compare/`,
`fixtures/` (общие состояния для галерей и тестов).

## [ ] 6. Данные: `~/.harness`

```
~/.harness/
  .gitignore            # "*"
  settings.json         # настройки pi (модель, thinking, …) и harness (раздел 6.1)
  auth.json             # учётные данные провайдеров (pi)
  harness.json          # умолчания новых сессий: variant, madness, implementer
  remotes.json          # подключения клиента (0600)
  subagents/<name>/     # профили субагентов пользователя (раздел 12.1)
  sessions/             # сессии pi
  locks/                # блокировки сессий
  sockets/<name>.sock   # каталог 0700
  nodes/<name>.json     # конфигурация узла (если не из NixOS-модуля)
  hub/                  # только у hub: users.json, devices.json (хэши), nodes.json (хэши ключей)
  users/<user>/settings.json   # только у hub: настройки UI пользователя hub
  themes/               # темы (формат pi)
  log/                  # журнал узла
  tmp/                  # загрузки из приложения
```

Инвариант: одну сессию обслуживает не больше одного агента среди всех узлов пользователя на
машине (блокировка).

### [ ] 6.1 Настройки

- `ui.theme` (по умолчанию тёмная тема pi), `ui.density`.
- `ui.tabs`: упорядоченный набор открытых сессий `[{ node, sessionId, seen }]` (`seen` — отметки
  просмотра сессии и её элементов для глифов `✓`/`✗`, раздел 10.5), общий для всех UI
  пользователя (A22); вкладка недоступной сессии (узел офлайн, сессия удалена) остаётся с
  отметкой `⊘` и причиной до явного закрытия.
- `ui.web.panes` (ширины панелей web), `ui.web.notifications` (системные уведомления
  браузера: выключены по умолчанию).
- `ui.font.chrome`, `ui.font.chat`: `{ family: "jetbrains-mono" | "iosevka-term" | "terminus" | "system", size }`;
  для `terminus` размер — из кеглей 12, 14, 16, 18, 20, 22, 24, 28, 32 px.
- `harness.tasks.notify`: умолчание `wake` | `queue` | `none` (A4).
- Хранение (A16): через hub — `users/<user>/settings.json` hub; без hub — `settings.json`
  узла. Команды `settings_get` / `settings_set`, событие `settings_changed` всем клиентам
  пользователя.

### [ ] 6.2 Ссылки на модели (M1, M2)

- Синтаксис: `provider/<семейство | id>[:<thinking>]`. Действует везде, где harness принимает
  модель: модель по умолчанию в настройках, область переключения моделей, `/model` и
  выбор модели в TUI и `app`, `--model` у `harness`, профили субагентов. pi всегда получает
  раскрытый id.
- `protocol/model-ref.ts` — чистая изоморфная `resolveModelRef(ref, catalog) → { model, thinking } |
  { error: "not_found" | "ambiguous", candidates }` (агент и UI раскрывают одинаково):
  1. Точный id провайдера — как есть.
  2. Иначе семейство: кандидаты — модели провайдера, в id которых семейство — отдельный
     токен (разделители `-`, `.`, `/`); датированные снимки (`-YYYYMMDD`) исключаются.
  3. Кандидаты группируются по базе — id без числовых токенов (`claude-opus`, `gpt-sol`);
     берётся группа с наименьшим числом токенов (варианты вроде `claude-opus-fast` в неё не
     попадают); две группы равной длины — `ambiguous`.
  4. В группе — максимум по числовому кортежу версии: `[5,5] > [5] > [4,8]`,
     `[6,2] > [6,1] > [6]`. Примеры на нынешнем каталоге: `anthropic/opus` → `claude-opus-5-5`,
     `openai-codex/sol` → `gpt-6.2-sol`.
- Когда: в момент выбора модели (новая сессия, запуск субагента, смена модели);
  идущая сессия модель сама не меняет. Сессия хранит запись `harness-model-ref { ref, resolved }`
  рядом с выбором модели pi.
- Модель исчезла из каталога (M2): при открытии сессии ссылка раскрывается заново,
  новая модель выбирается, запись обновляется, в транскрипт и статусную строку —
  «`opus`: claude-opus-5-5 → claude-opus-5-6». Сессия с точным id без ссылки — как сейчас в pi.
- UI показывает ссылку и раскрытие: `anthropic/opus → claude-opus-5-5` (footer, выбор модели,
  профили субагентов).
- Движок `claude` переводит ссылку в флаги Claude Code (раздел 12.4).

## [ ] 7. Протоколы

Кадрирование — JSONL (5.1). Каждое соединение начинается рукопожатием `hello`
(`protocol`, `harness`-версия, роль, возможности клиента: `component-bridge`, `images`,
`ansi`), ответ — `welcome` (идентичность, узел/hub, версии) или ошибка `version_mismatch`.

### [ ] 7.1 HAP (агент ↔ узел, stdio)

- pi RPC без изменений: команды (`prompt`, `steer`, `follow_up`, `abort`, `new_session`,
  `get_state`, `get_messages`, `set_model`, `cycle_model`, `get_available_models`,
  `set_thinking_level`, …, `bash`, `abort_bash`, `get_session_stats`, `export_html`,
  `switch_session`, `fork`, `clone`, `get_entries`, `get_tree`, `set_session_name`,
  `get_commands`), ответы, события `AgentSessionEvent` (включая `entry_appended`).
- Добавлено harness:
  - `harness_snapshot { limit }` → `{ seq, entries (последние limit), cursor?, partialMessage?,
    state, interactions, tasks }`; после него — записи с `seq` > снимка (согласованность:
    снимок + хвост); `harness_entries_before { cursor, limit }` → `{ entries, cursor? }` —
    догрузка истории.
  - `harness_subagent_send { session, text }` — steering живого субагента `claude` оператором
    (раздел 12.9); ошибка `not_found`, если сессия не жива. Субагент `harness` — обычный
    агент узла, steering — обычный `steer` в его канал.
  - `harness_spawn_child { profile, brief, parent }` (агент → узел) → `{ agentId, sessionId }`:
    дочерний агент движка `harness` (раздел 12.3).
  - `harness_state` (полный снимок HarnessState после изменения).
  - `harness_prompt { text, mode: "plan" | "build" | "simple", images? }` — режим явный.
  - `harness_set { variant? , madness?, implementer? }`, `harness_interrupt { reason }` (`/-`).
  - `harness_interaction_request { id, kind, payload, toolCallId? }`,
    `harness_interaction_response { id, value }`,
    `harness_interaction_closed { id, reason: "answered" | "cancelled" | "expired" | "ended" }`.
    `kind`: `gate`, `secret`, `questions`, `choice`, `display`, `pi-dialog`.
  - `harness_component_open { id, overlay, options }`, `harness_component_render { id, lines }`,
    `harness_component_input { id, data }`, `harness_component_resize { id, width, theme }`,
    `harness_component_close { id }`.
  - `harness_ui { method: notify | setStatus | setWidget | setTitle, … }`.
  - `harness_task_start/stop/subscribe/unsubscribe`, `harness_task_event { id, state }`,
    `harness_task_output { id, offset, chunk }` (только подписанным).
  - `harness_complete { kind: "path" | "file", prefix }` → варианты.

### [ ] 7.2 Протокол узла (клиент ↔ узел)

Каналы: `open { channel, target }`, `data { channel, record }`, `close { channel, reason }`.
Канал `control` узла: `nodes_list`, `sessions_list`, `agents_list`, `agent_start { cwd, sessionId? }`,
`agent_attach { agentId, level: "summary" | "full" }`, `agent_level { agentId, level }`,
`agent_detach`, `agent_close`, `files_list/get/put/mkdir`, `settings_get/set`, `presence`.

- `full`: канал агента несёт HAP (снимок + живой поток).
- `summary`: только `harness_summary { status: "idle" | "running" | "waiting" | "error", mode, title,
  unread, waiting, tasks: { running, failed }, lastActivity }`; узел считает сводку из HAP сам и
  шлёт не чаще 4 раз в секунду на агента.
- Агенты от подписок не зависят: отключение вкладки — `agent_detach`, агент работает дальше; пул
  выгружает только простаивающих.

### [ ] 7.3 Протокол hub

Тот же протокол узла; `target` включает `node`. Hub проверяет токен клиента и доступ к узлу
(пользователь в списке узла), пересылает каналы по связи узла; узел повторно проверяет
пользователя из кадра `open`. Связь узел → hub: `hello` с ключом узла, затем мультиплекс
каналов, которые hub открывает на узле. Узел офлайн → `node_offline`.

### [ ] 7.4 Мультифронтенд

Агент может быть подключён к любому числу клиентов. Interaction закрывается первым ответом;
остальным — `closed: answered`. Мост компонентов показывается на всех клиентах с
возможностью `component-bridge`, ввод принимается от любого, `done` закрывает у всех.

## [ ] 8. Ядро harness: Interactions и состояние

- Interactions заменяют все прямые `ctx.ui.custom` harness: gate (`index.ts` `askGateDecision`),
  секрет (`tool_ask_secret.ts` `askOperator`), `ask_user`, `display_file`, диалог ожидания
  Claude. Семантика решений gate (Allow / Allow with comment / Reject with comment / Stop;
  комментарии steer и в результат) не меняется; комментарий одобрения переносится из
  `pendingGateComments` в `details` результата (отрисовщики чистые).
- Секрет: значение идёт клиент → узел → агент по TLS/unix; в память сессии
  (`sessionSecrets`), маскирование результатов — как сейчас.
- HarnessState: `{ mode, variant, madness, implementer, model: { ref, resolved }, tasks[], subagents[] }`;
  долговечная часть — записи сессии (`harness-mode`, `harness-variant`, `harness-madness`,
  `harness-implementer`, `harness-model-ref`, `harness-task`, `harness-subagent`).
- Режимы и gate: правила `gate.ts` `changeReview` без изменений; `hasUI` для gate — «есть
  подключённый клиент, способный ответить»; без клиентов BUILD ждёт ответа (Interaction
  остаётся открытой до подключения или остановки прогона).
- Профиль `server` упраздняется: поведение определяется возможностями клиентов, а не
  профилем процесса; `skills/server` загружается, когда узел объявлен серверным в конфиге.

## [ ] 9. Фоновые задачи (Supervisor)

- Процесс: отдельная группа, `cwd`, окружение сессии + секреты, лог
  `<workspace сессии>/tasks/<id>.log` (модель читает `read`), состояния
  `starting → running → (waiting) → exited | killed | failed`, код выхода, время.
- Инструменты модели:
  - `task_start { command, cwd?, name?, notify?: "wake" | "queue" | "none", wait_for?: { exit? , pattern?, timeout_s? } }`
    → `id`; `notify` по умолчанию — `harness.tasks.notify`.
  - `task_status { id? }` (все или одна), `task_output { id, offset?, tail_lines?, grep? }`,
    `task_wait { id, exit?, pattern?, timeout_s }` (возврат по первому событию),
    `task_input { id, text }` (stdin), `task_stop { id, signal? }`.
  - Правила — как у bash (режимы, gate не применяется к bash), `executionMode` — как у bash.
- Уведомления: событие задачи (выход; совпадение `pattern`) →
  `wake`: `pi.sendMessage({ customType: "harness-task", display: true, content }, { triggerTurn: true, deliverAs: "followUp" })`
  — прогон в текущем режиме, если агент свободен, или подмешивание в идущий; `queue`:
  `deliverAs: "nextTurn"`; `none`: только состояние.
- Источники задач — один интерфейс `TaskSource { list, output(offset), stop }`: `own`
  (процессы harness: `task_*`, сам процесс Claude) и `claude` (фоновые задачи сессии Claude,
  отражённые из её потока; раздел 12.8). Модель, оператор и уведомления работают с обоими
  одинаково.
- Жизненный цикл: состояние в `globalThis` (переживает `/reload`); `session_shutdown` —
  остановка групп; пул узла считает агента с живыми задачами занятым.
- Оператор: список, вывод, остановка — в правой полосе и виде задачи TUI и `app` (раздел 10.5).

## [ ] 10. Приложение `app` (iOS, Android, web, десктоп)

В разделах 10.1–10.5 и в решениях A23/A25 «web» означает приложение `app` на любой цели;
детали конкретной цели помечены (web — браузер и окно десктопа; native — iOS и Android).
Раскладка, зоны, паттерны и дух — одни на всех целях; различаются детали исполнения.

### 10.1 Принципы

**Правило (A25): место и поток — общие с TUI, исполнение — своё.** Web не имитирует
терминал и не уходит к общим web-конвенциям: раскладка, зоны экрана и места появления —
как в TUI (из `WorkbenchModel`), а мышь, наведение, выделение, перетаскивание, прокрутка и качество
отрисовки — по-webовски.

| Паттерн | TUI | Web (то же место, другие детали) |
|---|---|---|
| Автодополнение (`/команды`, `@file`, пути) | блок над редактором на его ширину | тот же блок над полем; мышь, прокрутка, подсветка совпадений; не список у курсора |
| Interactions (gate, секрет, вопросы, выбор, ожидание лимита) | занимают зону редактора, транскрипт над ними | тот же блок в зоне редактора; фокус удерживается в блоке; diff gate — встроенный просмотрщик; не модальное окно по центру |
| Выбор модели, thinking, сессии, дерева | список в зоне редактора | то же место; фильтр по вводу, мышь |
| Команды | `/` в редакторе | `/` в поле ввода; палитры команд нет |
| Уведомления и статус | статусная строка над footer | та же строка; тостов нет; вне вкладки браузера — заголовок, favicon, системные уведомления |
| Панель `Ctrl+\` | overlay поверх правой полосы | так же |
| Узкий экран | полосы скрыты, вызываются клавишей как overlay | так же; на касание — тот же overlay кнопкой или жестом |
| Транскрипт, редактор, footer, три колонки | как в 10.5 | та же раскладка; панели меняют ширину перетаскиванием |

**Дух (общее с TUI):** тёмная тема pi — единственный источник цветов; моноширинные
шрифты двух зон (10.3); плотность: основной кегль 13px, межстрочный ≈1,35, малые отступы,
без пустого воздуха; рамки 1px токенами `border*`; без теней и градиентов; скругление
не больше 2px; глифы состояний `● ◆ ✓ ✗ ⊘` и braille-спиннер; режим — цвет рамки редактора;
полное управление с клавиатуры и подсказки клавиш; состояния — только токенами.

**Не имитируется:** кнопки вида `[ Allow ]` (настоящие кнопки с `Kbd`); жёсткая сетка
в `ch` и «одна строка на запись»; рамка с заголовком в линии как единственный способ группировки.

**Web-детали (способы вызвать общие действия или отразить общие состояния, раскладку не
меняют):**
- строки полос: подсказка при наведении (полный путь, состояние), контекстное меню (закрыть,
  открыть в новом окне, скопировать id, остановить), перетаскивание вкладок (порядок
  `ui.tabs`), средняя кнопка закрывает вкладку; ширина панелей — перетаскиванием, сохраняется
  в настройках UI;
- транскрипт: выделение и копирование, кнопка копирования у кода и вывода, кликабельные
  ссылки и пути (путь открывает просмотр файла), сворачивание строк инструментов кликом, diff
  рядом при большой ширине, увеличение изображений, «вниз к новому» при прокрутке вверх;
- поле ввода: перетаскивание и вставка файлов (загрузка на узел `files_put` → `@file`),
  вставка изображений;
- адреса и окна: deep link `#/<узел>/<сессия>/<элемент>`, «назад/вперёд» браузера
  по выбору вкладок и элементов; несколько окон — независимые клиенты с общим `ui.tabs`;
- внимание: заголовок вкладки браузера и favicon с числом ожидающих диалогов (`◆ 2`);
  системные уведомления браузера о `◆` и завершении — по согласию в настройках;
- native (iOS, Android): долгое нажатие — то же контекстное меню; свайп от края — overlay
  полос; «поделиться» и выбор файла/фото вместо перетаскивания; кнопка голосового ввода
  в редакторе; выделение части текста на iOS — read-only `TextInput` (`*.ios.tsx`); аппаратная
  клавиатура (iPad, Android) — та же карта действий; deep links `harness://<узел>/<сессия>/<элемент>`;
  safe area и клавиатура системы не перекрывают редактор;
- касание: цели не меньше 32px при той же плотности текста; тема всегда наша, не системная;
- доступность: роли и доступные имена (на них стоят тесты), видимый фокус,
  `prefers-reduced-motion`; анимаций, кроме спиннера, нет.

### [ ] 10.2 Токены

Генератор: тема pi (`dark.json` или `~/.harness/themes/*.json`) → типизированный объект
семантических токенов (все токены pi + `pageBg`, `cardBg`) для `StyleSheet`; тема приходит с узла в
настройках и применяется без перезапуска через контекст темы. В компонентах нет собственных
цветов (проверка: тест на литералы цвета в `packages/app/src`).

### [ ] 10.3 Шрифты

Nix: `jetbrains-mono`, `iosevka-bin.override { variant = "SGr-IosevkaTerm"; }`,
`terminus_font_ttf` → `pyftsubset` (латиница, кириллица, пунктуация, U+2190–21FF,
U+2500–257F, U+2580–259F, U+25A0–25FF, U+2700–27BF, U+2800–28FF) → TTF (native) и woff2
(web); начертания regular/bold/italic (у Terminus курсива нет — не подделывается); лицензии OFL
рядом; подключение — `expo-font`, интерфейс не показывается до загрузки шрифтов.

### [ ] 10.4 Компонентная база

Компоненты — на примитивах RN (`View`, `Text`, `Pressable`, `TextInput`, виртуализированные
списки); платформенные детали — в `*.web.tsx` / `*.ios.tsx` / `*.android.tsx` рядом с общим файлом,
только где исполнение действительно различается. Доступность — `accessibilityRole`/`accessibilityLabel`
(на web — ARIA, на native — дерево доступности; на них стоят тесты).

1. Основы: токены, шрифты, единицы и стили плотности и состояний.
2. Примитивы: `Text`, `Row`, `Stack`, `Frame`, `Rule`, `Kbd`, `Chip`, `Spinner`, `ScrollArea`, `Ansi`.
3. Ввод: `Button` (настоящая кнопка с `Kbd`), `Toggle`, `SelectList`, `Input`, `MaskedInput`,
   `Editor`, `DropZone` (web), `FilePicker` и `VoiceInput` (native).
4. Зоны и накладки (по зонам `WorkbenchModel`): `EditorZone` (редактор | Interaction | выбор
   из списка), `AboveEditorBlock` (автодополнение, очередь), `Overlay` (панель `Ctrl+\`, скрытые
   полосы), `StatusLine`; детали — `Tooltip`, `ContextMenu`, `Resizer`. Модальных окон по
   центру, палитры команд, тостов и отдельных выезжающих панелей нет (A25).
5. Содержимое: `Markdown`, `Code`, `DiffView` (построчно и рядом), `ImageViewer`, `FileView`,
   `CopyButton`, `JumpToLatest`.
6. Транскрипт: `UserMessage`, `AssistantMessage`, `Thinking`, `ToolRow`, `BashExecution`,
   `CustomMessage`, `ModeEntry`, `FinishedBanner`, `CompactionSummary`, `BranchSummary`,
   `SkillInvocation`; реестр отрисовщиков: read, bash, edit, write, grep, find, ls, codemode,
   `lsp_*`, `project_tree`, `task_*`, `subagent`, `ask_user`, `ctx_*`, fallback.
7. Interactions (блоки `EditorZone`): `Gate`, `Secret`, `Questions`, `Choice`, `DisplayFile`, `PiDialog`.
8. Оболочка (раздел 10.5): `AppFrame` (три колонки на flex), `Pairing` (QR, A28), `SessionTabs`,
   `SessionItems`, `SessionView` (транскрипт с окном видимости и догрузкой истории, редактор,
   footer), `TaskView`, `SubagentView` (вид субагента `claude`; субагент `harness` — `SessionView`),
   `NewSession` (узел, каталог, существующая сессия), выбор
   модели/thinking/дерева, `Settings`. Состояние и действия — из `WorkbenchModel` и `keymap.ts`.

Галерея — маршрут сборки со всеми компонентами во всех состояниях на общих фикстурах
testkit (включая записи реальных сессий); инструмент визуального контроля и ревью (раздел 16.3),
не тест: вид — деталь дизайна, его смотрят на скриншоте.

`custom()` чужого кода агента в web недоступен (сообщение); для известных случаев —
типизированное представление от адаптерного расширения агента (по решению на случай).

### [ ] 10.5 Мультисессионный экран (TUI и `app` одинаково)

```
┌ сессии ───────────┐┌ основная область ─────────────────────┐┌ внутри сессии ────┐
│● laptop/harness   ││ транскрипт (ScrollView, followEnd)    ││● сессия           │
│◆ hub/infra        ││                                       ││● dev-server  12m  │
│✓ work/api         ││                                       ││✓ tests     exit 0 │
│  work/docs        ││                                       ││◆ claude a1b2      │
│  + новая          ││ редактор (рамка цвета режима)         ││●   subagent       │
└───────────────────┘│ footer                                │└───────────────────┘
                     └───────────────────────────────────────┘
```

- Глиф строки — единственный значок и всегда первый слева, в обеих полосах. Нет маркера выбора
  (выбранная строка — фон `selectedBg`), нет стрелок вложенности (вложенность — отступом), нет
  отметок справа. Режим (PLAN, BUILD, SIMPLE) — цвет имени, не значок. Из нескольких
  состояний показывается самое важное (вычисляет `WorkbenchModel`):

  | Глиф | Состояние | Приоритет |
  |---|---|---|
  | `⊘` | недоступна (узел офлайн, сессия удалена) | 1 |
  | `◆` | ждёт оператора (открыта Interaction, в том числе выбор при ожидании лимита Claude) | 2 |
  | `✗` | ошибка или неудача, не просмотрена | 3 |
  | `●` | работает | 4 |
  | `✓` | завершилась, не просмотрена | 5 |
  | пробел | простаивает или всё просмотрено | 6 |

  Просмотр (элемент стал активным и показан) гасит `✓` и `✗` в пробел; отдельной отметки
  «непрочитано» нет. Отметки просмотра — в `ui.tabs` вместе с вкладками, поэтому общие
  для всех UI пользователя.
- Левая полоса — вкладки `ui.tabs`, по строке: глиф, `узел/имя` (имя сессии или имя
  каталога) цветом режима; при нескольких узлах — строки-заголовки узлов; в конце «+ новая».
- Правая полоса — содержимое активной сессии, всё на одном уровне: первой строкой — сама
  сессия (глиф тот же, что у её вкладки), затем фоновые задачи (`own` и `claude`) и
  субагенты (`<профиль> <id>`); вложенные субагенты и подагенты Claude (`local_agent`) —
  отступом под своим субагентом. Строка — глиф,
  имя и справа приглушённым текстом краткое состояние (код выхода, время работы).
- Основная область по выбранному элементу: сессия — транскрипт, редактор, footer; задача —
  живой вывод (ANSI, followEnd) и действия (остановить, ввод в stdin, ждать); субагент
  `harness` — полный вид сессии; субагент `claude` — его поток (шаги, текст, вложенные вызовы,
  отказы в правах); в обоих — строка steering (C12): активна только для живого субагента,
  у остановленного — неактивна с подсказкой «продолжить может вызывающая модель».
- Зоны основной области (сверху вниз): `main`, `aboveEditor` (автодополнение и очередь —
  блоком на ширину редактора), `editor` (редактор, либо Interaction, либо выбор из списка
  на его месте), `status`, `footer`; поверх — `overlays`. Одинаково в TUI и `app`.
- Узкий экран: правая полоса скрывается меньше 110 колонок, левая — меньше 80 (web — те
  же пороги в `ch`); скрытые полосы вызываются как overlay — клавишей, в web ещё кнопкой
  или жестом.
- Клавиши по умолчанию: `Alt+1…9`, `Ctrl+PgUp/PgDn` — вкладки; `Alt+↑/↓` — элементы
  правой полосы; `Ctrl+T` — новая сессия; `Ctrl+W` — закрыть вкладку (`agent_detach`).
- Interaction в неактивной сессии: `◆` у вкладки и уведомление в статусной строке; фокус не
  перехватывается, диалог открывается при переключении на вкладку.
- Производительность: `full` — только активная вкладка и LRU из 3; снимок частями; вывод
  задачи — по подписке; отрисовывается только активная вкладка; TUI — кэш кадров pi-tui
  (прокрутка O(высоты экрана)), `app` — виртуализированный список транскрипта
  (проверяется в G8).
- Паритет (A23, A25): всё выше, включая зоны, — состояние и правила `WorkbenchModel` и
  `keymap.ts`; TUI и `app` только рисуют. Платформенные детали (10.1) раскладку не меняют.

### [ ] 10.6 Десктоп: `harness web-app`

Веб-сборка `app` в нативном окне (A13); нативный десктоп на RN — будущий этап.

- Главный поток: встроенный узел или подключение к socket (A9); HTTP/WebSocket на
  `127.0.0.1:<случайный порт>`; одноразовый токен во `#fragment` URL.
- Worker: окно webview — своя обвязка `bun:ffi` к libwebview 0.12.0 (собирается в Nix против
  GTK4 + WebKitGTK 6 на Linux, WKWebView на macOS): `create`, `navigate`, `set_title`,
  `set_size`, `run`, `terminate`, `destroy`; JS-callback'и FFI не используются.
- Закрытие окна → `run()` возвращает → Worker → процесс завершается.

### [ ] 10.7 Сборка и публикация

- Expo (SDK 58, RN 0.88), prebuild без облака EAS; Metro для всех целей; у `packages/app`
  свой `node_modules` от bun (A17).
- Web-сборка и Android (APK/AAB, `androidenv` nixpkgs, зависимости Gradle зафиксированы) — в Nix;
  iOS — `xcodebuild` на macOS вне песочницы (Xcode не в Nix).
- `nix/release-app.sh`: сборка, подпись и выгрузка — TestFlight/App Store (`xcrun altool` или
  App Store Connect API) и Google Play (Play Developer API); ключи подписи и ключи API магазинов —
  в cage (A26); CI релизов — macOS-раннер для iOS.
- Для магазинов: политика конфиденциальности (`docs/legal/privacy.md`): приложение говорит
  только с hub пользователя, мы данных не собираем.
- Версия приложения и версия протокола сверяются в `harness_hello` (раздел 7): приложение
  из магазина обновляется независимо от hub, при несовместимости — понятное сообщение какую
  сторону обновить.

## [ ] 11. Перенос нынешних возможностей

- Режимы, madness, simple, implementer, панель, статус-строка, баннер завершения, системный
  промпт в транскрипте (первый прогон), `/-`, последовательные write/edit/bash — в
  `extension` (логика) и `tui`/`app` (вид).
- `update.ts`: проверка master при старте — в `cli`/`tui`; обновление: установка через
  `nix profile` — `nix profile upgrade`, затем перезапуск UI и встроенного узла; узлы под
  systemd/NixOS — сообщение о пересборке системы.
- macOS: `harness-open`/Quick Action открывают `harness` в Ghostty (как сейчас `pi`).

## [ ] 12. Субагенты

### [ ] 12.1 Профили и источники (S1, S2)

```
<источник>/subagents/<name>/
  SUBAGENT.md    # frontmatter — профиль; тело — роль (инструкция субагенту)
  SKILL.md       # брифинг для вызывающей модели (скилл subagent-<name>)
```

Frontmatter `SUBAGENT.md`:

```yaml
name: explorer
description: Собирает сводку по кодовой базе; ничего не меняет
engine: harness            # harness | claude
model: openai-codex/sol:medium   # ссылка на модель (раздел 6.2)
mode: plan                 # plan | build | simple | inherit (режим вызывающего)
tools: { allow: [...], deny: [...] }   # имена и маски; ctx_* запрещены всегда
background: false          # умолчание для вызова
notify: wake               # wake | queue | none
subagents: []              # кого сам может звать (S6)
```

- Источники: `.harness/subagents/` проекта (только если проект доверенный по правилам pi) →
  `~/.harness/subagents/` → бандл `packages/extension/subagents/bundled/`; совпадение имени —
  побеждает более ранний.
- Проверка при загрузке: схема frontmatter; ссылка на модель раскрывается; для `claude` —
  `:thinking` из `low | medium | high | xhigh | max`; имена в `subagents` существуют и не дают
  цикла. Профиль с ошибкой не регистрируется, ошибка — в отчёте зависимостей и в статусной
  строке.
- Набор профилей фиксируется на старте прогона (как весь промпт harness); изменения файлов
  действуют со следующего прогона.
- Брифинг-скиллы регистрируются как обычные скиллы pi (`resources_discover`): в `<skills>`
  модель видит только описание, читает текст, когда делегирует. Описание начинается с
  «Only on the operator's explicit request».
- Бандловые профили (S4):
  - `builder`: `engine: claude`, `model: anthropic/opus:medium`, `mode: inherit`. Роль — исполнитель
    согласованного плана (блок `claude` из `prompt.yaml`, 12.4). Брифинг: передать план
    целиком и самодостаточно (файлы, символы, поведение, проверки), после — ревью
    `git diff` и проверки самой вызывающей моделью, исправления — в ту же сессию.
  - `explorer`: `engine: harness`, `model: openai-codex/sol:medium`, `mode: plan`, `tools.allow:
    [read, bash, project_tree, lsp_definition, lsp_type_definition, lsp_implementations,
    lsp_references, lsp_hover, lsp_symbols, lsp_call_hierarchy, lsp_type_hierarchy,
    lsp_diagnostics, lsp_workspace, web_search, web_fetch]`. Роль — сводка по кодовой базе
    фиксированной структуры: назначение, структура и модули, контракты и точки входа,
    данные, сборка и тесты, соглашения, ответы на вопросы брифа — с путями и строками.
    Брифинг: задать охват (каталоги, подсистемы) и конкретные вопросы.

### [ ] 12.2 Инструмент `subagent` и правила вызова

- `subagent { agent, task, continue?, session?, background? }`: `agent` — перечисление имён
  загруженных профилей; `task` — самодостаточный бриф (субагент не видит разговора
  вызывающего; при продолжении — что дальше и что изменилось с его остановки);
  `continue` / `session` — взаимоисключающие (последняя или названная сессия этого профиля;
  запись с другим cwd — ошибка); `background` — умолчание из профиля, `true` — итог
  приходит уведомлением по `notify` профиля. Несколько фоновых субагентов работают
  одновременно; нефоновый вызов — `executionMode: "sequential"`.
- Правило вызова (S5) — `prompt.yaml`, `guidelines`: «Call `subagent` only when the operator
  explicitly asks for it in this conversation, or when the active-mode selector names an
  implementer — the operator's standing request to implement through that subagent, and for
  implementation only. Never launch a subagent on your own initiative.» В роль каждого
  субагента с непустым `subagents` — «call a subagent only when the brief explicitly says so».
- Вложенность (S6): инструмент `subagent` у субагента есть только при непустом
  `subagents`, перечисление `agent` — именно эти профили; глубина считается из цепочки
  родителей, на глубине 2 инструмента нет.
- Переключатель implementer (C1): запись `harness-implementer { profile | null }`, умолчание в
  `harness.json`, селектор `<active-mode mode="build|simple" implementer="builder" />`; PLAN — без
  атрибута. Промпт режимов (build/simple) при implementer: реализация и исправления —
  `subagent { agent: <профиль> }` по его брифинг-скиллу; недоступность — стоп и отчёт (C2);
  выбор оператора «продолжить в harness» — продолжить с места остановки по `git diff` и
  плану; возвращая работу субагенту — назвать изменения с его остановки.
- Интерфейс движка (`subagents/engine.ts`): `SubagentEngine.start(profile, brief, ctx) →
  SubagentSession { send(text), interrupt(), stopTask(id), events: AsyncIterable<SubagentEvent>,
  close() }`; `SubagentEvent` — нормализованные события: `init`, `step`, `text`,
  `rate_limit_wait { window, resetsAt }`, `rate_limit_over`, `task { id, state, outputFile? }`,
  `tasks_live`, `overage`, `usage { cost }`, `result`.
- Итог — блок передачи работы (12.9) для любого движка. Стоимость: у каждого субагента
  своя; в строке правой полосы и в баннере завершения прогона вызывающего — сумма с
  разбивкой.
- UX: субагенты — строки правой полосы своей сессии на одном уровне с задачами
  (`● explorer r3f2`, `◆ builder a1b2`), их вложенные субагенты и подагенты Claude — отступом
  (раздел 10.5). Вид: движок `harness` — полный вид сессии (транскрипт, редактор для
  steering, footer с его моделью); `claude` — вид Claude. Субагента `harness` можно открыть
  отдельной вкладкой. Экран «Субагенты» в настройках (TUI и `app`): профили с
  источником, движком, ссылкой и раскрытой моделью, ошибки загрузки, просмотр
  `SUBAGENT.md`/`SKILL.md`. Запуска из UI нет (S5).

### [ ] 12.3 Движок `harness`

- Агент просит узел записью HAP `harness_spawn_child { profile, brief, parent }`; узел запускает
  дочерний `harness-agent` в том же cwd: новая сессия pi с `parentSession`, модель и thinking —
  из раскрытой ссылки, инструменты — набор профиля, промпт harness + роль профиля,
  режим — из профиля (`inherit` — режим вызывающего), madness наследуется; секреты
  сессии не передаются.
- Родитель подписан на ребёнка как клиент узла (`full`) и переводит его события в
  `SubagentEvent`; итог — последний ответ ассистента ребёнка после `agent_end`.
- Interactions ребёнка (gate и др.) идут оператору с подписью «субагент <имя>» и `◆` у его
  строки и строки родительской сессии.
- Steering (C12) — обычный steer в сессию ребёнка; родитель видит его в потоке событий
  и помечает «оператор → <имя>: …».
- Остановка: `/-`, Esc и завершение нефонового вызова — `abort` ребёнка; пул узла
  останавливает детей закрытого родителя, кроме фоновых: те дорабатывают и отчитываются
  уведомлением при следующем открытии родителя. Продолжение — новый промпт в ту же
  сессию pi.

### [ ] 12.4 Движок `claude`: промпт и модули

- Правила для Claude (C4): `prompt.yaml` блок `claude` (`preamble` — исполнение брифа: как
  согласовано, невыполнимо — объяснить в отчёте, не коммитить и не пушить без указания,
  scratch — `{{WORKSPACE_TMP}}`, финальный отчёт; `rules`; `guidelines: [output_capture,
  wait_on_completion, search_scope, untrusted_data]`; `sections: [engineering_principles]`);
  `claudeSystemPrompt(workspaceRoot, profile)` в `core/prompt.ts` добавляет роль профиля и
  правила (`promptGuidelines`/`tool_guidelines`) инструментов harness, доступных профилю; имена
  проверяются при загрузке.
- Модель: ссылка на семейство (`anthropic/opus`) → `--model opus` (алиас Claude Code: последняя
  модель семейства, доступная аккаунту); точный id → `--model <id>`; `:thinking` →
  `--effort`. Фактическая модель — из `system/init`, показывается в строке и итоге.
- Плагин: `packages/extension/claude-plugin/harness/skills/testing` → ссылка на
  `skills/testing` (скилл `harness:testing`).
- `tool_guidelines.subagent`; `tool_feedback`: `/-` прерывает bash, задачи и субагентов.
- `deps.ts`: строка `claude` (путь, версия, статус входа или «не найден») и профили субагентов.

Модули `packages/extension/subagents/engines/claude/`:

- `engine.ts` — `SubagentEngine` на CLI (12.5); вторая реализация — после одобрения (12.11).
- `stream.ts` — разбор stream-json в `SubagentEvent`; типы — `protocol/claude.ts` по
  документированным формам; неизвестные типы сообщений игнорируются, неизвестные поля не
  ломают разбор.
- `policy.ts` — `decide(tool, input, ctx)` в режиме профиля: `Edit`/`Write`/`NotebookEdit` →
  `authorizeChange` по пути (Interaction `gate`: путь и diff из `old_string`/`new_string`); `Bash` → разрешено,
  команда запоминается по `tool_use_id`; остальное → разрешено.
- `tools-adapter.ts` — инструменты harness для Claude: описание и схема из `pi.getAllTools()`
  по набору профиля (C9); вызов — `ctx.executeTool` вызова `subagent` (gate, маскирование
  секретов, `/-`, порядок `write`/`edit`/`bash`, вложенные вызовы в строке `subagent`).
- `bridge-server.ts` — unix socket агента `~/.harness/sockets/agent-<id>.sock` (каталог 0700),
  одноразовый токен запуска; обслуживает MCP (`tools-adapter`, `permission`) и решения хука
  (`policy`).
- В `cli`: `harness claude-bridge mcp` (stdio-MCP ↔ socket) и `harness claude-bridge hook`
  (вход хука ↔ socket ↔ JSON-решение).

Общие модули `packages/extension/subagents/`: `registry.ts` (профили, брифинг-скиллы),
`engine.ts` (интерфейс), `tool.ts` (инструмент `subagent`, связь с Supervisor и Interactions),
`engines/harness.ts`, `engines/claude/`, `bundled/` (`builder`, `explorer`).

### [ ] 12.5 Запуск Claude (CLI)

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --model <opus|id> --effort <level>
  --permission-mode default --permission-prompts host
  --settings '{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"harness claude-bridge hook","timeout":2592000}]}]}}'
  --mcp-config '{"mcpServers":{"harness":{"command":"harness","args":["claude-bridge","mcp"]}}}'
  --strict-mcp-config --permission-prompt-tool mcp__harness__permission
  --add-dir <workspace> --plugin-dir <claude-plugin/harness>
  --append-system-prompt <claudeSystemPrompt> [--resume <id>]
```

- Окружение: без `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
  `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`,
  `CLAUDE_CODE_USE_ANTHROPIC_AWS`; без секретов сессии (вывод родного `Bash` Claude не
  маскируется; секрет нужен — `mcp__harness__bash`); с `CLAUDE_CODE_RETRY_WATCHDOG=1`,
  `HARNESS_BRIDGE_SOCKET`, `HARNESS_BRIDGE_TOKEN`.
- Проверки до запуска: `claude` в PATH (иначе — сообщение со ссылкой на установку); версия не
  ниже минимума используемых возможностей (иначе — «обновите Claude Code»); `claude auth status`
  — только `loggedIn && authMethod === "claude.ai" && apiProvider === "firstParty"`. После
  старта: `apiKeySource === "none"` в `system/init` и нужные `capabilities`.
- Задача, продолжение живой сессии и исправления — сообщениями в stdin процесса; `--resume` —
  только после настоящей остановки.
- Остановка: управляющие запросы `stop_task` (все живые задачи), затем `interrupt`; без этих
  возможностей у версии Claude — SIGTERM группе.
- Процесс держится, пока есть живые фоновые задачи Claude; `session_shutdown` агента
  останавливает его.

### [ ] 12.6 Права Claude

- Хук `PreToolUse` — первый шаг проверки прав Claude, до правил allow/deny настроек:
  `permissionDecision: allow | deny` с причиной из `decide`. «Reject with comment» оператора —
  причина отказа для Claude; «Stop» — `interrupt` и `terminate` прогона.
- `mcp__harness__permission` — только для ask-правил, та же `decide`; ответ — один текстовый
  блок `{"behavior":…}` без `structuredContent`.

### [ ] 12.7 Лимиты подписки Claude

- `rate_limit_wait` → Interaction `choice`: «Ждать» / «Остановить Claude, продолжить в
  harness» (результат с пометкой выбора, не ошибка) / «Остановить Claude и прогон»
  (`terminate: true`); закрывается сама, когда ожидание закончилось (`rate_limit_over`).
- `overage` (usage credits) — отметка в ходе и в итоге.

### [ ] 12.8 Фоновые задачи Claude

- Источник `claude` в Supervisor: `task_started` / `task_updated` / `task_notification` /
  `background_tasks_changed` → состояние задач; команда — из `Bash` по `tool_use_id`; вывод —
  `output_file`; остановка — `stop_task`; уведомления вызывающей модели — по `notify`.

### [ ] 12.9 Итог и продолжение (оба движка)

- Блок передачи работы всегда: профиль, сессия, фактическая модель, состояние, ходы,
  длительность, стоимость, изменённые файлы, шаги, последний текст, отказы в правах,
  сообщения оператора (C12); для `claude` — `permission_denials` и usage credits; успех — +
  отчёт субагента.
- Сессии субагентов — в HarnessState и записях `harness-subagent { profile, engine, session,
  parent, state: running/done/stopped/failed }`; продолжение — `continue: true` или `session`.
- Steering оператором (C12) для `claude`: `harness_subagent_send` → сообщение stream-json в живой
  процесс Claude (учитывается на ближайшей границе хода); для `harness` — steer в сессию ребёнка
  (12.3). В строке `subagent` и блоке передачи работы — запись «оператор → <имя>: …» без
  отдельного хода вызывающей модели. Остановленный субагент — отказ: его работа
  принадлежит вызову `subagent`, через контекст которого работают gate и инструменты harness;
  продолжить его может только вызывающая модель.

### [ ] 12.10 Тесты

- Unit: `registry` (источники и приоритет, доверие проекту, ошибки frontmatter, циклы
  `subagents`, effort для `claude`); набор инструментов профиля (`ctx_*` всегда исключены,
  `subagent` — только при непустом `subagents`, глубина 2); перевод ссылки в `--model`/`--effort`.
- Integration, движок `harness` (сценарная модель в родителе и ребёнке): `explorer` в PLAN не
  может править; итог приходит родителю; gate ребёнка в BUILD с подписью; фоновый
  ребёнок переживает закрытие родителя и отчитывается, нефоновый — останавливается;
  steering оператором; продолжение.
- Правило S5 — контракт промпта: текст правила есть в собранном промпте всех режимов, описания
  брифинг-скиллов бандла начинаются с «Only on the operator's explicit request».
- Unit движка `claude`: разбор stream-json по фикстурам (включая [`fixtures/claude/`](fixtures/claude/));
  `decide` по таблице для каждого режима; сборка аргументов и окружения; минимальная версия и
  `capabilities`.
- Integration с поддельным `claude` (скрипт: stream-json, управляющие запросы, хук и MCP через
  мост): успех; правка в BUILD → Reject с комментарием → Claude получает отказ; ожидание лимита
  с тремя выборами; фоновая задача видна, останавливается, будит вызывающую модель; продолжение живой
  и остановленной сессии; `/-`; `claude` не найден / не залогинен / слишком старый.
- Инварианты: у дочернего процесса нет переменных биллинга по API и секретов; socket моста не
  принимает чужой токен; `ctx_*` и не разрешённые профилем инструменты не видны Claude.

### [ ] 12.11 После одобрения Anthropic (только после одобрения, C11)

1. Зафиксировать одобрение в `docs/legal/claude.md`: от кого, дата, ссылка, точный охват
   (Agent SDK с подпиской пользователей в открытом проекте; поставка бинаря — отдельно, только
   если явно разрешена).
2. Ворота G6: JS-часть `@anthropic-ai/claude-agent-sdk` собирается `bun2nix` без платформенных
   optional-пакетов (запасной путь — `fetchurl` одного tarball).
3. `engines/claude/sdk-engine.ts` — вторая реализация `SubagentEngine` для `claude`: `query()` в
   режиме потокового ввода; `hooks.PreToolUse` (callback `decide`, `timeout` 2592000, `onFailure: "block"`) и
   `canUseTool` (`decide`); `mcpServers: { harness: createSdkMcpServer(tools-adapter) }`;
   `strictMcpConfig`, `systemPrompt { type: "preset", preset: "claude_code", append }`,
   `plugins`, `resume`, `env`; `interrupt()`, `stopTask()`, `streamInput`, `accountInfo()`;
   `model`, `effort`; типизированные сообщения → те же `SubagentEvent`. `policy`, `tools-adapter`,
   Supervisor, Interactions, инструмент `subagent`, профили и промпт не меняются.
4. Бинарь: без разрешения на поставку — `pathToClaudeCodeExecutable` = `claude` пользователя с
   теми же проверками версии; с разрешением — поставляемый бинарь (derivation `unfree` с
   разрешением по имени во flake, исключение из `cache-export.sh`, как у Chrome), совместимый
   бинарь пользователя (той же версии или новее) имеет приоритет.
5. Сценарии движка `claude` из 12.10 прогоняются против обеих реализаций с одним поддельным
   бинарём (CLI-ввод и управляющий протокол SDK); оба зелёные — умолчание переключается на
   `sdk-engine`.
6. Без наследия: удаляются CLI-реализация `engines/claude/engine.ts`, `bridge-server.ts`, команды
   `harness claude-bridge` и их тесты; разделы 12.4–12.8 переписываются под SDK.

## [ ] 13. Документация, саморасширение и язык

### [ ] 13.1 Что поставляется

```
<bundle>/share/harness/
  docs/            # документы harness (из docs/ репозитория)
  src/             # исходники harness: packages/*, prompt.yaml, skills/, subagents/bundled/
  pi/              # симлинки на поставляемые пакеты pi версий из bun.lock:
                   #   coding-agent/{README.md,docs,examples}, .d.ts пакетов pi
```

Исходников pi в бандле нет (npm-пакеты содержат `dist/*.js` и `.d.ts`); контракты API — `.d.ts`.

### [ ] 13.2 Состав `docs/`

- `index.md` — карта: какой документ читать для какой задачи.
- `architecture.md` — слои, пакеты, процессы, границы (разделы 4–5 этого плана в форме документа).
- `pi-mapping.md` — таблица переводов pi → harness: пути (`~/.pi/agent` → `~/.harness`, …),
  команды (`pi …` → `harness …`), переменные окружения; API pi, не используемые в harness,
  и их замена (`ctx.ui.custom` → Interactions, `InteractiveMode` → `tui`, RPC → HAP,
  профили и т.д.). Документы pi читаются с этим переводом, а не переписываются.
- `extending/`: инструменты (регистрация — ссылка на pi `extensions.md`; своё — Interactions,
  чистые отрисовщики `presentation/`, gate), субагенты, скиллы (ссылка на pi `skills.md` +
  источники harness), темы (ссылка на pi `themes.md` + токены web), ссылки на модели,
  компоненты web (галерея), testkit.
- `protocol/`: `hap.md`, `node.md`, `hub.md` — вручную, только поведение (порядок,
  согласованность снимка и хвоста, ошибки, версии); HAP ссылается на pi `rpc.md`,
  `rpc-commands.md`, `rpc-extension-ui.md` и описывает только `harness_*`; `reference/` —
  сгенерирован из `protocol/schemas.ts` (D3) генератором `protocol/gen-reference.ts` и хранится в
  репозитории.
- `operations/`: `harness node`/`hub`, NixOS-модуль, Fly, настройки, Claude Code (установка и вход
  пользователем).
- `legal/claude.md` — по разделу 12.11; `legal/privacy.md` — по разделу 10.7.

README заканчивается разделом **TODO** (что сознательно отложено):
- Native push notifications: APNs (iOS) and FCM (Android) through our push relay (`harness relay`
  role) deployed on Fly; hubs send through it with per-device handles bound to the hub key.
- End-to-end encrypted push payloads: the hub encrypts for the device key, the iOS Notification
  Service Extension and the Android FCM data-message handler decrypt; the relay, Apple and Google
  see only ciphertext.
- Native desktop on React Native (Linux, macOS, Windows) once the desktop platforms of RN mature;
  until then the desktop runs the web build in a native window (`harness web-app`).

Правило отсылок: на pi — относительной markdown-ссылкой с якорем в раскладке бандла
(`[registerTool](../pi/coding-agent/docs/extensions.md#custom-tools)`); контракт pi не
пересказывается — ссылка и только отличие harness. В checkout та же раскладка доступна в `result/share/
harness` после `nix build`. `.dirinfo.md` каталогов репозитория — по-английски.

### [ ] 13.3 Промпт

- Секция `pi_docs` в `prompt.yaml` заменяется `harness_docs`: пути `{{HARNESS_DOCS}}`,
  `{{HARNESS_SRC}}`, `{{PI_DOCS}}`; правило «по задачам о самом harness — сначала `index.md` harness;
  документы pi — только по ссылкам из него и с переводом `pi-mapping.md`»; короткая карта
  тем со ссылками в `docs/` harness. `{{PI_README}}` и карта тем pi из промпта уходят.
- `core/prompt.ts` заполняет пути из раскладки бандла (в checkout — из репозитория и кэша bun).

### [ ] 13.4 Саморасширение

Модель по просьбе оператора создаёт субагентов, скиллы, темы и расширения pi в
`~/.harness/…` или `.harness/…` проекта — по `docs/extending/`: где лежит файл, формат, когда
подхватывается (следующий прогон), как проверить. Бандл в store неизменяем; изменение самого
harness — работа в checkout с обычным циклом сборки и `AGENTS.md` репозитория.

### [ ] 13.5 Язык (D2)

- Все строки UI (`tui`, `app`, `presentation/`, сообщения `cli` и ошибок
  инструментов) — по-английски, прямо в коде, без каталогов переводов.
- Нынешние русские строки в коде: комментарий `index.ts:952` (переводится при переносе);
  фикстуры `remote/test/*` (уходят с `remote/` или в `experiments/`, её проверки не касаются); `prompt.yaml:51` — примеры фраз оператора
  («запиши план», «Зафиксируй»), остаются как единственное явное исключение: это
  цитаты ввода оператора, а не текст интерфейса.
- Правило промпта «отвечать на языке оператора» не меняется.

### [ ] 13.6 Проверки (`testkit`, `nix flake check`)

- Ссылки: каждая ссылка в `docs/` и в секции промпта разрешается вместе с якорем в
  раскладке бандла (pi — версии из `bun.lock`); обновление pi, сломавшее якорь, валит
  сборку с списком мест.
- Без пересказа: ни один абзац `docs/` не совпадает с документами pi по 12 и более подряд
  идущим словам (шинглы).
- Справочник протокола: `docs/protocol/reference/` совпадает с выводом генератора.
- Полнота перевода: каждый путь `~/.pi/…` и каждая команда `pi …` из поставляемых документов
  pi есть в `pi-mapping.md`.
- Пути промпта (`{{HARNESS_DOCS}}`, `{{HARNESS_SRC}}`, `{{PI_DOCS}}`) существуют в собранном
  бандле (smoke).
- Язык: нет кириллицы в поставляемых исходниках (кроме фикстур тестов), в `docs/` и в текстах
  промпта — с единственным исключением из 13.5, записанным в тесте по точному месту.

## [ ] 14. Nix

- `flake.nix`: пакеты `harness` (cli + tui + agent + extension + web-сборка `app` + шрифты +
  libwebview + бандловые инструменты + `share/harness/{docs,src,pi}`, раздел 13.1), `harness-app-web`
  (статическая web-сборка), `harness-app-android` (APK/AAB, `androidenv`), devShell (bun, bun2nix,
  Android SDK и эмулятор, Maestro, инструменты тестов); `nixosModules.harness`; шаблон `remote`
  обновлён. iOS — вне Nix (10.7).
- Зависимости JS: один `bun.lock`; `bun2nix.fetchBunDeps` → `BUN_INSTALL_CACHE_DIR` (для `app` —
  из того же кэша собирается его `node_modules`);
  `nix/npm` и его `package-lock.json` удаляются; `nix/update.sh` обновляет `bun.lock` и
  регенерирует выражение bun2nix.
- Бандловые бинарные инструменты (lightpanda, tsgo, gopls, rust-analyzer, browser,
  cage, ffmpeg, exiftool, go, rust, режимы `bundled`) — как сейчас в `nix/package.nix`.
- NixOS-модуль: `services.harness.nodes.<name> = { user; roles = [ "node" | "hub" ]; hubs = [ { url; keyFile; } ]; users = [ … ]; listen; settings; }`
  → systemd-юниты `harness-<name>` от `user`.
- Образ Fly (`nix/remote-image.nix`): `s6-svscan` с сервисами — `harness hub` от
  служебного пользователя и `harness node` каждого пользователя от его uid (`s6-setuidgid`),
  связь узлов с hub по localhost; секреты — cage, как сейчас.
- Claude Code в бандл не входит (C8): ни derivation, ни правила в `cache-export.sh`; README —
  Claude Code ставит и логинит пользователь.

## [ ] 15. Что удаляется (без наследия)

- Лаунчер `pi`, `pi-dev` (заменяется `harness` из checkout: `bun packages/cli/main.ts`),
  загрузка расширения в `InteractiveMode`.
- `remote/` целиком: `core/rpc.ts` (клиент `pi --mode rpc`), переключение uid
  (`accounts.ts`, `user-helper.ts`, `helper.ts`), `idle.ts` (hub всегда работает) —
  заменены `node` и `client`. Telegram-фронтенд и Mini App — не удаляются, а переносятся в
  `experiments/telegram/` (5.8); секрет токена бота в cage и вебхук на Fly убираются.
- `pi-ask-user` как внешний пакет (копия в `extension/tools/ask_user`).
- Herdr (A21): бинарь `herdr` и ссылка в `bin/`, его интеграция с pi (`herdr-agent-state.ts`),
  события `herdr:blocked` (`reportBlocked`, `startBlockedTool`, `finishBlockedTool`,
  `blockingTools` в `index.ts`), проверка копии интеграции в отчёте зависимостей, версия в
  манифесте, упоминания в README.
- Обычный (неполноэкранный) режим TUI — его нет с самого начала (A24).
- Профиль `server` (`HARNESS_PROFILE`).
- `nix/npm`.
- Секция `pi_docs` промпта и подстановка `{{PI_README}}` (заменены `harness_docs`, раздел 13.3).
- README и `.dirinfo.md` переписываются под новую структуру по-английски; README ссылается на
  `docs/index.md`.

## [ ] 16. Тестирование

### [ ] 16.1 Наборы

- Unit — рядом с модулями, `bun test`: кодеки и схемы `protocol`; reducer'ы `client`;
  `changeReview`; `auth` и `routing`; автомат `supervisor` (поддельные `Clock`/`Spawner`);
  разбор stream-json Claude; сборка `claudeSystemPrompt`; генератор токенов темы;
  поведение компонентов `app` (`SelectList`, `Editor`, блоки Interactions; React Native Testing
  Library, клавиатурные сценарии; раннер подтверждается в G9);
  граф импортов и границы пакетов; `WorkbenchModel` (вкладки, глиф по таблице приоритетов
  10.5 — все сочетания состояний, просмотр гасит `✓`/`✗`, порядок
  элементов, цель ввода, переключение уровней подписки) и `keymap.ts`; сводки узла из HAP
  (статусы, предел частоты на поддельных часах).
- Integration — `tests/scenarios/`, настоящие `harnessd` и `harness-agent`, поддельные
  внешние системы.

### [ ] 16.2 Тестовый харнесс (`testkit`)

- `topology({ nodes, clients })`: узлы (роли, пользователи, связи), клиенты (`tui`, `web`,
  `ios`, `android`, `raw`); временные `HOME` и порты; сценарии параллельны.
- Сценарная модель: faux-провайдер pi-ai, загружаемый в агентов расширением testkit;
  сценарий ходов (текст, thinking, вызовы инструментов, ошибки, остановка) и запись
  запросов для проверок.
- Время: поддельные часы во всех процессах стенда через канал `HARNESS_TEST_CONTROL`;
  сдвиг времени — явный.
- Подделки: `claude` (сценарии stream-json, ожидание лимита, ошибки),
  обрыв сети, падение агента, недоступный узел.
- Сценарии — именованные шаги (`s.step("open session", …)`); граница шага — точка
  остановки, снимка и отчёта.
- Драйверы клиентов с общим словарём действий — идентификаторы `client/keymap.ts`
  (`tabs.next`, `gate.allow`, …), одинаковые для TUI и `app`, плюс сырые `key` / `type` / `click`:
  - `tui`: клиент на виртуальном `Terminal` pi-tui фиксированного размера, вывод — в
    `@xterm/headless` (сетка ячеек с цветами и атрибутами); на тестовом терминале
    объявлен протокол изображений iTerm2, изображения рисует `@xterm/addon-image` (G7);
    утверждения — `tui.sees(text)`, `tui.line(n)` по тексту экрана.
  - `web`: web-сборка `app` в Playwright на браузере бандла, один браузер на прогон,
    контекст на клиента; утверждения — роли и доступные имена (ARIA).
  - `native` (`ios`, `android`): Maestro на симуляторе iOS (macOS) и эмуляторе Android
    (`androidenv`); действия — по доступным именам; утверждения — дерево доступности;
    состояние моделей — через тестовый канал приложения (только в тестовой сборке).
  - `raw`: голый протокол.
  Все драйверы отдают состояние `ClientModel` и `WorkbenchModel` клиента.
- Вердикты — только по смыслу: состояние моделей, доступные имена web, видимый текст TUI,
  записи протокола. Пиксели и эталонные изображения вердикта не дают (вид — деталь
  дизайна, скилл `testing`).
- Синхронизация только по событиям (запись протокола, состояние Interaction, строка на
  экране, файл готовности стенда); таймаут — защита от зависания, его срабатывание —
  провал.
- Скорость: сценарии — параллельные процессы с отдельными `HOME` и портами; скриншоты —
  только при провале и по запросу; ничто не ждёт времени.

### [ ] 16.3 Инструментация: отчёты, скриншоты, управление стендом

- **Отчёты** — `.test-reports/<run>/` (в `.gitignore`), ссылка `.test-reports/latest`. На
  сценарий: `report.md` (шаг, входы, ожидалось и получено, ссылки), `protocol/*.jsonl`
  (каждое соединение), `agents/*.stderr`, `nodes/*.log`, `sessions/` (копии), `model/<клиент>.json`
  (`ClientModel` + `WorkbenchModel`), `screens/<шаг>-<клиент>.*` — экраны **всех** UI-клиентов на
  шаге провала и на последнем успешном шаге; для native — ещё логи устройства
  (`adb logcat`, `simctl` log).
  Вывод консоли — строка на тест, сводка, путь к `report.md` каждого провала.
- **Снимок экрана** — инструментация, не вердикт: снимается при провале, по `--shots
  <шаг|all>` и командой `shot`; смотрят его модель (`read` PNG) и оператор (`display_file`).
  - TUI: `screen.png` (сетка ячеек `@xterm/headless` → HTML-сетка со встроенным JetBrains Mono и
    цветами ячеек → PNG тем же браузером), `screen.txt` (чистый текст), `screen.ansi` (исходный
    поток, воспроизводится `cat` в настоящем терминале).
  - web: `screen.png` и `aria.yml`; фиксированы viewport, `deviceScaleFactor`, встроенные шрифты,
    `--font-render-hinting=none`, sRGB, поддельные часы клиента (спиннеры и время стоят).
  - native: `screen.png` (`xcrun simctl io screenshot`, `adb exec-out screencap`) и
    `a11y.yml` (иерархия доступности Maestro); фиксированы модель устройства и масштаб,
    статус-бар (демо-режим), поддельные часы клиента.
  - TUI и web растеризует один браузер бандла — одинаковые шрифты и цвета, снимки
    сравнимы рядом; native — снимки устройства теми же шрифтами и токенами.
- **Управление стендом** (оператор и агент) через управляющий сокет стенда:

  ```
  harness-test up <сценарий|топология> [--until <шаг>]   # стенд в фоне, возврат по готовности, печатает id
  harness-test step <id>                                  # следующий шаг сценария
  harness-test do <id> <клиент> action <action-id>        # действие из общей keymap
  harness-test do <id> <клиент> key|type|click <…>        # сырые клавиши / текст / клик по role+name
  harness-test state <id> <клиент>                        # JSON ClientModel + WorkbenchModel
  harness-test shot <id> [<клиент>]                       # снимки в отчёт стенда, печатает пути
  harness-test logs <id> [<процесс>]                     # хвосты протоколов и журналов
  harness-test down <id>
  ```

- **Галереи** — визуальный контроль и паритет:
  - общие фикстуры `testkit/fixtures/`: каждая Interaction в каждом варианте, отрисовщики
    инструментов на реальных записях сессий, вкладки со всеми глифами, правая полоса с
    задачами и субагентами, узкий экран, длинные строки, пустые состояния;
  - галерея `app` (маршрут внутри приложения, раздел 10.4; снимается на web, iOS и Android)
    и галерея TUI (те же фикстуры через компоненты TUI на
    виртуальном терминале);
  - `harness-test gallery [<фильтр>]` → `.test-reports/<run>/gallery/`: ряды TUI | web | iOS | Android на фикстуру и
    `index.html`; падает только на ошибке отрисовки (исключение, пустой экран), не на
    изменении вида;
  - `harness-test gallery --compare <git-ref|каталог>` — для ревью: по каждой изменившейся
    фикстуре «было / стало / разница» и список изменений, без вердикта. Перед ревью
    изменения UI модель смотрит изменившиеся пары.
- **Тесты самой инструментации**: растеризатор TUI на эталонном ANSI даёт ожидаемую
  сетку ячеек (контракт растеризатора; проверяется сетка, не пиксели); отчёт о провале
  содержит всё перечисленное выше — на намеренно падающем сценарии-фикстуре.

### [ ] 16.4 Покрытие

| Тип | Что проверяется |
|---|---|
| Контракт | Набор соответствия протоколу узла для трёх реализаций (в-процессе, unix socket, через hub); HAP против `harness-agent`; презентационный runtime на фикстурах реальных сессий; CLI-команды администрирования. |
| Бизнес-правило | Gate по режимам и охвату; доступ к узлам по спискам; `notify`; переключатель implementer и селектор; настройки по пользователю hub; режим и набор инструментов профиля субагента; субагент только по просьбе оператора (контракт промпта); раскрытие ссылок на модели. |
| Сценарий пользователя | TUI на ноутбуке запускает агента на узле рабочей машины через hub; TUI и `app` на телефоне на одном агенте — ответ в одном закрывает диалог в другом; привязка телефона по QR из `harness hub device add` (A28); файл из «поделиться» или выбора фото оказывается на узле и упомянут `@file`; голосовой ввод становится текстом в редакторе; `send_file` агента приходит в приложение; фоновая задача будит модель; закрытие UI при узле под systemd — агент и задачи живут, повторное подключение показывает всё; `harness web-app` со встроенным узлом; субагенты — сценарии раздела 12.10; модель по ссылке снята из каталога — сессия открывается с перераскрытой моделью и сообщением (M2); мультисессионность: несколько вкладок на разных узлах, Interaction в неактивной вкладке (`◆`, фокус не перехвачен, диалог при переключении), вкладка открыта в TUI — сразу есть в web, виды задачи и сессии Claude, steering Claude оператором и пометка у архитектора; **паритет**: один сценарий ведёт TUI и web, сравниваются состояние `WorkbenchModel` включая зоны экрана, текст полос TUI (`screen.txt`) и ARIA-снимок web (смысл, не пиксели); **web-детали** (утверждения по смыслу): перетаскивание вкладки меняет `ui.tabs` и сразу видно в TUI; файл, брошенный в поле ввода, оказывается на узле и упомянут `@file`; deep link открывает нужный элемент; на узкой ширине всё доступно через overlay полос; системное уведомление о `◆` в неактивной вкладке при выданном разрешении; **native-детали**: долгое нажатие даёт то же контекстное меню, свайп открывает overlay полосы, deep link `harness://…` открывает нужный элемент, аппаратная клавиатура вызывает действия карты; паритет TUI ↔ iOS/Android — по состоянию `WorkbenchModel` и дереву доступности. |
| Инвариант | Секрет не попадает в логи, журнал, сессию, протокол других пользователей; одна сессия — один агент; пользователь видит только свои узлы и сессии; дочерний `claude` без переменных биллинга по API и секретов; субагент не получает секретов сессии родителя; глубина вложенности не больше 2; socket моста Claude не принимает чужой токен; пакеты бандла в презентационном runtime не запускают процессов, сокетов, таймеров и не пишут файлы. |
| Отказ | Узел офлайн и возвращается; hub перезапущен; агент падает посреди хода; несовпадение версий; обрыв посреди Interaction; переполнение вывода задачи; длинный путь socket; вкладка сессии офлайн-узла (`⊘`, возвращение узла); steering остановленного субагента отклоняется; профиль с ошибкой не регистрируется и виден в отчёте; ссылка на модель неоднозначна или не раскрывается; занятая блокировка сессии; код привязки истёк или уже использован; версия приложения несовместима с hub (сообщение, что обновить); приложение возвращается из фона — переподключение и снимок без потерь; `claude` не найден / не залогинен / лимит. |

### [ ] 16.5 Команды

- `nix flake check` — сборка бандла, web-сборка и Android-сборка `app`, unit, integration
  (TUI, web, raw), smoke, галереи TUI и web (только ошибки отрисовки). Эмуляторы в песочницу
  не входят.
- `harness-test native [ios|android] [<имя>]` — сценарии и галерея на эмуляторах: Android — на Linux
  и macOS, iOS — на macOS; обязателен перед релизом приложения и в CI релизов.
- `harness-test [unit|integration|gallery] [<имя>] [--shots <шаг|all>] [--until <шаг> --keep]` — всё,
  набор или один тест/сценарий; команды стенда — 16.3.
- `AGENTS.md`: локальный минимум перед коммитом — `nix develop --command nix flake check`
  (с изменениями в индексе).

### [ ] 16.6 CI (GitHub Actions)

Пайплайны — код в `.github/workflows/`. Лёгкий `check` идёт на каждый push; тяжёлые
запускает агент или оператор через `gh workflow run`, ждёт `gh run watch`, разбирает `gh run view` /
`gh run download`. Отчёты testkit (`.test-reports/`) прикрепляются к каждому запуску как
артефакты: провал на CI разбирается так же, как локальный, без повторного прогона.

| Пайплайн | Запуск | Что делает |
|---|---|---|
| `check` | push в `master`, PR | `nix flake check` на ubuntu: сборка бандла, unit, integration (TUI, web, raw), web- и Android-сборка `app`, галереи (только ошибки отрисовки) |
| `native-android` | выключен; включать и запускать только вручную, при крайней необходимости | Эмулятор Android на ubuntu (KVM), сценарии Maestro, галерея |
| `native-apple` | выключен; включать и запускать только вручную, при крайней необходимости | macOS-раннер: сборка iOS, симулятор и Maestro, галерея; окно `harness web-app` на macOS (WKWebView, G3) |
| `compatibility` | расписание, `gh workflow run` | Полная матрица систем (x86_64/aarch64-linux, darwin) |
| `update` | расписание, `gh workflow run` | Обновление закреплённых версий (`bun.lock`, выражение bun2nix, flake), проверка `check` и продвижение `master` |
| `release-app` | `gh workflow run` | Подпись и выгрузка в магазины (10.7); секреты в GitHub Secrets — только по команде оператора |

На время переписывания пайплайны старой системы `update` и `compatibility` выключены
(`gh workflow disable`) и включаются переписанными; их автоматические коммиты в `master`, если
появятся, отбрасываются. `check` переписывается на этапе 1 и дальше растёт вместе с
`nix flake check`; `build.yml` и `publish-cache.yml` старой системы заменяются или удаляются
вместе с ним.

## [ ] 17. Этапы

0. **Ворота осуществимости** (прототипы в ветке; провал — возврат к оператору):
   - G1: агент на SDK под bun — пакеты бандла, codemode, MCP, lsp, **промпт harness
     проходит `systemPromptProblem`**, magic-context с эмбеддингами (onnxruntime) под bun,
     явное завершение процесса. (Частично подтверждено: загрузка и ход с codemode+bash.)
   - G2: patchright (`browser` MCP) под bun.
   - G3: `bun:ffi` + libwebview в Worker на Linux (WebKitGTK 6) и macOS; закрытие окна;
     вставка изображений и буфер обмена.
   - G4: сборка workspace через `bun2nix` без `node_modules`, включая нативные модули
     (onnxruntime, sharp); пакет `app` — с `node_modules` из того же кэша (A17).
   - G8: критичные компоненты `app` на iOS, Android и web — транскрипт на 5000 записей
     (виртуализация, прокрутка, догрузка истории), редактор с блоком автодополнения над
     полем, Markdown/ANSI/diff, выделение и копирование (iOS — через read-only `TextInput`),
     встроенные шрифты, аппаратная клавиатура (iPad, Android), deep link, web-детали через
     `*.web.tsx` (контекстное меню, перетаскивание файлов, `:focus-visible`).
   - G9: сборка `app` — Expo prebuild + Metro с bun как пакетным менеджером; web и Android
     в Nix, iOS на macOS; изоморфные `protocol`/`client` импортируются как есть; раннер
     компонентных тестов (React Native Testing Library); Maestro на эмуляторах.
   - G5: на установленной версии Claude Code — потоковый ввод, управляющие запросы
     `interrupt` и `stop_task`, хук `PreToolUse` через `--settings` с длинным таймаутом,
     stdio-MCP-мост через `--mcp-config`. Если управляющие запросы не работают — SIGTERM без
     продолжения хода, это фиксируется в разделе 12.
   - G7: `@xterm/headless` с растеризацией через браузер бандла даёт верную сетку на выводе
     pi-tui (цвета, ширина box-drawing, braille и эмодзи); `@xterm/addon-image` показывает
     изображения iTerm2. Иначе на месте изображения в снимке TUI — подписанная рамка, это
     фиксируется в 16.3.
1. `protocol`, `client`, каркас `testkit` (стенд и топология, faux-модель, часы, отчёт,
   управление стендом, драйвер `raw`); пайплайн `check` новой системы (16.6); генератор
   справочника протокола и проверки документации и языка (13.6). Дальше каждый этап пишет
   документы своих пакетов.
2. `extension`: перенос, Interactions, HarnessState, Supervisor и `task_*`, `presentation`, `ask_user`.
3. `agent` (HAP, uiContext, мост компонентов).
4. `node`: пул, сессии, блокировки, unix socket, настройки.
5. `tui` и `cli` (`harness`, `harness node`) — первое рабочее состояние: полноэкранный
   мультисессионный экран на `WorkbenchModel`, уровни подписки и сводки; драйвер и
   растеризатор TUI, галерея TUI; удаление лаунчера `pi` и herdr.
6. WebSocket, auth, routing, uplinks, `harness hub`, администрирование, NixOS-модуль.
7. Перенос Telegram в `experiments/telegram/`; образ Fly на s6 (`harness hub` без Telegram);
   удаление `remote/`.
8. Документация: общий проход — `index.md`, `architecture.md`, `pi-mapping.md`, `extending/`,
   `operations/`, секция промпта `harness_docs`, раскладка `share/harness` в бандле.
9. `app` (основы, компоненты, галерея, оболочка, привязка по QR) на web и `harness web-app` (Linux);
   драйвер web, ряды TUI | web в галерее, `--compare`.
10. Субагенты (раздел 12): реестр и инструмент `subagent`, движок `harness` и `explorer`, движок
   `claude` и `builder`. Ссылки на модели (раздел 6.2) — в этапе 2 (`extension`) и этапе 1
   (`protocol/model-ref.ts`).
11. Нативные цели и тяжёлый CI — в самом конце, когда всё остальное работает: `app` на Android
   и iOS, драйвер native, ряды iOS | Android в галерее; macOS-окно `harness web-app`; G8 и G9
   на iOS и Android; пайплайны `native-android`, `native-apple`, `compatibility`, `update`
   (16.6), запуск через `gh`; публикация (10.7): `nix/release-app.sh`, `release-app`,
   TestFlight и внутреннее тестирование Google Play, затем релиз в магазинах.

Каждый этап заканчивается зелёным `nix flake check`. Ворота фазы 0 на Linux проходятся сразу;
их macOS-, iOS- и Android-части — на этапе 11.

### Ход работ

Сверяется с разделами 5–16 после каждого шага; раздел получает `[x]`, только когда сделан
целиком. Пока ни один раздел не закрыт полностью — ниже, что сделано и что осталось по этапам.

- **Этап 0.** G1 закрыт (отступление 4). G2, G4 сняты переходом на node и npm-lock
  (отступления 1–2). G3 снят отступлением 16, G7 закрыт на этапе 5, G8/G9 — сборки
  web, Android и iOS проходят (этапы 9 и 11), G5 закрыт живой проверкой (этап 10).
- **Этап 1.** Сделано: `protocol` — `framing`, `version`, `errors`, `state`, `interactions`,
  `hap`, `node`, `model-ref` с тестами; `client` — `connection`, `ClientModel`, `AgentModel`,
  `WorkbenchModel`, `keymap`, транспорт WebSocket; `testkit/stand` (стенд, сценарная модель);
  пайплайн `check` и `nix flake check` (`nix/check.nix`), `AGENTS.md`; `schemas.ts` с проверкой
  на входе узла и агента; тест графа пакетов (`tests/boundaries.test.ts`); `Clock` с
  `ManualClock` в узле, uplink и `Workbench`; переподключение клиента (`addEndpoint`); зоны
  экрана, действия, выбор из списка, поиск в `Workbench`; `testkit` — сценарии из шагов,
  отчёты, `control/` и `harness-test`, драйверы `raw` и `tui`, `fixtures/`; справочник протокола
  из схем и проверки документов и языка (этап 8). Осталось: `Spawner`/`NodeFs` узла не
  внедряются (тесты идут на настоящих процессах во временном HOME — отступление 11).
- **Этап 2.** Сделано: перенос в `packages/extension`, `core/` (режимы, gate, authorize,
  interrupts, settings, prompt), Interactions через хост, `state/store`, `supervisor` и `task_*`,
  `ask_user` на `questions`, `ask_secret` на `secret`, `display_file`, `send_file` клиентам,
  TUI-диалоги в `presentation/tui`; `models/` (ссылки на модели, M1/M2, сценарий); комментарий
  gate в `details`; отчёт зависимостей со строкой Claude Code и профилями субагентов
  (`harness_report`).
- **Этап 3.** Сделано: `agent` — `runtime`, `hap-server` (команды pi RPC + `harness_*`), `ui-context`,
  `interactions`, тема, явное завершение; HAP по fd 3 (отступление 5); мост компонентов
  (`component-bridge.ts`, `harness_component_*`, возможности клиента в `hello`, сценарии);
  агент — клиент своего узла (`harness_node`, отступление 14); вход провайдеров по протоколу
  (`harness_login*`, шаги входа — interactions; сценарий `login`).
- **Этап 4.** Сделано: `node` — агенты, сводки, сессии и блокировки, unix socket, настройки
  (отступление 7), в-процессе транспорт; выгрузка простаивающих агентов и лимит (`node.ts`,
  сценарий `pool`); `files_*` (в `node.ts`); журнал `telemetry.ts`; автодополнение `@file` в
  TUI для сессий на других машинах — через узел сессии (`remote-complete.ts`).
- **Этап 5.** Сделано: `tui` (полноэкранный, три колонки, транскрипт, футер, вид задачи,
  отрисовщики пакетов), `cli` (`harness`, `harness node`), бандл без лаунчера `pi` и herdr,
  smoke-тесты бандла; драйвер TUI, растеризатор (G7 закрыт для сетки ячеек и PNG; изображения
  iTerm2 не проверены) и галерея TUI; поиск по транскрипту; выбор модели и сессии в зоне
  редактора; выбор узла для новой вкладки; OSC 7501; тема из `ui.theme`. Осталось: окна дерева
  сессии и настроек; `!`-bash оператора; догрузка истории при прокрутке вверх. Сделано
  после: `/login`, `/logout`, строки subagents, dependencies и update в панели (обновление
  профиля Nix из TUI); `/bash` и `/bash-quiet` (отступление 16); догрузка истории у
  верхнего края; `/tree` (переход по дереву, `harness_navigate`, `harness_reload`); `/settings`
  (тема — общая для клиентов пользователя и применяется сразу; сжатие и очереди — сессии);
  текст агента для редактора (`setEditorText`) попадает в редактор TUI. Этап 5 на Linux сделан.
- **Этап 6.** Сделано: `auth.ts` (пользователи, устройства, ключи узлов — хэши, 0600),
  `hub.ts` (маршрут, присутствие, настройки пользователей hub), `endpoints/ws.ts`, `uplink.ts`
  (переподключение), `config.ts` (`nodes/<name>.json`), `harness hub`, `harness hub
  user|device|node …`, `harness remote …`, клиент через hub ко многим узлам; сценарий
  `tests/scenarios/hub.test.ts`; NixOS-модуль `services.harness.nodes` с VM-тестом.
  Коды привязки (A28) сделаны на этапе 9.
- **Этап 7.** Сделано: Telegram в `experiments/telegram/`, образ Fly на s6 (hub и узлы
  пользователей от их uid, регистрация узлов при загрузке) с VM-тестом в podman, шаблон
  `templates/remote` без бота.
- **Этап 8.** Сделано: `docs/` (index, architecture, pi-mapping, extending, protocol со
  справочником из схем, operations), раскладка `share/harness/{src,docs,pi}`, секция
  `harness_docs`, проверки 13.6 (`tests/docs.test.ts`), README по-английски с TODO.
  Документы `app` (`operations/app.md`) и субагентов (`extending/subagents.md`) дописаны.
- **Этап 10.** Сделано: реестр профилей (проект/`~/.harness`/бандл, проверки, циклы), бандловые
  `builder` и `explorer` с брифинг-скиллами, инструмент `subagent` (блок передачи, фон с
  `notify`, `continue`/`session`, steering оператора, строки в HarnessState и записи, доотчёт
  фоновых при повторном открытии), движок `harness` (дочерний агент с ролью, инструментами,
  режимом и моделью профиля; узел ограничивает глубину и останавливает не фоновых детей с
  родителем), движок `claude` (CLI-схема 12.4–12.8: мост по unix socket с токеном, хук
  `PreToolUse` и MCP через `harness claude-bridge`, правки через `authorize`, ожидание лимита —
  выбор оператора, фоновые задачи Claude в задачах сессии, проверки перед запуском, без
  переменных биллинга), правила S5 и implementer в промпте, вид субагентов и их interactions
  в TUI; поддельный `claude` в testkit; unit-тесты и сценарии `subagents`, `claude`; документ
  `docs/extending/subagents.md`. G5 закрыт живой проверкой `tests/live/claude.live.ts` на Claude Code
  2.1.303 (мост MCP, хук и gate правки, прерывание); она нашла две ошибки: проверка входа
  шла с переменными биллинга в окружении, `background_tasks_changed` не несёт `status` (запись
  живого прогона — фикстура `testdata/background-tasks.jsonl`).
- **Этап 9 (web и Linux-окно).** Сделано: пакет `app` (Expo 58, RN 0.88, react-native-web; свои
  `node_modules` из своего lock-файла, отступление 17), Metro берёт `#protocol`/`#client`;
  экран из `Workbench.screen()` — три колонки, зоны (транскрипт с инструментами, Markdown,
  командами оператора и баннерами; блок над редактором с автодополнением `/` и `@file`;
  редактор цвета режима; interactions в зоне редактора; списки выбора; статус; footer),
  overlay-полосы на узком экране, панель `Ctrl+\`; тема пользователя с узла (`theme_get`),
  шрифты двух зон (`ui.font.chrome`/`ui.font.chat`) из `nix/app-fonts.py`; клавиши из общей
  карты; web-детали — заголовок и значок с `◆ N`, адрес `#/<узел>/<сессия>` и back/forward,
  файлы перетаскиванием (`files_upload`); привязка устройства — `harness hub device add …
  --url` печатает ссылку `#pair=` и QR, hub раздаёт сборку; `harness web-app` (отступление 16);
  общие с TUI команды клиента (`Workbench.clientCommand`, `commands()`); драйвер web и
  сценарии `web` (паритет с TUI по смыслу) и привязки через hub; галерея пар TUI | web.
  После: `/settings` в app — шрифты двух зон и уведомления браузера (`Workbench` `uiSettings`),
  ширина полос перетаскиванием (`ui.web.panes`), `docs/operations/app.md`; коды привязки
  (A28: одноразовый код на 10 минут, `POST /pair`); файлы туда-обратно (`send_file` → Download,
  выбор файлов), голосовой ввод (запись в app, `transcribe` на узле сессии), журналы узла
  в панели (`logs_tail`: свой пользователь, админы hub). Этап 9 для web и Linux сделан; цели
  iOS/Android (share sheet, выбор фото, микрофон, `expo-font`) — этап 11.
- **Этап 11.** Сделано: пайплайны `compatibility` (бандл на aarch64-linux и macOS, `harness`
  стартует), `update` (проверка `nix flake check` перед продвижением), `native-android` и
  `native-apple` (release-сборки, эмулятор и симулятор, Maestro против hub на раннере —
  оба зелёные); на телефонах: safe area и клавиатура, шрифты `expo-font`, привязка с
  адресом hub, токен в Keychain/Keystore, файлы через «поделиться», выбор фото и
  документов, голос с микрофона, ссылки `harness://`, долгое нажатие — контекстное меню;
  открытый трафик — только к localhost и хосту эмулятора (отступления 20–22). Осталось:
  публикация в магазины (`release-app`) — нужны аккаунты Apple Developer и Google Play и
  ключи подписи (секреты оператора); окно `harness web-app` на macOS не проверено вживую.

### Порядок работы

- Работа идёт в `master`: пользователей мало, и они знают, что пока не обновляются.
  Коммиты — локально, законченными шагами; push — крупными блоками, когда система обретает
  форму.
- Тесты старой системы не запускаются; проверка коммита — набор новой системы по мере
  его появления; `AGENTS.md` обновляется, когда заработает `nix flake check`.
- Технические отступления (среда выполнения, библиотека, способ сборки — например,
  node вместо bun для пакета) исполнитель принимает сам и записывает в раздел 19;
  дорабатываются итеративно после первой рабочей версии. Функциональные требования
  (поведение, контракты, инварианты, UX) не урезаются — такое решает оператор.
- Исполнитель останавливается и ждёт оператора только для: секретов и аккаунтов (ключи
  магазинов — на этапе 11, по команде); живой проверки Claude Code при исчерпанном лимите
  (работа продолжается без неё, проверка — позже); освобождения диска вне репозитория.
- После каждого прогона — отчёт: что сделано, где стоим, что дальше.

## 18. Открытые вопросы

Нет. Внешняя зависимость — одобрение Anthropic (C11); до него движок `claude` работает по
CLI-схеме разделов 12.4–12.8, после — переход по 12.11.

## 19. Отступления

Журнал технических отступлений от плана, принятых в ходе работы («Порядок работы», раздел
17): что изменено, почему, чем заменено, что вернуть при полировке.

1. **Среда выполнения — node, не bun** (A17, G1, G2). Все пакеты исполняются node (22.18+, встроенное
   снятие типов TypeScript), тесты — `node --test`, проверка типов — `tsgo`. Почему: pi и
   пакеты бандла рассчитаны на node (воркеры magic-context, patchright, MCP), node уже в бандле;
   это снимает риски G1/G2 целиком. Следствия: в коде нет enum, namespace и parameter
   properties (снятие типов их не поддерживает), импорты — с расширением `.ts`. bun остаётся
   в бандле как инструмент. Вернуть: перевод на bun — отдельной задачей, если понадобится.
2. **Зависимости — один npm-lock (`nix/npm`, `importNpmLock`)**, не `bun.lock` + bun2nix (A17,
   G4). Почему: работающий механизм с нативными модулями (onnxruntime, sharp,
   autoPatchelf) уже есть; G4 становится не нужен. `node_modules` — в Nix store; checkout
   ссылается на них симлинком, как раньше.
3. **Связь пакетов — `imports` корневого `package.json`** (`#protocol/*`, `#client/*`, …), не
   workspaces. Почему: `node_modules` — симлинк на store, ссылок workspace в нём быть не может;
   subpath imports поддерживают node и TypeScript. Границы пакетов проверяет тест импортов.
4. **G1, промпт под SDK.** Причина найдена: обработчики `session_start` и `before_agent_start`
   нынешнего расширения трогают тему TUI без `initTheme()` и падают, поэтому промпт harness не
   назначается. В новой системе логика расширения тему не трогает (вид — в `presentation/`),
   а хост агента вызывает `initTheme()`; onnxruntime-node загружается и работает.
   Хост следует запуску pi (`createAgentSessionServices` → `createAgentSessionFromServices` →
   `createAgentSessionRuntime`, как `main.js`) и завершает процесс явно. G1 закрыт: промпт
   harness проходит проверку, бандловые пакеты (magic-context с onnxruntime) и codemode работают
   в агенте бандла (smoke-тест `tests/smoke/bundle.test.ts`).
5. **HAP по fd 3, а не по stdin/stdout.** Узел открывает агенту пару сокетов на fd 3; stdout и
   stderr агента идут в его журнал (`~/.harness/log/agents/<id>.log`). Почему: любой случайный
   `console.log` расширения иначе ломает поток; перехват stdout pi не экспортирует.
   `--stdio` для отладки.
6. **Протокол узла — адресованные кадры вместо каналов `open/data/close`** (7.2). Кадры
   `hello/welcome/refused`, `req/res` (операции с id), `evt` (события узла), `hap { node?, agent, rec }`.
   Узел переписывает id запросов к агенту под соединение и возвращает ответ только спросившему.
   Согласованность снимка без `seq`: `agent_attach { level: "full" }` отвечает снимком агента, а
   живые записи идут клиенту только после ответа — поток агента упорядочен, поэтому снимок +
   хвост не теряют и не дублируют записи. Сводки — событие `summary` в `evt`.
7. **Настройки UI — `~/.harness/ui-settings.json`**, а не `settings.json` (6.1). Почему:
   `settings.json` пишет сам pi в каждом агенте (модель, thinking); два писателя одного
   файла теряли бы записи. Ключи те же (`ui.tabs`, `ui.theme`, …), плоские.
8. **Команды pi — `harness auth|config|mcp|install|remove|uninstall|list|update …`** передаются в
   CLI pi на `~/.harness`; вход провайдера из TUI — `/login` по протоколу (на узле сессии).
9. **Вывод фоновой задачи в TUI — опросом `harness_task_output`** раз в 700 мс, пока открыт
   вид задачи, а не подпиской. Вернуть: подписка `harness_task_subscribe` с потоком кусков.
10. **Отправка сообщения — Ctrl+Enter и Alt+Enter**: терминалы без протокола клавиатуры
    Kitty не отличают Ctrl+Enter от Enter; отправку делает приложение, а не редактор pi-tui
    (тот занимает Alt+Enter под новую строку).
11. **`Spawner` и `NodeFs` узла не внедряются**: агенты порождает `AgentLink`, файлы — `node:fs`;
    тесты идут на настоящих процессах агента со сценарной моделью во временном `HOME` (так проверяется
    и настоящая сборка), время — через `Clock`. Вернуть, если понадобятся сценарии отказов
    файловой системы.
12. **Справочник протокола — `protocol/reference.ts` + `testkit/docs/write-reference.ts`**, а не
    `protocol/gen-reference.ts`: запись файлов — Node API, а `protocol` изоморфный.
13. **Инсталляция без бинарного кэша**: публикация кэша выключена (лимит релиза GitHub),
    `install.sh` и README больше его не предлагают; бандл собирается локально. Вернуть: кэш
    в другом хранилище (например, cachix).
14. **Дочерние агенты — через собственное соединение агента с узлом**, а не запросом
    `harness_spawn_child`: агент — обычный клиент протокола узла (кадры `harness_node` внутри
    его HAP-потока), запускает ребёнка `agent_start { subagent }` и следит за ним `agent_attach`,
    как любой клиент. Узел сам ставит родителя и глубину. Так у ребёнка те же снимок, поток,
    interactions и закрытие, что у вкладки, без второго механизма.
15. **Команда оператора — `/bash <cmd>` и `/bash-quiet <cmd>`**, а не `!cmd` pi: в harness ведущий `!` —
    запрос BUILD. pi записывает такие команды без события, поэтому агент сам отдаёт их записи
    (`entry_appended`) после команды и в конце прогона.
16. **Окно `harness web-app` — app-окно Chromium из бандла** (`--app=<url>`, свой профиль во
    временном каталоге), а не webview/webview + `bun:ffi` (G3): runtime — node, не bun
    (отступление 1), а Chromium уже в бандле для браузерного MCP и тестов; окно без вкладок и
    адресной строки, закрытие окна завершает процесс. Сервер, токен в `#fragment` и протокол —
    как в плане. Вернуть: системный webview, если понадобится меньший след памяти.
17. **Приложение: шрифты и тема.** Шрифты на web —
    свои `@font-face` из сборки (woff2 урезаются `fonttools` в Nix), не `expo-font`; на iOS/Android —
    `expo-font`, но только обычное начертание каждой гарнитуры (жирный и курсив — системы).
    Вернуть: семейства начертаний по `fontWeight`/`fontStyle` на native. Цвета —
    тема pi, разрешённая узлом (`theme_get`), а не генератор токенов при сборке: так работают и
    пользовательские темы из `~/.harness/themes/`; при сборке генерируется только тема первого
    кадра (`fallback.generated.ts`). Тестовый слой — драйвер web на Playwright, без RNTL/happy-dom.
19. **`send_file` — до 40 МБ** (файл идёт клиенту одним кадром `files_get` в base64, кадры до 64 МиБ),
    а не 50 МБ Telegram; `files_get` читает домашний каталог и временный (туда модель складывает
    zip). Вернуть: потоковая передача кусками, если понадобятся большие файлы.
18. **Файлы оператора — `files_upload`** в `~/.harness/uploads/` узла (имя без каталогов), а не
    `files_put` по пути клиента: брошенный в окно файл попадает в сообщение как `@path`.
20. **Нативные сборки — вне песочницы Nix**: `nix/app-native.sh` берёт из Nix `node_modules` и шрифты и
    делает `expo prebuild`, дальше Gradle (Android SDK раннера) и `xcodebuild` + CocoaPods (macOS) в
    пайплайнах `native-android`/`native-apple`; Android не в `nix flake check` (зависимости Gradle не
    зафиксированы в Nix). Вернуть: Android в Nix (`androidenv` + зафиксированный Gradle).
21. **Нет приёма «поделиться» в приложение** (share extension iOS / intent Android): файлы попадают в
    сессию из выбора фото и документов кнопкой `+`; отдать файл из приложения — через
    системное «поделиться». Вернуть: расширение/intent приёма файлов.
22. **Maestro-сценарий один** (`packages/app/maestro/pair-and-start.yaml`: привязка кодом, новая сессия,
    overlay полосы, ссылка `harness://`) на iOS и Android; галерея native и сценарии файлов и голоса
    на устройствах не сделаны (системные окна выбора и микрофон автоматизируются плохо).
    Вернуть: галерея на маршруте `/gallery` через deep link и снимки Maestro.
23. **Пайплайны эмуляторов выключены** (`native-android`, `native-apple`): приложения пока не
    выпускаются; прогоны — только на этой машине и точечно. Вернуть: `gh workflow enable` перед выпуском.
24. **ask_user — пакет `pi-ask-user` (0.17.2) в бандле, а не перенос его кода**: схема, описание,
    правила и отрисовщики инструмента — его; в TUI его же компонент запускается клиентом в зоне
    редактора (только inline, без overlay и Alt+O); приложение рисует свой вид с той же семантикой и
    собирает тот же результат (`packages/client/src/ask-user.ts`). Интеракция `questions` несёт
    параметры вызова и возвращает результат инструмента. Вернуть: ничего — это и есть «один в один».
