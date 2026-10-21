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

## KI-Analyse (OpenAI)
Unter **Einstellungen → KI** trägst du den OpenAI-API-Schlüssel und das Modell ein (verschlüsselt gespeichert; Abrechnung nach Verbrauch bei OpenAI, nicht über ein ChatGPT-Abo).
- **Analyse starten:** wertet bis zu 120 Produkte mit bestätigten Mitbewerberpreisen aus und liefert Zusammenfassung, Preisempfehlungen (senken/halten/erhöhen/prüfen) und Auffälligkeiten. Einkaufspreise sind der KI unbekannt, Vorschläge immer gegen die Marge prüfen.
- **Unsichere Zuordnungen prüfen lassen:** beurteilt „zu prüfen"-Treffer; ab 85 % Sicherheit wird bestätigt bzw. verworfen, der Rest bleibt mit KI-Notiz zur manuellen Entscheidung.
- Übermittelt werden nur Artikelnummer, Name, Marke und Preise. Kosten pro Analyse sind gering (ein Aufruf).

## Wichtig
- Anmeldung per Session-Cookie, Passwörter mit scrypt gehasht, Login-Versuche begrenzt. Bei öffentlicher URL `SETUP_TOKEN` setzen und die Einrichtung sofort durchführen.
- Die **robots.txt** der Mitbewerber wird immer beachtet; gesperrte Seiten erscheinen als „gesperrt". Pausen zwischen Abrufen pro Shop einstellbar (Standard 3 s).
- Seiten, die den Preis nur per JavaScript nachladen, liefern ohne Preis-Selektor nichts. Dafür wäre ein Browser-Modus (Playwright) die Erweiterung.
- Nutzung im Rahmen der Nutzungsbedingungen der jeweiligen Shops; bei Beschränkungen besser Preisvergleichsportale/Feeds nutzen.
