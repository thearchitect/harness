# Полировка 4: клиент и hub, состояния, ввод, вид

Согласованный план. Каждый пункт «Порядка работ» — отдельный коммит после минимума
шага; полный `nix flake check` — один раз, перед финальным push (см. «Проверки перед
коммитом и push»); эмуляторы не запускаются.

## Что проверено при подготовке

- **Права на сокет.** У node.js нет API, чтобы узнать, от какого пользователя подключились к
  unix-сокету. Доступ к локальному hub обеспечивают права файловой системы: каталог `0700`,
  сокет `0600` (так же устроены ssh-agent и Docker).
- **TLS.** Hub сам TLS не делает: его завершает прокси перед ним — Fly proxy (сертификаты
  `*.fly.dev` и своих доменов выпускает сам), `tailscale serve` (`*.ts.net`) или Caddy (сам
  получает и продлевает сертификат Let's Encrypt). Самоподписанный сертификат браузер не примет;
  собственный ACME в hub (Let's Encrypt; на голый IP — только профиль `shortlived`, 160 часов,
  с 15.01.2026) отложен: библиотека `acme-client` 5.4.0 (последний выпуск 07.2024) профилей не
  заявляет.
- **Fly.** Fly proxy останавливает машину без трафика и будит первым запросом, холодный старт
  около 2 секунд, но про работающих агентов не знает. Поэтому засыпание решает сам hub: в
  `fly.toml` `auto_stop_machines = "off"`, `auto_start_machines = true`
  (https://fly.io/docs/launch/autostop-autostart/).
- **Сканер QR.** `CameraView` из `expo-camera` читает QR на Android, iOS и в вебе (в вебе — только
  QR) (https://docs.expo.dev/versions/latest/sdk/camera/, https://github.com/expo/expo/issues/33913).
- **Протокол.** JSON-записи по строке (`packages/protocol/src/framing.ts`), схемы TypeBox. gRPC не
  подходит: в браузере (grpc-web, Connect) нет двустороннего потока, в React Native нет поддержки,
  поверх stdio по SSH его пришлось бы заворачивать, бинарные записи не читаются в логах.
- **Отступ прокрутки.** У редактора pi-tui окно прокрутки — поле `scrollOffset`, оно сдвигается,
  только когда курсор выходит за край (`editor.js`, `render`). Отступ ставится в своём подклассе до
  отрисовки. Однострочный `Input` держит курсор по центру (`input.js`), поэтому `LineField` рисует
  видимую часть сам.
- **SSH.** OpenSSH (здесь 10.6) пробрасывает unix-сокеты (`-L local_socket:remote_socket`,
  `AllowStreamLocalForwarding yes` по умолчанию), но `harness hub attach` надёжнее: путь к сокету
  знает сама машина, и проброс на сервере может быть выключен.
- **Стрелки в терминале.** На hub и через виртуальный терминал стрелка `\x1b[A` работает. pi-tui
  включает в kitty флаги 7 (с отчётом о типах событий): удержанная стрелка приходит как
  `\x1b[1;1:2A`, нажатие в части терминалов — как `\x1b[1;1:1A`. `shellBytes` переводит только
  формы `…u`, остальное уходит в оболочку как есть. `parseKey` pi-tui читает все формы.
- **Сломанные вкладки.** Все 5 вкладок `ui.tabs` в `~/.harness/ui-settings.json` ссылаются на
  несуществующие файлы сессий. `SessionManager.open` на отсутствующий файл создаёт новую сессию
  с другим id, вкладка своего агента не находит и висит в `starting…`; каждый запуск плодит
  агента-сироту. Вкладки попали в `ui.tabs` через `keepDraft` после `harness_prompt` команды,
  которая не создала сообщения (pi пишет файл только при `_hasConversation`).
- **Попутная ошибка.** `TerminalModel.detach()` бросает исключение, если узел уже отключён.

## 1. Архитектура: клиент и hub

**Инварианты**

- В системе есть только клиенты и hub.
- Hub однопользовательский: работает от имени пользователя, его состояние лежит в домашнем
  каталоге.
- На машине у пользователя ровно один hub. Его держит служба пользователя или первое окно harness
  на машине (hub внутри процесса, тот же код как библиотека).
- Hub сам выполняет все сессии: агенты — его дочерние процессы. Исполнителей на других машинах
  нет и не будет; работа на другой машине идёт через hub той машины.
- Клиент (TUI, веб, приложение) может быть подключён к нескольким hub: к своему и к hub других
  машин.

**Что уходит**

- Узлы за hub и всё, что их обслуживает:
  - `harness hub node add`, ссылки и ключи узлов (`hubs` в конфиге, `nodes.json`);
  - маршрутизация `route` и роль `HubRole`;
  - событие `nodes`.
- Многопользовательский режим:
  - `harness hub user add`, админы;
  - `users/<user>`, настройки по пользователю (`settingsFor`);
  - проверка `allowed()`.
- Слово «узел»: пакет `packages/node` переносится в `packages/hub` через `lsp_refactor`,
  `NodeApi`/`NodeOps` переименовываются в `HubApi`/`HubOps`, тексты и документация меняются.
- Выбор узла для новой сессии: сессия создаётся на выбранном в полосе hub.
- Перед массовыми переименованиями — коммит, дерево чистое.

**Полоса слева, верхний блок** — список hub этого клиента:

- свой hub: `inprocess`, если его держит это окно, иначе `local`;
- удалённые — по именам из `remotes.json`;
- последней строкой «+ add».

Отметки строк: `⊘` — hub недоступен, `◆` — в нём кто-то ждёт оператора, `●` — идёт работа.

## 2. Подключение к hub

**Протокол.** Один: JSON-записи (запросы, ответы, события), схемы TypeBox. Три транспорта:
unix-сокет, stdio по SSH, WebSocket. gRPC не используем (см. «Что проверено»).

| Способ | Как | Шифрование | Аутентификация | Кому |
|---|---|---|---|---|
| локальный | `~/.harness/run/hub.sock` | не нужно | права: каталог 0700, сокет 0600 | клиенты на той же машине |
| SSH | `harness connect ssh://user@host` → клиент держит `ssh -T -o BatchMode=yes user@host harness hub attach` | SSH | ключи и агент SSH, `~/.ssh/config` | TUI на других машинах |
| сеть | HTTP и WebSocket за прокси, включается в `/hub` | прокси (Fly, `tailscale serve`, Caddy) | одноразовая ссылка → токен устройства | браузер, телефон, TUI по ссылке |

**`harness hub attach`** соединяет stdin/stdout со своим сокетом и сверяет протокол.

- Hub не запущен — выходит с кодом и причиной:
  `harness: no hub runs for user@host (start the service, or open harness there)`.
- Сам ничего не запускает.

**`harness connect ssh://…`**

- Запускается в обычном терминале, чтобы ssh мог один раз спросить про ключ хоста или парольную
  фразу. Затем проверяет `attach`.
- Записывает в `remotes.json` запись `{ name, ssh, command? }`, где `command` — путь к `harness`
  на той машине, если его нет в PATH неинтерактивного ssh.
- Клиент потом подключается в режиме `BatchMode`. Ошибку ssh показывает в строке статуса и в
  логе, переподключается с нарастающими паузами.

**Сеть — что делает hub**

- Своего TLS у hub нет: он слушает HTTP на `hub.network.listen` (по умолчанию `127.0.0.1:8790`).
- Адрес не на loopback разрешён только с `hub.network.proxy: true` — когда порт доступен только
  прокси (как на Fly). Иначе hub не стартует и называет причину.
- Внешний адрес для ссылок и QR — `hub.network.url`.
- По `/` hub раздаёт веб-интерфейс из бандла (`.#appWeb`), версия всегда совпадает с hub;
  `/ws` — протокол, `/pair` — привязка.
- Cookie `Secure` работает: для браузера соединение — HTTPS до прокси.
- Hub внутри TUI тоже открывает сетевой доступ, если он включён; телефон тогда работает, пока
  окно открыто.
- Рецепты в `docs/operations/hub.md`: `tailscale serve --bg 8790`, Caddy
  (`hub.example.com { reverse_proxy 127.0.0.1:8790 }`), `fly.toml`.

**Одноразовая ссылка `https://<hub>/#pair=<код>`**

- Код после `#` не уходит на сервер, в логи прокси и в Referer.
- Живёт 10 минут, используется один раз, не больше 5 попыток; неудачи ограничиваются по адресу и
  пишутся в лог.
- Как работает:
  - **браузер** (вставили ссылку или телефон открыл QR системной камерой): hub отдаёт
    веб-интерфейс, страница вызывает `POST /pair { code, name }`, получает cookie
    `HttpOnly; Secure; SameSite=Strict` и стирает код из адреса (`history.replaceState`) — это и
    вход, и регистрация устройства; WebSocket к тому же hub передаёт cookie сам;
  - **сканер QR в приложении** (`expo-camera`, все платформы) или вставка ссылки в приложение
    или TUI (`harness connect https://…#pair=…`, «+ add»): клиент привязывается и получает
    токен в ответе (TUI — `client/remotes.json`, телефон — Keychain/Keystore);
  - **телефон с установленным приложением**: на странице кнопка «Открыть в приложении»
    (`harness://pair?hub=…&code=…`). Universal Links и App Links не подходят: домен hub у каждого
    свой, а их нужно прописывать в сборке приложения.
- Имя устройства по умолчанию — из клиента («Chrome on macOS», имя хоста), меняется в `/hub`.
- Hub хранит только хэш токена (256 бит) в `devices.json`. Отзыв сразу закрывает соединения
  устройства; отозванный токен — понятная причина и предложение привязаться заново.

**Диалог `/hub`** (режим «диалог», на месте поля ввода, рамка `DialogFrame`; те же действия —
командами `harness hub network|device …`)

- состояние сети: вкл/выкл, адрес, внешний URL, прокси;
- устройства: имя, когда добавлено, последнее подключение, адрес; переименование, отзыв;
- экран «добавить устройство»: заголовок `add device`; поле имени (`LineField`), Enter создаёт
  код; QR (в TUI полублоками, в приложении картинкой); под ним ссылка целиком без отступов;
  строки-действия «copy link» и «new code»; состояние «действует до …», «использован:
  <устройство>», «истёк» (QR и ссылка скрываются); клавиши `← back · enter select · esc close`.
- В правой панели — строка `hub…`, открывающая этот диалог (сама панель узкая: QR с полями
  занимает около 37 колонок, а ссылка перенеслась бы).
- Первое устройство на Fly: `fly ssh console -C "harness hub device add --name laptop"` печатает
  ссылку и QR.

**Сон hub (`hub.idleExit`; в образе Fly включён, локально выключен)**

- Hub завершается после 10 минут без клиентов и без работающих агентов (идущих ходов и
  фоновых задач); работа агента держит машину, даже если все клиенты ушли.
- `fly.toml`: `auto_stop_machines = "off"`, `auto_start_machines = true`, `hub.network.proxy: true`,
  hub слушает `0.0.0.0:8080`. Первый запрос будит машину; страница и клиенты ждут hub и
  подключаются.
- Сессии лежат на томе Fly и переживают сон; оболочки терминалов при сне закрываются.

## 3. Состояния: что где хранится

| Состояние | Где |
|---|---|
| сессия: записи, ветки, имя, режимы, стоимость | hub (`hub/sessions/`) |
| живое: прогон, задачи, субагенты, вопросы, терминалы | hub (процессы) |
| рабочее место: вкладки и их порядок, «просмотрено», черновики (текст и вложения) | hub (`hub/workspace.json`) — общее для всех устройств |
| вложения | hub (`hub/attachments/<сессия>/<sha256>.<ext>`) |
| настройки пользователя: тема, избранные модели, клавиши, умолчания, `log.*`, `hub.*` | hub (`hub/settings.json`) |
| вид окна по hub и сессии: прокрутка, раскрытый вывод, выбранный элемент, показан ли терминал, открыта ли панель; активная вкладка каждого hub; выбранный hub | клиент (`client/window.json`; в вебе — хранилище страницы; на телефоне — файл) |
| настройки устройства: шрифты, ширины полос, уведомления | клиент |
| список hub и их токены или SSH-записи | клиент: TUI — `client/remotes.json` (0600), телефон — Keychain/Keystore, веб — cookie `HttpOnly` своего hub |

**Правило пустой сессии.** Сессия пустая, если её состояние совпадает с начальным:

- нет записей;
- черновик пуст и вложений нет;
- имя не задано;
- модель, thinking и режимы — начальные.

Решает сравнение состояния, а не история действий.

- Пустая сессия живёт только в окне, при закрытии исчезает бесследно, её агент останавливается.
- Сессия становится изменённой (начали печатать, приложили файл, переименовали) — она попадает
  во вкладки рабочего места на hub вместе с черновиком.
- Всё стёрли до начального состояния и сообщений нет — сессия уходит из рабочего места и снова
  принадлежит только окну.

**Черновики.**

- Пишутся на hub не чаще раза в секунду и при уходе из вкладки (`workspace_draft_set` с
  ревизией). Побеждает последняя запись.
- Поле в фокусе не перезаписывается чужим изменением, как имя сессии в J полировки 2.
- Начатое на ПК видно на телефоне.

**Вложения.**

- Вставка (Ctrl/Alt+V), перетаскивание и выбор файла сразу загружают файл на hub
  (`attachments_put`) и ставят в черновик `@путь`. Даже локальная картинка из буфера не идёт в
  `tmp`.
- Вложения, на которые не ссылаются ни черновик, ни транскрипт, удаляются через
  `attachments.retentionDays` (по умолчанию 7).

**Исправление `starting…`.**

- Вкладка попадает в рабочее место только по правилу пустой сессии, а не после
  `harness_prompt`. Поэтому `/login` и другие команды больше не сохраняют пустые вкладки.
- `agent_start` на файл, которого нет, отвечает `not_found`. Hub убирает такую вкладку из
  рабочего места, клиент говорит об этом в строке статуса.
- `starting…` виден, только пока запуск действительно идёт; ошибка показывается со своей
  причиной.
- 5 сломанных вкладок оператора исчезнут при первом запуске.

## 4. Структура `~/.harness`

```
~/.harness/
  agent/     что читает pi (PI_CODING_AGENT_DIR): settings.json, auth.json, models.json, mcp.json,
             mcp-auth.json, mcp-*.json, trust.json, themes/, extensions/, skills/, subagents/
  hub/       settings.json, workspace.json, devices.json (хэши токенов), pairings.json, sessions/,
             attachments/, claude/
  client/    remotes.json, window.json, settings.json
  run/       hub.sock, hub.lock
  log/       hub/, agents/, tui/, clients/<устройство>/  — по файлу <дата>.jsonl
```

**Перенос** при первом запуске новой версии, под lock:

- копия всего в `~/.harness.backup-<дата>.tgz`;
- файлы pi → `agent/`;
- `ui-settings.json` и `harness.json` сливаются в `hub/settings.json`;
- `ui.tabs` → `hub/workspace.json`;
- `ui-state/tui.json` → `client/window.json`;
- `nodes/<имя>.json` → `hub.*` в настройках;
- `hub/*` остаётся на месте;
- `remotes.json` → `client/` (записи пересобираются, токены сохраняются);
- `sessions/` → `hub/sessions/`;
- `users/`, `log/node-*.jsonl` и `log/agents/*.log` удаляются (о `users/` — предупреждение в
  строке статуса);
- `sockets/` и `locks/` → `run/`.

Перенос повторно безопасен: если прервался, продолжается при следующем запуске.

## 5. Ввод: одна политика

Модуль `packages/client/src/input/`, общий для TUI и приложения:

- **`keys.ts`** — канонический вид клавиши `{ key, ctrl, alt, shift }`.
  - В терминале его дают `parseKey`/`decodeKittyPrintable`; отпускания отбрасываются, повтор
    считается нажатием.
  - В вебе — по `event.code`, поэтому работает и в русской раскладке.
- **`modes.ts`** — `modeOf(screen)` возвращает режим и его владельца.
- **`actions.ts`** — реестр глобальных действий: id, клавиша, описание. Из него генерируются
  привязки Ctrl+X и Alt+X, подсказки `Ctrl/Alt+X` и секция «ДЕЙСТВИЯ» панели. Свои привязки
  пользователя (`keys` в настройках hub) меняют клавишу действия.
- **`editing.ts`** — клавиши правки полей, без букв. Из этой таблицы ставится менеджер привязок
  pi-tui; умолчания pi не используются.
- **`policy.ts`** — `route(mode, key)` возвращает `global(action)` | `owner(key)` | `scroll(n)` |
  `exit` | `ignore`. Правила записаны таблицей данных.
- **`profiles.ts`** — какие клавиши не доходят в каком окружении: TUI с kitty и без, вкладка
  браузера, окно `web-app`, телефон с клавиатурой. Нужен только для теста.

TUI (`App.onKey`) и приложение (`keyboard.web.ts`) только переводят клавишу в канонический вид и
исполняют результат `route`.

**Режимы**

| Режим | Когда | Что принадлежит режиму | Глобальные действия |
|---|---|---|---|
| чат | открыта сессия | набор и правка в поле; Enter — новая строка; Ctrl/Alt+Enter — отправить; Shift+Tab — уровень thinking; PgUp/PgDn и колесо листают историю, фокус остаётся в поле; Ctrl/Alt+Home/End — к началу или концу истории; Esc останавливает прогон. Внутри — дополнение: ↑↓ выбор, Tab или Enter подставить, Esc закрыть | да |
| диалог | вопрос, подтверждение правки, вход, секрет, выбор модели/сессии/настроек/`/tree`, поиск, выбор папки новой сессии | ↑↓, Enter, Пробел, Tab, набор в поле, ← вне поля — назад, Esc — отмена | да |
| панель | панель Ctrl/Alt+\ или фокус в полосе (Ctrl/Alt+S) | ↑↓, Enter, Пробел, набор в полях, Esc — закрыть | да |
| захват | терминал, редактор промпта, компонент расширения | весь ввод | нет; выход: Ctrl/Alt+/ у терминала, выход из редактора, у компонента — его собственный |

**Глобальные действия.** Ctrl+клавиша и Alt+клавиша работают всегда одинаково, других дублей
нет.

| Клавиша | Действие |
|---|---|
| N / O / W | новая сессия / открыть / закрыть вкладку |
| PgUp/PgDn, 1…9 | соседняя вкладка, вкладка N |
| ↑/↓ | элементы сессии |
| S | фокус в полосу |
| / | терминал |
| \ | панель со списком всех действий и фильтром |
| G | редактор промпта |
| L / P | модель / следующая модель |
| E | раскрыть вывод |
| F | поиск |
| Q | выход |
| C / V | в чате: очистить поле или скопировать выделение / вставить |

**Правка полей** (поле чата и все однострочные):

- стрелки, Home/End;
- Ctrl/Alt+←/→ — по словам;
- Backspace, Delete;
- Ctrl/Alt+Backspace — слово назад, Ctrl/Alt+Delete — слово вперёд;
- Ctrl/Alt+Z — отмена.

Сочетаний в стиле emacs нет.

Скрытия thinking-блоков нет: убираются `hideThinkingBlock`, привязка `app.thinking.toggle` и
подпись скрытого thinking.

**Тесты**

- маршрут каждого действия в каждом режиме;
- в каждом профиле у каждого действия доставляется хотя бы один вариант;
- глобальные клавиши не пересекаются с правкой и режимами;
- в захвате глобальные клавиши не срабатывают;
- русская раскладка в вебе.

## 6. Вид: окно, дополнение, диалог

**Два состояния окна**

- **сессия:** транскрипт и поле ввода;
- **новая сессия:** выбор папки в основной области (это режим «диалог»), поля ввода нет.

Закрыли последнюю вкладку или вкладок нет — открывается выбор папки. Esc в нём возвращает к
предыдущей вкладке, если она есть. Строки «no session — …» больше нет.

**Дополнение** (`/`, `@`, имена сессий):

- над полем блок, только верхняя линия цвета `border` (синий в теме pi), слева на линии подпись:
  `commands`, `files`, `sessions`;
- выбранная строка — `▌` на `selectedBg`, внизу подсказка клавиш;
- поле остаётся, фокус в нём.

**Диалог:**

- вместо поля, линии `border` сверху и снизу, заголовок на верхней линии, строка подсказки, без
  отступов;
- `DialogFrame` в TUI и `Dialog` в приложении — одна рамка для всех диалогов: выбор модели,
  сессии, `/settings`, `/tree`, вход, секрет, подтверждение правки, ask_user, поиск;
- у ask_user и подтверждения правки содержимое и клавиши не меняются, меняется только рамка.

Компоненты расширений (`/mcp` и прочие) — тоже диалог в нашей рамке, внутри которой их
собственные линии (перекрашивать их не будем: это было бы костылём).

## 7. Терминал (Ctrl/Alt+/)

- **Ввод.** Захват: в оболочку идёт всё, кроме Ctrl/Alt+/. Клавиши кодируются заново под
  состояние программы внутри:
  - режим стрелок приложения (DECCKM);
  - протокол kitty, если программа его включила (с её флагами);
  - стандартные модификаторы.

  Повтор клавиши уходит как нажатие. Вставка, фокус и мышь передаются в тех режимах, которые
  программа включила.
- **Где держится.** Терминал на hub, по id сессии, как сейчас.
- **Исправление.** `TerminalModel.detach()` больше не падает без связи.
- **Тесты.**
  - unit на таблицу кодирования: все формы стрелок, Home/End, Delete, PgUp/PgDn, F1–F12 с
    модификаторами, повторы, DECCKM, kitty внутри;
  - сценарий TUI: стрелка вызывает историю в fish и sh; Ctrl+C, Esc, Ctrl+\, Ctrl+N уходят в
    оболочку; Ctrl+/ скрывает терминал;
  - шаг в веб-сценарии.

## 8. Редактор промпта (Ctrl/Alt+G)

- Открывается в такой же рамке, как терминал, режим «захват».
- Работает на hub через тот же механизм терминала, поэтому доступен из любого клиента: операция
  `editor_open { session, text }`, событие завершения с текстом.
- Редактор — `$HARNESS_EDITOR` hub или `micro` из бандла (добавляется в `nix/package.nix`
  скрытым инструментом).
- Черновик пишется во временный файл в `hub/attachments/<сессия>/`. Повторный Ctrl/Alt+G ничего
  не делает. Рамка закрывается, когда редактор завершился, и текст файла становится черновиком
  (на hub, с ревизией).

## 9. Отступ прокрутки

- **Настройки:** `ui.scrollOff.vertical` = 2, `ui.scrollOff.horizontal` = 10 (настройки
  пользователя на hub).
- **Поле чата TUI:** подкласс `ChatEditor` перед отрисовкой ставит окно так, чтобы над и под
  курсором оставалось нужное число строк, если они есть.
- **`LineField`:** рисует видимую часть сам: держит не меньше 10 символов слева и справа от
  курсора, если они есть; у края текста курсор подходит к краю.
- **Веб:** то же для поля ввода и однострочных полей, через `scrollTop`/`scrollLeft`.
- **Телефоны:** у системного `TextInput` прокрутку не задать, там остаётся системная.
- **Тесты:** unit на подкласс и `LineField`, шаг в TUI-сценарии.

## 10. Логи

- **Формат:** JSONL `{at, level, source, event, …}`. Каждая запись несёт id, по которым запрос
  прослеживается от клиента через hub до агента: `client`, `connection`, `req`, `hub`, `agent`,
  `session`.
- **Содержимое пишется всегда:** тексты сообщений, ответы модели, вывод инструментов, ввод в
  терминал. Значения секретов маскируются всегда: `ask_secret`, `auth.json`, токены, коды
  привязки.
- **Срок хранения:** файлы по дням, удаляются старше `log.retentionDays` (по умолчанию 3) — при
  старте и раз в час.
- **Где:**
  - hub: свой лог, агенты (свой структурированный лог плюс сырой stderr), клиенты (`logs_put`
    пакетами);
  - TUI: локально и копия на свой hub;
  - приложение: локально (веб — IndexedDB, телефон — файлы) и на hub.
- **Что пишется:**
  - hub: каждая операция (длительность, ошибка), рукопожатия, SSH-подключения через
    `attach`, сетевой доступ; выдача и использование кодов привязки (без самих кодов),
    неудачные попытки с адресом, отзыв устройств; засыпание hub и его причина;
    `agent_start` с запрошенной и полученной сессией, рабочее место, терминалы, перенос
    `~/.harness`;
  - агент: старт (версии, модель, расширения и их ошибки), прогоны, запросы, вопросы и ответы,
    ошибки со стеком;
  - клиенты: подключения и переподключения, запросы, действия и режимы, строки статуса, жизнь
    вкладок, предзагрузка, ошибки.
- **Уровни:** `log.level`; на уровне `debug` ещё сырые байты клавиатуры и время отрисовки.
- **Чтение:** `harness logs [--since] [--follow] [--source] [--agent] [--session] [--json]`
  сливает источники по времени. Строка «logs» в панели показывает то же.
- **Тесты:**
  - удаление старых файлов;
  - один `req` проходит через клиента, hub и агента;
  - логи приложения доходят до hub;
  - секреты замаскированы.
- **Документация:** `docs/legal/privacy.md` переписывается.

## 11. Инварианты в `AGENTS.md`

Новый раздел перед «Architecture, UI and UX»:

```markdown
## Invariants

- There are clients and hubs, nothing else. A hub is single-user: it runs as its user and keeps
  its state in the user's home (`~/.harness`). A user has exactly one hub per machine, run as a
  user service or held inside the first harness window on that machine (the same code as a
  library).
- A hub executes every session itself: agents are its child processes, on its machine. There are
  no executors elsewhere, ever. Work on another machine goes through that machine's hub.
- Clients reach a hub by its unix socket (`~/.harness/run/hub.sock`: the filesystem's permissions
  are the authentication), over SSH (`ssh user@host harness hub attach`, which only connects to a
  running hub and never starts one), or over HTTP behind a TLS proxy (Fly, `tailscale serve`,
  Caddy) when the hub enables network access: a device pairs once by a one-time link
  (`https://<hub>/#pair=<code>`) and keeps its token (a browser as an HttpOnly cookie); the hub
  keeps only its hash and never terminates TLS itself. One protocol (JSON records) over all three.
  A client may be connected to several hubs.
- The hub keeps everything of the user: sessions, the workspace (tabs, their order, drafts and
  attachments), user settings, devices, logs. A client keeps only what depends on its screen
  (scroll, expanded output, the item shown, the active tab per hub, the chosen hub), its device
  settings and its list of hubs with their credentials.
- A session is empty while its state equals its initial state (no entries, empty draft, no
  attachments, no name, initial model and modes); what decides is the comparison, not the history
  of actions. An empty session belongs to its window alone and leaves nothing behind; a changed one
  joins the workspace with its draft.
- A window shows either a session (transcript and editor) or the choice of a new session's
  folder; nothing in between.
- Input follows one policy (`packages/client/src/input/`): exactly one mode owns the keyboard —
  chat, dialog, panel or capture. Global actions are Ctrl+key and Alt+key alike, always both,
  never other duplicates, and act in every mode but capture; capture (terminal, prompt editor,
  an extension's component) takes all input but its own exit. Unmodified keys belong to the mode;
  Esc goes back one level. Field editing uses no letter chords.
- The editor zone has two forms: a completion above the editor (top rule only) and a dialog in
  the editor's place (top and bottom rules), both in the theme's `border` color.
- Logs are full and structured (JSONL with ids that follow a request from client to hub to
  agent), on the hub and on clients, kept `log.retentionDays` (3 by default); secrets' values are
  always masked.
```

В разделе «Architecture, UI and UX» строка

```markdown
- State is the node's; a window's view is the device's and survives restarts;
  concurrent writers merge by revision or lock — consistency is predictable.
```

заменяется на

```markdown
- State is the hub's; a window's view is the client's and survives restarts;
  concurrent writers merge by revision or lock — consistency is predictable.
```

Правило проверок в начале `AGENTS.md` (сейчас ссылается на несуществующие `nix/smoke.sh` и
`nix/test.sh`) заменяется на:

````markdown
Before every commit, with the changes staged (`git add`: the flake builds only
git-tracked files), run the step's minimum and commit only when it passes:

- `nix build` (a new extension file must be listed in the extension fileset of
  `nix/package.nix`: the bundle is what users get);
- `tsc -p .` (and `tsc -p packages/app/tsconfig.json` when the app changed);
- `nix/check.sh <the tests the change touches>`.

Before pushing `master`, run the full check and push only when it passes:

```bash
nix develop --command nix flake check -L
```

`master` is what users install and update to, and CI checks it only after the
push.
````

## Порядок работ

0. Инварианты и правило проверок в `AGENTS.md`, этот план в `plans/`.
1. Hub вместо узлов: перенос пакета, однопользовательский режим, удаление узлов за hub, полоса
   hub.
2. Структура `~/.harness` и перенос.
3. Подключения: SSH (`attach`, `connect ssh://`), сеть за прокси, раздача веб-интерфейса,
   одноразовая ссылка и привязка, cookie, диалог `/hub`, `hub.idleExit` и `fly.toml`.
4. Состояния: рабочее место на hub, вид окна на клиенте, правило пустой сессии, вложения,
   исправление `starting…`.
5. Ввод: политика, режимы, клавиши, правка полей, без скрытия thinking.
6. Вид: два состояния окна, дополнение, `DialogFrame`.
7. Терминал (кодирование, Ctrl/Alt+/).
8. Редактор промпта и `micro`.
9. Отступ прокрутки.
10. Логи.

## Документация (обновляется в каждом пункте)

- `README.md`;
- `docs/operations/nodes.md` → `docs/operations/hub.md` (с рецептами `tailscale serve`, Caddy, `fly.toml`);
- `docs/operations/fly.md` и `nix/remote-image.nix` (hub за Fly proxy, `hub.idleExit`, первое устройство
  через `fly ssh console`);
- `docs/operations/settings.md`, `docs/operations/app.md`;
- `docs/protocol/*` и справочник;
- `docs/legal/privacy.md`;
- `docs/pi-mapping.md` (раскладка больше не pi);
- отступления в плане платформы.

## Проверки перед коммитом и push

- **Перед каждым коммитом** (изменения в `git add`):
  - `nix build` — бандл собирается, новые файлы в него попали;
  - `tsc -p .`, для приложения ещё `tsc -p packages/app/tsconfig.json`;
  - `nix/check.sh` на тестах, которые задевает шаг: unit-тесты изменённых модулей и их
    сценарии;
  - веб-сценарий — только если шаг меняет приложение, с пересборкой `.#appWeb`.
- **Перед финальным push** — полный `nix develop --command nix flake check -L` (все тесты на
  бандле, модуль NixOS и образ Fly в виртуальных машинах, `remote-tools`). Упал —
  исправления отдельными коммитами поверх, история не переписывается.
- До push `master` есть только локально: промежуточные коммиты без полной проверки не
  доходят ни до пользователей, ни до CI.

## Проверки — сводно

- unit на каждый модуль, перечисленные в разделах;
- сценарии:
  - два клиента одного hub, телефон через сеть;
  - привязка по ссылке в веб-сценарии: страница с `#pair=` сразу входит, cookie `HttpOnly`, код
    стёрт из адреса, повторное использование отклонено; `harness connect https://…#pair=…` в
    TUI-сценарии; отзыв закрывает соединение;
  - отказ запуска на внешнем адресе без `hub.network.proxy`;
  - `hub.idleExit`: hub не засыпает при работающем агенте и засыпает без клиентов и агентов;
  - TUI через `ssh://` к hub в тестовом sshd на этой машине, если sshd доступен в песочнице,
    иначе через подменённую команду ssh;
  - перенос старого `~/.harness` с пятью сломанными вкладками;
  - режимы и клавиши в TUI и вебе;
  - терминал, редактор промпта;
  - логи с общим `req`;
- вручную в tmux и Ghostty: стрелки в терминале, `micro`, рамки диалогов.
