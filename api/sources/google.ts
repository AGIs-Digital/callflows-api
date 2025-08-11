import axios from 'axios';
import { SearchResult, SourceResult } from '../types/lead-scraping';
import { getCachedSearch, setCachedSearch } from '../cache/search-cache';

// Funktion zur Normalisierung und Validierung von Telefonnummern
function normalizePhoneNumber(phone: string): string | undefined {
  // Entferne alle nicht-numerischen Zeichen außer + am Anfang
  let cleaned = phone.replace(/[^\d+]/g, '');
  
  // Entferne führende Nullen, aber behalte internationale Vorwahl
  if (cleaned.startsWith('0049')) {
    cleaned = '+49' + cleaned.substring(4);
  } else if (cleaned.startsWith('0') && !cleaned.startsWith('+')) {
    cleaned = '+49' + cleaned.substring(1);
  } else if (!cleaned.startsWith('+') && cleaned.length >= 10) {
    cleaned = '+49' + cleaned;
  }
  
  // Validiere deutsche Telefonnummer
  const germanPhoneRegex = /^\+49\d{10,11}$/;
  if (germanPhoneRegex.test(cleaned)) {
    // Formatiere schön: +49 XXX XXXXXXX
    const formatted = cleaned.replace(/^(\+49)(\d{2,4})(\d+)$/, '$1 $2 $3');
    return formatted;
  }
  
  return undefined;
}

// HTTP-basierte Telefonnummer-Extraktion (KEINE Browser mehr!)
async function scrapePhoneFromWebsite(url: string): Promise<string | undefined> {
  try {
    console.log(`📞 HTTP phone scraping from: ${url}`);
    
    // HTTP Request mit User-Agent (wie bei 11880)
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      },
      timeout: 8000, // Kürzer als 11880 für schnellere Google-Suche
      maxRedirects: 3,
    });
    
    console.log(`✅ Page loaded: ${response.status} - ${url}`);
    
    // 1. Suche nach tel:-Links im HTML
    const telLinkRegex = /href=['"]tel:([^'"]+)['"]/gi;
    let match;
    const telLinks: string[] = [];
    
    while ((match = telLinkRegex.exec(response.data)) !== null) {
      const phone = match[1].replace(/[^\d\+\-\s\(\)]/g, '').trim();
      if (phone) {
        const normalized = normalizePhoneNumber(phone);
        if (normalized && !telLinks.includes(normalized)) {
          telLinks.push(normalized);
        }
      }
    }
    
    if (telLinks.length > 0) {
      console.log(`📞 Found tel: link: ${telLinks[0]}`);
      return telLinks[0];
    }
    
    // 2. Text-basierte Regex-Suche (wie Browser-Version aber auf HTML)
    const textContent = response.data
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove scripts
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')   // Remove styles
      .replace(/<[^>]+>/g, ' ')                          // Remove HTML tags
      .replace(/&[^;]+;/g, ' ');                         // Remove HTML entities
    
    // Deutsche Telefonnummer-Pattern (optimiert für HTTP)
    const phonePatterns = [
      // tel: Links (zusätzliche Sicherheit)
      /tel:[\+\d\s\-\(\)]{8,}/gi,
      // Kontakt-Bereiche
      /(Kontakt|Contact|Telefon|Phone|Fon|Tel\.?)[\s:]*[\+\d\s\-\/\(\)]{10,}/gi,
      // Internationale Formate
      /(\+49[\s\-]?(?:\(0\))?[\s\-]?\d{2,5}[\s\-\/]?\d{3,4}[\s\-\/]?\d{3,4})/g,
      // Deutsche Vorwahl mit 0
      /(^|[^\d])0\d{2,5}[\s\-\/]?\d{3,4}[\s\-\/]?\d{3,4}(?=[^\d]|$)/g,
      // Mit Klammern um Vorwahl
      /(\(0\d{2,5}\)[\s\-]?\d{3,4}[\s\-]?\d{3,4})/g,
    ];
    
    const foundPhones: string[] = [];
    
    for (const pattern of phonePatterns) {
      const matches = textContent.match(pattern);
      if (matches) {
        for (const match of matches) {
          // Bereinige Match
          let phone = match
            .replace(/^(Kontakt|Contact|Telefon|Phone|Fon|Tel\.?)[\s:]*/i, '')
            .replace(/^tel:/i, '')
            .trim();
          
          // Entferne führende/nachfolgende Nicht-Telefon-Zeichen
          phone = phone.replace(/^[^\d\+\(]+/, '').replace(/[^\d]+$/, '');
          
          const normalized = normalizePhoneNumber(phone);
          if (normalized && !foundPhones.includes(normalized)) {
            foundPhones.push(normalized);
            console.log(`📞 Found phone via pattern: ${normalized}`);
          }
        }
      }
    }
    
    if (foundPhones.length > 0) {
      return foundPhones[0]; // Erste gefundene Nummer
    }
    
    console.log(`📞 No phone found on: ${url}`);
    return undefined;
    
  } catch (error: any) {
    console.error(`📞 Phone scraping failed for ${url}:`, error.message);
    return undefined;
  }
}

export async function searchGoogle(query: string, apiKey: string, cseId: string, useCache: boolean = true): Promise<SourceResult> {
  try {
    console.log('🔍 Searching Google Custom Search for:', query);

    // Prüfe Cache zuerst
    if (useCache) {
      const cached = getCachedSearch(query, 'google');
      if (cached && !cached.isComplete) {
        console.log(`📋 GOOGLE: Continuing from cache (page ${cached.currentPage + 1})...`);
        // Weiter von der letzten Position
      }
    }

    const results: SearchResult[] = [];
    let totalProcessed = 0;
    
    // PRODUCTION OPTIMIERT für Google Custom Search API:
    // - 100 Ergebnisse max (10 Seiten × 10) - Google API Limit
    // - Schnelleres Rate Limiting für Production
    const maxPages = 100; // Google Custom Search API max: 100 Ergebnisse
    const requestDelay = 500; // 500ms zwischen Requests (etwas schneller)
    
    for (let page = 0; page < maxPages; page++) {
      const startIndex = page * 10 + 1;
      
      try {
        console.log(`Fetching Google results page ${page + 1}/${maxPages} (results ${startIndex}-${startIndex + 9})`);
        
        const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
          params: {
            key: apiKey,
            cx: cseId,
            q: query,
            num: 10,
            start: startIndex
          },
          timeout: 10000
        });

        if (!response.data.items || response.data.items.length === 0) {
          console.log(`No more results found at page ${page + 1}`);
          break; // Keine weiteren Ergebnisse
        }

        // Verarbeite alle 10 Ergebnisse pro Seite
        const itemsToProcess = response.data.items; // Alle Ergebnisse
        
        console.log(`📋 Processing ${itemsToProcess.length} Google results on page ${page + 1}/${maxPages}...`);

        for (const [index, item] of itemsToProcess.entries()) {
          totalProcessed++;
          
          // Rate Limiting für Phone Scraping (optimiert für Production)
          if (index > 0) {
            await new Promise(resolve => setTimeout(resolve, 200)); // 200ms zwischen Phone Requests (schneller)
          }
          
          try {
            console.log(`🔄 [${totalProcessed}] Processing: ${item.title}`);
            
            // Filter: Keine Foren, Marktplätze oder Social Media
            const unwantedDomains = [
              'reddit.com',
              'facebook.com',
              'twitter.com',
              'tiktok.com',
              'youtube.com',
              'ebay.de',
              'ebay-kleinanzeigen.de',
              'kleinanzeigen.de',
              'markt.de',
              'quoka.de',
              'kalaydo.de',
              'gutefrage.net',
              'wer-weiss-was.de'
            ];
            
            if (!item.link) {
              console.log(`[${index + 1}] ❌ SKIPPED (No link)`);
              continue;
            }
            
            const url = new URL(item.link);
            const domain = url.hostname.toLowerCase();
            
            const isUnwanted = unwantedDomains.some(unwanted => 
              domain.includes(unwanted) || 
              item.link.toLowerCase().includes(unwanted) ||
              item.title.toLowerCase().includes('forum') ||
              item.title.toLowerCase().includes('reddit') ||
              item.title.toLowerCase().includes('wiki')
            );
            
            if (isUnwanted) {
              console.log(`[${totalProcessed}] ❌ SKIPPED (Forum/Social): ${domain}`);
              continue;
            }
            
            console.log(`[${totalProcessed}] ✅ BUSINESS WEBSITE: ${domain}`);
            
            // Versuche Telefonnummer von der Website zu scrapen
            let phone: string | undefined;
            
            if (item.link) {
              console.log(`[${totalProcessed}] 📞 Scraping phone from: ${item.link}`);
              phone = await scrapePhoneFromWebsite(item.link);
              
              if (phone) {
                console.log(`[${totalProcessed}] ✅ Phone found: ${phone}`);
              } else {
                console.log(`[${totalProcessed}] ❌ No phone found`);
              }
            } else {
              console.log(`[${totalProcessed}] ⏭️  Skipped (social media or invalid URL)`);
            }

            const result: SearchResult = {
              source: 'google',
              companyName: item.title.replace(/[^\w\s\-\.\&\(\)]/g, '').trim(),
              phone,
              url: item.link,
              description: item.snippet
            };

            results.push(result);
            console.log(`[${totalProcessed}] ✅ Added: "${result.companyName}" ${phone ? '(with phone)' : '(no phone)'}`);

          } catch (itemError) {
            console.error(`[${totalProcessed}] ❌ Error processing item:`, itemError);
            // Füge Ergebnis trotzdem hinzu, aber ohne Telefonnummer
            results.push({
              source: 'google',
              companyName: item.title.replace(/[^\w\s\-\.\&\(\)]/g, '').trim(),
              url: item.link,
              description: item.snippet
            });
          }
        }

      } catch (pageError) {
        console.error(`Error fetching Google page ${page + 1}:`, pageError);
        if (page === 0) {
          throw pageError; // Fehler bei erster Seite werfen
        }
        break; // Bei späteren Seiten einfach abbrechen
      }
      
      // Optimierte Verzögerung für Google API Limits
      if (page < maxPages - 1) {
        console.log(`⏱️  Rate limiting: Waiting ${requestDelay}ms before next page...`);
        await new Promise(resolve => setTimeout(resolve, requestDelay));
      }
    }

    console.log(`🎉 Google search completed: ${results.length} results found`);
    
    // Speichere in Cache
    if (useCache && results.length > 0) {
      setCachedSearch(query, 'google', results, maxPages, maxPages, true);
      console.log(`💾 GOOGLE: Cached ${results.length} results`);
    }
    
    return {
      source: 'google',
      results
    };

  } catch (error: any) {
    console.error('Google search error:', error);
    return {
      source: 'google',
      results: [],
      error: 'Google API-Fehler: ' + (error.response?.data?.error?.message || error.message || 'Unbekannter Fehler')
    };
  }
}