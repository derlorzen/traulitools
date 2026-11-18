import { first, digits, normOffer } from './util.js';

/**
 * Marktquelle idealo: zu jeder EAN alle Händlerangebote auf idealo mit Preis, Versand und Gesamtpreis.
 * Der eigene Shop kann dort gelistet sein (canList), verglichen wird dann der eigene idealo-Gesamtpreis.
 */
export default {
  key: 'idealo', name: 'idealo', kind: 'offers', canList: true,
  about: 'Alle Händlerangebote zu einer EAN auf idealo, mit Preis, Versand und Gesamtpreis.',
  countries: [['de', 'idealo.de'], ['at', 'idealo.at']],
  defaults: { perDay: 100, days: 14, daysA: 3, budget: 10 },
  defaultActor: 's-r~idealo-scraper',
  actors: {
    's-r~idealo-scraper': {
      label: 'Idealo Price Scraper (s-r)', note: 'erprobt, etwa 4,40 $ je 1.000 Artikel', per1000: 4.4, batch: 5,
      input: (eans, country) => ({ eans, country, concurrency: 3 }),
      cost: (runs, found) => runs * 0.002 + found * 0.004,
    },
    'firsthand~idealo-api': {
      label: 'Idealo API (firsthand)', note: 'günstig, etwa 1 $ je 1.000 Artikel, aber noch kaum genutzt', per1000: 1, batch: 25,
      input: (eans, country) => ({ eans, markets: [country], includeOffers: true, maxItems: 0 }),
      cost: (_runs, found) => found * 0.001,
    },
  },
  // Eigener Actor: Eingabe mit den gängigen Feldnamen, Kosten vorsichtig wie beim teuersten bekannten Tarif
  custom: { label: 'Eigener Actor', note: 'Kosten geschätzt wie s-r', per1000: 4.4, batch: 5, input: (eans, country) => ({ eans, country, markets: [country], includeOffers: true }), cost: (runs, found) => runs * 0.002 + found * 0.004 },

  /** Ein Ergebnis des Actors in { ean, ext_id, url, title, offers, count } übersetzen; null = überspringen. */
  normProduct(item) {
    if (item?.found === false || item?.error) return null;
    const offers = (Array.isArray(item.offers) ? item.offers : []).map(normOffer).filter(Boolean).sort((a, b) => a.total - b.total);
    const id = first(item.idealo_sku, item.product_id, item.id, item.productId);
    return {
      ean: digits(first(item.ean, item.gtin, item.matched_gtin, item.searchQuery)),
      ext_id: id != null ? String(id) : null,
      url: first(item.url, item.productUrl) ?? null, title: first(item.title, item.name) ?? null,
      offers, count: Number(first(item.offer_count, item.offersCount, item.offers_count, offers.length)) || offers.length,
    };
  },
};
