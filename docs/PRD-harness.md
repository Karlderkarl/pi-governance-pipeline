# PRD — Multi-Modell Auto-Develop-Harness

**Status:** Entwurf
**Datum:** 2026-08-21
**Zielgruppe:** `prd-to-governance` (Generierung von SOUL.md, AGENTS.md, CLAUDE.md, MEMORY.md) sowie menschliche Reviewer

---

## 1. Problem

Bestehende Agent-Harnesses führen einen Coding-Task mit *einem* Modell in *einem* Kontext aus. Daraus folgen drei Schwächen:

1. **Korrelierte Fehler.** Implementierung und Review durch dasselbe Modell teilen dieselben blinden Flecken. Ein Review, das den eigenen Code bewertet, fällt nachweislich milder aus.
2. **Keine Kostendifferenzierung.** Recherche, Implementierung und Endabnahme haben sehr unterschiedliche Anforderungen, laufen aber auf demselben (meist teuersten) Modell.
3. **Unbegrenzte Retry-Schleifen.** Ohne harte Ressourcengrenze kann ein einzelnes schwieriges Ticket im unbeaufsichtigten Betrieb beliebig viel Budget verbrauchen.

## 2. Ziel

Eine issue-getriebene Pipeline, die pro Arbeitsschritt ein **bewusst gewähltes Modell** einsetzt, Qualität über **unabhängige Mehrfach-Reviews** absichert und Kosten über **explizite Budgets** deckelt. Die Pipeline wird aus Governance-Dateien generiert, nicht handgeschrieben.

**Nicht-Ziele:** Kein eigenes Agent-Harness von Grund auf. Kein Ersatz für menschliches Code-Review bei sicherheitskritischen Änderungen. Keine Autonomie über den Merge hinaus (Deployment bleibt außerhalb).

## 3. Architektur

Zwei Ebenen, klar getrennt:

**Governance-Ebene** — vier Dateien, erzeugt und auditiert von `prd-to-governance`:

| Datei | Inhalt |
|---|---|
| `SOUL.md` | Projektidentität: Stack, Architektur, Coding-Standards, Security, Compliance |
| `AGENTS.md` | Agentenverhalten: Rollen, **Modell-Mapping**, Workflow, Review-Regeln, verbotene Aktionen, Phasenplan |
| `CLAUDE.md` | Harness-Konfiguration: Tool-Präferenzen, Dev-Commands, Working Rules, Env-Vars |
| `MEMORY.md` | Lebender Status: erledigte Arbeit, Entscheidungen, Blocker, nächste Schritte |

**Pipeline-Ebene** — `auto-develop.sh`, generiert von `governance-to-automation` aus allen vier Dateien.

### Ablauf pro Issue

```
Issue-/Pipeline-Erstellung
  → Recherche (einmalig pro Issue)
  → Implementierung / TDD
  → Linter + Clean-Code-Gate (deterministisch, kein LLM)
  → 3 parallele Reviews: Security | Quality | Correctness
  → Controller (schwaches Modell, aggregiert Review-JSON, schlägt vor)
  → Master Review (Frontier-Modell, entscheidet — läuft immer)
      ├─ freigegeben  → Governance-Update → nächstes Issue
      ├─ Fix nötig     → zurück zur Implementierung (eigenes Coding-Modell)
      └─ 3× gescheitert → Abbruch: blocked + Blocker in MEMORY.md + Mensch
```

## 4. Anforderungen

### 4.1 Modell-Routing

Jeder Pipeline-Schritt ist ein eigener Prozessaufruf; das Skript wählt das Modell, nicht der Agent. Das Mapping steht in `AGENTS.md` und ist ohne Änderung am Skript austauschbar:

```yaml
models:
  research:          { provider: X, model: mid }
  implement:         { provider: X, model: strong }
  implement_master:  { provider: Y, model: frontier }
  review:
    security:        { provider: Y, model: mid }
    quality:         { provider: Z, model: mid }
    correctness:     { provider: X, model: mid }
  controller:        { provider: X, model: small }
  master_review:     { provider: Y, model: frontier }
  constraints:
    no_self_review: true
```

**R1** — Fehlt der `models:`-Block, läuft die Pipeline mit einem Default-Modell für alle Rollen. Rückwärtskompatibilität ist zwingend.
**R2** — Reviewer-Modelle sollen von mindestens zwei Anbietern stammen. Diversität schlägt Einzelstärke, weil unabhängige blinde Flecken der eigentliche Zweck der Mehrfach-Reviews sind.
**R3** — `no_self_review`: Ein Modell, das implementiert hat, darf denselben Diff nicht reviewen. Kollidiert es mit einer Reviewer-Rolle, entfällt dieser Reviewer für den Lauf und die Schwelle wird auf die verbleibenden angepasst.

### 4.2 Reviews

**R4** — Die drei Reviewer laufen in getrennten Prozessen mit getrennten Kontexten und sehen die Urteile der anderen nicht.
**R5** — Jeder Reviewer liefert JSON nach festem Schema: Liste von Findings mit `severity` (critical/high/medium/low), `file`, `line`, `rationale`, plus ein Gesamtvotum.
**R6** — Freigabekriterium ist **severity-basiert**, nicht prozentual: kein `critical` oder `high` blockiert; `medium` und `low` werden zu Folge-Tickets. *(Ersetzt die ursprüngliche 80-%-Regel, die bei drei Reviewern faktisch Einstimmigkeit verlangte.)*

### 4.3 Controller und Master

**R7** — Der Controller **entscheidet nicht, er schlägt vor.** Sein Output ist ein Vorschlag plus konsolidierte Findings.
**R8** — Der Master Review läuft über **jeden** Lauf und erteilt die Freigabe. Er sieht die Reviewer-JSONs im Original, nicht nur die Zusammenfassung des Controllers, damit er dessen Aggregationsfehler abfangen kann.
**R9** — Bei eigenem Fix startet der Master frisch vom Issue und erhält die bisherigen Findings als Ausschlussliste — **nicht** den gescheiterten Diff als Ausgangspunkt. Sonst erbt das neue Modell die gescheiterte Denkrichtung.

### 4.4 Zähler und Budget

Zwei getrennte Größen, die nicht vermischt werden dürfen:

- **Versuchszähler** = Qualitätssignal („dieser Ansatz führt nicht zum Ziel"). Pro Issue, beim Sub-Issue-Split zurückgesetzt.
- **Budget** = Ressourcengrenze („dieser Ticket-Baum hat genug gekostet"). An der Wurzel geführt, über den ganzen Baum verbraucht, nie zurückgesetzt.

**R10** — Beide Größen leben im Harness (`.pipeline/state/<root_id>.json`), nicht im Modellkontext. Das Modell erfährt höchstens „du hast noch N Versuche".
**R11** — Parameter mit Defaults: `max_attempts_controller: 3`, `max_attempts_master: 3`, `max_runs_per_tree: 25`, `max_split_depth: 1`.

**Begründung für R11:** Bei Split-Grad 4 und Tiefe 1 ergibt sich `3 + 4 × 6 = 27` Implementierungsläufe, jeder mit rund sechs Modellaufrufen — etwa 160 Aufrufe für ein Ursprungsticket. Bei Tiefe 2 sind es rund 123 Läufe und über 700 Aufrufe. Niemand hat je „mehr als drei Versuche" erlaubt, und trotzdem läuft das System 123-mal. Die Tiefenbegrenzung kappt das exponentielle Wachstum, das Baumbudget deckelt den Rest.

### 4.5 Sicherheit

**R12** — Privilegierte Ausführung und Auto-Merge sind **standardmäßig aus**, erreichbar nur über explizite `--unattended` / `--auto-merge` Flags hinter einer Laufzeit-Bestätigung.
**R13** — Harnesses ohne eingebaute Permission-Gates (z. B. Pi) erfordern eine Container-Grenze oder eine Gate-Extension, damit R12 erhalten bleibt. Der Default darf beim Harness-Wechsel nicht stillschweigend kippen.
**R14** — Ein Abbruch ist nie stumm: Issue als `blocked` markieren, Blocker in `MEMORY.md` schreiben, Mensch benachrichtigen. `MEMORY.md` fließt in die Issue-Erstellung zurück, damit der nächste Durchlauf die Vorgeschichte kennt.

### 4.6 Harness-Neutralität

**R15** — SOUL, AGENTS und MEMORY sind harness-agnostisch. Nur die Harness-Konfiguration ist vendor-spezifisch und wird über eine Adapter-Ebene gerendert: `CLAUDE.md` für Claude Code, `SYSTEM.md` + Konfiguration für Pi. Die Extraktionslogik existiert einmal.
**R16** — Der Vertrag zwischen `prd-to-governance` und `governance-to-automation` ist versioniert und explizit dokumentiert: welche Felder gelesen werden, welche optional sind, was bei Abwesenheit passiert.

## 5. Offene Entscheidungen

- `[USER DECISION REQUIRED]` Konkrete Modelle und Anbieter je Rolle
- `[USER DECISION REQUIRED]` Budgetvererbung an Sub-Issues (Kontovariante vs. anteilige Aufteilung des Restbudgets)
- `[USER DECISION REQUIRED]` Zielwert für `max_runs_per_tree` — 25 ist ein Vorschlag, keine gemessene Größe
- `[NEEDS CLARIFICATION]` Wird Pi das primäre Harness oder laufen Claude Code und Pi parallel als austauschbare Backends?

## 6. Akzeptanzkriterien

1. Eine Änderung am `models:`-Block in `AGENTS.md` ändert das Routing ohne Anfassen von `auto-develop.sh`.
2. Governance ohne `models:`-Block läuft unverändert durch (Rückwärtskompatibilität).
3. Ein künstlich unlösbares Issue endet nach spätestens `max_runs_per_tree` Läufen als `blocked` mit Eintrag in `MEMORY.md` — nicht in einer Endlosschleife.
4. Die drei Reviewer-Prozesse enthalten nachweislich keine gegenseitigen Urteile im Kontext.
5. Ohne `--unattended` fordert jeder privilegierte Schritt eine Bestätigung an.
6. Dieselbe Governance erzeugt lauffähige Pipelines für mindestens zwei Harnesses.
