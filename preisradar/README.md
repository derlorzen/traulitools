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
4. **Abgleich** verteilt über den Tag (Einstellungen → Abrufplan) oder zu festen Zeiten (`SCRAPE_HOURS=6,18`) und per Knopf. Preise werden aus JSON-LD, Meta-Tags oder einem eigenen CSS-Selektor gelesen. Der Preisverlauf wird bei Änderung gespeichert.

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
Ist die Suche eines Shops gesperrt (robots.txt) oder nur per JavaScript gerendert, trägst du beim Mitbewerber seine Sitemap-URL(s) ein (ohne Such-URL). Die App liest die Produkt-URLs ein (wöchentlich neu), wählt pro Artikel die ähnlichsten per Marke und Name, ruft die Produktseiten ab und bestätigt per EAN/Herstellernummer. Bei Bedarf wählt die KI aus den ähnlichsten URLs. Unterstützt werden auch `.xml.gz` und Index-Sitemaps (gibt es Teil-Sitemaps für Artikel/Produkte, werden nur diese gelesen). „Sitemaps automatisch finden" sucht über die robots.txt (`Sitemap:`-Zeilen) und übliche Pfade. Auch für den eigenen Shop kann eine Sitemap hinterlegt werden (Einstellungen): Die URLs werden deinen Artikeln zugeordnet. **Artikelbasis aus der eigenen Sitemap:** „Produkte importieren" (Einstellungen → Dein Shop) ruft die Produktseiten der eigenen Sitemap im Hintergrund ab und legt die Artikel an (Artikelnummer, Name, Marke, EAN, Herstellernummer, Preis). Bereits importierte Seiten werden übersprungen, der Lauf lässt sich begrenzen, stoppen und wiederholen. Pause pro Seite: `OWN_IMPORT_DELAY_MS` (Standard 400 ms). Die robots.txt wird dabei immer beachtet, auch bei Weiterleitungen.

## Mitbewerber per Produktlink einrichten
Im Tab Mitbewerber den Link zu einem Produkt des Mitbewerbers einfügen: Preisradar erkennt die Preisquelle (JSON-LD, Meta, Microdata, sonst KI), probiert gängige Such-URLs (nur wenn die robots.txt sie erlaubt und sie das Produkt wirklich findet) und sucht die Sitemaps. Funktioniert keine Suche, wird der Mitbewerber mit seinen Sitemaps angelegt.

## Beobachtete Artikel und Abrufplan
- **Beobachtet** sind die Artikel, die bei Mitbewerbern abgeglichen werden (Haken im Tab Preise, Sammelaktionen „Gefilterte beobachten“). Neu importierte Artikel aus der Sitemap sind zunächst nicht beobachtet, CSV- und Shopware-Import beobachten neue Artikel. „Alle Artikel“ zeigt immer die komplette Artikelbasis.
- **Verteilter Abruf (Standard):** alle `Abstand` bis `Abstand + Aufschlag` Sekunden (Standard 200 bis 300) ein Paket von bis zu 100 Artikeln je Mitbewerber, die am längsten nicht geprüften zuerst, jeder Artikel höchstens alle 12 Stunden. Pausen zwischen Seiten werden zusätzlich zufällig um bis zu 50 % gestreckt. Der Abruf nutzt stets die gleiche, offen erkennbare Kennung (`PreisradarBot`) und beachtet die robots.txt. IP-Rotation oder Verschleierung gibt es bewusst nicht.

## Wichtig
- Anmeldung per Session-Cookie, Passwörter mit scrypt gehasht, Login-Versuche begrenzt. Bei öffentlicher URL `SETUP_TOKEN` setzen und die Einrichtung sofort durchführen.
- Die **robots.txt** der Mitbewerber wird immer beachtet; gesperrte Seiten erscheinen als „gesperrt". Pausen zwischen Abrufen pro Shop einstellbar (Standard 3 s).
- Seiten, die den Preis nur per JavaScript nachladen, liefern ohne Preis-Selektor nichts. Dafür wäre ein Browser-Modus (Playwright) die Erweiterung.
- Nutzung im Rahmen der Nutzungsbedingungen der jeweiligen Shops; bei Beschränkungen besser Preisvergleichsportale/Feeds nutzen.

## Claude-Zugang (MCP)

Unter Einstellungen → „Claude-Zugang (MCP)" einen Token erzeugen (wird nur einmal angezeigt, gespeichert wird der Hash). Endpunkt: `POST /mcp` (Streamable HTTP, JSON-RPC), Token als `Authorization: Bearer …` oder `?token=…`.
Lesen: `overview`, `analysis_summary`, `recommendations`, `search_products`, `get_product`, `list_competitors`, `list_runs`. Ändern: Abrufe (`start_scrape`, `stop_scrape`), Beobachtung (`track_products`), Import (`import_from_sitemap`, `import_csv`, `import_shopware`, `import_competitor_urls`, `refresh_own_sitemap`), Einstellungen (`get_settings`, `update_settings`), Mitbewerber (`create_/update_/delete_competitor`, `autosetup_competitor`, `discover_sitemaps`), Treffer (`confirm_match`, `reject_match`, `set_match_url`). Preise im Shop werden nie geändert, Zugangsdaten (API-Keys, Passwörter) lassen sich über MCP nicht setzen.
Claude Code: `claude mcp add --transport http preisradar https://<host>/mcp --header "Authorization: Bearer <token>"`.

## Preisliste, Sofortprüfung, Kategorien, offline

- Die Preisliste lädt seitenweise vom Server (100 Zeilen, weitere beim Scrollen); Filter und Sortierung (Spaltenköpfe) laufen serverseitig (`GET /api/products`).
- „Prüfen" je Artikel fragt sofort alle Mitbewerber ab, unabhängig vom laufenden Abruf (`POST /api/products/:id/check`).
- Verteilter Abruf: jedes Paket wird auf die eingestellte Größe je Mitbewerber aufgefüllt (fällige zuerst, dann die am längsten nicht geprüften). Jeder Artikel wird automatisch höchstens zweimal täglich (Europe/Berlin) und mit mindestens 8 Stunden Abstand abgefragt; „Prüfen“ für einen einzelnen Artikel ist ausgenommen.
- Abruf-Vorlagen: findet die KI einen Preis, leitet Preisradar daraus CSS-Selektoren ab (bis zu fünf je Mitbewerber) und liest weitere Seiten ohne KI. Vorlagen mit vielen Fehlschlägen fallen weg.
- Nicht gefundene Artikel: Link „suchen" in die Shopsuche des Mitbewerbers (Feld „Suchlink für dich", automatisch aus der Startseite erkennbar). Gefundene Produktseite in der Detailansicht einfügen, sie wird sofort abgerufen.
- Sitemap-Kategorien je Mitbewerber auswählbar; gesucht wird dann nur in diesen URLs.
- Eigene Artikel, die nicht mehr in der eigenen Sitemap stehen (täglicher Abgleich) oder 404 liefern, bleiben erhalten und werden als „bei dir offline" markiert; sie zählen nicht in der Analyse und werden nicht mehr abgefragt.

## Google Search Console

Einstellungen → „Google Search Console“: Property (`sc-domain:belkai.de` oder `https://www.belkai.de/`) und JSON-Schlüssel eines Dienstkontos (Search Console API aktiviert, Dienstkonto-E-Mail in der Search Console als Nutzer „Eingeschränkt“ eingetragen). Abgleich täglich (Seiten, Suchanfragen je Seite, 90 Tage Tagesverlauf; letzte 28 Tage, Daten 2–3 Tage verzögert). Bereich „Sichtbarkeit“: Kennzahlen, Verlauf, Chancen aus Preis und Suche, Produktseiten, Suchanfragen. Preisliste sortierbar nach Impressionen/Klicks, Empfehlungen nach „Nachfrage × Abstand“. Testumgebung: `GSC_API_BASE`, `GSC_TOKEN_URL`.

## Shopware-Abgleich, Mindestmarge

Täglich (oder „Jetzt abgleichen“): Preis, Einkaufspreis (`purchasePrices`), Steuersatz, Bestand und verkaufte Stück/Umsatz 30/90 Tage (Bestellpositionen ohne stornierte Bestellungen) der bekannten Artikel, nur lesend. Einkaufspreise alternativ per CSV (`Artikelnummer;Einkaufspreis`, z. B. aus JTL-Wawi). Mindestmarge (Einstellungen, Standard 10 % auf den Nettoverkaufspreis) begrenzt Senkungsvorschläge.

## Tägliche E-Mail

SMTP unter Einstellungen; Versand einmal täglich zur eingestellten Stunde (Europe/Berlin). Vorschau: `GET /api/digest/preview`.

## Google Merchant Center

Merchant API (Berichte) mit dem Dienstkonto der Search Console (Scope `content`): Vergleichspreise (`price_competitiveness_product_view`), Preisvorschläge (`price_insights_product_view`), Wettbewerber je Kategorie (`competitive_visibility_competitor_view`). Zuordnung über Angebots-ID = Artikelnummer. Mitbewerber aus Domain anlegen: `POST /api/competitors/from-domain`. Testumgebung: `MERCHANT_API_BASE`.

## Prüf-Stufen für große Sortimente

Bei vielen tausend Artikeln wird nicht alles täglich abgefragt. **Täglich** (Stufe A, Standard 1000 Artikel, einstellbar unter Einstellungen → Abrufplan) werden die wichtigsten Artikel geprüft, in dieser Reihenfolge: von Hand gesetzt, in den letzten 90 Tagen verkauft (Shopware, nach Umsatz), Preisänderung eines Mitbewerbers in den letzten 7 Tagen, Google-Impressionen (Search Console), über dem Google-Vergleichspreis (Merchant Center). Alle **übrigen** (Stufe B) alle 4 Tage (einstellbar). Nicht gefundene Artikel werden wöchentlich, nach 4 erfolglosen Versuchen monatlich erneut gesucht. Neue Zuordnungen werden zuerst einmal gesucht, Stufe A vorneweg. Der Preisverlauf speichert nur Änderungen plus einen Punkt pro Woche.

In der Preisliste setzt „täglich“ (Zeile und Detailansicht) einen Artikel von Hand auf tägliche Prüfung; unter „Weitere Filter“ gibt es den Filter „täglich geprüft“ und die Sammelaktion für gefilterte Artikel. Das Lagebild zeigt unter „Betrieb“ Verteilung, Fortschritt der Erstzuordnung und Aktualität je Stufe. API: `POST /api/products/pin {ids|query, pin}`.
