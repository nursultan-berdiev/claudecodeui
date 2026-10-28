# Документы Word и Excel

Файлы Word (`.docx`) и Excel (`.xlsx`) читай и правь через `docli`, а не через
самописные скрипты на python-docx или openpyxl. `docli` установлен в окружении
и доступен в каждом чате.

Чтение (ничего не меняет, работает и в режиме «План»):

- `docli word read файл.docx` — текст документа;
- `docli word tables файл.docx` — таблицы;
- `docli word search файл.docx -q "текст"` — поиск;
- `docli word info файл.docx` — свойства документа;
- `docli excel sheets файл.xlsx` — список листов;
- `docli excel read файл.xlsx --sheet Лист1 --limit 1000` — содержимое листа
  (без `--limit` выводятся только первые 10 строк);
- `docli excel cell файл.xlsx -c A1 --sheet Лист1` — значение ячейки;
- `docli excel search файл.xlsx -q "значение"` — поиск;
- `docli excel info файл.xlsx` — свойства книги.

Правка (только в режиме «Авто» и только по просьбе пользователя): `docli word
replace`, `batch-replace`, `update-paragraph`, `update-table`, `add-paragraph`,
`add-table`, `create`, `from-template`; `docli excel set`, `formula`,
`batch-update`, `insert-row`, `delete-row`, `add-sheet`, `create`, `from-csv`.
Параметры команды смотри в `docli word <команда> --help` и
`docli excel <команда> --help`.

Сам скрипт пиши, только если нужной операции в `docli` нет, и скажи об этом
пользователю.

## Старые форматы `.doc` и `.xls`

`docli` читает только `.docx`, `.xlsx` и `.xlsm`. Старый файл сначала
конвертируй в новый формат через LibreOffice, а результат читай через `docli`.
Исходный файл пользователя не трогай: конвертируй копию во временной папке.
Весь блок выполняй одной командой: скобки и `trap` удаляют временную папку
при любом исходе, в том числе после ошибки `soffice` или `docli`.

```bash
(
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  cp -- "файл.doc" "$tmp/"
  timeout -k 5 120 soffice --headless "-env:UserInstallation=file://$tmp/profile" \
    --convert-to docx --outdir "$tmp" "$tmp/файл.doc" > /dev/null 2>&1
  docli word read "$tmp/файл.docx"
  # если новый файл нужен пользователю, скопируй его здесь же, рядом с исходным и под новым именем:
  # cp -- "$tmp/файл.docx" "каталог-исходного-файла/файл (сконвертирован).docx"
)
```

- Для `.xls` то же самое с `--convert-to xlsx` и `docli excel read`.
- Имена файлов всегда в двойных кавычках и после `cp --`: в них бывают пробелы
  и начальный `-`.
- Свой профиль (`-env:UserInstallation`) и `timeout -k` обязательны: с общим
  профилем параллельный запуск молча ничего не создаёт, а обычный `timeout`
  (без `-k`) не убивает зависший `soffice`, он игнорирует SIGTERM.
- Если `soffice` не создал файл или упал по таймауту, скажи об этом
  пользователю и не подменяй содержимое догадками.
- В ответе упомяни, что файл был сконвертирован.
- `.doc` и `.xls` не правь. Правки вноси в сконвертированную копию, сохранённую
  рядом с исходником под новым именем, и предложи её пользователю как новый файл.
