# Preisradar

Web-App für den Preisvergleich von belkai.de (Shopware 6) mit frei wählbaren Mitbewerbern.
Node 22, SQLite (eingebaut), keine externen Dienste, keine Tracker oder Fremd-Fonts.

## Ablauf
1. **Eigene Produkte** kommen über die Shopware-Admin-API (oder CSV): Artikelnummer, EAN, Herstellernummer, Bruttopreis.
2. **Mitbewerber** legst du in der Oberfläche (Reiter „Mitbewerber") oder in `data/competitors.json` an (siehe `competitors.example.json`; wird beim Start übernommen).
3. **Zuordnung** pro Produkt und Mitbewerber:
   - Suche beim Mitbewerber per EAN, dann Herstellernummer, dann Artikelnummer.
   - Treffer wird geprüft: EAN/Nummer in den Seitendaten → **bestätigt**. Nur Namensähnlichkeit → **„prüfen"** (Preis blass angezeigt, zählt nicht für „günstigster", Button „Passt / Passt nicht").
   - Manuelle Produkt-URLs (Detailansicht oder URL-CSV) haben Vorrang und werden nie überschrieben.
4. **Abgleich** zweimal täglich (`SCRAPE_HOURS=6,18`) und per Knopf. Preise werden aus JSON-LD, Meta-Tags oder einem eigenen CSS-Selektor gelesen. Der Preisverlauf wird bei Änderung gespeichert.

## Erster Start und Shopware
Beim ersten Aufruf legst du im Browser Benutzername und Passwort an (nur einmal möglich; mit `SETUP_TOKEN` zusätzlich per Einrichtungscode geschützt).
Danach unter **Einstellungen** den Shopware-Zugang eintragen: Shopware-Admin → Einstellungen → System → Integrationen → Integration anlegen (Lesezugriff reicht), Client-ID und Secret kopieren. „Verbindung testen" prüft den Zugang. Das Secret wird verschlüsselt in der Datenbank gespeichert (Schlüssel: `SECRET_KEY` oder automatisch `/data/secret.key`).
Importiert werden aktive, kaufbare Produkte (Varianten erben Preis/EAN vom Hauptprodukt). Preise aus Preislisten/Regeln werden nicht berücksichtigt, nur der Standard-Bruttopreis.

## Starten
```
npm install
cp .env.example .env   # ausfüllen, dann Variablen setzen
npm start              # http://localhost:3000
npm test
```
## Deployment aus Git (ohne Docker)
Voraussetzung: Node >= 22.13 (`.node-version` liegt bei). Start: `npm ci --omit=dev && npm start`.
- **Coolify (Nixpacks, ohne Dockerfile):** Repo als Anwendung hinzufügen, Build-Pack „Nixpacks", Port 3000, Umgebungsvariablen wie in `.env.example`. Wichtig: `DB_PATH=/data/preisradar.db` setzen und unter „Persistent Storage" ein Verzeichnis nach `/data` mounten, sonst geht die Datenbank bei jedem Deploy verloren. Dort kann auch `competitors.json` liegen (`COMPETITORS_FILE=/data/competitors.json`).
- **Eigener Server (systemd/pm2):** `git pull && npm ci --omit=dev`, dann Neustart. Beispiel pm2: `pm2 start "npm start" --name preisradar`.
- Zeitzone für den Zeitplan: `TZ=Europe/Berlin`.
- Health-Check: `/healthz`.

## KI-Scraping (OpenAI) und Analyse
Unter **Einstellungen → KI** trägst du den OpenAI-API-Schlüssel und das Modell ein (verschlüsselt gespeichert; Abrechnung nach Verbrauch bei OpenAI, nicht über ein ChatGPT-Abo).
- **Die KI scrapt, die Analyse läuft per Regelwerk.** Beim Abruf der Mitbewerber liest die KI Seiten aus (Prinzip wie bei AI-Scrapern): Sie wählt in den Suchergebnissen den passenden Treffer und liest Preis, Titel und Verfügbarkeit ohne CSS-Selektoren. Ein von der KI genannter Preis zählt nur, wenn er wörtlich auf der Seite steht.
- **Pro Mitbewerber einstellbar:** *Bei Bedarf* (Regeln zuerst, KI nur wenn nichts gefunden wird, sparsam), *Immer prüfen* (KI beurteilt auch unsichere Treffer) oder *Aus*. Begrenzung: ca. 400 KI-Anfragen pro Lauf (`AI_MAX_CALLS_PER_RUN`).
- **Einrichtungshilfe:** Beim Mitbewerber unter „Einrichtung testen" zeigt „Mit KI auslesen", was die KI auf einer Produktseite erkennt.
- Übermittelt werden Produktname, Marke, Nummern und der bereinigte Text der Mitbewerber-Seite, keine Kundendaten.
- Grenze: Die App lädt Seiten ohne Browser. Shops, die Preise erst per JavaScript nachladen, sind für Regeln und KI unsichtbar (Browser-Automatisierung wie browser-use bräuchte Python und Chromium auf dem Server).
- **Analyse:** feste Regeln (`src/analysis.js`): bis 2 % über dem Günstigsten konkurrenzfähig, ab 5 % darunter Erhöhung möglich, über 40 % Abweichung als mögliche Fehlzuordnung markiert. Keine KI beteiligt.

## Mitbewerber über Sitemap
Ist die Suche eines Shops gesperrt (robots.txt) oder nur per JavaScript gerendert, trägst du beim Mitbewerber seine Sitemap-URL(s) ein (ohne Such-URL). Die App liest die Produkt-URLs ein (wöchentlich neu), wählt pro Artikel die ähnlichsten per Marke und Name, ruft die Produktseiten ab und bestätigt per EAN/Herstellernummer. Bei Bedarf wählt die KI aus den ähnlichsten URLs. Unterstützt werden auch `.xml.gz` und Index-Sitemaps (gibt es Teil-Sitemaps für Artikel/Produkte, werden nur diese gelesen). „Sitemaps automatisch finden" sucht über die robots.txt (`Sitemap:`-Zeilen) und übliche Pfade. Auch für den eigenen Shop kann eine Sitemap hinterlegt werden (Einstellungen): Die URLs werden deinen Artikeln zugeordnet. Die robots.txt wird dabei immer beachtet, auch bei Weiterleitungen.

## Wichtig
- Anmeldung per Session-Cookie, Passwörter mit scrypt gehasht, Login-Versuche begrenzt. Bei öffentlicher URL `SETUP_TOKEN` setzen und die Einrichtung sofort durchführen.
- Die **robots.txt** der Mitbewerber wird immer beachtet; gesperrte Seiten erscheinen als „gesperrt". Pausen zwischen Abrufen pro Shop einstellbar (Standard 3 s).
- Seiten, die den Preis nur per JavaScript nachladen, liefern ohne Preis-Selektor nichts. Dafür wäre ein Browser-Modus (Playwright) die Erweiterung.
- Nutzung im Rahmen der Nutzungsbedingungen der jeweiligen Shops; bei Beschränkungen besser Preisvergleichsportale/Feeds nutzen.
