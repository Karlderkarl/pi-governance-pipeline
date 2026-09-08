# Release 1.2.2 — Korrekturen und Verifikation

Dieser Release enthält die bisherigen uncommitteten Korrekturen für F01–F13 und die nachfolgenden Gegenproben F14–F18 sowie G01/G02. Die Review-Berichte vom 8. September dokumentieren jeweils ihren damaligen Stand. Insbesondere `review-2026-09-08-3.md` ist Claudes Bericht; die zusätzliche Codex-Prüfung wird für den Release durch die folgenden automatisierten Regressionen nachvollziehbar erhalten.

| Befund | Verhalten in 1.2.2 | Regression |
|---|---|---|
| F01–F13 | Prozessstatus, Budgets, tiefe Splits, Beitragsverlauf, Vertrags-/Zustandsschema, Issue-Identität, Governance und Kontrolldateien werden deterministisch geprüft | `review-findings.test.mjs`, `review-boundaries.test.mjs`, bestehende Prozess-/Gate-/Stash-/Split-Tests |
| F14 | Ungültige JSON-Kandidaten können echte kritische Findings nicht verdrängen; vollständiger Lauf erzeugt keinen Approval-Commit | `release-122.test.mjs`: F14 |
| F15 | Eigene Severity-Partitionen behalten ihre Blockierwirkung bei Kandidatenzusammenführung und Deduplizierung | `release-122.test.mjs`: F15, beide Reihenfolgen |
| F16 | Neue Junctions werden entfernt, ihre bestehenden Zieldateien bleiben erhalten; ersetzte Verzeichnisse werden wiederhergestellt | `release-122.test.mjs`: zwei F16-Tests, davon einer als vollständiger Pipeline-Lauf |
| F17 | Review und Commit verwenden dieselben normalisierten Git-Blobs, auch wenn sich Filter oder Arbeitsdateien anschließend ändern | `release-122.test.mjs`: F17 |
| F18 | Zweiter Prozess mit abweichendem TEMP/TMPDIR kann dieselbe Repository-Sperre nicht erwerben | `release-122.test.mjs`: F18 |
| G01 | Binärdateien erhalten einen beschriebenen menschlichen Prüfweg mit ausdrücklicher, außerhalb des Arbeitsbaums gespeicherter Freigabe konkreter SHA-256-Werte | `release-122.test.mjs`: G01/G02, falscher Hash verweigert, richtiger Hash erlaubt Abschluss |
| G02 | Wiederholte Starts eines unveränderten Prüfblockers verbrauchen keine weiteren Implementierungsversuche; Status `paused`, Grund in Zustand und MEMORY.md | `release-122.test.mjs`: Binär- und Text-Wiederaufnahme |
| Zusätzliche Beobachtungen | Kontrollprüfung auch beim erneuten Lesen einer Command-Issue-Quelle im Split; doctor meldet vorhandene Lauf-Sperren | `release-122.test.mjs`: zwei weitere Tests |

Die Budgetkorrektur bucht keine gestarteten Versuche zurück. Ein aufgelöster Prüfblocker setzt den normalen Entwicklungsablauf fort; eine dabei erneut gestartete Implementierung zählt als neuer Versuch. Die Binärfreigabe behauptet keine automatische Inhaltsprüfung: Ein Mensch prüft den konkreten Blob, der Hash bindet anschließend seine Freigabe an diese Bytes. Der Textstandard steigt auf 512 KiB. Die alte F11-Reproduktion setzt ihre ursprüngliche Grenze von 64 KiB nun ausdrücklich, damit die Absicherung trotz geändertem Standard weiterhin getestet wird.

README, Release Notes, Operations, Prompt-Dokumentation und Invarianten wurden auf diesen Ablauf abgeglichen. Die npm-Dateiliste enthält jetzt auch die Release Notes, sodass der README-Link im installierten Paket auflösbar ist.

## Verifikation

Die abschließenden Ergebnisse werden vor dem Release-Commit eingetragen. Lokal laufen die Prüfungen auf Windows mit Node 26.8.1 und Git Bash. Die Modelle werden durch deterministische Rollenprozesse ersetzt; Git-Operationen, Dateisystem-Verknüpfungen und Prozesskonkurrenz sind real. Der Pi SDK wird für die Integrationstests tatsächlich geladen.

Die CI-Matrix prüft zusätzlich Ubuntu mit Node 18 und 22 sowie Windows mit Node 22. Der Release-Workflow testet erneut auf Ubuntu/Node 22 und veröffentlicht erst danach per npm Trusted Publishing. Ein echter Modelllauf und macOS sind für diese Version nicht geprüft. Die Integritätskontrollen sind Prozessgrenzen innerhalb derselben OS-Berechtigungen, keine Betriebssystem-Sandbox.
