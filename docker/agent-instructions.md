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
пользователю. Старые форматы `.doc` и `.xls` `docli` не читает.
