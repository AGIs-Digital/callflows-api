import { VercelRequest, VercelResponse } from '@vercel/node';
import { LeadSearchConfig, SearchResult, SourceResult } from './types/lead-scraping';
import { searchGoogle } from './sources/google';
import { search11880 } from './sources/11880';
import { getCacheStatus, getNextPageFromCache } from './cache/search-cache';

// Intelligente Duplikatentfernung
function removeDuplicates(results: SearchResult[]): SearchResult[] {
  const seen = new Map<string, SearchResult>();
  
  for (const result of results) {
    // Firmenname normalisieren für Vergleich
    const normalizedName = result.companyName
      .toLowerCase()
      .replace(/[^\w\s]/g, '') // Sonderzeichen entfernen
      .replace(/\s+/g, ' ') // Mehrfache Leerzeichen
      .replace(/\b(gmbh|ag|ug|kg|ohg|e\.?k\.?|mbh|inc|ltd|llc)\b/g, '') // Rechtsformen entfernen
      .trim();
    
    // URL normalisieren
    const normalizedUrl = result.url ? 
      result.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') : '';
    
    // Telefonnummer normalisieren  
    const normalizedPhone = result.phone ?
      result.phone.replace(/[\s\-\/\(\)]/g, '').replace(/^\+49/, '0') : '';
    
    // Unique Key erstellen (Kombination aus Name, URL, Phone)
    const uniqueKey = `${normalizedName}|${normalizedUrl}|${normalizedPhone}`;
    
    // Prüfe auf Duplikate
    if (seen.has(uniqueKey)) {
      const existing = seen.get(uniqueKey)!;
      
      // Behalte das Ergebnis mit den meisten Informationen
      const newScore = scoreResult(result);
      const existingScore = scoreResult(existing);
      
      if (newScore > existingScore) {
        seen.set(uniqueKey, result);
      }
    } else {
      seen.set(uniqueKey, result);
    }
  }
  
  return Array.from(seen.values());
}

// Bewertung eines Ergebnisses basierend auf verfügbaren Informationen
function scoreResult(result: SearchResult): number {
  let score = 0;
  if (result.phone) score += 3;
  if (result.url) score += 2;
  if (result.description) score += 1;
  if (result.companyName.length > 5) score += 1;
  return score;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS Headers SOFORT setzen - ERWEITERT für Cross-Domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With, X-CSRF-Token, Cache-Control');
  res.setHeader('Access-Control-Allow-Credentials', 'false'); // Explizit false bei * Origin
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin'); // Wichtig für Caching

  // OPTIONS Request MUSS 200 zurückgeben
  if (req.method === 'OPTIONS') {
    console.log('CORS request received');
    return res.status(200).end();
  }

  // Nur POST Requests erlauben
  if (req.method !== 'POST') {
    return res.status(405).json({ 
      success: false, 
      message: 'Method not allowed.' 
    });
  }

  try {
    // Debug: Log den Request
    console.log('Request method:', req.method);
    console.log('Request body:', req.body);
    console.log('Request headers:', req.headers);

    const config: LeadSearchConfig = req.body;
    const { useCache = true, pageSize = 20, continueFromCache = false } = req.body;

    if (!config || !config.query?.trim()) {
      console.error('Invalid request body:', config);
      return res.status(400).json({
        success: false, 
        message: 'Suchanfrage ist erforderlich.'
      });
    }

    console.log(`Starting search for: "${config.query}"`, { useCache, pageSize, continueFromCache });
    
    // CACHE-MODUS: Prüfe ob bereits Ergebnisse vorhanden sind
    if (useCache && continueFromCache) {
      console.log('🔄 CACHE MODE: Checking for cached results...');
      
      const googleCache = getCacheStatus(config.query, 'google');
      const cache11880 = getCacheStatus(config.query, '11880');
      
      console.log('📊 Cache Status:', { 
        google: googleCache, 
        cache11880 
      });
      
      // Wenn Cache vorhanden, gib nächste Seite zurück
      if (googleCache.cached || cache11880.cached) {
        const googlePage = getNextPageFromCache(config.query, 'google', pageSize);
        const page11880 = getNextPageFromCache(config.query, '11880', pageSize);
        
        const allResults = [...googlePage.results, ...page11880.results];
        const finalResults = removeDuplicates(allResults);
        
        console.log(`✅ CACHE: Returning ${finalResults.length} cached results`);
        
        return res.status(200).json({
          success: true,
          results: finalResults,
          cache: {
            google: googleCache,
            cache11880,
            hasMore: googlePage.hasMore || page11880.hasMore
          },
          fromCache: true
        });
      }
    }

    // Parallele Suche in allen verfügbaren Quellen
    const searchPromises: Promise<SourceResult>[] = [];
    const errors: string[] = [];

    // Google Custom Search (verwende Environment Variables)
    let googleApiKey = process.env.GOOGLE_API_KEY;
    let googleCseId = process.env.GOOGLE_CSE_ID;
    
    // TEMPORÄRER FALLBACK: Falls .env.local nicht geladen wird
    if (!googleApiKey || !googleCseId) {
      console.log('Trying hardcoded fallback for Google credentials...');
      googleApiKey = 'AIzaSyDYOSjzT84kXkOILP_s8L1c4Td0JFThUwo';
      googleCseId = 'a72a1990010cb4262';
    }
    
    console.log('Environment Check:', {
      hasGoogleApiKey: !!googleApiKey,
      hasGoogleCseId: !!googleCseId,
      googleApiKeyLength: googleApiKey?.length || 0,
      googleCseIdLength: googleCseId?.length || 0,
      processEnvKeys: Object.keys(process.env).filter(key => key.includes('GOOGLE')),
      nodeEnv: process.env.NODE_ENV
    });
    
    if (googleApiKey && googleCseId) {
      console.log('Google API: Starting search with credentials');
      searchPromises.push(searchGoogle(config.query, googleApiKey, googleCseId, useCache));
    } else {
      console.error('Google API: Still no credentials available');
      errors.push('Google API: Keine gültigen Credentials verfügbar');
    }

    // 11880 (immer versuchen, AGB werden intern geprüft)
    searchPromises.push(search11880(config.query, useCache));

    if (searchPromises.length === 0) {
      return res.status(500).json({
        success: false,
        message: 'Keine Suchquellen verfügbar. API-Konfiguration prüfen.'
      });
    }

    console.log(`Starting search with ${searchPromises.length} sources...`);

    // Warte auf alle Suchergebnisse
    const sourceResults = await Promise.allSettled(searchPromises);

    // Sammle alle Ergebnisse
    const allResults: SearchResult[] = [];
    
    for (let index = 0; index < sourceResults.length; index++) {
      const result = sourceResults[index];
      if (result.status === 'fulfilled') {
        const sourceResult = result.value;
        allResults.push(...sourceResult.results);
        
        if (sourceResult.error) {
          errors.push(sourceResult.error);
        }
        
        console.log(`Source ${index + 1}: ${sourceResult.results.length} results`);
      } else {
        console.error(`Source ${index + 1} failed:`, result.reason);
        errors.push(`Suchquelle ${index + 1}: ${result.reason.message || 'Unbekannter Fehler'}`);
      }
    }

    console.log(`Total raw results: ${allResults.length}`);

    // Entferne Duplikate
    const uniqueResults = removeDuplicates(allResults);
    console.log(`Unique results after deduplication: ${uniqueResults.length}`);

    // Cache-Status für Response
    const googleCacheStatus = getCacheStatus(config.query, 'google');
    const cache11880Status = getCacheStatus(config.query, '11880');

    return res.status(200).json({
      success: true,
      results: uniqueResults,
      errors: errors.length > 0 ? errors : undefined,
      cache: {
        google: googleCacheStatus,
        "11880": cache11880Status,
        hasMore: !googleCacheStatus.isComplete || !cache11880Status.isComplete
      },
      fromCache: false
    });

  } catch (error: any) {
    console.error('Lead search error:', error);
    console.error('Error stack:', error.stack);
    return res.status(500).json({
      success: false, 
      message: 'Ein unerwarteter Fehler ist aufgetreten.',
      error: error.message // Immer Error-Message zeigen für besseres Debugging
    });
  }
}