import axios from 'axios';
import * as cheerio from 'cheerio';
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
  try {
    console.log('🔍 11880: Starting HTTP-based search for:', query);
    
    const { what, where } = parseSearchQuery(query);
    console.log(`🎯 11880: Searching "${what}" in "${where}"`);
    
    // Baue URL nach dem Schema: https://www.11880.com/suche/was/wo
    const searchUrl = `https://www.11880.com/suche/${encodeURIComponent(what)}/${encodeURIComponent(where)}`;
    console.log(`🌐 11880: Fetching ${searchUrl}`);
    
    const results: SearchResult[] = [];
    let currentPage = 1;
    const maxPages = 3; // Limit für Performance
    
    while (currentPage <= maxPages) {
      console.log(`📄 11880: Scraping page ${currentPage}...`);
      
      const pageUrl = currentPage === 1 ? searchUrl : `${searchUrl}?page=${currentPage}`;
      
      try {
        // HTTP Request mit User-Agent
        const response = await axios.get(pageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'de-DE,de;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
          },
          timeout: 10000,
        });
        
        console.log(`✅ 11880: Page ${currentPage} loaded, status: ${response.status}`);
        
        // Parse HTML mit Cheerio
        const $ = cheerio.load(response.data);
        
        // Extrahiere Ergebnisse mit den bekannten Selektoren
        const titleElements = $('h2.result-list-entry-title__headline.result-list-entry-title__headline--ellipsis');
        
        console.log(`📋 11880: Found ${titleElements.length} title elements on page ${currentPage}`);
        
        if (titleElements.length === 0) {
          console.log(`📄 11880: No results found on page ${currentPage}`);
          break;
        }
        
        titleElements.each((index, titleEl) => {
          if (results.length >= 10) return false; // Break out of loop
          
          const $titleEl = $(titleEl);
          const companyName = $titleEl.text().trim();
          
          if (!companyName || companyName.length < 2) return; // Continue to next
          
          console.log(`🔍 Processing "${companyName}"`);
          
          let phone: string | undefined;
          let website: string | undefined;
          let description: string | undefined;
          
          // Strategie 1: Suche im direkten li-Element (Listencontainer)
          const $listItem = $titleEl.closest('li');
          if ($listItem.length > 0) {
            const $phoneEl = $listItem.find('span.result-list-entry-phone-number__label');
            if ($phoneEl.length > 0) {
              phone = $phoneEl.text().trim();
              phone = phone?.replace(/&nbsp;/g, ' ').replace(/\u00A0/g, ' ').trim();
              console.log(`✅ Found phone in list item: "${phone}"`);
            }
          }
          
          // Strategie 2: Suche im gesamten result-list-entry Container
          if (!phone) {
            const $entryContainer = $titleEl.closest('.result-list-entry');
            if ($entryContainer.length > 0) {
              const $phoneEl = $entryContainer.find('span.result-list-entry-phone-number__label');
              if ($phoneEl.length > 0) {
                phone = $phoneEl.text().trim();
                phone = phone?.replace(/&nbsp;/g, ' ').replace(/\u00A0/g, ' ').trim();
                console.log(`✅ Found phone in entry container: "${phone}"`);
              }
            }
          }
          
          // Strategie 3: Index-basierte Suche
          if (!phone) {
            const allPhones = $('span.result-list-entry-phone-number__label');
            const allTitles = $('h2.result-list-entry-title__headline.result-list-entry-title__headline--ellipsis');
            
            const titleIndex = allTitles.index(titleEl);
            if (titleIndex >= 0 && titleIndex < allPhones.length) {
              const $phoneEl = allPhones.eq(titleIndex);
              phone = $phoneEl.text().trim();
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
          
          // Website-URL suchen (mehrere Strategien)
          console.log(`🌐 Searching for website URL for "${companyName}"`);
          
          // Strategie 1: Direkte Website-Links in der Entry
          const $container = $listItem.length > 0 ? $listItem : $titleEl.closest('.result-list-entry');
          if ($container.length > 0) {
            // Suche nach Website-Button oder Link
            const $websiteLink = $container.find('a[href*="http"]:not([href*="11880.com"]):not([href*="tel:"]):not([href*="mailto:"])').first();
            if ($websiteLink.length > 0) {
              website = $websiteLink.attr('href');
              console.log(`✅ Found website link: "${website}"`);
            }
            
            // Fallback: Suche nach spezifischen Klassen für Website-Links
            if (!website) {
              const websiteSelectors = [
                'a.result-list-entry-website-link',
                'a[class*="website"]',
                'a[class*="homepage"]',
                'a[class*="web"]',
                '.website-link a',
                '.homepage-link a',
                'a[title*="Website"]',
                'a[title*="Homepage"]'
              ];
              
              for (const selector of websiteSelectors) {
                const $webLink = $container.find(selector).first();
                if ($webLink.length > 0) {
                  const href = $webLink.attr('href');
                  if (href && href.startsWith('http') && !href.includes('11880.com')) {
                    website = href;
                    console.log(`✅ Found website via selector "${selector}": "${website}"`);
                    break;
                  }
                }
              }
            }
          }
          
          // Bereinige Website-URL
          if (website) {
            // Entferne 11880-Tracking-Parameter
            try {
              const url = new URL(website);
              if (url.hostname.includes('11880.com') || url.pathname.includes('/redirect/')) {
                console.log(`⚠️ Skipping 11880 redirect URL: ${website}`);
                website = undefined;
              } else {
                website = url.toString();
              }
            } catch (e) {
              console.log(`⚠️ Invalid URL format: ${website}`);
              website = undefined;
            }
          }
          
          // Beschreibung (verwende bereits definiertes $container)
          if ($container.length > 0) {
            description = $container.text().substring(0, 150).replace(/\s+/g, ' ').trim();
          }
          
          results.push({
            source: '11880',
            companyName,
            phone,
            url: website,
            description
          });
          
          console.log(`✅ 11880: "${companyName}" - ${phone ? 'Phone: ✓' : 'Phone: ✗'} - ${website ? 'Website: ✓' : 'Website: ✗'}`);
        });
        
        if (results.length >= 10) break;
        
        currentPage++;
        
      } catch (pageError) {
        console.error(`❌ 11880: Failed to load page ${currentPage}:`, pageError);
        break;
      }
    }
    
    console.log(`🎉 11880 HTTP search completed: ${results.length} total results found across ${currentPage - 1} pages`);
    return {
      source: '11880',
      results
    };
    
  } catch (error: any) {
    console.error('❌ 11880 HTTP search error:', error);
    console.error('❌ Error stack:', error.stack);
    
    return {
      source: '11880',
      results: [],
      error: '11880 HTTP-Scraping-Fehler: ' + (error.message || 'Unbekannter Fehler')
    };
  }
}
