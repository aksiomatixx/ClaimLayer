'use strict';

/**
 * db.js — M5 Supabase Swap.
 *
 * All Map-based stores replaced with Supabase queries.
 * Preserved unchanged:
 *   - ZIP_COORDS / haversineDistanceMiles / zipDistance  (pure JS, no DB)
 *   - PROVIDERS_SEED  (in-memory fallback; provider search is synchronous)
 *
 * users.checkPassword  →  supabaseAuth.auth.signInWithPassword()
 */

const { supabase, supabaseAuth } = require('./supabase');

// ── Zip-code coordinates ──────────────────────────────────────────────────────
const ZIP_COORDS = {
  '90057': { lat: 34.0634, lon: -118.2756 },
  '90010': { lat: 34.0611, lon: -118.2908 },
  '90020': { lat: 34.0722, lon: -118.3047 },
  '90036': { lat: 34.0852, lon: -118.3479 },
  '93021': { lat: 34.2837, lon: -118.8796 },
  '90001': { lat: 33.9731, lon: -118.2479 },
  '90002': { lat: 33.9494, lon: -118.2466 },
  '90011': { lat: 34.0061, lon: -118.2681 },
  '90015': { lat: 34.0347, lon: -118.2687 },
  '90028': { lat: 34.1016, lon: -118.3267 },
  '90038': { lat: 34.0925, lon: -118.3378 },
  '91301': { lat: 34.1560, lon: -118.8956 },
};

function haversineDistanceMiles(lat1, lon1, lat2, lon2) {
  const R    = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function zipDistance(zip1, zip2) {
  const a = ZIP_COORDS[zip1];
  const b = ZIP_COORDS[zip2];
  if (!a || !b) return 5.0;
  return parseFloat(haversineDistanceMiles(a.lat, a.lon, b.lat, b.lon).toFixed(1));
}

// ── Provider seed ─────────────────────────────────────────────────────────────
const PROVIDERS_SEED = [
  { id:'prov_001', name:'Pacific Occupational Medicine — Koreatown',    specialty:'Occupational Medicine', address_line1:'3756 W 6th St, Suite 200',        city:'Los Angeles',   state:'CA', zip:'90057', phone:'(213) 555-0110', fax:'(213) 555-0111', email:'wc@pacificocmed.com',             mpn_tier:1, walk_in:false, rating:4.7, hours:'Mon–Fri 8am–5pm',                  languages:['English','Spanish','Korean'],           accepting_new_wc:true },
  { id:'prov_002', name:'Olympic Medical Group — Mid-Wilshire',         specialty:'Occupational Medicine', address_line1:'3470 Wilshire Blvd, Suite 820',   city:'Los Angeles',   state:'CA', zip:'90010', phone:'(213) 555-0210', fax:'(213) 555-0211', email:'wc@olympicmedgroup.com',           mpn_tier:1, walk_in:false, rating:4.5, hours:'Mon–Fri 8am–6pm, Sat 9am–1pm',     languages:['English','Spanish'],                   accepting_new_wc:true },
  { id:'prov_003', name:'Wilshire Occupational Health Center',          specialty:'Occupational Medicine', address_line1:'3055 Wilshire Blvd, Suite 310',   city:'Los Angeles',   state:'CA', zip:'90010', phone:'(213) 555-0312', fax:'(213) 555-0313', email:'scheduling@wilshireocchealth.com', mpn_tier:2, walk_in:false, rating:4.2, hours:'Mon–Fri 8:30am–5:30pm',             languages:['English','Tagalog'],                   accepting_new_wc:true },
  { id:'prov_004', name:'Hancock Park Occupational Medicine',           specialty:'Occupational Medicine', address_line1:'131 N Larchmont Blvd, Suite 100', city:'Los Angeles',   state:'CA', zip:'90020', phone:'(323) 555-0410', fax:'(323) 555-0411', email:'wc@hancockparkocc.com',            mpn_tier:2, walk_in:false, rating:4.3, hours:'Mon–Fri 9am–5pm',                  languages:['English','Spanish','Armenian'],         accepting_new_wc:true },
  { id:'prov_005', name:'Fairfax District Occupational Health',         specialty:'Occupational Medicine', address_line1:'8920 Wilshire Blvd, Suite 500',   city:'Beverly Hills', state:'CA', zip:'90036', phone:'(310) 555-0510', fax:'(310) 555-0511', email:'occmed@fairfaxocchealth.com',     mpn_tier:2, walk_in:false, rating:4.1, hours:'Mon–Fri 8am–5pm',                  languages:['English','Spanish','Hebrew'],           accepting_new_wc:true },
  { id:'prov_006', name:'LA Orthopedic Specialists — Wilshire',         specialty:'Orthopedic Surgery',    address_line1:'3811 Wilshire Blvd, Suite 600',   city:'Los Angeles',   state:'CA', zip:'90057', phone:'(213) 555-0610', fax:'(213) 555-0611', email:'wc@laorthospecialists.com',        mpn_tier:1, walk_in:false, rating:4.8, hours:'Mon–Fri 8am–5pm',                  languages:['English','Spanish'],                   accepting_new_wc:true },
  { id:'prov_007', name:'LA Sports Medicine & Orthopedics — Fairfax',  specialty:'Orthopedic Surgery',    address_line1:'7601 Beverly Blvd, Suite 300',    city:'Los Angeles',   state:'CA', zip:'90036', phone:'(323) 555-0710', fax:'(323) 555-0711', email:'wc@lasportsortho.com',             mpn_tier:2, walk_in:false, rating:4.6, hours:'Mon–Fri 8am–6pm',                  languages:['English','Spanish'],                   accepting_new_wc:true },
  { id:'prov_008', name:'Moorpark Orthopedic Surgery Center',           specialty:'Orthopedic Surgery',    address_line1:'18250 Technology Dr, Suite 150',  city:'Moorpark',      state:'CA', zip:'93021', phone:'(805) 555-0810', fax:'(805) 555-0811', email:'wc@moorparkortho.com',             mpn_tier:2, walk_in:false, rating:4.4, hours:'Mon–Fri 8am–5pm',                  languages:['English','Spanish'],                   accepting_new_wc:true },
  { id:'prov_009', name:'Koreatown Urgent Care & Occupational Health',  specialty:'Urgent Care',           address_line1:'2930 W Olympic Blvd',             city:'Los Angeles',   state:'CA', zip:'90057', phone:'(213) 555-0910', fax:'(213) 555-0911', email:'wc@koreatown-urgentcare.com',      mpn_tier:1, walk_in:true,  rating:4.4, hours:'Mon–Fri 7am–8pm, Sat–Sun 8am–5pm', languages:['English','Spanish','Korean'],           accepting_new_wc:true },
  { id:'prov_010', name:'Beverly & Western Medical Center',             specialty:'Urgent Care',           address_line1:'5428 W Beverly Blvd',             city:'Los Angeles',   state:'CA', zip:'90020', phone:'(323) 555-1010', fax:'(323) 555-1011', email:'wc@beverlywesternmed.com',         mpn_tier:2, walk_in:true,  rating:4.0, hours:'Mon–Sun 8am–9pm',                  languages:['English','Spanish','Tagalog'],          accepting_new_wc:true },
  { id:'prov_011', name:'Fairfax Urgent Care Center',                   specialty:'Urgent Care',           address_line1:'500 N Fairfax Ave',               city:'Los Angeles',   state:'CA', zip:'90036', phone:'(323) 555-1110', fax:'(323) 555-1111', email:'wc@fairfaxurgentcare.com',         mpn_tier:2, walk_in:true,  rating:4.1, hours:'Mon–Sun 8am–8pm',                  languages:['English','Spanish','Hebrew','Russian'],  accepting_new_wc:true },
  { id:'prov_012', name:'Moorpark Community Urgent Care',               specialty:'Urgent Care',           address_line1:'375 Los Angeles Ave, Suite 101',  city:'Moorpark',      state:'CA', zip:'93021', phone:'(805) 555-1210', fax:'(805) 555-1211', email:'wc@moorparkurgentcare.com',        mpn_tier:2, walk_in:false, rating:3.9, hours:'Mon–Fri 8am–6pm, Sat 9am–3pm',     languages:['English','Spanish'],                   accepting_new_wc:true },
  { id:'prov_013', name:'Mid-Wilshire Physical Therapy & Rehabilitation',specialty:'Physical Therapy',     address_line1:'3575 Cahuenga Blvd W, Suite 240', city:'Los Angeles',   state:'CA', zip:'90010', phone:'(213) 555-1310', fax:'(213) 555-1311', email:'wc@midwilshrept.com',              mpn_tier:2, walk_in:false, rating:4.5, hours:'Mon–Fri 7am–7pm',                  languages:['English','Spanish'],                   accepting_new_wc:true },
  { id:'prov_014', name:'Western Avenue Rehabilitation & Physical Therapy',specialty:'Physical Therapy',  address_line1:'4141 W 3rd St, Suite 100',        city:'Los Angeles',   state:'CA', zip:'90020', phone:'(323) 555-1410', fax:'(323) 555-1411', email:'wc@westernaptrehab.com',           mpn_tier:2, walk_in:false, rating:4.3, hours:'Mon–Fri 7am–6pm',                  languages:['English','Spanish','Armenian'],         accepting_new_wc:true },
  { id:'prov_015', name:'Miracle Mile Physical Therapy Group',           specialty:'Physical Therapy',     address_line1:'5455 Wilshire Blvd, Suite 1210',  city:'Los Angeles',   state:'CA', zip:'90036', phone:'(323) 555-1510', fax:'(323) 555-1511', email:'wc@miraclemilept.com',             mpn_tier:2, walk_in:false, rating:4.6, hours:'Mon–Fri 7am–7pm, Sat 8am–12pm',    languages:['English','Spanish'],                   accepting_new_wc:true },
];

// In-memory fallback for provider lookup in tests that don't seed Supabase
const _providersMap = new Map(PROVIDERS_SEED.map(p => [p.id, p]));

// ── providers ─────────────────────────────────────────────────────────────────
const providers = {
  async findAll() {
    const { data } = await supabase.from('providers').select('*');
    if (!data || data.length === 0) return Array.from(_providersMap.values());
    return data;
  },

  async findById(id) {
    const { data } = await supabase.from('providers').select('*').eq('id', id).single();
    if (!data) return _providersMap.get(id) || null;
    return data;
  },

  // Synchronous distance-based search — always uses in-memory seed
  search({ zip, specialty, walk_in }) {
    let results = Array.from(_providersMap.values()).filter(p => p.accepting_new_wc);
    if (specialty && specialty !== 'all') results = results.filter(p => p.specialty === specialty);
    if (walk_in === true || walk_in === 'true') results = results.filter(p => p.walk_in);
    results = results.map(p => ({ ...p, distance_miles: zipDistance(zip, p.zip) }));
    results.sort((a, b) =>
      a.mpn_tier - b.mpn_tier || a.distance_miles - b.distance_miles || b.rating - a.rating
    );
    return results;
  },
};

// ── appointments ──────────────────────────────────────────────────────────────
const appointments = {
  async create(data) {
    const row = {
      claim_id:         data.claim_id,
      provider_id:      data.provider_id,
      appointment_date: data.appointment_date,
      appointment_time: data.appointment_time,
      visit_type:       data.visit_type,
      status:           data.status || 'scheduled',
      notes:            data.notes,
      created_at:       new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    };
    const { data: row2, error } = await supabase.from('appointments').insert(row).select().single();
    if (error) throw new Error(error.message);
    return _apptOut(row2);
  },

  async findById(id) {
    const { data } = await supabase.from('appointments').select('*').eq('id', id).single();
    return data ? _apptOut(data) : null;
  },

  async findByClaim(claimId) {
    const { data } = await supabase.from('appointments').select('*').eq('claim_id', claimId);
    return (data || []).map(_apptOut);
  },

  async update(id, patch) {
    const { data } = await supabase
      .from('appointments').update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id).select().single();
    return data ? _apptOut(data) : null;
  },
};

function _apptOut(r) {
  return r ? {
    id: r.id, claim_id: r.claim_id, provider_id: r.provider_id,
    appointment_date: r.appointment_date, appointment_time: r.appointment_time,
    visit_type: r.visit_type, status: r.status, notes: r.notes,
    confirmation_number: r.confirmation_number || null,
    created_at: r.created_at, updated_at: r.updated_at,
  } : null;
}

// ── documents ─────────────────────────────────────────────────────────────────
const documents = {
  async create(data) {
    const row = {
      claim_id:          data.claim_id,
      doc_type:          data.doc_type,
      description:       data.description,
      source:            data.source,
      storage_path:      data.storage_path,
      file_size_bytes:   data.file_size_bytes,
      mime_type:         data.mime_type,
      filehandler_pushed: false,
      created_at:        new Date().toISOString(),
    };
    const { data: r, error } = await supabase.from('documents').insert(row).select().single();
    if (error) throw new Error(error.message);
    return _docOut(r);
  },

  async findById(id) {
    const { data } = await supabase.from('documents').select('*').eq('id', id).single();
    return data ? _docOut(data) : null;
  },

  async findByClaim(claimId) {
    const { data } = await supabase.from('documents').select('*').eq('claim_id', claimId);
    return (data || []).map(_docOut);
  },

  async update(id, patch) {
    const { data } = await supabase.from('documents').update(patch).eq('id', id).select().single();
    return data ? _docOut(data) : null;
  },
};

function _docOut(r) {
  return r ? {
    id: r.id, claim_id: r.claim_id, doc_type: r.doc_type, description: r.description,
    source: r.source, storage_path: r.storage_path, file_size_bytes: r.file_size_bytes,
    mime_type: r.mime_type, filehandler_pushed: r.filehandler_pushed,
    filehandler_doc_id: r.filehandler_doc_id, ai_read: r.ai_read,
    ai_summary: r.ai_summary, created_at: r.created_at,
  } : null;
}

// ── magicLinkTokens ───────────────────────────────────────────────────────────
const magicLinkTokens = {
  async create(data) {
    const row = {
      jti:             data.jti,
      claim_id:        data.claim_id,
      adp_employee_id: data.adp_employee_id,
      expires_at:      data.expires_at,
      used_at:         null,
      created_at:      new Date().toISOString(),
    };
    const { error } = await supabase.from('magic_link_tokens').insert(row);
    if (error) throw new Error(error.message);
  },

  async findByJti(jti) {
    const { data } = await supabase.from('magic_link_tokens').select('*').eq('jti', jti).single();
    if (!data) return null;
    return { jti: data.jti, claim_id: data.claim_id, adp_employee_id: data.adp_employee_id,
             expires_at: data.expires_at, used_at: data.used_at };
  },

  async markUsed(jti) {
    await supabase.from('magic_link_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('jti', jti);
  },

  /**
   * Atomic single use: flips used_at only when it is still NULL and
   * reports whether THIS caller won. Two concurrent validations of the
   * same link cannot both succeed.
   */
  async markUsedAtomic(jti) {
    const { data, error } = await supabase.from('magic_link_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('jti', jti).is('used_at', null)
      .select();
    if (error) throw new Error(error.message);
    return (data || []).length > 0;
  },
};

// ── employees (ADP cache) ─────────────────────────────────────────────────────
const employees = {
  async upsert(adpEmployeeId, data) {
    const row = {
      adp_employee_id:   adpEmployeeId,
      adp_associate_oid: data.associateOID,
      first_name:        data.firstName,
      last_name:         data.lastName,
      dob:               data.dob,
      address_line1:     data.address?.line1,
      address_state:     data.address?.state,
      address_zip:       data.address?.zip,
      phone:             data.phone,
      job_title:         data.jobTitle,
      hire_date:         data.hireDate,
      aww:               data.aww,
      td_rate:           data.tdRate,
      weeks_calculated:  data.weeksCalculated,
      updated_at:        new Date().toISOString(),
    };
    const { data: r, error } = await supabase
      .from('employees').upsert(row, { onConflict: 'adp_employee_id' })
      .select().single();
    if (error) throw new Error(error.message);
    return _empOut(r);
  },

  async findByAdpId(adpEmployeeId) {
    const { data } = await supabase
      .from('employees').select('*').eq('adp_employee_id', adpEmployeeId).single();
    return data ? _empOut(data) : null;
  },
};

function _empOut(r) {
  return r ? {
    id: r.id, adpEmployeeId: r.adp_employee_id, associateOID: r.adp_associate_oid,
    firstName: r.first_name, lastName: r.last_name, dob: r.dob,
    address: { line1: r.address_line1, state: r.address_state, zip: r.address_zip },
    phone: r.phone, jobTitle: r.job_title, hireDate: r.hire_date,
    aww: r.aww != null ? parseFloat(r.aww) : null,
    tdRate: r.td_rate != null ? parseFloat(r.td_rate) : null,
    weeksCalculated: r.weeks_calculated,
  } : null;
}

// ── employers ─────────────────────────────────────────────────────────────────
const EMPLOYER_SEED = new Map([
  ['employer-brightcare-001', { id:'employer-brightcare-001', name:'BrightCare Home Health',  address_line1:'1200 W 7th St, Suite 300',      city:'Los Angeles',    state:'CA', zip:'90017', phone:'(213) 555-2000', primary_contact_email:'hr@brightcarehh.com' }],
  ['employer-carewell-001',   { id:'employer-carewell-001',   name:'CareWell Services',         address_line1:'500 N Brand Blvd, Suite 700',   city:'Glendale',       state:'CA', zip:'91203', phone:'(818) 555-3000', primary_contact_email:'hr@carewellservices.com' }],
  ['employer-sunrise-001',    { id:'employer-sunrise-001',    name:'SunRise Home Care',         address_line1:'22700 Ventura Blvd, Suite 200', city:'Woodland Hills', state:'CA', zip:'91364', phone:'(818) 555-4000', primary_contact_email:'hr@sunrisehomecare.com' }],
]);

const employers = {
  async findById(id) {
    const { data } = await supabase.from('employers').select('*').eq('id', id).single();
    return data || EMPLOYER_SEED.get(id) || null;
  },
};

// ── users ─────────────────────────────────────────────────────────────────────
// findByEmail + employer metadata come from the public users table.
// Password verification delegates to Supabase Auth.
const users = {
  async findByEmail(email) {
    const { data } = await supabase.from('users').select('*').eq('email', email).single();
    return data || null;
  },

  async checkPassword(email, password) {
    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
    if (error || !data?.user) return false;
    return true;
  },
};

// ── Test reset helper ─────────────────────────────────────────────────────────
function _reset() {
  // Clears the mock store's test-created rows for appointments/documents/tokens
  if (typeof supabase._resetStore === 'function') {
    supabase._resetStore(['appointments', 'documents', 'magic_link_tokens', 'employees', 'users']);
  }
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
  PROVIDERS_SEED,
};
