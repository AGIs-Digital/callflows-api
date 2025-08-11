import puppeteerCore from 'puppeteer-core';
import puppeteer from 'puppeteer';
import chromium from '@sparticuz/chromium';
import { SearchResult, SourceResult } from '../types/lead-scraping';

// Hilfsfunktion um Suchbegriff in "Was" und "Wo" aufzuteilen
function parseSearchQuery(query: string): { what: string; where: string } {
  const locationKeywords = ['berlin', 'hamburg', 'münchen', 'köln', 'frankfurt', 'stuttgart', 'düsseldorf', 'dortmund', 'essen', 'leipzig', 'bremen', 'dresden', 'hannover', 'nürnberg'];
  
  const queryLower = query.toLowerCase();
  
  // Suche nach Städtenamen
  for (const city of locationKeywords) {
    if (queryLower.includes(city)) {
      const what = query.replace(new RegExp(city, 'gi'), '').trim();
      return {
        what: what || 'dienstleister', // Fallback wenn nur Stadt
        where: city
      };
    }
  }
  
  // Fallback: Versuche das letzte Wort als Ort zu interpretieren
  const words = query.split(' ');
  if (words.length >= 2) {
    const lastWord = words[words.length - 1];
    const remainingWords = words.slice(0, -1).join(' ');
    
    return {
      what: remainingWords,
      where: lastWord
    };
  }
  
  return {
    what: query,
    where: 'deutschland' // Fallback für deutschlandweite Suche
  };
}

export async function search11880(query: string): Promise<SourceResult> {
  let browser;
  
  try {
    console.log('🔍 11880: Starting NEW search for:', query);
    
    // Puppeteer mit chrome-aws-lambda für Vercel
    const isLocal = process.env.NODE_ENV !== 'production';
    console.log(`🔧 Environment: ${isLocal ? 'LOCAL' : 'PRODUCTION'}`);
    
    if (isLocal) {
      // Lokale Entwicklung - verwende System Chrome
      console.log('🔧 Using local Chrome browser');
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    } else {
      // Vercel Production - verwende @sparticuz/chromium (modernste Vercel-kompatible Library)
      console.log('🔧 Using @sparticuz/chromium for Vercel');
      console.log('🔧 Platform:', process.platform);
      console.log('🔧 Architecture:', process.arch);
      console.log('🔧 Node version:', process.version);

      // Stabilisierung: Headless/Graphics setzen und eindeutiges Profil pro Invocation
      chromium.setHeadlessMode = true;
      chromium.setGraphicsMode = false;
      const userDataDir = `/tmp/chromium-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      try {
        // Hauptweg: @sparticuz/chromium mit puppeteer-core
        const executablePath = await chromium.executablePath();
        console.log('🔧 Sparticuz Chrome executable path:', executablePath);

        browser = await puppeteerCore.launch({
          args: [
            ...chromium.args,
            '--hide-scrollbars',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
          ],
          defaultViewport: chromium.defaultViewport,
          executablePath,
          headless: chromium.headless,
          ignoreHTTPSErrors: true,
          userDataDir,
        });
        console.log('✅ Browser launched successfully with @sparticuz/chromium');

      } catch (sparticuzError) {
        console.error('❌ @sparticuz/chromium failed:', sparticuzError);
        console.log('🔄 Fallback: Trying regular puppeteer with built-in Chrome...');

        try {
          // Einziger Fallback: reguläres puppeteer (integrierter Chrome)
          browser = await puppeteer.launch({
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-accelerated-2d-canvas',
              '--no-first-run',
              '--no-zygote',
              '--single-process',
              '--disable-gpu',
              '--hide-scrollbars',
              '--disable-web-security',
              '--disable-features=VizDisplayCompositor',
            ],
            headless: true,
            ignoreHTTPSErrors: true,
            userDataDir,
          });
          console.log('✅ Fallback: Browser launched with regular puppeteer');
        } catch (puppeteerError) {
          console.error('❌ Regular puppeteer also failed:', puppeteerError);
          throw new Error(`CRITICAL: 11880 scraping unavailable. Sparticuz failed: ${String(sparticuzError?.message || sparticuzError)} | Puppeteer failed: ${String(puppeteerError?.message || puppeteerError)}`);
        }
      }
    }
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    const { what, where } = parseSearchQuery(query);
    console.log(`🎯 11880: Searching "${what}" in "${where}"`);
    
    // Baue URL nach dem Schema: https://www.11880.com/suche/was/wo
    const searchUrl = `https://www.11880.com/suche/${encodeURIComponent(what)}/${encodeURIComponent(where)}`;
    
    console.log(`🌐 11880: Navigating to ${searchUrl}`);
    
    await page.goto(searchUrl, { 
      waitUntil: 'domcontentloaded', 
      timeout: 20000 
    });
    
    // Cookie-Banner akzeptieren falls vorhanden
    try {
      await page.click('button[data-testid="uc-accept-all-button"], .cookie-accept', { timeout: 3000 });
      await page.waitFor(1000);
    } catch (e) {
      console.log('🍪 11880: No cookie banner found');
    }
    
    // Warte auf Suchergebnisse
    await page.waitFor(3000);
    
    const results: SearchResult[] = [];
    let currentPage = 1;
    const maxPages = 3; // Limit für Performance
    
    while (currentPage <= maxPages) {
      console.log(`📄 11880: Scraping page ${currentPage}...`);
      
      // Warte auf Ergebnisse
      try {
        await page.waitForSelector('h2.result-list-entry-title__headline', { timeout: 5000 });
      } catch (e) {
        console.log(`📄 11880: No results found on page ${currentPage}`);
        break;
      }
      
      // Extrahiere Ergebnisse mit den spezifischen Selektoren
      const pageResults = await page.evaluate(() => {
        const items: Array<{
          name: string;
          phone?: string;
          website?: string;
          description?: string;
        }> = [];
        
        // Finde alle Firmennamen
        const titleElements = document.querySelectorAll('h2.result-list-entry-title__headline.result-list-entry-title__headline--ellipsis');
        
        for (const titleEl of Array.from(titleElements)) {
          const companyName = titleEl.textContent?.trim();
          
          if (!companyName || companyName.length < 2) continue;
          
          // NEUE STRATEGIE: Suche breitere Bereiche für Telefonnummer
          let phone: string | undefined;
          let website: string | undefined;
          let description: string | undefined;
          
          console.log(`🔍 SEARCHING für "${companyName}":`);
          
          // Strategie 1: Suche im direkten li-Element (Listencontainer)
          const listItem = titleEl.closest('li');
          if (listItem) {
            console.log(`📋 List item found, searching for phone...`);
            const phoneEl = listItem.querySelector('span.result-list-entry-phone-number__label');
            if (phoneEl) {
              phone = phoneEl.textContent?.trim();
              phone = phone?.replace(/&nbsp;/g, ' ').replace(/\u00A0/g, ' ').trim();
              console.log(`✅ Found phone in list item: "${phone}"`);
            }
          }
          
          // Strategie 2: Suche im gesamten result-list-entry Container
          if (!phone) {
            const entryContainer = titleEl.closest('.result-list-entry') || titleEl.closest('[class*="result-list-entry"]');
            if (entryContainer) {
              console.log(`📋 Entry container found, searching for phone...`);
              const phoneEl = entryContainer.querySelector('span.result-list-entry-phone-number__label');
              if (phoneEl) {
                phone = phoneEl.textContent?.trim();
                phone = phone?.replace(/&nbsp;/g, ' ').replace(/\u00A0/g, ' ').trim();
                console.log(`✅ Found phone in entry container: "${phone}"`);
              }
            }
          }
          
          // Strategie 3: Suche nach Geschwister-Elementen des Titel-Parents
          if (!phone) {
            const titleParent = titleEl.parentElement;
            if (titleParent && titleParent.parentElement) {
              console.log(`📋 Searching in siblings of title parent...`);
              const phoneEl = titleParent.parentElement.querySelector('span.result-list-entry-phone-number__label');
              if (phoneEl) {
                phone = phoneEl.textContent?.trim();
                phone = phone?.replace(/&nbsp;/g, ' ').replace(/\u00A0/g, ' ').trim();
                console.log(`✅ Found phone in siblings: "${phone}"`);
              }
            }
          }
          
          // Strategie 4: Globale Suche mit Index-Matching
          if (!phone) {
            console.log(`📋 Trying global search with index matching...`);
            // Alle Telefonnummern auf der Seite finden
            const allPhones = document.querySelectorAll('span.result-list-entry-phone-number__label');
            // Alle Titel auf der Seite finden
            const allTitles = document.querySelectorAll('h2.result-list-entry-title__headline.result-list-entry-title__headline--ellipsis');
            
            // Index des aktuellen Titels finden
            const titleIndex = Array.from(allTitles).indexOf(titleEl);
            console.log(`📋 Title index: ${titleIndex}, Total phones: ${allPhones.length}`);
            
            if (titleIndex >= 0 && titleIndex < allPhones.length) {
              const phoneEl = allPhones[titleIndex];
              phone = phoneEl.textContent?.trim();
              phone = phone?.replace(/&nbsp;/g, ' ').replace(/\u00A0/g, ' ').trim();
              console.log(`✅ Found phone via index matching: "${phone}"`);
            }
          }
          
          // Bereinige Telefonnummer
          if (phone) {
            phone = phone.replace(/\s+/g, ' ').trim();
            if (phone.length === 0) {
              phone = undefined;
            }
          }
          
          console.log(`🔍 FINAL result for "${companyName}": ${phone ? `"${phone}"` : 'NOT FOUND'}`);
          console.log(`🔍 ========================================`);
          
          // Beschreibung - verwende das erste gefundene Container-Element
          const container = titleEl.closest('li') || titleEl.closest('.result-list-entry') || titleEl.closest('div');
          if (container) {
            description = container.textContent?.substring(0, 150).replace(/\s+/g, ' ').trim();
          }
          
          items.push({
            name: companyName,
            phone,
            website: undefined, // Website-Scraping deaktiviert für 11880
            description
          });
        }
        
        return items;
      });
      
      console.log(`📋 11880: Found ${pageResults.length} entries on page ${currentPage}`);
      
      // Füge Ergebnisse hinzu
      for (const result of pageResults) {
        if (results.length >= 10) break; // TESTING: Limit auf 10 für Tests
        
        results.push({
          source: '11880',
          companyName: result.name,
          phone: result.phone,
          url: result.website,
          description: result.description
        });
        
        console.log(`✅ 11880: "${result.name}" - ${result.phone ? 'Phone: ✓' : 'Phone: ✗'} - Web: disabled`);
      }
      
      if (results.length >= 10) break;
      
      // Versuche zur nächsten Seite zu gehen
      currentPage++;
      const nextPageUrl = `${searchUrl}?page=${currentPage}`;
      
      try {
        console.log(`🔄 11880: Going to page ${currentPage}: ${nextPageUrl}`);
        await page.goto(nextPageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitFor(2000);
        
        // Prüfe ob es noch Ergebnisse gibt
        const hasResults = await page.$('h2.result-list-entry-title__headline');
        if (!hasResults) {
          console.log(`🏁 11880: No more results found on page ${currentPage}`);
          break;
        }
        
      } catch (e) {
        console.log(`❌ 11880: Failed to load page ${currentPage}:`, e);
        break;
      }
    }
    
    await browser.close();
    
    console.log(`🎉 11880 search completed: ${results.length} total results found across ${currentPage - 1} pages`);
    return {
      source: '11880',
      results
    };
    
  } catch (error: any) {
    if (browser) await browser.close().catch(() => {});
    
    console.error('❌ 11880 search error:', error);
    console.error('❌ Error stack:', error.stack);
    console.error('❌ Error details:', {
      name: error.name,
      message: error.message,
      code: error.code,
      signal: error.signal
    });
    
    return {
      source: '11880',
      results: [],
      error: '11880 Scraping-Fehler: ' + (error.message || 'Unbekannter Fehler') + ' (Details in logs)'
    };
  }
}