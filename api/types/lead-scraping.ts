export interface SearchResult {
  source: 'google' | '11880';
  companyName: string;
  phone?: string;
  url?: string;
  description?: string;
}

export interface LeadSearchConfig {
  query: string;
}

export interface LeadSearchResponse {
  success: boolean;
  results: SearchResult[];
  errors?: string[];
}

export interface SourceResult {
  source: SearchResult['source'];
  results: SearchResult[];
  error?: string;
}