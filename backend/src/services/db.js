'use strict';

/**
 * db.js — In-memory database abstraction for M2.
 *
 * Every method has the same interface as the Supabase client calls
 * that will replace them in M3 (Supabase milestone).
 * Replace the Map operations with Supabase queries — the route/service
 * layer should need zero changes.
 *
 * Stores:
 *   providers        — 15 seeded LA-area MPN providers (read-only seed)
 *   appointments     — appointment records (claim → provider bookings)
 *   documents        — uploaded/generated document metadata
 *   magicLinkTokens  — single-use employee intake tokens
 *   employees        — ADP-pulled employee records (cache)
 *   employers        — employer records (test seed)
 */

// ── Zip-code coordinates for distance calculation ─────────────────────────────
const ZIP_COORDS = {
  '90057': { lat: 34.0634, lon: -118.2756 }, // Koreatown
  '90010': { lat: 34.0611, lon: -118.2908 }, // Mid-Wilshire
  '90020': { lat: 34.0722, lon: -118.3047 }, // Hancock Park
  '90036': { lat: 34.0852, lon: -118.3479 }, // Fairfax / Mid-City
  '93021': { lat: 34.2837, lon: -118.8796 }, // Moorpark
  // Common employee home zips (ADP mock data)
  '90001': { lat: 33.9731, lon: -118.2479 },
  '90002': { lat: 33.9494, lon: -118.2466 },
  '90011': { lat: 34.0061, lon: -118.2681 },
  '90015': { lat: 34.0347, lon: -118.2687 },
  '90028': { lat: 34.1016, lon: -118.3267 },
  '90038': { lat: 34.0925, lon: -118.3378 },
  '91301': { lat: 34.1560, lon: -118.8956 }, // Agoura Hills (Moorpark adjacent)
};

/**
 * Haversine distance in miles between two lat/lon points.
 */
function haversineDistanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Returns distance in miles between two zip codes.
 * Falls back to 5.0 miles if either zip is unknown.
 */
function zipDistance(zip1, zip2) {
  const a = ZIP_COORDS[zip1];
  const b = ZIP_COORDS[zip2];
  if (!a || !b) return 5.0;
  return parseFloat(haversineDistanceMiles(a.lat, a.lon, b.lat, b.lon).toFixed(1));
}

// ── Provider seed data ─────────────────────────────────────────────────────────
// 15 realistic LA-area MPN providers across 5 zip codes.
// Covers: Occ Med (5), Orthopedic Surgery (3), Urgent Care (4), PT (3).
// At least 3 walk_in = true, at least 3 mpn_tier = 1.
// NOTE: This seed is for development/demo only. Not a real MPN network.

const PROVIDERS_SEED = [
  // ── Occupational Medicine (5) ──────────────────────────────────────────────
  {
    id: 'prov_001',
    name: 'Pacific Occupational Medicine — Koreatown',
    specialty: 'Occupational Medicine',
    address_line1: '3756 W 6th St, Suite 200',
    city: 'Los Angeles', state: 'CA', zip: '90057',
    phone: '(213) 555-0110', fax: '(213) 555-0111',
    email: 'wc@pacificocmed.com',
    mpn_tier: 1, walk_in: false, rating: 4.7,
    hours: 'Mon–Fri 8am–5pm',
    languages: ['English', 'Spanish', 'Korean'],
    accepting_new_wc: true,
  },
  {
    id: 'prov_002',
    name: 'Olympic Medical Group — Mid-Wilshire',
    specialty: 'Occupational Medicine',
    address_line1: '3470 Wilshire Blvd, Suite 820',
    city: 'Los Angeles', state: 'CA', zip: '90010',
    phone: '(213) 555-0210', fax: '(213) 555-0211',
    email: 'wc@olympicmedgroup.com',
    mpn_tier: 1, walk_in: false, rating: 4.5,
    hours: 'Mon–Fri 8am–6pm, Sat 9am–1pm',
    languages: ['English', 'Spanish'],
    accepting_new_wc: true,
  },
  {
    id: 'prov_003',
    name: 'Wilshire Occupational Health Center',
    specialty: 'Occupational Medicine',
    address_line1: '3055 Wilshire Blvd, Suite 310',
    city: 'Los Angeles', state: 'CA', zip: '90010',
    phone: '(213) 555-0312', fax: '(213) 555-0313',
    email: 'scheduling@wilshireocchealth.com',
    mpn_tier: 2, walk_in: false, rating: 4.2,
    hours: 'Mon–Fri 8:30am–5:30pm',
    languages: ['English', 'Tagalog'],
    accepting_new_wc: true,
  },
  {
    id: 'prov_004',
    name: 'Hancock Park Occupational Medicine',
    specialty: 'Occupational Medicine',
    address_line1: '131 N Larchmont Blvd, Suite 100',
    city: 'Los Angeles', state: 'CA', zip: '90020',
    phone: '(323) 555-0410', fax: '(323) 555-0411',
    email: 'wc@hancockparkocc.com',
    mpn_tier: 2, walk_in: false, rating: 4.3,
    hours: 'Mon–Fri 9am–5pm',
    languages: ['English', 'Spanish', 'Armenian'],
    accepting_new_wc: true,
  },
  {
    id: 'prov_005',
    name: 'Fairfax District Occupational Health',
    specialty: 'Occupational Medicine',
    address_line1: '8920 Wilshire Blvd, Suite 500',
    city: 'Beverly Hills', state: 'CA', zip: '90036',
    phone: '(310) 555-0510', fax: '(310) 555-0511',
    email: 'occmed@fairfaxocchealth.com',
    mpn_tier: 2, walk_in: false, rating: 4.1,
    hours: 'Mon–Fri 8am–5pm',
    languages: ['English', 'Spanish', 'Hebrew'],
    accepting_new_wc: true,
  },

  // ── Orthopedic Surgery (3) ─────────────────────────────────────────────────
  {
    id: 'prov_006',
    name: 'LA Orthopedic Specialists — Wilshire',
    specialty: 'Orthopedic Surgery',
    address_line1: '3811 Wilshire Blvd, Suite 600',
    city: 'Los Angeles', state: 'CA', zip: '90057',
    phone: '(213) 555-0610', fax: '(213) 555-0611',
    email: 'wc@laorthospecialists.com',
    mpn_tier: 1, walk_in: false, rating: 4.8,
    hours: 'Mon–Fri 8am–5pm',
    languages: ['English', 'Spanish'],
    accepting_new_wc: true,
  },
  {
    id: 'prov_007',
    name: 'LA Sports Medicine & Orthopedics — Fairfax',
    specialty: 'Orthopedic Surgery',
    address_line1: '7601 Beverly Blvd, Suite 300',
    city: 'Los Angeles', state: 'CA', zip: '90036',
    phone: '(323) 555-0710', fax: '(323) 555-0711',
    email: 'wc@lasportsortho.com',
    mpn_tier: 2, walk_in: false, rating: 4.6,
    hours: 'Mon–Fri 8am–6pm',
    languages: ['English', 'Spanish'],
    accepting_new_wc: true,
  },
  {
    id: 'prov_008',
    name: 'Moorpark Orthopedic Surgery Center',
    specialty: 'Orthopedic Surgery',
    address_line1: '18250 Technology Dr, Suite 150',
    city: 'Moorpark', state: 'CA', zip: '93021',
    phone: '(805) 555-0810', fax: '(805) 555-0811',
    email: 'wc@moorparkortho.com',
    mpn_tier: 2, walk_in: false, rating: 4.4,
    hours: 'Mon–Fri 8am–5pm',
    languages: ['English', 'Spanish'],
    accepting_new_wc: true,
  },

  // ── Urgent Care (4) ────────────────────────────────────────────────────────
  {
    id: 'prov_009',
    name: 'Koreatown Urgent Care & Occupational Health',
    specialty: 'Urgent Care',
    address_line1: '2930 W Olympic Blvd',
    city: 'Los Angeles', state: 'CA', zip: '90057',
    phone: '(213) 555-0910', fax: '(213) 555-0911',
    email: 'wc@koreatown-urgentcare.com',
    mpn_tier: 1, walk_in: true, rating: 4.4,
    hours: 'Mon–Fri 7am–8pm, Sat–Sun 8am–5pm',
    languages: ['English', 'Spanish', 'Korean'],
    accepting_new_wc: true,
  },
  {
    id: 'prov_010',
    name: 'Beverly & Western Medical Center',
    specialty: 'Urgent Care',
    address_line1: '5428 W Beverly Blvd',
    city: 'Los Angeles', state: 'CA', zip: '90020',
    phone: '(323) 555-1010', fax: '(323) 555-1011',
    email: 'wc@beverlywesternmed.com',
    mpn_tier: 2, walk_in: true, rating: 4.0,
    hours: 'Mon–Sun 8am–9pm',
    languages: ['English', 'Spanish', 'Tagalog'],
    accepting_new_wc: true,
  },
  {
    id: 'prov_011',
    name: 'Fairfax Urgent Care Center',
    specialty: 'Urgent Care',
    address_line1: '500 N Fairfax Ave',
    city: 'Los Angeles', state: 'CA', zip: '90036',
    phone: '(323) 555-1110', fax: '(323) 555-1111',
    email: 'wc@fairfaxurgentcare.com',
    mpn_tier: 2, walk_in: true, rating: 4.1,
    hours: 'Mon–Sun 8am–8pm',
    languages: ['English', 'Spanish', 'Hebrew', 'Russian'],
    accepting_new_wc: true,
  },
  {
    id: 'prov_012',
    name: 'Moorpark Community Urgent Care',
    specialty: 'Urgent Care',
    address_line1: '375 Los Angeles Ave, Suite 101',
    city: 'Moorpark', state: 'CA', zip: '93021',
    phone: '(805) 555-1210', fax: '(805) 555-1211',
    email: 'wc@moorparkurgentcare.com',
    mpn_tier: 2, walk_in: false, rating: 3.9,
    hours: 'Mon–Fri 8am–6pm, Sat 9am–3pm',
    languages: ['English', 'Spanish'],
    accepting_new_wc: true,
  },

  // ── Physical Therapy (3) ───────────────────────────────────────────────────
  {
    id: 'prov_013',
    name: 'Mid-Wilshire Physical Therapy & Rehabilitation',
    specialty: 'Physical Therapy',
    address_line1: '3575 Cahuenga Blvd W, Suite 240',
    city: 'Los Angeles', state: 'CA', zip: '90010',
    phone: '(213) 555-1310', fax: '(213) 555-1311',
    email: 'wc@midwilshrept.com',
    mpn_tier: 2, walk_in: false, rating: 4.5,
    hours: 'Mon–Fri 7am–7pm',
    languages: ['English', 'Spanish'],
    accepting_new_wc: true,
  },
  {
    id: 'prov_014',
    name: 'Western Avenue Rehabilitation & Physical Therapy',
    specialty: 'Physical Therapy',
    address_line1: '4141 W 3rd St, Suite 100',
    city: 'Los Angeles', state: 'CA', zip: '90020',
    phone: '(323) 555-1410', fax: '(323) 555-1411',
    email: 'wc@westernaptrehab.com',
    mpn_tier: 2, walk_in: false, rating: 4.3,
    hours: 'Mon–Fri 7am–6pm',
    languages: ['English', 'Spanish', 'Armenian'],
    accepting_new_wc: true,
  },
  {
    id: 'prov_015',
    name: 'Miracle Mile Physical Therapy Group',
    specialty: 'Physical Therapy',
    address_line1: '5455 Wilshire Blvd, Suite 1210',
    city: 'Los Angeles', state: 'CA', zip: '90036',
    phone: '(323) 555-1510', fax: '(323) 555-1511',
    email: 'wc@miraclemilept.com',
    mpn_tier: 2, walk_in: false, rating: 4.6,
    hours: 'Mon–Fri 7am–7pm, Sat 8am–12pm',
    languages: ['English', 'Spanish'],
    accepting_new_wc: true,
  },
];

// Convert array → Map for O(1) lookup
const providersStore = new Map(PROVIDERS_SEED.map(p => [p.id, p]));

// ── Runtime stores (start empty) ───────────────────────────────────────────────
const appointmentsStore   = new Map();
const documentsStore      = new Map();
const magicLinkTokenStore = new Map();
const employeeCache       = new Map(); // keyed by adpEmployeeId
const employerStore       = new Map([
  ['employer-brightcare-001', {
    id: 'employer-brightcare-001',
    name: 'BrightCare Home Health',
    address_line1: '1200 W 7th St, Suite 300',
    city: 'Los Angeles', state: 'CA', zip: '90017',
    phone: '(213) 555-2000',
    primary_contact_email: 'hr@brightcarehh.com',
  }],
  ['employer-carewell-001', {
    id: 'employer-carewell-001',
    name: 'CareWell Services',
    address_line1: '500 N Brand Blvd, Suite 700',
    city: 'Glendale', state: 'CA', zip: '91203',
    phone: '(818) 555-3000',
    primary_contact_email: 'hr@carewellservices.com',
  }],
  ['employer-sunrise-001', {
    id: 'employer-sunrise-001',
    name: 'SunRise Home Care',
    address_line1: '22700 Ventura Blvd, Suite 200',
    city: 'Woodland Hills', state: 'CA', zip: '91364',
    phone: '(818) 555-4000',
    primary_contact_email: 'hr@sunrisehomecare.com',
  }],
]);

// ── providers ─────────────────────────────────────────────────────────────────
const providers = {
  findAll() {
    return Array.from(providersStore.values());
  },
  findById(id) {
    return providersStore.get(id) || null;
  },
  search({ zip, specialty, walk_in }) {
    let results = Array.from(providersStore.values()).filter(p => p.accepting_new_wc);
    if (specialty && specialty !== 'all') {
      results = results.filter(p => p.specialty === specialty);
    }
    if (walk_in === true || walk_in === 'true') {
      results = results.filter(p => p.walk_in);
    }
    // Attach distance from requested zip
    results = results.map(p => ({
      ...p,
      distance_miles: zipDistance(zip, p.zip),
    }));
    // Sort: mpn_tier ASC, distance_miles ASC, rating DESC
    results.sort((a, b) =>
      a.mpn_tier - b.mpn_tier ||
      a.distance_miles - b.distance_miles ||
      b.rating - a.rating
    );
    return results;
  },
};

// ── appointments ──────────────────────────────────────────────────────────────
const appointments = {
  create(data) {
    const appt = {
      id: `appt_${Date.now()}`,
      ...data,
      status: data.status || 'scheduled',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    appointmentsStore.set(appt.id, appt);
    return appt;
  },
  findById(id) {
    return appointmentsStore.get(id) || null;
  },
  findByClaim(claimId) {
    return Array.from(appointmentsStore.values()).filter(a => a.claim_id === claimId);
  },
  update(id, patch) {
    const appt = appointmentsStore.get(id);
    if (!appt) return null;
    const updated = { ...appt, ...patch, updated_at: new Date().toISOString() };
    appointmentsStore.set(id, updated);
    return updated;
  },
};

// ── documents ─────────────────────────────────────────────────────────────────
const documents = {
  create(data) {
    const doc = {
      id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ...data,
      filehandler_pushed: false,
      created_at: new Date().toISOString(),
    };
    documentsStore.set(doc.id, doc);
    return doc;
  },
  findById(id) {
    return documentsStore.get(id) || null;
  },
  findByClaim(claimId) {
    return Array.from(documentsStore.values()).filter(d => d.claim_id === claimId);
  },
  update(id, patch) {
    const doc = documentsStore.get(id);
    if (!doc) return null;
    const updated = { ...doc, ...patch };
    documentsStore.set(id, updated);
    return updated;
  },
};

// ── magicLinkTokens ───────────────────────────────────────────────────────────
const magicLinkTokens = {
  create(data) {
    // data: { jti, claim_id, adp_employee_id, expires_at }
    magicLinkTokenStore.set(data.jti, { ...data, used_at: null });
  },
  findByJti(jti) {
    return magicLinkTokenStore.get(jti) || null;
  },
  markUsed(jti) {
    const record = magicLinkTokenStore.get(jti);
    if (record) {
      record.used_at = new Date().toISOString();
      magicLinkTokenStore.set(jti, record);
    }
  },
};

// ── employees (ADP cache) ─────────────────────────────────────────────────────
const employees = {
  upsert(adpEmployeeId, data) {
    const existing = employeeCache.get(adpEmployeeId) || {};
    const record = { ...existing, ...data, adp_employee_id: adpEmployeeId, updated_at: new Date().toISOString() };
    employeeCache.set(adpEmployeeId, record);
    return record;
  },
  findByAdpId(adpEmployeeId) {
    return employeeCache.get(adpEmployeeId) || null;
  },
};

// ── employers ─────────────────────────────────────────────────────────────────
const employers = {
  findById(id) {
    return employerStore.get(id) || null;
  },
};

// ── users (mock — replace with Supabase Auth in M5) ──────────────────────────
const MOCK_USERS = [
  {
    id:            'user-employer-1',
    email:         'hr@brightcarehh.com',
    // plaintext mock password — Supabase handles real hashing in M5
    _password:     'test1234',
    role:          'employer',
    employer_id:   'employer-brightcare',
    employer_name: 'BrightCare Home Health',
  },
  {
    id:            'user-employer-2',
    email:         'hr@carewellservices.com',
    _password:     'test1234',
    role:          'employer',
    employer_id:   'employer-carewell-001',
    employer_name: 'CareWell Services',
  },
];

const users = {
  findByEmail(email) {
    return MOCK_USERS.find(u => u.email === email) || null;
  },
  checkPassword(email, password) {
    const user = MOCK_USERS.find(u => u.email === email);
    return user ? user._password === password : false;
  },
};

// ── Test/reset helper ─────────────────────────────────────────────────────────
function _reset() {
  appointmentsStore.clear();
  documentsStore.clear();
  magicLinkTokenStore.clear();
  employeeCache.clear();
}

module.exports = {
  providers,
  appointments,
  documents,
  magicLinkTokens,
  employees,
  employers,
  users,
  zipDistance,
  _reset,
};
