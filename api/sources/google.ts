import axios from 'axios';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { SearchResult, SourceResult } from '../types/lead-scraping';

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

// Funktion zum Scrapen von Telefonnummern von der echten Website
async function scrapePhoneFromWebsite(url: string): Promise<string | undefined> {
  const isLocal = process.env.NODE_ENV !== 'production';
  // In Production keine Browser-Starts für Google, um Konflikte/Startkosten zu vermeiden
  if (!isLocal) {
    console.log('Google phone scraping disabled in production to avoid Chromium conflicts');
    return undefined;
  }

  let browser;
  if (isLocal) {
    // Lokale Entwicklung - verwende System Chrome
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  } else {
    // Vercel Production - verwende @sparticuz/chromium
    browser = await puppeteer.launch({
      args: [...chromium.args, '--hide-scrollbars', '--disable-web-security'],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
  }
  
  const page = await browser.newPage();
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 12000 });
    
    // Warte kurz um sicherzustellen, dass dynamischer Content geladen wird
    await page.waitForTimeout(1000);
    
    // 1. Versuche spezifische DOM-Selektoren für Telefonnummern
    const phoneFromSelectors = await page.evaluate(() => {
      const selectors = [
        '[href^="tel:"]',
        '[data-phone]',
        '.phone',
        '.telefon',
        '.contact-phone',
        '.tel',
        '#phone',
        '#telefon',
        '.contact-info [href^="tel:"]',
        'a[href*="tel"]',
        '.footer [href^="tel:"]',
        '.header [href^="tel:"]'
      ];
      
      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        for (const element of Array.from(elements)) {
          const href = element.getAttribute('href');
          if (href && href.startsWith('tel:')) {
            return href.replace('tel:', '').trim();
          }
          const text = element.textContent?.trim();
          if (text && /[\d\+\-\s\(\)]{8,}/.test(text)) {
            return text;
          }
        }
      }
      return null;
    });
    
    if (phoneFromSelectors) {
      const normalized = normalizePhoneNumber(phoneFromSelectors);
      if (normalized) {
        await browser.close();
        return normalized;
      }
    }
    
    // 2. Hole den gesamten Text und suche mit verbesser Regex
    const pageText = await page.evaluate(() => document.body.textContent) || '';
    
    // Verbesserte deutsche Telefonnummer-Pattern
    const phonePatterns = [
      // Internationale Formate
      /(\+49[\s\-]?(?:\(0\))?[\s\-]?\d{2,5}[\s\-\/]?\d{3,4}[\s\-\/]?\d{3,4})/g,
      // Deutsche Vorwahl mit 0
      /(0\d{2,5}[\s\-\/]?\d{3,4}[\s\-\/]?\d{3,4})/g,
      // Mit Klammern um Vorwahl
      /(\(0\d{2,5}\)[\s\-]?\d{3,4}[\s\-]?\d{3,4})/g,
      // Mit Labels
      /(Tel\.?:?\s*[\+\d\s\-\/\(\)]{10,})/gi,
      /(Telefon:?\s*[\+\d\s\-\/\(\)]{10,})/gi,
      /(Phone:?\s*[\+\d\s\-\/\(\)]{10,})/gi,
      /(Fon:?\s*[\+\d\s\-\/\(\)]{10,})/gi,
      /(Mobil:?\s*[\+\d\s\-\/\(\)]{10,})/gi,
      // Ohne Label aber mit charakteristischen Formaten
      /(\+49[\s\(]?[1-9]\d{1,4}[\s\)\-\/]?\d{3,4}[\s\-\/]?\d{3,4})/g,
      /(0[1-9]\d{1,4}[\s\-\/]?\d{3,4}[\s\-\/]?\d{3,4})/g
    ];
    
    const foundPhones: string[] = [];
    
    for (const pattern of phonePatterns) {
      const matches = pageText.match(pattern);
      if (matches) {
        for (const match of matches) {
          let phone = match.replace(/^(Tel\.?:?\s*|Telefon:?\s*|Phone:?\s*|Fon:?\s*|Mobil:?\s*)/i, '').trim();
          
          // Normalisiere und validiere
          const normalized = normalizePhoneNumber(phone);
          if (normalized && !foundPhones.includes(normalized)) {
            foundPhones.push(normalized);
          }
        }
      }
    }
    
    // Nimm die erste gültige Telefonnummer
    if (foundPhones.length > 0) {
      await browser.close();
      return foundPhones[0];
    }
    
  } catch (error) {
    console.error('Phone scraping error for', url, ':', error);
  } finally {
    await browser.close();
  }
  
  return undefined;
}

export async function searchGoogle(query: string, apiKey: string, cseId: string): Promise<SourceResult> {
  try {
    console.log('Searching Google Custom Search for:', query);

    const results: SearchResult[] = [];
    
    // TESTING: Limit auf 10 Ergebnisse für Tests
    const maxPages = 1; // Nur erste Seite für Tests
    
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

        // Verarbeite alle 10 Ergebnisse für Tests (normalerweise nur 3 um Zeit zu sparen)
        const itemsToProcess = response.data.items.slice(0, 10); // Alle für Tests
        
        console.log(`Processing ${itemsToProcess.length} Google results...`);

        for (const [index, item] of itemsToProcess.entries()) {
          if (results.length >= 10) break; // TESTING: Limit auf 10 Ergebnisse gesamt
          
          try {
            console.log(`[${index + 1}/${itemsToProcess.length}] Processing: ${item.title}`);
            
            // Versuche Telefonnummer von der Website zu scrapen
            let phone: string | undefined;
            
            if (item.link && !item.link.includes('facebook.com') && !item.link.includes('xing.com')) {
              console.log(`[${index + 1}] Scraping phone from: ${item.link}`);
              phone = await scrapePhoneFromWebsite(item.link);
              
              if (phone) {
                console.log(`[${index + 1}] ✅ Phone found: ${phone}`);
              } else {
                console.log(`[${index + 1}] ❌ No phone found`);
              }
            } else {
              console.log(`[${index + 1}] ⏭️  Skipped (social media or invalid URL)`);
            }

            const result: SearchResult = {
              source: 'google',
              companyName: item.title.replace(/[^\w\s\-\.\&\(\)]/g, '').trim(),
              phone,
              url: item.link,
              description: item.snippet
            };

            results.push(result);
            console.log(`[${index + 1}] Added: "${result.companyName}" ${phone ? '(with phone)' : '(no phone)'}`);

          } catch (itemError) {
            console.error(`[${index + 1}] Error processing item:`, itemError);
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
    }

    console.log(`🎉 Google search completed: ${results.length} results found`);
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