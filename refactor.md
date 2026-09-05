# Refactor: pi-governance-pipeline

**Status:** Umgesetzt als 1.2.0 (siehe Abschnitt 10)
**Datum:** 2026-09-05
**Basis:** `main` @ `e3929c9` (Release 1.0.17)
**Gelesen:** `SKILL.md`, `references/*.md`, `assets/auto-develop.sh`, `assets/lib/*.mjs`, `extensions/pipeline-guard.ts`, `prompts/*.md`, `tests/*`, beide Workflows, README, `docs/PRD-harness.md`, `docs/review-2026-09-05.md`, `MEMORY.md`. pi 0.85.1 und Claude Code liegen lokal vor; Flags wurden gegen `pi --help` und `claude --help` geprüft.

---

## 0. Leitsatz

> **Der Skill generiert keine Pipeline mehr. Er konfiguriert eine, die das Paket mitbringt und testet.**

Heute bittet der Skill ein Sprachmodell, ein 1213-Zeilen-Bash-Skript zu kopieren, drei Variablen anzupassen und dabei 19 Invarianten einzuhalten. Das ist eine deterministische Aufgabe, die von einem probabilistischen Akteur erledigt wird. Die Drift-Notiz "no generation eval" in `MEMORY.md` ist das Symptom, nicht das Problem.

Das PRD selbst gibt die Richtung vor: Zähler und Budget gehören in den Harness, nicht in den Modellkontext (R10). Dasselbe Argument gilt für die Schleife. Modell-Urteil nur dort, wo Urteil gebraucht wird: PRD lesen, Repo inspizieren, Entscheidungen mit dem Menschen klären, Audit-Befunde einordnen. Alles andere ist Code, der einmal geschrieben, getestet und versioniert wird.

Alles in diesem Dokument darf sich ändern. Abschnitt 1 nicht.

---

## 1. Der Kern, der bleibt

Diese sieben Punkte sind der Grund, warum der Skill existiert. Jede Stufe in Abschnitt 5 muss sie nachweislich erhalten, und die Testsuite pinnt sie.

| Nr. | Kern | Herkunft im PRD |
|---|---|---|
| K1 | **Governance ist die Quelle der Wahrheit.** Routing, Budgets, Gate-Regeln stehen in `AGENTS.md`; nichts davon wird im Code oder in einem Prompt entschieden. Eine Änderung am `models:`-Block ändert das Routing, ohne dass irgendetwas anderes angefasst wird. | §3, R16, AK1, AK2 |
| K2 | **Der Harness wählt das Modell, nicht der Agent.** Jede Rolle ist ein eigener Prozess mit einem bewusst gewählten Modell. Kostendifferenzierung: mittleres Modell für die Masse der Arbeit, Frontier nur dort, wo entschieden wird, Eskalation nur nach Scheitern. | §4.1, R1 |
| K3 | **Unabhängiges Mehrfach-Review.** Drei Reviewer in drei Prozessen über mindestens zwei Anbieter, keine geteilten Urteile, kein Self-Review. Das Gate ist severity-basiert, nicht prozentual. Der Controller schlägt vor, der Master entscheidet und sieht die Originale. Der Master kann kein blockierendes Gate übersteuern. | R2 bis R8 |
| K4 | **Eskalation startet frisch.** `take_over` verwirft den abgelehnten Baum und den Research-Cache; das stärkere Modell bekommt das Issue und die Findings als Ausschlussliste, nie den gescheiterten Diff. | R9 |
| K5 | **Zähler und Budget leben im Harness.** Attempts sind ein Qualitätssignal pro Issue. Das Baumbudget ist ein Ressourcenlimit an der Wurzel, das nie zurückgesetzt wird. Ein Modell erfährt höchstens "N Versuche übrig". | R10, R11 |
| K6 | **Sicher per Default, Abbruch nie stumm.** Privilegierte Schritte und Auto-Merge nur nach expliziter Bestätigung vor der Schleife. Ein Abbruch markiert das Issue, schreibt den Blocker nach `MEMORY.md` und benachrichtigt einen Menschen. | R12 bis R14 |
| K7 | **Governance ist harness-neutral.** SOUL, AGENTS, MEMORY kennen keinen Anbieter. Nur die Harness-Konfiguration wird pro Harness gerendert, aus einer Extraktion. | R15, AK6 |

Wenn eine Änderung unten einen dieser Punkte schwächt, ist die Änderung falsch, nicht der Punkt.

---

## 2. Befund: Was heute im Weg steht

Das sind keine Bugs. Die Bugs hat das Review vom 2026-09-05 geschlossen. Das hier sind Strukturprobleme, die jedes weitere Review teurer machen als das letzte.

### B1. Die Pipeline wird "generiert", aber faktisch kopiert

`SKILL.md` sagt: "Copy the bundled pipeline and adapt only the documented points … do not rewrite the loop." `prompts/automate.md` sagt: "Start from `assets/auto-develop.sh` … adapt it … Every invariant in `references/pipeline-template.md` must hold in the result." Das Modell soll also kopieren, drei Variablen setzen, 19 Invarianten prüfen und pi-Flags gegen `pi --help` verifizieren.

Folgen:

- Die Kopie im Projekt driftet vom Paket weg. "Re-sync" ist ein manueller Modus, den niemand auslöst.
- `SKILL.md` muss das gesamte Schleifenwissen tragen, damit das Modell es beim Kopieren nicht verletzt. Daher 201 Zeilen und 3195 Wörter, die bei jedem Trigger in den Kontext wandern.
- Es gibt keine Möglichkeit zu testen, ob ein Modell, das dem Skill folgt, eine konforme Pipeline erzeugt. `/pipeline-audit` mit 29 Prüfpunkten existiert genau deshalb.

### B2. Zwei Sprachen in einer Datei

`auto-develop.sh` enthält 17 eingebettete `node -e`-Programme (Konfigurationsextraktion, JSON-Logging, Blocker-Historie, Findings-Prosa, Diff-Truncation, tasks.md-Update, Master-Parser, Prompt-Pruning) und ruft `governance.mjs state` an 7 Stellen als Subprozess auf, jedes Mal mit `GOVERNANCE_AGENTS` im Environment.

Folgen:

- Kein Stück davon ist einzeln testbar. Die Suite kann nur das ganze Skript treiben.
- shellcheck sieht das JavaScript nicht.
- Bash-3.2-Kompatibilität (`${arr[0]+_}`), ARG_MAX (Prompt über stdin), `dd` statt `head -c`, GNU `timeout` oder gar keins: alles Kommentare, die einen Workaround erklären, den Node nicht bräuchte.
- Auf Windows läuft es nur in Git Bash. Der Autor arbeitet auf Windows.

### B3. Vier Kopien der Invarianten

Dieselben Regeln stehen in `SKILL.md` (Abschnitt "Non-negotiable invariants"), in `pipeline-template.md` (19 nummerierte Invarianten), in `pipeline-audit.md` (29 Prüfpunkte) und als Doku-Greps in `smoke.sh`. Der Safety-Abschnitt der README ist eine vierte Fassung des Safety-Abschnitts in `SKILL.md`. Finding F10 des Reviews (Audit-Punkt 15 und Invariante 12 nannten nur `MEMORY.md` als stash-geschützt) war die direkte Folge.

### B4. Die Gates stehen nicht in der Governance

`pipeline-template.md` behauptet: "Stack-agnostic: the gates are read from governance, never hardcoded." Tatsächlich sind `LINT_CMD` und `TEST_CMD` Umgebungsvariablen, die leer ausgeliefert werden. Das Skript warnt beim Start und läuft dann ohne deterministisches Gate. Der PRD-Ablauf "Linter + Clean-Code-Gate (deterministisch, kein LLM)" ist im Default nicht erfüllt. Die Governance ist per Design unvollständig: Der Modus `govern` inspiziert das Repo nach Dev-Commands für `SYSTEM.md`, schreibt sie aber nirgends hin, wo die Pipeline sie liest.

### B5. Konfiguration ist verstreut

Sechzehn `${VAR:-default}`-Knöpfe im Skript, fünf `PIPELINE_*`-Variablen für den Guard, die Dualität `GOVERNANCE_AGENTS` / `AGENTS_FILE`, fünf Flags, dazu der Contract in `AGENTS.md`. Es gibt keinen Ort, an dem ein Operator die Konfiguration eines Laufs vollständig sieht.

### B6. Der Guard prüft Kommandostrings, nicht die Eigenschaft, die zählt

`pipeline-guard.ts` ist erklärtermaßen ein Speed Bump: Regexe über den getippten Befehl. Die Eigenschaft, auf die es für die Pipeline ankommt, lautet "Governance ist nach einem Implementierungsversuch unverändert". Die prüft niemand direkt. `eval`, `bash -c`, ein Skript, das eine Datei schreibt: alles geht am Regex vorbei, und das Paket sagt das auch.

### B7. Toter Vertrag, fehlende Schnittstelle

`max_split_depth` wird streng validiert, inklusive Override-Variable, und nie benutzt. Das eigentliche Hindernis ist nicht der fehlende Split-Zweig, sondern dass die Issue-Quelle keine Schnittstelle hat: `tasks.md` und `!command` sind zwei Sonderfälle im Skript, und ein Kommando-Backend kann kein Sub-Issue anlegen. Ohne `create` kann es keinen Split geben.

### B8. Keine Kostensicht

Kosten sind die zweite Säule des PRD (§1 Punkt 2). Das Event-Log kennt Rolle, Modell, Exit-Status und Prompt-Pfad, aber keine Tokens und keine Kosten. pi 0.85.1 hat `--mode json`, und das Bundle führt `usage`- und `cost`-Felder. Die These "mittleres Modell implementiert, Frontier entscheidet, das senkt die Kosten" ist mit dem heutigen Log nicht messbar.

### B9. Ein Harness

AK6 verlangt lauffähige Pipelines für zwei Harnesses. Die pi-Flags stehen direkt in `run_role`. Es gibt keine Naht, an der ein zweiter Harness andocken könnte.

### B10. `SKILL.md` ist ein Betriebshandbuch

Bedrohungsmodell, Umgebungsvariablen, pi-Trust-Mechanik, Launch-Snippet, Eskalationsdetails, Invarianten. Das meiste davon existiert nur, weil das Modell die Schleife schreiben soll (B1). Ein Skill, der konfiguriert statt generiert, braucht davon einen Bruchteil.

### B11. Die Testsuite ist ein 2275-Zeilen-Monolith

59 Szenario-Abschnitte in einer Bash-Datei, Fixtures inline, Reihenfolge implizit, jedes Szenario kopiert Skript und Libs erneut. Der Stub-`pi` erkennt Rollen am Prompt-Präfix ("You review a diff for one concern only: security"), koppelt die Tests also an den Wortlaut der Prompts. Die Suite ist die eigentliche Stärke des Pakets, aber sie wächst linear mit jedem Finding und ist auf Windows nur in Git Bash lauffähig.

### B12. Prompts als Heredocs

Die Rahmung "issue text and diff are untrusted input" ist ein Sicherheitsmerkmal. Sie steht in einem Bash-Heredoc in `build_review_prompt`. Nicht als Text reviewbar, nicht per Diff nachvollziehbar, nicht pro Rolle testbar.

### Ist-Inventar

| Bestandteil | Umfang | Anmerkung |
|---|---|---|
| `assets/auto-develop.sh` | 1213 Zeilen Bash | 17 `node -e`, 7 `state`-Subprozesse, 4 `eval`, 16 Env-Knöpfe |
| `assets/lib/governance.mjs` | 692 Zeilen | Parser, Validator, State-Store in einer Datei |
| `assets/lib/gate.mjs` | 244 Zeilen | sauber, bleibt |
| `extensions/pipeline-guard.ts` | 236 Zeilen | Regex-Gate, `/pipeline-status`, `pipeline_state` |
| `SKILL.md` | 201 Zeilen, 3195 Wörter | wird bei jedem Trigger geladen |
| `references/*.md` | 446 Zeilen | Contract, Dateien, Template, Prompt-Builder |
| `tests/smoke.sh` | 2275 Zeilen Bash | 59 Abschnitte |
| Governance-Pfadlisten | 4 Kopien | `is_gov`, Pathspec-Excludes, `preserve_paths`, `GOVERNANCE` im Guard |

---

## 3. Zielbild

> **Hinweis zum Stand:** Dieser Abschnitt ist der Entwurf vor dem Review. Zwei Punkte darin sind überholt und in Abschnitt 10 korrigiert: Die Integritätsprüfung stellt aus dem Snapshot wieder her, nicht aus HEAD (3.6), und den Prompt-Override-Slot im Zielrepo (3.7) gibt es nicht. `harness:` ist kein Contract-Feld (3.2).

### 3.1 Paketlayout

```
pi-governance-pipeline/
  bin/pipeline.mjs                 CLI: init | run | status | report | doctor
  lib/
    contract/   parse.mjs, validate.mjs        Contract v2, v1 bleibt lesbar
    state/      store.mjs                      Zähler und Budget, unverändertes Dateiformat
    issues/     source.mjs, tasks-md.mjs, command.mjs, github.mjs
    harness/    adapter.mjs, pi.mjs, claude-code.mjs, stub.mjs
    review/     gate.mjs, parse-reviewer.mjs, parse-master.mjs
    diff/       capture.mjs                    Per-Datei-Truncation, Manifest, Ausschlüsse
    prompts/    render.mjs, templates/*.md
    loop/       issue.mjs, attempt.mjs, escalate.mjs, commit.mjs, split.mjs
    log/        events.mjs                     JSONL plus Usage
    integrity/  governance-paths.mjs, snapshot.mjs
  extensions/pipeline-guard.ts     bleibt: interaktive Bremse, /pipeline-status, pipeline_state
  skills/governance-pipeline/
    SKILL.md                       kurz, drei Modi
    references/governance-files.md
    references/contract.md         v2
    references/operations.md       Flags, Variablen, Bedrohungsmodell (aus SKILL.md und README)
    references/invariants.md       einzige Quelle, nummeriert INV-01 …
  prompts/govern.md, automate.md, pipeline-audit.md, pipeline-report.md
  tests/                           node --test, Szenarien gegen einen programmierbaren Stub-Harness
```

Im Zielprojekt liegen nur noch:

```
AGENTS.md            mit dem Contract-v2-Block
auto-develop.sh      zwei Zeilen: exec npx --yes pi-governance-pipeline@<pin> run "$@"
.pipeline/           wie heute, gitignored
```

Die Libs werden nicht mehr ins Projekt kopiert. Die Version ist der Pin im Wrapper. "Re-sync" ist ein Bump dieses Pins. Für Offline-Umgebungen und Entwicklung des Pakets selbst gibt es `PIPELINE_BIN=<pfad zu bin/pipeline.mjs>` als Override; `init` schreibt auf Wunsch stattdessen den absoluten Pfad der pi-Installation in den Wrapper.

Das Paket ist bereits auf npm und verlangt Node 18. `npx` bringt keinen neuen Abhängigkeitstyp.

### 3.2 Contract v2

```yaml pipeline-contract
contract: 2
harness: pi                      # pi | claude-code, Default pi

models:                          # unverändert gegenüber v1
  research:          { provider: openai,    model: gpt-5-mini,   thinking: low }
  implement:         { provider: anthropic, model: sonnet-4.5,   thinking: high }
  implement_master:  { provider: google,    model: gemini-3-pro, thinking: high }
  controller:        { provider: openai,    model: gpt-5-nano }
  master_review:     { provider: anthropic, model: opus-4.5,     thinking: high }
  review:
    security:        { provider: google,    model: gemini-3-flash, thinking: medium }
    quality:         { provider: openai,    model: gpt-5 }
    correctness:     { provider: anthropic, model: haiku-4.5,   thinking: low }
  constraints:
    no_self_review: true

budgets:                         # unverändert; max_split_depth wird in 3.5 real
  max_attempts_controller: 3
  max_attempts_master: 3
  max_runs_per_tree: 25
  max_split_depth: 1

review:                          # unverändert
  blocking_severities: [critical, high]
  followup_severities: [medium, low]

issues:                          # neu
  source: tasks.md               # Datei, oder:
  # source: { command: "gh issue list --label ready --json number,title", trust: external }

gates:                           # neu: geordnete Liste, alle müssen vor jedem Review bestehen
  - { name: lint, run: "npm run lint" }
  - { name: test, run: "npm test" }
  # - { name: complexity, run: "npx eslint --max-complexity 10 src" }   # das Clean-Code-Gate aus dem PRD
```

Regeln:

- Eine v1-Datei (kein `contract:`-Schlüssel, kein `issues`, kein `gates`) parst weiter mit den heutigen Defaults und Warnungen. Rückwärtskompatibilität ist AK2.
- Steht `contract: 2` in der Datei, ist `gates` Pflicht. Wer ohne deterministisches Gate laufen will, schreibt `gates: []` hin. Absicht wird sichtbar, ein leeres Gate ist nie mehr ein Versehen.
- `issues.source` ist Pflicht ab v2. `trust: external` kennzeichnet Quellen, deren Text nicht vom Betreiber stammt (`gh`, Jira). Das Startup-Gate verlangt dafür eine Bestätigung, wie für `--unattended`.
- `govern` schreibt `issues` und `gates` aus der Repo-Inspektion (`package.json` scripts, `Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod`). Ist die Wahl unklar, steht `[USER DECISION REQUIRED]` als Wert; der Parser behandelt den Marker als "fehlt" und `init` bricht mit dem Feldnamen ab.
- `harness` wählt den Adapter und den Renderer für die Harness-Konfiguration: `SYSTEM.md` plus `.pi/APPEND_SYSTEM.md` für pi, `CLAUDE.md` für Claude Code. Eine Extraktion, zwei Renderer, wie R15 es beschreibt.
- Alles andere aus v1 bleibt wortgleich: Fence-Regeln, unbekannte Schlüssel warnen, Absenz ist ein dokumentierter Zustand, `automate` schreibt nie.

Der Vertrag zwischen `govern` und `automate` wird damit vollständig: Was die Pipeline zum Laufen braucht, steht in einer Datei, die der Guard schützt, die committet ist und die ein Mensch reviewen kann. Die Gates laufen weiterhin durch eine Shell. Der Unterschied: Die Quelle ist jetzt Governance, nicht das Environment des Aufrufers.

### 3.3 Harness-Adapter

Eine Schnittstelle, zwei Implementierungen, ein Stub für Tests.

```js
invoke({
  role,            // "implement" | "review.security" | …
  model,           // "provider/id" oder "default"
  thinking,        // optional
  prompt,          // String, geht über stdin
  cwd,
  isolation,       // "implementer" | "reviewer" | "judge"
  trusted,         // true nur nach dem Startup-Gate, nie für reviewer
  timeoutMs,
}) → { status, text, usage: { input, output, cacheRead, cost }, durationMs }
```

**pi-Adapter.** Exakt die heutigen Flags pro Isolationsklasse: `-p --no-session` immer; `reviewer` bekommt `-nc -t read,grep,find,ls --no-approve`; `judge` (controller, master_review) bekommt `--no-tools`; `--approve` nur bei `trusted` und nie für `reviewer`. Neu, gegen pi 0.85.1 geprüft: `reviewer` bekommt zusätzlich `-ne -ns -np`. Keine Extensions, keine Skills, keine Prompt-Templates, auch keine globalen. Damit kann weder eine Projekt-Extension das `read`-Tool ersetzen noch eine globale Extension des Operators Kontext in ein Review tragen. Reviewer sind read-only, der Guard hat dort ohnehin nichts zu tun. Usage kommt aus `--mode json`; die genaue Ereignisform ist gegen die installierte Version zu verifizieren, und fehlende Usage ist "n/a", nie ein Abbruch.

**claude-code-Adapter.** `claude -p --model … --output-format json`, Tool-Allowlist über `--tools` beziehungsweise `--allowedTools`, `--setting-sources` für die Isolation von Projekt- und User-Settings, `--json-schema` für Reviewer- und Master-Ausgabe. Das Äquivalent zu `--approve` ist der `--permission-mode`, der Schreibzugriffe nicht-interaktiv erlaubt; er sitzt hinter demselben Startup-Gate. Details in Stufe 6.

**Timeout** ist ein Argument an `child_process.spawn`, nicht mehr GNU `timeout` oder nichts. Ein Timeout leert die Ausgabe, wie heute.

### 3.4 Issue-Quelle als Schnittstelle

```js
list()                       → [{ id, title, text, parent }]
markDone(id)
markBlocked(id, reason)
create({ parent, title, text }) → id      // optional
```

- `tasks-md`: heutiges Checkbox-Format. Sub-Issues aus einem Split werden als eingerückte Kinder unter dem Elternteil angelegt.
- `command`: heutiges `!command`, nur `list`. Ohne `create` wird ein Split zur Ablehnung mit klarer Meldung. `trust: external` ist hier der Default.
- `github`: `gh issue list`, `gh issue create`, `gh issue comment` für Blocker. Nicht in der ersten Stufe, aber die Schnittstelle ist dafür geschnitten.

Die Ids bleiben pfadsicher, die Roh-Id bleibt für `markDone` erhalten. Beides ist heute schon so, nur verstreut.

### 3.5 Split wird real

Der Master darf ab v2 mit `{"decision":"split","issues":[{"title":…,"text":…},…]}` antworten, wenn zwei Bedingungen gelten: Die Tiefe des Issues ist kleiner als `max_split_depth`, und die Issue-Quelle kann `create`. Sonst zählt die Antwort als `reject` mit dem Hinweis, warum nicht gesplittet wurde.

Budget-Modell: **Kontovariante.** Das Baumbudget liegt an der Wurzel und wird von allen Kindern verbraucht, Attempts werden pro Sub-Issue neu gezählt. Das ist keine neue Entscheidung, sondern die, die R10 und der State-File-Entwurf (`root_id`, `runs_used`, `issues.*`) bereits treffen. Die offene PRD-Frage "Kontovariante vs. anteilige Aufteilung" wird damit beantwortet und im PRD als entschieden markiert. Die Alternative (anteilig) hätte einen Vorteil, nämlich dass ein einzelnes Kind nicht das ganze Konto leeren kann; sie kostet einen zweiten Zähler pro Kind und ist ohne Erfahrungswerte nicht zu kalibrieren. Erst messen (3.8), dann bei Bedarf nachziehen.

`block_issue` bekommt weiterhin die Wurzel-Id. Ein blockiertes Kind legt keine neue State-Datei an. Das steht heute als Anforderung an Generatoren im Template; jetzt ist es Code.

### 3.6 Sicherheit: von der Regex zur geprüften Eigenschaft

**Governance-Integrität im Harness.** Vor jeder Rolle wird ein Snapshot der Governance-Pfade gehasht (`SOUL.md`, `AGENTS.md`, `AGENTS.override.md`, `SYSTEM.md`, `.pi/**`, `CLAUDE.md`, `MEMORY.md`, die Schreibweisen in Großbuchstaben). Nach `implement` und `implement_master` wird verglichen. Bei Abweichung: Wiederherstellung aus HEAD beziehungsweise Löschen der neuen Datei, der Versuch zählt als abgelehnt mit dem Grund "governance modified: <pfade>", Log-Ereignis. `MEMORY.md` schreibt nur der Harness selbst (Blocker). Das deckt `eval`, `bash -c`, Skripte und alles, was die Regex nicht sieht. Es ist keine Sandbox, aber die Eigenschaft, auf die es ankommt, wird jetzt geprüft statt vermutet.

**Eine Pfadliste.** `lib/integrity/governance-paths.mjs` ist die einzige Quelle für Diff-Ausschluss (beide Pfade: untracked und tracked), Stash-Schutz, Integritätsprüfung und den Guard. Finding F5 (`AGENTS.override.md` in keiner der drei Listen) war ein Duplikationsfehler; er kann so nicht wieder entstehen.

**Der Guard bleibt, aber schmaler.** Für interaktive Sessions ist er nützlich: Ein Agent, der aus Gewohnheit `git push --force` tippt, wird gefragt. Die Regexe wandern in ein importierbares Modul mit Tabellen-Tests (der bestehende `guard.test.mjs` bleibt). Die Pipeline verlässt sich nicht mehr auf ihn.

**Startup-Gate unverändert im Prinzip**, erweitert um die Bestätigung externer Issue-Quellen. Alle Bestätigungen vor der Schleife, `--yes` für nicht-interaktives stdin, sonst Abbruch. Die Umgebungsvariable `PIPELINE_UNATTENDED=1` bleibt die Brücke zum Guard in Kindprozessen.

**Kanarienvogel-Test für Reviewer-Isolation.** Die Suite pflanzt einen eindeutigen String in `AGENTS.md` und `.pi/APPEND_SYSTEM.md` einer Testumgebung und prüft, dass der Stub-Harness für `reviewer`-Aufrufe exakt die Isolationsflags erhält. Optional `pipeline doctor --live`: ein echter, billiger Reviewer-Aufruf, dessen Antwort den Kanarienvogel nicht enthalten darf. Kostet einen Modellaufruf, läuft nur auf Wunsch.

### 3.7 Prompts als Templates

`lib/prompts/templates/<rolle>.md` mit Platzhaltern. Jedes Template hat einen **festen Harness-Vorspann**, den Projekte nicht überschreiben können: die Rahmung von Issue und Diff als nicht vertrauenswürdige Eingabe, die Severity-Definitionen, das Ausgabeschema, "you have N attempts left". Darunter ein optionaler Projektanteil aus `pipeline/prompts/<rolle>.md` im Zielrepo, committet und damit reviewbar.

Tests rendern jedes Template mit Fixtures und prüfen als Eigenschaften, nicht als Wortlaut:

- Reviewer-Prompts enthalten kein fremdes Urteil, keine Panelgröße, keinen Modellnamen.
- `implement_master` erhält keinen Diff und Findings ohne Zeilennummern.
- Der Attempt-Zähler erscheint nur als "N left".
- Die Untrusted-Input-Rahmung ist vorhanden.

Der Stub-Harness in den Tests erkennt Rollen dann am `role`-Argument, nicht am Prompt-Präfix. Die Kopplung an den Wortlaut (B11) verschwindet.

### 3.8 Beobachtbarkeit und Kosten

Jedes Log-Ereignis bekommt `usage` (Input, Output, Cache-Read) und, wo der Harness es liefert, `cost`. `pipeline report [--issue <id>]` druckt pro Issue: Versuche, Aufrufe pro Rolle, Tokens, Kosten, Wanduhrzeit, Ausgang. `/pipeline-status` in der Extension zeigt dieselbe Tabelle.

Damit wird die Kostenthese des PRD erstmals prüfbar: Der Bericht zeigt den Kostenanteil pro Rolle. Wenn `master_review` mehr kostet als `implement`, stimmt die Modellwahl nicht, und man sieht es, statt es zu vermuten.

### 3.9 `SKILL.md` neu

Frontmatter wie heute (`name`, gekürzte `description`, `compatibility`). Körper höchstens 80 Zeilen:

1. **Zweck** in drei Sätzen. PRD zu Governance, Governance zu Pipeline, das Paket bringt die Pipeline mit.
2. **Wann laden, wann nicht.** Unverändert: nicht nur, weil ein Repo eine `AGENTS.md` hat.
3. **Modus `govern`.** Wie heute, verweist auf `governance-files.md`. Neu: schreibt `issues` und `gates` aus der Repo-Inspektion, rendert die Harness-Konfiguration nach `harness:`.
4. **Modus `automate`.** Führt `pipeline init` aus (schreibt Wrapper, validiert Contract, prüft `.gitignore`, HEAD, Node-Version), dann `pipeline run --dry-run`, zeigt die Ausgabe. Bei Contract-Fehlern: Fehler erklären, Korrektur vorschlagen, die Korrektur läuft über `govern`, weil nur `govern` Governance schreibt. Das Modell kopiert nichts und schreibt keine Schleife.
5. **Modus `audit`.** Führt `pipeline doctor` aus (deterministisch: Contract, Gitignore, HEAD, Gates konfiguriert, Wrapper-Pin aktuell, Trust-Zustand) und ordnet den Befund ein. Die Invarianten der Schleife prüft die Suite des Pakets, nicht ein Modell.
6. **Fünf Verbote.** Nie die Schleife selbst schreiben. Nie ein Modell im Prompt wählen. Nie Governance unter `pi -p` ohne `PIPELINE_ALLOW_GOVERNANCE_WRITE=1` schreiben. Nie das Startup-Gate umgehen. Nie `.pipeline/state` von Hand ändern.

Alles andere wandert nach `references/operations.md` (Flags, Variablen, Bedrohungsmodell, Trust-Mechanik von pi; die README verlinkt dorthin statt zu kopieren) und `references/invariants.md`.

### 3.10 Invarianten als einzige Quelle

`references/invariants.md` führt jede Invariante mit Id, einem Satz, dem Grund und dem Test, der sie pinnt:

```
INV-07  Der Master kann kein blockierendes Gate übersteuern.
        Grund: ein deterministischer Severity-Fail steht über jedem Modell-Urteil.
        Test: tests/loop/master.test.mjs → "approve over gate_status 4 is rejected"
```

`pipeline-audit.md` verweist auf Ids statt Regeln zu wiederholen. `pipeline-template.md` entfällt; sein Inhalt ist Code plus `invariants.md`. Ein Traceability-Test prüft, dass jede Id mindestens einen Test hat und jeder Test mindestens eine Id nennt. Doku-Greps in der Suite ("SKILL.md must mention MIN_REVIEWERS") entfallen, weil die Doku nichts mehr lehrt, was der Code nicht selbst tut.

### 3.11 Tests

- `node --test`, eingebaut seit Node 18, keine Abhängigkeit.
- `tests/helpers/scenario.mjs`: legt ein Temp-Repo an (`git init`, Initial-Commit, `AGENTS.md` aus Fixture, Issue-Quelle), liefert `run(args)`, liest State, Log, Prompts, Git-Zustand.
- `tests/helpers/stub-harness.mjs`: pro Rolle eine Warteschlange von Antworten, zeichnet jeden Aufruf mit Flags und Prompt auf. Ersetzt `tests/fixtures/bin/pi`.
- Die 59 Szenarien werden als Tabelle portiert, jedes mit seiner INV-Id im Namen.
- Contract-Fixtures als Dateien unter `tests/fixtures/contracts/`.
- `guard.test.mjs` bleibt.
- shellcheck nur noch für den Zwei-Zeilen-Wrapper.
- CI-Matrix: Ubuntu, Windows, macOS; Node 18 und 22. Windows ohne Git Bash ist ein Akzeptanzkriterium.

---

## 4. Was bewusst nicht geändert wird

- Die drei Reviewer-Rollen und ihre Fokusse, das Severity-Schema, die Gate-Logik in `gate.mjs`.
- Die Semantik von Attempts und Baumbudget, das State-Dateiformat (v1-Dateien bleiben lesbar).
- Das Layout von `.pipeline/` und die Pflicht, es zu gitignoren.
- Das Startup-Gate: Bestätigung vor der Schleife, `--yes` für nicht-interaktives stdin.
- Das Muster "Controller schwach, Master Frontier", die Eskalation frisch vom Issue, das Löschen des Research-Caches bei `take_over`.
- Die `yaml pipeline-contract`-Fence in `AGENTS.md` und alle v1-Felder.
- Das Blocker-Format in `MEMORY.md` (`## Blocker — <id> (<datum>)`), damit bestehende Historie weiter gelesen wird.
- Die Namen `/govern`, `/automate`, `/pipeline-audit`, `/pipeline-status` und `auto-develop.sh`. Die Bedeutung von `/automate` ändert sich (konfigurieren statt generieren), der Name bleibt, weil README und PRD ihn kennen.
- Trusted Publishing, Tag-Gate, `release-notes.md`-Frischeprüfung.

---

## 5. Migration in Stufen

Jede Stufe ist einzeln releasbar und lässt die Suite grün. Reihenfolge ist Risiko-Reihenfolge: erst das, was Tests ermöglicht, dann das, was Tests braucht.

### Stufe 0: Einfrieren und nachzeichnen

- Tag 1.0.17 ist die Referenz.
- `references/invariants.md` mit Ids schreiben. Quelle: die 19 Template-Invarianten, die 29 Audit-Punkte, der Invarianten-Abschnitt in `SKILL.md`, deduplizieren.
- Jedes der 59 Szenarien in `smoke.sh` bekommt eine Id im Kommentar.
- Kein Code ändert sich.

**Abnahme:** Traceability-Tabelle vollständig; jede Id hat ein Szenario oder ist als "kein Test" markiert und begründet.

### Stufe 1: Herauslösen

- Jedes `node -e`-Programm wird ein Modul unter `lib/` mit Unit-Tests: `log/events`, `loop/blocker-history`, `review/findings-prose`, `diff/capture`, `issues/tasks-md`, `review/parse-master`, `log/prune`.
- `governance.mjs` wird in `contract/parse`, `contract/validate`, `state/store` aufgeteilt; die CLI-Fassade bleibt für das Bash-Skript erhalten.
- `lib/integrity/governance-paths.mjs` als einzige Liste; das Bash-Skript und der Guard lesen sie.
- `auto-develop.sh` ruft die Module auf, statt sie inline zu tragen. Verhalten unverändert.

**Abnahme:** `smoke.sh` grün; Zahl der `node -e` im Skript ist 0; Pfadliste existiert genau einmal; jedes neue Modul hat Tests.

**Risiko:** gering. Reine Extraktion, Verhalten pinnt die Suite.

### Stufe 2: Orchestrator in Node

- `bin/pipeline.mjs run` implementiert die Schleife mit den Modulen aus Stufe 1, dem pi-Adapter und der Issue-Schnittstelle (`tasks-md`, `command`).
- `--dry-run`-Ausgabe bleibt zeilenkompatibel, weil Tests und Operatoren sie lesen.
- `auto-develop.sh` wird zum Wrapper. Ein Release lang sind beide Wege lauffähig, mit `PIPELINE_ENGINE=bash|node`; danach wird die Bash-Schleife entfernt.
- Szenarien nach `node --test` portieren, gegen den Stub-Harness.

**Abnahme:** Alle portierten Szenarien grün gegen den Node-Runner; Windows-CI ohne Git Bash grün; `smoke.sh` läuft parallel bis zum Dual-Release.

**Risiko:** mittel. Verhaltensparität. Mitigation: Stufe 0 macht jede Abweichung benennbar, das Dual-Release macht sie umkehrbar.

### Stufe 3: Contract v2 und `init`

- `issues` und `gates` im Contract; Validator prüft v2-Pflichtfelder; v1 bleibt gültig.
- `pipeline init`: Wrapper mit Pin, `.gitignore`-Eintrag, HEAD-Prüfung, Contract-Validierung, Dry-Run.
- `pipeline doctor`: die projektbezogenen Prüfungen aus `pipeline-audit.md`, deterministisch.
- `prompts/automate.md` und `pipeline-audit.md` neu; `SKILL.md` auf die Form aus 3.9; `operations.md` aus `SKILL.md` und README zusammengezogen; `pipeline-template.md` entfällt.
- `govern` schreibt `issues` und `gates` und rendert nach `harness:`.

**Abnahme:** Ein v1-Projekt läuft unverändert; ein v2-Projekt ohne `gates` bricht bei `init` mit dem Feldnamen ab; `SKILL.md` unter 80 Zeilen; Doku-Greps aus der Suite entfernt und durch den Traceability-Test ersetzt.

**Risiko:** gering bis mittel. Migrationsfehler in Projekten; `doctor` sagt, was fehlt.

### Stufe 4: Integrität und Isolation

- Governance-Snapshot und Vergleich um `implement` und `implement_master`; Wiederherstellung; Ablehnungsgrund; Log-Ereignis.
- `-ne -ns -np` für Reviewer im pi-Adapter.
- Kanarienvogel-Test mit dem Stub; `doctor --live` optional.
- Guard-Regexe als Modul; `guard.test.mjs` bleibt.

**Abnahme:** Ein Stub-Implementierer, der `AGENTS.md` ändert, verliert den Versuch, die Datei ist danach identisch mit HEAD, das Ereignis steht im Log; Reviewer-Aufrufe tragen die vollständige Isolationsflagliste.

### Stufe 5: Split und Bericht

- `create` in `tasks-md`; Split-Zweig in der Schleife; Tiefe und Quelle als Bedingungen; Kontovariante.
- Usage-Erfassung aus `--mode json`; `pipeline report`; `/pipeline-status` mit Kosten.
- PRD: offene Entscheidung Budgetvererbung als entschieden markieren; Drift-Notiz "max_split_depth is a dead contract" streichen.

**Abnahme:** Ein Issue mit `split` bei Tiefe 0 und `max_split_depth: 1` erzeugt Kinder im selben Baum; dieselbe Antwort bei Tiefe 1 wird zur Ablehnung; ein Baum, dessen Kinder das Konto leeren, endet `blocked` mit Blocker; `report` zeigt Kosten pro Rolle.

### Stufe 6: Zweiter Harness

- `harness/claude-code.mjs`: Flags gegen `claude --help` der installierten Version; Reviewer-JSON über `--json-schema`; Schreibrechte für Implementierer hinter dem Startup-Gate.
- Renderer für `CLAUDE.md` im Modus `govern`.
- Suite mit Stub-`claude`; ein optionaler Live-Smoke.
- Drift-Notiz "PRD AK6 unmet" streichen.

**Abnahme:** Dieselbe `AGENTS.md` mit `harness: claude-code` läuft die Szenariotabelle grün; Reviewer-Isolation ist auch dort per Kanarienvogel geprüft.

---

## 6. Offene Entscheidungen

| Nr. | Frage | Empfehlung | Alternative |
|---|---|---|---|
| D1 | `issues` und `gates` in `AGENTS.md` oder eigene `pipeline.yaml`? | In `AGENTS.md`. Eine Datei, guard-geschützt, PRD sagt "Gates aus der Governance". | Eigene Datei trennt "wer die Agenten sind" von "wie die Schleife läuft"; kostet eine zweite Schutzliste. |
| D2 | Engine per `npx` mit Pin oder weiter kopierte Libs? | `npx` mit Pin plus `PIPELINE_BIN`-Override. | Kopie ist offline-fest, driftet aber und ist der Grund für den Re-sync-Modus. |
| D3 | Split implementieren oder Feld als `reserved` markieren? | Implementieren, Kontovariante. Das State-Modell ist dafür gebaut. | `reserved`: ehrlich, aber der Baumbudget-Entwurf bleibt dann Theorie. |
| D4 | Node-Minimum 18 belassen oder auf 22 heben? | 18 für die Laufzeit, 22 für die Suite (`--experimental-strip-types` braucht sie schon heute). | Einheitlich 22 vereinfacht CI, schließt aber Umgebungen aus, die 1.0.x heute nutzen. |
| D5 | Bash-Wrapper behalten? | Ja, zwei Zeilen. PRD und README nennen `auto-develop.sh`. | Nur `npx …`: eine Datei weniger, ein Einstiegspunkt weniger zum Finden. |
| D6 | Reviewer mit `-ne -ns -np`? | Ja. Reviewer sind read-only, und globale Extensions des Operators haben in einem unabhängigen Review nichts verloren. | Ohne: heutiger Stand, Isolation hängt an `--no-approve` plus Trust-Zustand. |
| D7 | Dry-Run-Ausgabe zeilenkompatibel halten? | Ja bis Stufe 3, danach freigeben. | Sofort neues Format spart Arbeit, bricht aber die Parität in Stufe 2. |

---

## 7. Risiken

| Risiko | Wirkung | Mitigation |
|---|---|---|
| Verhaltensabweichung beim Port | eine Invariante fällt still | Stufe 0 macht jede Regel benennbar; Dual-Release in Stufe 2; jede Szenario-Id muss auf beiden Engines grün sein |
| `npx` erreicht die Registry nicht | Pipeline startet nicht | Pin plus lokaler Cache; `PIPELINE_BIN`; `init --local` schreibt den pi-Installationspfad |
| v2-Migration in bestehenden Projekten | Lauf bricht ab | v1 bleibt gültig; `doctor` nennt das fehlende Feld; `init` ändert Governance nie selbst |
| Split erhöht Kosten | Baumbudget schneller leer | Budget an der Wurzel deckelt; Default-Tiefe 1; Quelle ohne `create` splittet nie |
| pi ändert das JSON-Ereignisformat | Usage fehlt | Usage ist optional; Bericht zeigt "n/a"; nie ein Abbruch |
| Integritätsprüfung stellt zu viel wieder her | legitime Änderung an einer Governance-Datei verloren | Die Pipeline darf Governance per Definition nicht ändern (`/govern` tut das); der Ablehnungsgrund nennt die Pfade, das Log das Ereignis |

---

## 8. Akzeptanzkriterien des Refactors

Die sechs Kriterien des PRD, plus das, was der Refactor neu verspricht.

| Nr. | Kriterium | Nachweis |
|---|---|---|
| AK1 | Änderung am `models:`-Block ändert das Routing ohne weitere Änderung | trivial: es gibt kein projektlokales Skript mehr; Test rendert Dry-Run vor und nach der Änderung |
| AK2 | Governance ohne `models:` läuft durch | Szenario "defaults", v1-Fixture |
| AK3 | Unlösbares Issue endet spätestens nach `max_runs_per_tree` als `blocked` mit Blocker | Szenario "unsolvable", Stub lehnt immer ab |
| AK4 | Reviewer-Prozesse enthalten keine gegenseitigen Urteile | Template-Eigenschaftstest plus Stub-Aufzeichnung der Reviewer-Prompts |
| AK5 | Ohne `--unattended` kein privilegierter Schritt | Startup-Gate-Test; Guard-Test; Kindprozesse tragen kein `--approve` |
| AK6 | Dieselbe Governance erzeugt Pipelines für zwei Harnesses | Szenariotabelle grün mit `harness: pi` und `harness: claude-code` gegen Stubs |
| N1 | `SKILL.md` unter 80 Zeilen; Invarianten an genau einer Stelle | Zeilenzähler in der Suite; Traceability-Test |
| N2 | Keine eingebetteten `node -e`; keine Bash-Schleife | grep in der Suite; `auto-develop.sh` höchstens 5 Zeilen |
| N3 | Suite läuft auf Windows ohne Git Bash | CI-Matrix |
| N4 | Governance-Änderung durch einen Implementierer wird erkannt, zurückgesetzt und protokolliert | Szenario "governance tamper" |
| N5 | Kosten pro Rolle sind im Bericht sichtbar | Szenario mit Stub-Usage; `report`-Ausgabe geprüft |
| N6 | Ein v2-Contract ohne `gates` kann nicht starten | Szenario "v2 without gates" |

---

## 9. Was der Skill danach noch tut

Kurz, damit der Unterschied greifbar ist.

**Heute:** Der Skill lehrt ein Modell, wie man eine Pipeline schreibt, die sieben Kernregeln einhält, und hofft per Audit-Checkliste, dass es geklappt hat.

**Danach:** Der Skill lehrt ein Modell, wie man aus einem PRD und einem Repo eine vollständige Governance schreibt, inklusive der Gates und der Issue-Quelle. Die Pipeline, die diese Governance ausführt, ist Code im Paket: einmal geschrieben, für jede Regel ein Test, auf drei Betriebssystemen grün, per Pin versioniert. Das Modell startet sie, liest ihre Diagnose und schlägt Governance-Korrekturen vor. Die sieben Kernregeln aus Abschnitt 1 gelten unverändert. Sie hängen nur nicht mehr davon ab, dass ein Modell sie beim Kopieren nicht verletzt.

---

## 10. Stand nach der Umsetzung (1.2.0)

Der Plan wurde am 2026-09-05 umgesetzt. Vorher wurde er reviewt; die Befunde des Reviews sind eingearbeitet, und die Umsetzung weicht an einigen Stellen bewusst vom Plan ab. Beides steht hier, damit der Plan oben als Entwurf lesbar bleibt und niemand die überholten Sätze für den Ist-Zustand hält.

### Korrekturen aus dem Review, so umgesetzt

| Befund | Umsetzung |
|---|---|
| `harness:` im Contract verletzt K7; Claude Code kann nur Anthropic-Modelle ausführen | Kein Contract-Feld. Der Harness wird pro Rolle aus dem Provider gewählt: `--harness anthropic=claude-code` (oder im Wrapper), pi ist Default für jeden Provider. `lib/harness/adapter.mjs`, INV-22 |
| Die v2-Syntax war mit dem Subset-Parser nicht darstellbar (Block-Sequenzen, Kommas in Anführungszeichen, Marker als Liste) | Parser neu geschrieben (`lib/contract/yaml.mjs`): Block-Sequenzen, quote-bewusstes Splitten, benannte Fehler für Block-Skalare, Anker, Tags. Marker werden auf jeder Ebene erkannt, auch als Liste, und lehnen den Lauf mit Feldnamen ab |
| Integritätsprüfung stellte aus HEAD wieder her; `research` hatte alle Tools | Wiederherstellung aus dem Snapshot, der vor der Rolle angelegt wird (`lib/integrity/snapshot.mjs`). `research` läuft mit `-t read,grep,find,ls` und wird ebenfalls geprüft. INV-20, INV-23 |
| "Die Pipeline verlässt sich nicht mehr auf den Guard" war zu viel | Formulierung in `operations.md`: Der Guard bleibt für destruktive Kommandos in unbeaufsichtigten Kindprozessen zuständig; die Integritätsprüfung ersetzt ihn nur für Governance-Schreibzugriffe |
| `--setting-sources` isoliert bei Claude Code nur Settings | Reviewer und Judges laufen mit `--safe-mode`, Judges zusätzlich `--tools ""`; `--max-budget-usd` als Kostendeckel. `lib/harness/claude-code.mjs` |
| Prompt-Override-Slot im Zielrepo war eine Injektionsfläche | Gestrichen. Templates sind harness-eigen (`lib/prompts/templates/`), Projektkontext kommt über SOUL.md |
| Kosten aus `--mode json` nur halb belegt | Umgesetzt, dann am selben Tag auf Entscheidung des Autors komplett entfernt: Der Skill misst nichts, weder Tokens noch Kosten; das legt der Coder selbst fest. 3.8 und N5 gelten damit nicht mehr |
| npx zieht Peer-Dependencies | `peerDependenciesMeta` optional für SDK und typebox; `bin` und `lib` in `files` |
| 3.5 und D3 widersprachen sich; `split` fehlte in der strictest-wins-Ordnung | Entschieden: Kontovariante (PRD §5 annotiert). `split` gilt nur als einzige, wohlgeformte Entscheidung; jede Mehrdeutigkeit ist ein reject mit Notiz. INV-06, INV-21 |
| Zahlen und Formulierungen (3 statt 4 `eval`, 8 statt 7 `state`-Aufrufe, 6 Flags, "vierte Fassung", Windows-Nuance, `contract_version`) | Für den Plan oben nicht mehr nachgezogen; der Ist-Zustand steht in `release-notes.md`, `README.md` und `operations.md`. Der Schlüssel heißt `contract_version` |

### Bewusste Abweichungen vom Plan

- **Kein Dual-Release.** Stufe 2 sah ein Release mit beiden Engines vor. Stattdessen wurde die komplette 1.0.17-Suite (`tests/smoke.sh`, 59 Szenarien) auf die Node-Engine umgestellt und grün gefahren, bevor die Bash-Schleife gelöscht wurde. Die Parität ist damit nachgewiesen, ohne zwei Install-Modelle in einem Release zu tragen.
- **Die Parity-Suite bleibt Bash.** Die 59 Szenarien wurden nicht nach `node --test` portiert; sie sind der Beweis, dass 1.2.0 sich wie 1.0.17 verhält, und das transkriptionsfrei. Neu in `tests/unit/` (`node --test`): Parser, Contract, Gate, Master-Entscheidung, Snapshot, Harness-Flags und -Ausgabe, Prompt-Eigenschaften, Issue-Quellen, Bericht, Traceability. N3 ("Suite ohne Git Bash") gilt für die Unit-Suite, nicht für die Parity-Suite.
- **Wrapper mit sieben Zeilen statt fünf**: Shebang, zwei Kommentarzeilen, `cd`, `PIPELINE_WRAPPER`, der `PIPELINE_BIN`-Zweig, der `npx`-Aufruf. Keine Logik.
- **`prompt-builders.md` bleibt** (aktualisiert), weil das Reviewer-Schema Vertragscharakter hat. `pipeline-template.md` ist gestrichen; Layout, State-Datei und Logging stehen in `operations.md`, die Invarianten in `invariants.md`.
- **`github`-Issue-Quelle nicht gebaut.** Die Schnittstelle (`list`, `markDone`, `markBlocked`, `create`) steht; `tasks-md` und `command` sind implementiert. Ein `gh`-Backend ist ein späteres Release.
- **Doku-Greps bleiben in der Suite**, in neuer Form: Sie prüfen jetzt, dass die Doku *nicht* mehr lehrt, was der Code tut (kein Launch-Snippet in SKILL.md, keine `assets/`, kein `pipeline-template.md`), plus die Traceability zwischen `invariants.md` und den Tests.

### Erfüllte Akzeptanzkriterien

AK1 bis AK5 durch die Parity-Suite und die Unit-Tests; AK6 mit einem Stub-`claude` (INV-22), ohne Live-Lauf; N1 (SKILL.md unter 80 Zeilen, Invarianten an einer Stelle) durch `traceability.test.mjs`; N2 (kein `node -e`, keine Bash-Schleife) ebenda; N3 für die Unit-Suite; N4 (Governance-Manipulation erkannt und zurückgesetzt) durch das Szenario "1.2.0 governance integrity"; N5 (Kosten pro Rolle) durch "1.2.0 usage from pi's JSON mode"; N6 (v2 ohne Gates startet nicht) durch "1.2.0 contract v2: gates from AGENTS.md".

### Offen nach 1.2.0

Live-Lauf gegen Claude Code und gegen pi im JSON-Modus; ein `gh`-Backend für die Issue-Quelle; eine Eval für `govern`; die Portierung der Parity-Suite nach `node --test`, wenn sie einmal nicht mehr als Paritätsbeweis gebraucht wird.
