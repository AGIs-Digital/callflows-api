// Zwischenspeicher für Suchergebnisse mit Pagination
import { SearchResult } from '../types/lead-scraping';

interface CachedSearch {
  query: string;
  source: 'google' | '11880';
  results: SearchResult[];
  totalPages: number;
  currentPage: number;
  lastSearchTime: number;
  isComplete: boolean; // Alle Seiten abgerufen?
}

// In-Memory Cache (in Production: Redis oder Database)
const searchCache = new Map<string, CachedSearch>();

// Cache-Key generieren
function getCacheKey(query: string, source: 'google' | '11880'): string {
  return `${source}:${query.toLowerCase().trim()}`;
}

// Suche aus Cache abrufen
export function getCachedSearch(query: string, source: 'google' | '11880'): CachedSearch | null {
  const key = getCacheKey(query, source);
  const cached = searchCache.get(key);
  
  if (!cached) return null;
  
  // Cache-Gültigkeit: 1 Stunde
  const oneHour = 60 * 60 * 1000;
  if (Date.now() - cached.lastSearchTime > oneHour) {
    searchCache.delete(key);
    return null;
  }
  
  return cached;
}

// Suchergebnisse in Cache speichern
export function setCachedSearch(
  query: string, 
  source: 'google' | '11880',
  results: SearchResult[],
  currentPage: number,
  totalPages: number,
  isComplete: boolean = false
): void {
  const key = getCacheKey(query, source);
  const existing = searchCache.get(key);
  
  if (existing) {
    // Ergebnisse anhängen
    existing.results.push(...results);
    existing.currentPage = currentPage;
    existing.totalPages = Math.max(existing.totalPages, totalPages);
    existing.isComplete = isComplete;
    existing.lastSearchTime = Date.now();
  } else {
    // Neuen Cache-Eintrag erstellen
    searchCache.set(key, {
      query,
      source,
      results: [...results],
      totalPages,
      currentPage,
      lastSearchTime: Date.now(),
      isComplete
    });
  }
}

// Nächste Seite aus Cache abrufen
export function getNextPageFromCache(
  query: string, 
  source: 'google' | '11880',
  pageSize: number = 20
): { results: SearchResult[], hasMore: boolean, nextStartIndex: number } {
  const cached = getCachedSearch(query, source);
  
  if (!cached) {
    return { results: [], hasMore: true, nextStartIndex: 0 };
  }
  
  // Berechne welche Ergebnisse bereits angezeigt wurden
  const startIndex = cached.currentPage * pageSize;
  const endIndex = startIndex + pageSize;
  
  const results = cached.results.slice(startIndex, endIndex);
  const hasMore = !cached.isComplete || endIndex < cached.results.length;
  
  return {
    results,
    hasMore,
    nextStartIndex: endIndex
  };
}

// Cache-Status abrufen
export function getCacheStatus(query: string, source: 'google' | '11880'): {
  cached: boolean,
  totalResults: number,
  isComplete: boolean,
  lastUpdate: Date | null
} {
  const cached = getCachedSearch(query, source);
  
  if (!cached) {
    return {
      cached: false,
      totalResults: 0,
      isComplete: false,
      lastUpdate: null
    };
  }
  
  return {
    cached: true,
    totalResults: cached.results.length,
    isComplete: cached.isComplete,
    lastUpdate: new Date(cached.lastSearchTime)
  };
}

// Cache leeren (für Tests)
export function clearCache(): void {
  searchCache.clear();
}
