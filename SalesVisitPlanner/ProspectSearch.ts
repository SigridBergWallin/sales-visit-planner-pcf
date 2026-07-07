import { IInputs } from "./generated/ManifestTypes";

export interface ProspectResult {
  name: string;
  address: string;
  city: string;
  lat: number;
  lon: number;
  category: string | null;
  phone: string | null;
  website: string | null;
  isInD365: boolean;
  d365Id: string | null;
  isOnRoute: boolean;
}

export const searchNearbyBusinesses = async (
  azureMapsKey: string,
  searchTerm: string,
  lat: number,
  lon: number,
  radiusKm: number
): Promise<ProspectResult[]> => {

  console.log('[ProspectSearch] START', {
    searchTerm, lat, lon, radiusKm,
    keyPresent: !!azureMapsKey,
    keyPreview: azureMapsKey?.substring(0, 8)
  });

  // Guard: validate all inputs
  if (!azureMapsKey || azureMapsKey.trim() === '') {
    throw new Error('Azure Maps key is missing');
  }
  if (!searchTerm || searchTerm.trim() === '') {
    throw new Error('Search term is empty');
  }
  if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
    throw new Error(
      `Invalid coordinates: lat=${lat} lon=${lon}`
    );
  }

  // Build URL using URLSearchParams to avoid 
  // any encoding issues
  const params = new URLSearchParams({
    'api-version': '1.0',
    'subscription-key': azureMapsKey,
    'query': searchTerm,
    'lat': lat.toString(),
    'lon': lon.toString(),
    'radius': (radiusKm * 1000).toString(),
    'countrySet': 'DK,SE,NO,DE,NL',
    'language': 'en-US',
    'limit': '20'
  });

  const url = 
    `https://atlas.microsoft.com/search/fuzzy/json`
    + `?${params.toString()}`;

  console.log('[ProspectSearch] fetching:', url);

  // Use XMLHttpRequest instead of fetch —
  // more reliable in D365 PCF WebView context
  const rawData = await new Promise<string>(
    (resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.setRequestHeader('Accept', 'application/json');
      
      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4) return;
        
        console.log('[ProspectSearch] XHR status:', 
          xhr.status);
        
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.responseText);
        } else {
          reject(new Error(
            `Azure Maps returned ${xhr.status}: `
            + xhr.responseText
          ));
        }
      };
      
      xhr.onerror = () => {
        console.error('[ProspectSearch] XHR network error');
        reject(new Error('Network request failed'));
      };
      
      xhr.ontimeout = () => {
        reject(new Error('Request timed out'));
      };
      
      xhr.timeout = 10000;
      xhr.send();
    }
  );

  console.log('[ProspectSearch] raw response received, '
    + 'length:', rawData.length);

  const data = JSON.parse(rawData);
  
  console.log('[ProspectSearch] results count:', 
    data.results?.length ?? 0);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data.results ?? []).map((r: any) => ({
    name: r.poi?.name ?? r.address.freeformAddress,
    address: r.address.freeformAddress ?? '',
    city: r.address.municipality ?? '',
    lat: r.position.lat,
    lon: r.position.lon,
    category: r.poi?.categories?.[0] ?? null,
    phone: r.poi?.phone ?? null,
    website: r.poi?.url ?? null,
    isInD365: false,
    d365Id: null,
    isOnRoute: false
  }));
};

export const searchByBuyerType = async (
  azureMapsKey: string,
  productTerm: string,
  lat: number,
  lon: number,
  radiusKm: number
): Promise<ProspectResult[]> => {

  const intentMap: Record<string, string[]> = {
    'window': [
      'construction company', 
      'architect', 
      'property developer',
      'building contractor'
    ],
    'rooflight': [
      'roofing contractor',
      'construction company',
      'architect'
    ],
    'skylight': [
      'roofing contractor',
      'construction company',
      'architect'
    ],
    'roof': [
      'roofing contractor',
      'building contractor'
    ],
    'contractor': [
      'construction company',
      'building services',
      'general contractor'
    ],
    'renovation': [
      'renovation company',
      'construction company',
      'interior design'
    ]
  };

  const lower = productTerm.toLowerCase().trim();
  let searchTerms = [productTerm];

  for (const [key, terms] of Object.entries(intentMap)) {
    if (lower.includes(key)) {
      searchTerms = terms;
      break;
    }
  }

  console.log('[ProspectSearch] buyer type terms:', 
    searchTerms);

  // Search for each term in parallel
  const searches = searchTerms.map(term =>
    searchNearbyBusinesses(
      azureMapsKey, term, lat, lon, radiusKm
    ).catch(err => {
      console.warn(
        `[ProspectSearch] term "${term}" failed:`, err
      );
      return [] as ProspectResult[];
    })
  );

  const allResults = await Promise.all(searches);

  // Deduplicate by name
  const seen = new Set<string>();
  return allResults.flat().filter(r => {
    const key = r.name.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
