# Mühle

Nine Men's Morris (Mühle), spielbar im Browser. Ein Flask-Backend liefert die Seite und eine kleine JSON-API; das Spielbrett ist eine 3D-Szene (Three.js/WebGL), gesteuert von reinem JavaScript. Kein Build-Schritt – Three.js wird direkt über ein Import-Map von einem CDN geladen.

![Mühle-Spielbrett](docs/screenshot.jpg)

## Features

- **2 Spieler** — lokal auf demselben Gerät, ein Browser steuert beide Farben.
- **Gegen Computer** — ein Minimax-Gegner (Alpha-Beta-Suche); Weiss oder Schwarz wählbar.
- **Online** — einen Mitspieler per Link einladen (`/g/<game_id>?t=<token>`), per E-Mail versendet oder manuell kopiert. Züge werden automatisch zwischen den Browsern synchronisiert.
- Vollständiges Regelwerk: Setzphase, Zugphase, Fliegen (bei nur noch 3 Steinen), Mühlenbildung und -schlagen (inklusive Schutzregel), Erkennung von Patt/Sieg.
- Synthetische Soundeffekte (Web Audio API, keine Audiodateien) sowie ein umschaltbarer Hintergrundmusik-Loop; Mühlen-Blitzanimationen und leuchtende Auren für geschlagene sowie zuletzt gezogene Steine.
- Frei drehbares, bildschirmfüllendes 3D-Brett (Kamera per Orbit/Zoom) mit fotorealistischen Materialien vor einem sternenklaren Nachthimmel; Einstellungen, Status und Spielerpanels schweben als Teil der Szene mit.
- Regelwerk zum Nachschlagen: ein Button (📜) öffnet eine pergamentartige Übersicht aller Spielregeln.
- Zwei kleine Easter Eggs: ein vorbeifliegendes Raumschiff und, wer das Brett von der Rückseite betrachtet, eine weitere Überraschung.
- Open-Graph-/Twitter-Vorschaubilder für geteilte Links.

## Starten

Benötigt [`uv`](https://docs.astral.sh/uv/).

```bash
uv run python app.py
```

Danach `http://localhost:5003/` öffnen. Der Server gibt beim Start zusätzlich eine LAN-URL aus, um im selben Netzwerk mit jemand anderem zu spielen.

### Docker

```bash
docker compose up --build
```

baut ein zweistufiges Alpine-Image (Builder-Stage löst Abhängigkeiten mit `uv` auf, Runtime-Stage ist ein schlankes `python:3.12-alpine` ohne Compiler-Toolchain) und startet den Server darin als nicht-root User `app` via `gunicorn` (ein einzelner Worker mit 4 Threads — Online-Spielstände und das Session-Secret liegen im Prozessspeicher, mehrere Worker würden diesen Zustand fragmentieren). `docker-compose.yml` mappt Container-Port `5003` auf Host-Port `5052` (`http://localhost:5052/`) und hängt den Container zusätzlich an ein externes Docker-Netzwerk namens `reverse-proxy`, über das ein vorgeschalteter Reverse Proxy (TLS-Terminierung, `X-Forwarded-Proto`/`-Host`, von Flask via `ProxyFix` ausgewertet) den Container unter seinem Servicenamen erreichen kann. Das Netzwerk muss vorher existieren:

```bash
docker network create reverse-proxy   # einmalig, falls noch nicht vorhanden
```

Wer ohne eigenen Reverse Proxy startet, kann diese Zeilen in `docker-compose.yml` entfernen oder das Netzwerk einfach leer anlegen — der Host-Port `5052` ist so oder so direkt erreichbar.

## Hinweise

- Das Brett benötigt beim ersten Laden eine Internetverbindung — Three.js wird von einem CDN (unpkg) geladen statt gebündelt.
- Der Zustand von Online-Spielen liegt nur im Arbeitsspeicher und geht bei einem Server-Neustart verloren.
- Damit jemand ausserhalb deines Netzwerks einem Online-Spiel beitreten kann, braucht es Port-Weiterleitung, einen Tunnel oder eben den Reverse-Proxy-Aufbau oben — der Server selbst bindet nur an `0.0.0.0:5003` innerhalb seines Netzwerks.
- Der Dev-Server läuft absichtlich mit `debug=False`: Der interaktive Werkzeug-Debugger wäre ein Risiko für Remote Code Execution, sobald der Server von anderen Geräten erreichbar ist — was für Netzwerkspiele nötig ist.
- `style.css`/`game.js` werden mit einem `?v=<md5>`-Query-Parameter ausgeliefert, der sich bei jeder inhaltlichen Änderung ändert — so liefert ein Reverse Proxy mit langem `Cache-Control` nach einem Deploy nie eine veraltete Version aus.
