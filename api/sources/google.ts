import axios from 'axios';
import puppeteer from 'puppeteer-core';
import chromium from 'chrome-aws-lambda';
import { SearchResult, SourceResult } from '../types/lead-scraping';

// Funktion zum Scrapen von Telefonnummern von der echten Website
async function scrapePhoneFromWebsite(url: string): Promise<string | undefined> {
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath,
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
  });
  const page = await browser.newPage();
  
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
    
    // Hole den gesamten Text der Seite
    const pageText = await page.evaluate(() => document.body.textContent) || '';
    
    // Erweiterte Telefonnummer-Pattern
    const phonePatterns = [
      /(\+49[\s\-]?\d{2,5}[\s\-\/]?\d{3,8}[\s\-\/]?\d{0,8})/g,
      /(0\d{2,5}[\s\-\/]?\d{3,8}[\s\-\/]?\d{0,8})/g,
      /(\(\d{2,5}\)[\s\-]?\d{3,8}[\s\-]?\d{0,8})/g,
      /(Tel\.?:?\s*[\+\d\s\-\/\(\)]{8,20})/gi,
      /(Telefon:?\s*[\+\d\s\-\/\(\)]{8,20})/gi,
      /(Phone:?\s*[\+\d\s\-\/\(\)]{8,20})/gi,
      /(Fon:?\s*[\+\d\s\-\/\(\)]{8,20})/gi
    ];
    
    for (const pattern of phonePatterns) {
      const matches = pageText.match(pattern);
      if (matches && matches.length > 0) {
        let phone = matches[0].replace(/^(Tel\.?:?\s*|Telefon:?\s*|Phone:?\s*|Fon:?\s*)/i, '').trim();
        // Bereinige die Telefonnummer
        phone = phone.replace(/[^\d\+\(\)\-\s\/]/g, '').trim();
        if (phone.length >= 8) {
          await browser.close();
          return phone;
        }
      }
    }
  } catch (error) {
    console.error('Phone scraping error:', error);
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