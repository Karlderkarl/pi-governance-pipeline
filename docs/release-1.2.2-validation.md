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

Lokale Ergebnisse auf Windows mit Node 26.8.1 und Git Bash:

| Prüfung | Ergebnis |
|---|---|
| `npm test` mit echtem Pi SDK | **144 bestanden, 0 fehlgeschlagen, 0 übersprungen** |
| `bash tests/smoke.sh` | vollständig bestanden, `smoke OK` |
| SDK innerhalb der Smoke-Suite | echter Bootstrap, TypeScript 5.8.3, 5/5 SDK-Integrationstests; kein Shim-Fallback |
| Guard-Verhalten | bestanden; die isolierte Fixture kopiert auch die neue Git-Hilfsabhängigkeit |
| ShellCheck und `git diff --check` | bestanden |
| `npm pack --dry-run` | 58 Dateien, 102.945 Byte Archiv, 313.878 Byte entpackt; Version 1.2.2 |
| GitHub-Release-Text | Extraktion ausschließlich des Abschnitts 1.2.2 geprüft |

Der lokale SDK-Bootstrap verwendete mit `NODE_USE_SYSTEM_CA=1` den Windows-Zertifikatsspeicher; die TLS-Prüfung blieb aktiv. Ein vorheriger Smoke-Durchlauf deckte die fehlende Kopie von `util/exec.mjs` in der Guard-Fixture auf. Nach deren Korrektur bestanden der gezielte Guard-Test und der vollständige erneute Durchlauf.

Die Modelle werden durch deterministische Rollenprozesse ersetzt; Git-Operationen, Dateisystem-Verknüpfungen und Prozesskonkurrenz sind real. Der Pi SDK wird für die Integrationstests tatsächlich geladen.

Die [CI-Matrix für den geprüften Code-Commit `f42e95d`](https://github.com/Karlderkarl/pi-governance-pipeline/actions/runs/34225066616) ist vollständig bestanden: Ubuntu mit Node 18 und 22 sowie Windows mit Node 22, jeweils Unit- und Smoke-Suite. Der abschließende Release-Commit ergänzt ausschließlich diesen Ergebnisbericht; der geprüfte Engine-Code bleibt unverändert. Der Release-Workflow testet den Tag erneut auf Ubuntu/Node 22 und veröffentlicht erst danach per npm Trusted Publishing. Ein echter Modelllauf und macOS sind für diese Version nicht geprüft. Die Integritätskontrollen sind Prozessgrenzen innerhalb derselben OS-Berechtigungen, keine Betriebssystem-Sandbox.
