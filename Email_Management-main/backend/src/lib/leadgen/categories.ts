/**
 * Business categories: what the user says -> OpenStreetMap tags + search keywords.
 * saved_searches.category and companies.category hold the `key`.
 * A request that matches no category becomes a keyword-only search (use case UC-01, alternate flow).
 */

export interface OsmTag {
  key: string;
  value: string;
}

export interface Category {
  key: string;
  label: string;
  osmTags: OsmTag[];
  /** Search engine keywords, best first ("dentist in Lahore"). */
  searchKeywords: string[];
  /** Extra words users type (English + Roman Urdu), lowercase. */
  aliases: string[];
}

const tag = (key: string, value: string): OsmTag => ({ key, value });

export const CATEGORIES: readonly Category[] = [
  { key: 'dentist', label: 'Dental clinics', osmTags: [tag('amenity', 'dentist'), tag('healthcare', 'dentist')], searchKeywords: ['dental clinic', 'dentist'], aliases: ['dentist', 'dentists', 'dental', 'dental clinic', 'dental clinics', 'orthodontist', 'daanton'] },
  { key: 'doctor', label: 'Doctors and clinics', osmTags: [tag('amenity', 'doctors'), tag('amenity', 'clinic'), tag('healthcare', 'clinic'), tag('healthcare', 'doctor')], searchKeywords: ['clinic', 'medical clinic'], aliases: ['doctor', 'doctors', 'clinic', 'clinics', 'medical clinic', 'physician', 'dermatologist', 'skin clinic'] },
  { key: 'hospital', label: 'Hospitals', osmTags: [tag('amenity', 'hospital'), tag('healthcare', 'hospital')], searchKeywords: ['hospital'], aliases: ['hospital', 'hospitals', 'aspatal'] },
  { key: 'pharmacy', label: 'Pharmacies', osmTags: [tag('amenity', 'pharmacy'), tag('healthcare', 'pharmacy')], searchKeywords: ['pharmacy'], aliases: ['pharmacy', 'pharmacies', 'chemist', 'medical store'] },
  { key: 'veterinary', label: 'Veterinary clinics', osmTags: [tag('amenity', 'veterinary')], searchKeywords: ['veterinary clinic'], aliases: ['vet', 'vets', 'veterinary', 'pet clinic'] },
  { key: 'real_estate', label: 'Real estate agencies', osmTags: [tag('office', 'estate_agent'), tag('shop', 'estate_agent')], searchKeywords: ['real estate agency', 'property dealer'], aliases: ['real estate', 'real estate agency', 'real estate agents', 'property dealer', 'property dealers', 'realtor', 'realtors', 'estate agent'] },
  { key: 'lawyer', label: 'Law firms', osmTags: [tag('office', 'lawyer')], searchKeywords: ['law firm', 'lawyer'], aliases: ['lawyer', 'lawyers', 'law firm', 'law firms', 'advocate', 'advocates', 'attorney', 'wakeel'] },
  { key: 'accountant', label: 'Accountants', osmTags: [tag('office', 'accountant'), tag('office', 'tax_advisor')], searchKeywords: ['accounting firm', 'chartered accountant'], aliases: ['accountant', 'accountants', 'accounting firm', 'chartered accountant', 'tax consultant', 'tax advisor'] },
  { key: 'it_company', label: 'IT and software companies', osmTags: [tag('office', 'it'), tag('craft', 'software'), tag('office', 'telecommunication')], searchKeywords: ['software company', 'it company'], aliases: ['software house', 'software houses', 'software company', 'software companies', 'it company', 'it companies', 'web development', 'app development'] },
  { key: 'marketing_agency', label: 'Marketing agencies', osmTags: [tag('office', 'advertising_agency'), tag('office', 'marketing')], searchKeywords: ['digital marketing agency', 'advertising agency'], aliases: ['marketing agency', 'marketing agencies', 'digital marketing', 'advertising agency', 'seo agency', 'ad agency'] },
  { key: 'restaurant', label: 'Restaurants', osmTags: [tag('amenity', 'restaurant')], searchKeywords: ['restaurant'], aliases: ['restaurant', 'restaurants', 'dhaba', 'eatery'] },
  { key: 'cafe', label: 'Cafes', osmTags: [tag('amenity', 'cafe')], searchKeywords: ['cafe', 'coffee shop'], aliases: ['cafe', 'cafes', 'coffee shop', 'coffee shops'] },
  { key: 'hotel', label: 'Hotels', osmTags: [tag('tourism', 'hotel'), tag('tourism', 'guest_house')], searchKeywords: ['hotel'], aliases: ['hotel', 'hotels', 'guest house', 'guest houses'] },
  { key: 'gym', label: 'Gyms and fitness centres', osmTags: [tag('leisure', 'fitness_centre'), tag('leisure', 'sports_centre')], searchKeywords: ['gym', 'fitness center'], aliases: ['gym', 'gyms', 'fitness center', 'fitness centre', 'fitness club'] },
  { key: 'beauty_salon', label: 'Beauty salons', osmTags: [tag('shop', 'beauty'), tag('shop', 'hairdresser')], searchKeywords: ['beauty salon', 'salon'], aliases: ['salon', 'salons', 'beauty salon', 'beauty parlour', 'beauty parlor', 'parlour', 'barber', 'hair salon', 'spa'] },
  { key: 'school', label: 'Schools', osmTags: [tag('amenity', 'school')], searchKeywords: ['school'], aliases: ['school', 'schools', 'school system'] },
  { key: 'college', label: 'Colleges and universities', osmTags: [tag('amenity', 'college'), tag('amenity', 'university')], searchKeywords: ['college', 'university'], aliases: ['college', 'colleges', 'university', 'universities'] },
  { key: 'training_institute', label: 'Training institutes', osmTags: [tag('amenity', 'training'), tag('office', 'educational_institution')], searchKeywords: ['training institute', 'academy'], aliases: ['training institute', 'academy', 'academies', 'coaching centre', 'tuition centre', 'it institute'] },
  { key: 'car_dealer', label: 'Car dealers', osmTags: [tag('shop', 'car')], searchKeywords: ['car dealer', 'car showroom'], aliases: ['car dealer', 'car dealers', 'car showroom', 'motors', 'auto dealer'] },
  { key: 'car_repair', label: 'Car workshops', osmTags: [tag('shop', 'car_repair')], searchKeywords: ['car workshop', 'auto repair'], aliases: ['car repair', 'car workshop', 'auto repair', 'mechanic', 'workshop'] },
  { key: 'travel_agency', label: 'Travel agencies', osmTags: [tag('shop', 'travel_agency'), tag('office', 'travel_agent')], searchKeywords: ['travel agency'], aliases: ['travel agency', 'travel agencies', 'travel agent', 'tour operator', 'umrah', 'hajj'] },
  { key: 'insurance', label: 'Insurance agencies', osmTags: [tag('office', 'insurance')], searchKeywords: ['insurance company'], aliases: ['insurance', 'insurance agency', 'insurance company', 'takaful'] },
  { key: 'architect', label: 'Architects', osmTags: [tag('office', 'architect')], searchKeywords: ['architecture firm', 'architect'], aliases: ['architect', 'architects', 'architecture firm', 'interior designer', 'interior design'] },
  { key: 'construction', label: 'Construction companies', osmTags: [tag('office', 'construction_company'), tag('craft', 'builder')], searchKeywords: ['construction company', 'builders'], aliases: ['construction', 'construction company', 'builders', 'builder', 'contractor', 'contractors'] },
  { key: 'furniture', label: 'Furniture stores', osmTags: [tag('shop', 'furniture')], searchKeywords: ['furniture store'], aliases: ['furniture', 'furniture store', 'furniture shop'] },
  { key: 'clothing', label: 'Clothing stores', osmTags: [tag('shop', 'clothes'), tag('shop', 'boutique')], searchKeywords: ['clothing store', 'boutique'], aliases: ['clothing', 'clothing store', 'boutique', 'boutiques', 'garments'] },
  { key: 'electronics', label: 'Electronics stores', osmTags: [tag('shop', 'electronics'), tag('shop', 'mobile_phone'), tag('shop', 'computer')], searchKeywords: ['electronics store', 'mobile shop'], aliases: ['electronics', 'electronics store', 'mobile shop', 'computer shop'] },
  { key: 'supermarket', label: 'Supermarkets', osmTags: [tag('shop', 'supermarket')], searchKeywords: ['supermarket'], aliases: ['supermarket', 'supermarkets', 'grocery store', 'mart'] },
  { key: 'bakery', label: 'Bakeries', osmTags: [tag('shop', 'bakery'), tag('shop', 'pastry')], searchKeywords: ['bakery'], aliases: ['bakery', 'bakeries', 'bakers', 'sweets'] },
  { key: 'printing', label: 'Printing services', osmTags: [tag('shop', 'copyshop'), tag('craft', 'printer')], searchKeywords: ['printing press', 'printing services'], aliases: ['printing', 'printing press', 'printers', 'print shop'] },
  { key: 'logistics', label: 'Logistics and courier', osmTags: [tag('office', 'logistics'), tag('office', 'courier')], searchKeywords: ['logistics company', 'courier service'], aliases: ['logistics', 'courier', 'courier service', 'freight', 'cargo'] },
  { key: 'manufacturer', label: 'Manufacturers', osmTags: [tag('man_made', 'works'), tag('industrial', 'factory')], searchKeywords: ['manufacturer', 'factory'], aliases: ['manufacturer', 'manufacturers', 'factory', 'factories', 'textile mill'] },
];

const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

export function getCategory(key: string | null | undefined): Category | null {
  return key ? (BY_KEY.get(key) ?? null) : null;
}

function clean(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/**
 * Finds the category in free text: "Lahore ke dental clinics", "software houses in Karachi".
 * The longest matching alias wins ("dental clinic" beats "clinic"). Null = keyword-only search.
 */
export function resolveCategory(text: string | null | undefined): Category | null {
  if (!text) return null;
  const hay = clean(text);
  if (BY_KEY.has(text.trim())) return BY_KEY.get(text.trim())!;
  let best: { c: Category; len: number } | null = null;
  for (const c of CATEGORIES) {
    for (const a of [c.key.replace(/_/g, ' '), ...c.aliases]) {
      if (hay.includes(clean(a)) && (!best || a.length > best.len)) best = { c, len: a.length };
    }
  }
  return best?.c ?? null;
}
