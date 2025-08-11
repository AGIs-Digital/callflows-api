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
          let detailUrl: string | undefined;
          
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
          
          // Website-URL suchen (Zwei-Stufen-Scraping für 11880)
          console.log(`🌐 Searching for website URL for "${companyName}"`);
          
          const $container = $listItem.length > 0 ? $listItem : $titleEl.closest('.result-list-entry');
          if ($container.length > 0) {
            
            // STUFE 1: Finde Detail-URL für diesen Eintrag
            
            // Suche nach verschlüsselten Detail-URLs und anderen Link-Pattern
            const detailLinkSelectors = [
              // Direkte Links (falls unverschlüsselt)
              'a[href*="/branchenbuch/"]',
              'a[href*="11880.com"][href*="html"]',
              // Title-Links (oft verschlüsselt)
              '.result-list-entry-title a',
              'h2 a',
              'h2.result-list-entry-title__headline a',
              // Mehr Details Buttons
              'a:contains("Mehr Details")',
              'a:contains("Details")',
              // Verschlüsselte Links (enthalten lange Base64-ähnliche Strings)
              'a[href*="*"]', // Links die mit * beginnen (verschlüsselt)
              'a[href^="/"]', // Relative Links
              // Nach data-Attributen
              'a[data-href]',
              'a[data-url]',
              '[data-testid*="detail"] a',
              // Alle Links im Container
              'a[href]'
            ];
            
            for (const selector of detailLinkSelectors) {
              const $detailLink = $container.find(selector).first();
              if ($detailLink.length > 0) {
                const href = $detailLink.attr('href');
                console.log(`🔍 Found link with selector "${selector}": ${href}`);
                
                if (href) {
                  // Verschlüsselte Links (beginnen mit *)
                  if (href.startsWith('*')) {
                    console.log(`🔒 Found encrypted link: ${href}`);
                    detailUrl = `https://www.11880.com${href}`;
                    console.log(`🔗 Constructed encrypted detail URL: ${detailUrl}`);
                    break;
                  }
                  // Normale Links
                  else if (href.includes('11880.com') || href.includes('/branchenbuch/')) {
                    detailUrl = href.startsWith('http') ? href : `https://www.11880.com${href}`;
                    console.log(`🔗 Found normal detail URL: ${detailUrl}`);
                    break;
                  }
                  // Relative Links die vielversprechend aussehen
                  else if (href.startsWith('/') && (href.length > 20 || href.includes('branchenbuch'))) {
                    detailUrl = `https://www.11880.com${href}`;
                    console.log(`🔗 Found relative detail URL: ${detailUrl}`);
                    break;
                  }
                }
              }
            }
            
            // Fallback: Konstruiere Detail-URL aus Firmenname (wenn verfügbar)
            if (!detailUrl && $titleEl.closest('a').length > 0) {
              const titleLink = $titleEl.closest('a').attr('href');
              if (titleLink && titleLink.includes('11880.com')) {
                detailUrl = titleLink.startsWith('http') ? titleLink : `https://www.11880.com${titleLink}`;
                console.log(`🔗 Found detail URL via title: ${detailUrl}`);
              }
            }
            
            // Speichere Detail-URL für späteren Abruf
            console.log(`🔗 Detail URL found: ${detailUrl || 'none'}`);
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
            description,
            _detailUrl: detailUrl // Temporär für Detail-Scraping
          });
          
          console.log(`✅ 11880: "${companyName}" - ${phone ? 'Phone: ✓' : 'Phone: ✗'} - ${website ? 'Website: ✓' : 'Website: ✗'} - ${detailUrl ? 'Detail: ✓' : 'Detail: ✗'}`);
        });
        
        // STUFE 2: Detail-Scraping für Website-URLs (nach der each-Schleife)
        console.log(`🔄 Starting detail scraping for ${results.length} entries...`);
        
        for (let i = 0; i < results.length && i < 5; i++) { // Limit auf erste 5 für Performance
          const result = results[i] as any;
          
          if (result._detailUrl && !result.url) {
            try {
              console.log(`📄 [${i+1}] Fetching detail page: ${result._detailUrl}`);
              
              const detailResponse = await axios.get(result._detailUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                  'Accept-Language': 'de-DE,de;q=0.9',
                  'Referer': searchUrl
                },
                timeout: 5000
              });
              
              console.log(`✅ [${i+1}] Detail page loaded: ${detailResponse.status}`);
              
              // Parse Detail-Seite
              const $detail = cheerio.load(detailResponse.data);
              
              // Nutze die strukturierte Detail-Seite mit entry-detail-list__label
              console.log(`🔍 [${i+1}] Parsing structured detail page...`);
              
              // Finde alle entry-detail-list__label Elemente (4 Stück: Telefon, Adresse, E-Mail, Homepage)
              const $labels = $detail('.entry-detail-list__label');
              console.log(`📋 [${i+1}] Found ${$labels.length} detail labels`);
              
              $labels.each((labelIndex, labelEl) => {
                const $label = $detail(labelEl);
                const labelText = $label.text().trim().toLowerCase();
                
                console.log(`🏷️ [${i+1}] Label ${labelIndex + 1}: "${labelText}"`);
                
                // Suche nach Website/Homepage Label
                if (labelText.includes('website') || labelText.includes('homepage') || labelText.includes('web')) {
                  // Finde den Link im gleichen Container
                  const $container = $label.parent();
                  const $websiteLink = $container.find('a[href^="http"]:not([href*="11880.com"])').first();
                  
                  if ($websiteLink.length > 0) {
                    const href = $websiteLink.attr('href');
                    if (href) {
                      result.url = href;
                      console.log(`✅ [${i+1}] Found website via structured label: "${href}"`);
                      return false; // Break out of each loop
                    }
                  }
                }
                
                // Fallback: Suche nach E-Mail Label und extrahiere Website aus E-Mail-Domain
                if (!result.url && (labelText.includes('e-mail') || labelText.includes('email'))) {
                  const $container = $label.parent();
                  const emailText = $container.text();
                  const emailMatch = emailText.match(/([a-zA-Z0-9._%+-]+@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))/);
                  
                  if (emailMatch) {
                    const domain = emailMatch[2];
                    if (!domain.includes('gmail') && !domain.includes('outlook') && !domain.includes('web.de')) {
                      const websiteUrl = `https://www.${domain}`;
                      result.url = websiteUrl;
                      console.log(`✅ [${i+1}] Found website via email domain: "${websiteUrl}"`);
                      return false; // Break out of each loop
                    }
                  }
                }
              });
              
            } catch (detailError: any) {
              console.error(`❌ [${i+1}] Failed to fetch detail page for ${result.companyName}:`, detailError.message);
            }
          }
          
          // Bereinige temporäre Felder
          delete result._detailUrl;
        }
        
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
